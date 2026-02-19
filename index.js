'use strict';

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const Busboy = require('busboy');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// -------------------- ENV --------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTHORIZE_SIGNATURE_KEY = process.env.AUTHORIZE_SIGNATURE_KEY || null;

const LICENSE_TABLE = 'license_keys';

// -------------------- SUPABASE --------------------
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// -------------------- Helpers --------------------
function pickFirst(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function genLicenseKey() {
  const a = crypto.randomBytes(4).toString('hex').toUpperCase();
  const b = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `HVT-${a}-${b}`;
}

// Header: X-ANET-SIGNATURE: "sha512=<hex>"
function verifyAuthorizeSignature(rawBody, signatureHeader) {
  if (!AUTHORIZE_SIGNATURE_KEY) return { ok: true, reason: 'signature_key_not_set_skip' };

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { ok: false, reason: 'missing_signature_header' };
  }

  const provided = signatureHeader.startsWith('sha512=')
    ? signatureHeader.slice('sha512='.length)
    : signatureHeader;

  let computed;
  try {
    computed = crypto
      .createHmac('sha512', AUTHORIZE_SIGNATURE_KEY)
      .update(rawBody || '', 'utf8')
      .digest('hex');
  } catch {
    return { ok: false, reason: 'compute_failed' };
  }

  try {
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(computed, 'hex');
    if (a.length !== b.length) return { ok: false, reason: 'signature_length_mismatch' };
    const match = crypto.timingSafeEqual(a, b);
    return match ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
  } catch {
    return { ok: false, reason: 'invalid_signature_format' };
  }
}

async function getRowByTxn(transaction_id) {
  const { data, error } = await supabase
    .from(LICENSE_TABLE)
    .select('*')
    .eq('transaction_id', transaction_id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Upsert "one sale = one row" into license_keys, while preserving existing license_key.
 */
async function upsertSaleRow(transaction_id, patch) {
  if (!transaction_id) throw new Error('missing_transaction_id');

  const existing = await getRowByTxn(transaction_id);

  // Preserve license_key if already created, otherwise create once.
  const license_key = existing?.license_key || genLicenseKey();

  // Build final payload. (Only overwrite what we explicitly set.)
  const payload = {
    transaction_id,
    license_key,
    updated_at: new Date().toISOString(),
    ...patch
  };

  const { data, error } = await supabase
    .from(LICENSE_TABLE)
    .upsert(payload, { onConflict: 'transaction_id' })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

// -------------------- Health --------------------
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'hvt-backend', licenseTable: LICENSE_TABLE });
});

// -------------------- Authorize.Net webhook (RAW JSON) --------------------
app.post(
  '/webhooks/authorize-net',
  express.raw({ type: '*/*', limit: '2mb' }),
  async (req, res) => {
    try {
      const rawBody = req.body ? req.body.toString('utf8') : '';
      const sigHeader = req.headers['x-anet-signature'];

      const sigCheck = verifyAuthorizeSignature(rawBody, sigHeader);
      if (!sigCheck.ok) {
        return res.status(401).json({ ok: false, error: 'invalid_signature', reason: sigCheck.reason });
      }

      let body = {};
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        body = {};
      }

      // Authorize: transaction id
      const transaction_id = pickFirst(body?.payload?.id);
      const eventType = pickFirst(body?.eventType) || 'authorize_net';

      if (!transaction_id) {
        return res.status(400).json({ ok: false, error: 'missing_transaction_id_from_authorize' });
      }

      // If authorize hits first, we still create the row (with placeholder status)
      const row = await upsertSaleRow(transaction_id, {
        authorize_received: true,
        last_source: 'authorize',
        authorize_event_type: eventType,
        raw_authorize: rawBody,
        authorize_body_json: body,
        // status logic:
        // - if we already have email/full_name from jotform -> active
        // - else -> pending_jotform
        status: 'pending_jotform'
      });

      // If Jotform already exists (email + name present), flip active
      if (row.email && row.full_name) {
        const activated = await upsertSaleRow(transaction_id, {
          authorize_received: true,
          last_source: 'authorize',
          authorize_event_type: eventType,
          raw_authorize: rawBody,
          authorize_body_json: body,
          status: 'active'
        });
        return res.status(200).json({ ok: true, transaction_id, status: activated.status });
      }

      return res.status(200).json({ ok: true, transaction_id, status: row.status, eventType });
    } catch (err) {
      console.error('[authorize webhook error]', err);
      return res.status(500).json({ ok: false, error: 'server_error', details: err.message });
    }
  }
);

// -------------------- Jotform webhook (multipart/form-data) --------------------
app.post('/webhooks/jotform', (req, res) => {
  const bb = Busboy({
    headers: req.headers,
    limits: { fieldSize: 5 * 1024 * 1024 }
  });

  const fields = {};
  let rawConcat = '';

  bb.on('field', (name, val) => {
    fields[name] = val;
    rawConcat += `\n[${name}]=${val}`;
  });

  bb.on('error', (err) => {
    console.error('[busboy error]', err);
    return res.status(400).json({ ok: false, error: 'invalid_multipart' });
  });

  bb.on('finish', async () => {
    try {
      let rawRequest = null;
      try {
        rawRequest = fields.rawRequest ? JSON.parse(fields.rawRequest) : null;
      } catch {
        rawRequest = null;
      }

      const rr = rawRequest || {};

      // Your Jotform structure:
      const first = pickFirst(rr?.q8_q8_fullname6?.first);
      const last = pickFirst(rr?.q8_q8_fullname6?.last);
      const email = pickFirst(rr?.q11_email);
      const transaction_id = pickFirst(rr?.transactionId);

      const full_name = [first, last].filter(Boolean).join(' ') || null;

      if (!transaction_id) {
        return res.status(400).json({ ok: false, error: 'missing_transaction_id_from_jotform' });
      }

      // Upsert into the same single row
      const row = await upsertSaleRow(transaction_id, {
        jotform_received: true,
        last_source: 'jotform',
        email: email || null,
        full_name: full_name || null,
        raw_jotform: rawConcat,
        jotform_body_json: rr,
        // status logic:
        // - if authorize already received -> active
        // - else -> pending_authorize
        status: 'pending_authorize'
      });

      // If authorize already came in, activate
      if (row.authorize_received) {
        const activated = await upsertSaleRow(transaction_id, {
          jotform_received: true,
          last_source: 'jotform',
          email: email || row.email || null,
          full_name: full_name || row.full_name || null,
          raw_jotform: rawConcat,
          jotform_body_json: rr,
          status: 'active'
        });

        return res.status(200).json({
          ok: true,
          transaction_id,
          license_key: activated.license_key,
          status: activated.status
        });
      }

      return res.status(200).json({
        ok: true,
        transaction_id,
        license_key: row.license_key,
        status: row.status
      });
    } catch (err) {
      console.error('[jotform webhook error]', err);
      return res.status(500).json({ ok: false, error: 'server_error', details: err.message });
    }
  });

  req.pipe(bb);
});

// -------------------- 404 --------------------
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

app.listen(PORT, () => console.log(`HVT backend listening on port ${PORT}`));
