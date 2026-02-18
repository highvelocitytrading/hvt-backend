'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);

/**
 * IMPORTANT:
 * We store the raw request body for signature validation and debugging.
 * We also keep parsed JSON in req.body via express.json().
 */
app.use(
  express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
      req.rawBody = buf?.toString('utf8') || '';
    }
  })
);

app.use(cors({ origin: true }));

const PORT = process.env.PORT || 3000;

// ------------------ Supabase ------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

// Your existing license table
const LICENSE_TABLE = process.env.SUPABASE_LICENSE_TABLE || 'license_keys';

// New capture table (for raw webhook payload logging)
const CAPTURE_TABLE = process.env.SUPABASE_CAPTURE_TABLE || 'webhook_captures';

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });
} else {
  console.warn(
    '[WARN] Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).'
  );
}

// ------------------ helpers ------------------
function genId() {
  return crypto.randomBytes(12).toString('hex');
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function genLicenseKey() {
  // Example: HVT-8F3A2C19-5D2B4E77
  const a = crypto.randomBytes(4).toString('hex').toUpperCase();
  const b = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `HVT-${a}-${b}`;
}

/**
 * Capture + store ANY webhook payload (raw + json + headers).
 */
async function storeCapture({ source, req }) {
  if (!supabase) throw new Error('supabase_not_configured');

  const headers = req.headers || {};
  const rawBody = req.rawBody || '';
  const parsedBody = req.body && Object.keys(req.body).length ? req.body : safeJsonParse(rawBody);

  const record = {
    id: genId(),
    source, // 'authorize' | 'jotform'
    content_type: headers['content-type'] || null,
    user_agent: headers['user-agent'] || null,
    ip:
      (headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.ip ||
      null,
    headers,
    body_json: parsedBody || null,
    body_raw: rawBody || null
  };

  const { data, error } = await supabase
    .from(CAPTURE_TABLE)
    .insert(record)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * Extract "best guess" fields from Authorize payload shapes.
 * We DO NOT assume exact structure until capture confirms.
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

  const email = pickFirst(
    body?.payload?.customer?.email,
    body?.payload?.customerEmail,
    body?.payload?.email,
    body?.customer?.email,
    body?.email
  );

  const fullName = pickFirst(
    body?.payload?.customer?.name,
    body?.payload?.billing?.name,
    body?.payload?.billTo?.name,
    body?.customer?.name,
    body?.full_name,
    body?.name
  );

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

// ------------------ routes ------------------
app.get('/', (req, res) => res.json({ ok: true, service: 'hvt-backend' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    hasSupabase: Boolean(supabase),
    licenseTable: LICENSE_TABLE,
    captureTable: CAPTURE_TABLE
  });
});

// ------------------ CAPTURE ENDPOINTS ------------------
app.post('/debug/capture/authorize', async (req, res) => {
  try {
    const row = await storeCapture({ source: 'authorize', req });
    return res.status(200).json({ ok: true, captured: true, id: row.id });
  } catch (e) {
    console.error('[capture authorize error]', e);
    return res.status(500).json({ ok: false, error: 'capture_failed', details: e.message });
  }
});

app.post('/debug/capture/jotform', async (req, res) => {
  try {
    const row = await storeCapture({ source: 'jotform', req });
    return res.status(200).json({ ok: true, captured: true, id: row.id });
  } catch (e) {
    console.error('[capture jotform error]', e);
    return res.status(500).json({ ok: false, error: 'capture_failed', details: e.message });
  }
});

/**
 * View the most recent capture (optionally filtered by source).
 * Examples:
 *  /debug/last?source=authorize
 *  /debug/last?source=jotform
 */
app.get('/debug/last', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });

    const source = pickFirst(req.query?.source);
    let q = supabase
      .from(CAPTURE_TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);

    if (source) {
      q = supabase
        .from(CAPTURE_TABLE)
        .select('*')
        .eq('source', source)
        .order('created_at', { ascending: false })
        .limit(1);
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.status(200).json({ ok: true, row: data?.[0] || null });
  } catch (e) {
    console.error('[debug last error]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ------------------ LICENSE ISSUING (kept) ------------------
app.post('/test/issue-license', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });

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

    const record = {
      email,
      full_name,
      transaction_id,
      authorize_event_type: pickFirst(req.body?.authorize_event_type) || 'manual_test',
      license_key: genLicenseKey(),
      status: pickFirst(req.body?.status) || 'active'
    };

    const { data, error } = await supabase
      .from(LICENSE_TABLE)
      .insert(record)
      .select()
      .single();

    if (error) {
      console.error('[Supabase insert error]', error);
      return res.status(500).json({ ok: false, error: 'supabase_insert_failed', details: error.message });
    }

    return res.status(200).json({ ok: true, stored: true, row: data });
  } catch (err) {
    console.error('[Test issue license error]', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/webhooks/authorize-net', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });

    const body = req.body || {};
    const { email, fullName, transactionId, eventType } = extractFromAuthorizeNet(body);

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
      return res.status(500).json({ ok: false, error: 'supabase_insert_failed', details: error.message });
    }

    return res.status(200).json({ ok: true, stored: true, id: data?.id ?? null, license_key: data?.license_key ?? null });
  } catch (err) {
    console.error('[Authorize.Net webhook error]', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

app.listen(PORT, () => console.log(`HVT backend listening on port ${PORT}`));
