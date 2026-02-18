'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true }));

const PORT = process.env.PORT || 3000;

// -------------------- Supabase --------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const LICENSE_TABLE = process.env.SUPABASE_LICENSE_TABLE || 'license_keys';
const CAPTURE_TABLE = process.env.SUPABASE_CAPTURE_TABLE || 'webhook_captures';

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });
} else {
  console.warn('[WARN] Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.');
}

// -------------------- helpers --------------------
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

function parseUrlEncoded(raw) {
  try {
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return obj;
  } catch {
    return null;
  }
}

function bestEffortParse(raw, contentType) {
  const ct = (contentType || '').toLowerCase();

  // JSON
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // URLENCODED (common for Jotform)
  if (ct.includes('application/x-www-form-urlencoded')) {
    return parseUrlEncoded(raw);
  }

  // Sometimes providers send text/plain but it's actually JSON
  try {
    const maybe = JSON.parse(raw);
    if (maybe && typeof maybe === 'object') return maybe;
  } catch {}

  return null;
}

async function insertCaptureRow({ source, path, headers, rawBody, parsedBody }) {
  if (!supabase) return { ok: false, error: 'supabase_not_configured' };

  const record = {
    source: source || 'unknown',
    path: path || null,
    content_type: headers?.['content-type'] || headers?.['Content-Type'] || null,
    headers: headers || {},
    raw_body: rawBody || '',
    body_json: parsedBody || null
  };

  const { data, error } = await supabase
    .from(CAPTURE_TABLE)
    .insert(record)
    .select()
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

// -------------------- health --------------------
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

// -------------------- RAW CAPTURE ENDPOINTS --------------------
// IMPORTANT: use express.raw here so it works for JSON, urlencoded, text, etc.
const rawParser = express.raw({ type: '*/*', limit: '5mb' });

app.post('/debug/capture', rawParser, async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const parsed = bestEffortParse(rawBody, req.headers['content-type']);

    const out = await insertCaptureRow({
      source: 'generic',
      path: req.path,
      headers: req.headers,
      rawBody,
      parsedBody: parsed
    });

    if (!out.ok) {
      console.error('[capture insert failed]', out.error);
      return res.status(500).json({ ok: false, error: 'capture_insert_failed', details: out.error });
    }

    return res.status(200).json({ ok: true, captured: true, id: out.row?.id || null });
  } catch (err) {
    console.error('[capture error]', err);
    return res.status(500).json({ ok: false, error: 'capture_server_error' });
  }
});

app.post('/debug/capture/:source', rawParser, async (req, res) => {
  try {
    const source = req.params.source || 'unknown';
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const parsed = bestEffortParse(rawBody, req.headers['content-type']);

    const out = await insertCaptureRow({
      source,
      path: req.path,
      headers: req.headers,
      rawBody,
      parsedBody: parsed
    });

    if (!out.ok) {
      console.error('[capture insert failed]', out.error);
      return res.status(500).json({ ok: false, error: 'capture_insert_failed', details: out.error });
    }

    return res.status(200).json({ ok: true, captured: true, id: out.row?.id || null });
  } catch (err) {
    console.error('[capture error]', err);
    return res.status(500).json({ ok: false, error: 'capture_server_error' });
  }
});

// -------------------- JSON endpoints (license issuing) --------------------
app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf?.toString('utf8') || '';
    }
  })
);

// Manual tester
app.post('/test/issue-license', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_not_configured' });

    const email = pickFirst(req.body?.email);
    const full_name = pickFirst(req.body?.full_name, req.body?.name);
    const transaction_id = pickFirst(req.body?.transaction_id);

    if (!email || !transaction_id) {
      return res.status(400).json({ ok: false, error: 'missing_fields', required: ['email', 'transaction_id'] });
    }

    const record = {
      email,
      full_name,
      transaction_id,
      authorize_event_type: pickFirst(req.body?.authorize_event_type) || 'manual_test',
      license_key: genLicenseKey(),
      status: pickFirst(req.body?.status) || 'active'
    };

    const { data, error } = await supabase.from(LICENSE_TABLE).insert(record).select().single();
    if (error) return res.status(500).json({ ok: false, error: 'supabase_insert_failed', details: error.message });

    return res.status(200).json({ ok: true, stored: true, row: data });
  } catch (err) {
    console.error('[test issue license error]', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Authorize.Net webhook (your current extractor can stay)
function extractFromAuthorizeNet(body) {
  const eventType =
    pickFirst(body?.eventType, body?.event_type, body?.type, body?.payload?.eventType, body?.payload?.event_type) ||
    'authorize_net';

  const email = pickFirst(body?.payload?.customer?.email, body?.payload?.customerEmail, body?.payload?.email, body?.customer?.email, body?.email);

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

    const { data, error } = await supabase.from(LICENSE_TABLE).insert(record).select().single();
    if (error) return res.status(500).json({ ok: false, error: 'supabase_insert_failed', details: error.message });

    return res.status(200).json({ ok: true, stored: true, id: data?.id ?? null, license_key: data?.license_key ?? null });
  } catch (err) {
    console.error('[authorize webhook error]', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

app.listen(PORT, () => console.log(`HVT backend listening on port ${PORT}`));
