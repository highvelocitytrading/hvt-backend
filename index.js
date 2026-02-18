'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);

// Keep raw body (useful for signature validation + raw capture)
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

// ------------------ ENV ------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

// Your tables
const LICENSE_TABLE = process.env.SUPABASE_LICENSE_TABLE || 'license_keys';

// Optional debug capture table (recommended)
const DEBUG_TABLE = process.env.SUPABASE_DEBUG_TABLE || 'webhook_events';

// ------------------ Supabase client ------------------
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
function pickFirst(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function genLicenseKey() {
  // Example: HVT-8F3A2C19-5D2B4E77
  const a = crypto.randomBytes(4).toString('hex').toUpperCase();
  const b = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `HVT-${a}-${b}`;
}

/**
 * Extract best-guess fields from Authorize.Net webhook payload
 * (We’ll lock these in after you capture real payloads.)
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
    body?.payload?.billTo?.email,
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
    body?.transaction_id,
    body?.transaction_id // just in case your test payload uses this
  );

  return { email, fullName, transactionId, eventType };
}

/**
 * Safe insert into debug table (won't break your flow if table doesn't exist)
 */
async function tryDebugStore(payload) {
  if (!supabase) return;

  try {
    await supabase.from(DEBUG_TABLE).insert({
      source: payload.source,
      headers: payload.headers,
      body: payload.body,
      raw_body: payload.raw_body
    });
  } catch (e) {
    // Don’t fail the webhook if debug storage isn’t set up
    console.warn('[WARN] Debug store failed (ok to ignore):', e?.message || e);
  }
}

// ------------------ routes ------------------
app.get('/', (req, res) => res.json({ ok: true, service: 'hvt-backend' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    hasSupabase: Boolean(supabase),
    licenseTable: LICENSE_TABLE,
    debugTable: DEBUG_TABLE
  });
});

/**
 * DEBUG CAPTURE ENDPOINT
 * Point Authorize.Net endpoint here temporarily:
 *   https://<your-railway-domain>/debug/capture
 *
 * This returns 200 no matter what so Authorize.Net won't keep retrying.
 */
app.post('/debug/capture', async (req, res) => {
  const payload = {
    source: 'authorize_net',
    received_at: new Date().toISOString(),
    headers: req.headers,
    body: req.body,
    raw_body: req.rawBody || null
  };

  // Always log to Railway logs
  console.log('[DEBUG CAPTURE]', JSON.stringify(payload, null, 2));

  // Optional: also store in Supabase (if webhook_events exists)
  await tryDebugStore(payload);

  return res.status(200).json({ ok: true, captured: true });
});

// Manual tester (verifies Supabase insert + license generation)
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
    const authorize_event_type =
      pickFirst(req.body?.authorize_event_type) || 'manual_test';
    const status = pickFirst(req.body?.status) || 'active';

    const record = {
      email,
      full_name,
      transaction_id,
      authorize_event_type,
      license_key,
      status
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
 * PRODUCTION Authorize.Net webhook endpoint (your real one)
 * Keep Authorize.Net pointed here once capture/mapping is confirmed:
 *   https://<your-railway-domain>/webhooks/authorize-net
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

    if (!email || !transactionId) {
      // Also log what we got, so you can see why it failed
      console.warn('[WARN] Missing fields from webhook:', {
        email,
        fullName,
        transactionId,
        eventType
      });

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
