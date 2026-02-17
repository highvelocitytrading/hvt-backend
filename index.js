'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);

// Keep the raw body (useful for webhook signature validation later)
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

// Supabase config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const WEBHOOK_TABLE = process.env.SUPABASE_WEBHOOK_TABLE || 'webhook_events';

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });
} else {
  console.warn(
    '[WARN] SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) is missing. Webhook inserts will fail until set.'
  );
}

// Basic routes
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'hvt-backend' });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    hasSupabase: Boolean(supabase),
    webhookTable: WEBHOOK_TABLE
  });
});

/**
 * Authorize.Net webhook endpoint
 * - Stores payload + headers to Supabase table for auditing/debugging
 * - Signature verification / business logic can be added later
 */
app.post('/webhooks/authorize-net', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error: 'supabase_not_configured',
        missing: [
          !SUPABASE_URL ? 'SUPABASE_URL' : null,
          !SUPABASE_KEY
            ? 'SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)'
            : null
        ].filter(Boolean)
      });
    }

    const payload = req.body || {};
    const rawBody = req.rawBody || '';
    const headers = req.headers || {};

    // Store the webhook event (adjust column names if your table differs)
    const record = {
      source: 'authorize_net',
      received_at: new Date().toISOString(),
      headers,
      payload,
      raw_body: rawBody
    };

    const { data, error } = await supabase
      .from(WEBHOOK_TABLE)
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
      id: data?.id ?? null
    });
  } catch (err) {
    console.error('[Webhook handler error]', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Unhandled error]', err);
  res.status(500).json({ ok: false, error: 'unhandled_error' });
});

app.listen(PORT, () => {
  console.log(`HVT backend listening on port ${PORT}`);
});
