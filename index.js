'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);

// Keep raw body (useful later for webhook signature validation)
app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf?.toString('utf8') || '';
    }
  })
);

app.use(cors({ origin: true }));

const PORT = process.env.PORT || 3000;

// Supabase env
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

// IMPORTANT: set this to "license_keys" in Railway
const LICENSE_TABLE = process.env.SUPABASE_LICENSE_TABLE || 'license_keys';

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });
} else {
  console.warn(
    '[WARN] SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) is missing.'
  );
}

// ---------- helpers ----------
function pickFirst(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function genLicenseKey() {
  // short, strong, non-guessable
  // Example: HVT-8F3A2C19-5D2B4E77
  const a = crypto.randomBytes(4).toString('hex').toUpperCase();
  const b = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `HVT-${a}-${b}`;
}

/**
 * Try hard to find email/full name/transaction id in different payload shapes.
 * You can tweak these mappings later once you see the exact Authorize.Net payload.
 */
function extractFromAuthorizeNet(body) {
  const eventType =
    pickFirst(
      body?.eventType,
      body?.event_type,
      body?.type,
      body?.payload?.eventType,
      body?.payload?.event_type
    ) || 'authorize_net';

  // Email candidates
  const email = pickFirst(
    body?.payload?.customer?.email,
    body?.payload?.customerEmail,
    body?.payload?.email,
    body?.customer?.email,
    body?.email
  );

  // Full name candidates
  const fullName = pickFirst(
    body?.payload?.customer?.name,
    body?.payload?.billing?.name,
    body?.payload?.billTo?.name,
    body?.customer?.name,
    body?.full_name,
    body?.name
  );

  // Transaction id candidates
  const transactionId = pickFirst(
    body?.payload?.id,
    body?.payload?.transactionId,
    body?.payload?.transId,
    body?.payload?.transaction_id,
    body?.transactionId,
    body?.transId,
    body?.transaction_id
  );

  return { email, fullName, transactionId, eventType };
}

// ---------- routes ----------
app.get('/', (req, res) => res.json({ ok: true, service: 'hvt-backend' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    hasSupabase: Boolean(supabase),
    licenseTable: LICENSE_TABLE
  });
});

// Manual tester (super useful for verifying inserts)
app.post('/test/issue-license', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
    }

    const email = pickFirst(req.body?.email);
    const full_name = pickFirst(req.body?.full_name, req.body?.name);
    const transaction_id = pickFirst(req.body?.transaction_id);

    if (!email || !transaction_id) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields',
        required: ['email', 'transaction_id']
      });
    }

    const license_key = genLicenseKey();
    const authorize_event_type = pickFirst(req.body?.authorize_event_type) || 'manual_test';
    const status = pickFirst(req.body?.status) || 'active';

    const record = {
      email,
      full_name,
      transaction_id,
      authorize_event_type,
      license_key,
      status
      // created_at will default to now() if you set that in Supabase
    };

    const { data, error } = await supabase
      .from(LICENSE_TABLE)
      .insert(record)
      .select()
      .single();

    if (error) {
      console.error('[Supabase insert error]', error);
      return res.status(500).json({
        ok: false,
        error: 'supabase_insert_failed',
        details: error.message
      });
    }

    return res.status(200).json({ ok: true, stored: true, row: data });
  } catch (err) {
    console.error('[Test issue license error]', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * Authorize.Net webhook endpoint
 * Inserts into license_keys with:
 * email, full_name, transaction_id, authorize_event_type, license_key, status
 */
app.post('/webhooks/authorize-net', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error: 'supabase_not_configured',
        missing: [
          !SUPABASE_URL ? 'SUPABASE_URL' : null,
          !SUPABASE_KEY ? 'SUPABASE_SERVICE_ROLE_KEY' : null
        ].filter(Boolean)
      });
    }

    const body = req.body || {};
    const { email, fullName, transactionId, eventType } = extractFromAuthorizeNet(body);

    // Minimum we MUST have to create a license row
    if (!email || !transactionId) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields_from_webhook',
        extracted: { email, fullName, transactionId, eventType }
      });
    }

    const record = {
      email,
      full_name: fullName,
      transaction_id: transactionId,
      authorize_event_type: eventType,
      license_key: genLicenseKey(),
      status: 'active'
    };

    const { data, error } = await supabase
      .from(LICENSE_TABLE)
      .insert(record)
      .select()
      .single();

    if (error) {
      console.error('[Supabase insert error]', error);
      return res.status(500).json({
        ok: false,
        error: 'supabase_insert_failed',
        details: error.message
      });
    }

    return res.status(200).json({
      ok: true,
      stored: true,
      id: data?.id ?? null,
      license_key: data?.license_key ?? null
    });
  } catch (err) {
    console.error('[Authorize.Net webhook error]', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('[Unhandled error]', err);
  res.status(500).json({ ok: false, error: 'unhandled_error' });
});

app.listen(PORT, () => console.log(`HVT backend listening on port ${PORT}`));
