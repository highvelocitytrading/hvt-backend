// routes/payment.js
// Payment processing endpoint for native site checkout forms.
// Receives Accept.js opaque payment tokens and creates Authorize.net charges/subscriptions.

'use strict';

const express = require('express');
const router  = express.Router();

const { chargeCard, createSubscription } = require('../services/authnet');
const { rateLimit } = require('../middleware/rateLimiter');
const { AUTHNET_API_LOGIN_ID, AUTHNET_CLIENT_KEY } = require('../config/constants');
const { upsertLicense } = require('../services/supabase');
const { nowISO } = require('../helpers/utils');
const AUTHNET_ENV = process.env.AUTHNET_ENV === 'sandbox' ? 'sandbox' : 'production';

// Tight rate limit — max 5 payment attempts per IP per minute
const payLimit = rateLimit({ windowMs: 60000, max: 5 });

// ─── GET /api/payment/config ──────────────────────────────────────────────────
// Returns the public Authorize.net credentials needed by Accept.js on the frontend.
// These are NOT secrets — the client key is designed to be embedded in the browser.
router.get('/api/payment/config', (req, res) => {
    if (!AUTHNET_API_LOGIN_ID || !AUTHNET_CLIENT_KEY) {
        return res.status(503).json({ ok: false, error: 'Payment not configured.' });
    }
    res.json({ ok: true, apiLoginID: AUTHNET_API_LOGIN_ID, clientKey: AUTHNET_CLIENT_KEY, env: AUTHNET_ENV });
});

// ─── PLAN CONFIG ─────────────────────────────────────────────────────────────
const PLANS = {
    monthly:  { type: 'subscription', amount: '497.00', intervalMonths: 1, planName: 'HVT Monthly — $497/mo'  },
    lifetime: { type: 'charge',       amount: '2497.00'                                                        },
    discord:  { type: 'subscription', amount: '37.00',  intervalMonths: 1, planName: 'HVT Discord — $37/mo'   },
    echo:     { type: 'charge',       amount: '97.00'                                                          },
};

// ─── POST /api/payment/charge ─────────────────────────────────────────────────
// Body: { plan, email, full_name, opaqueDataDescriptor, opaqueDataValue }
// Returns: { ok: true, transaction_id? } or { ok: true, subscription_id? }
router.post('/api/payment/charge', payLimit, express.json({ limit: '64kb' }), async (req, res) => {
    const {
        plan,
        email,
        full_name,
        opaqueDataDescriptor,
        opaqueDataValue,
    } = req.body || {};

    // ── Input validation ────────────────────────────────────────────────────
    if (!plan || !PLANS[plan]) {
        return res.status(400).json({ ok: false, error: 'Invalid plan.' });
    }
    const emailClean = (email || '').toLowerCase().trim();
    if (!emailClean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
        return res.status(400).json({ ok: false, error: 'Valid email is required.' });
    }
    if (!opaqueDataDescriptor || !opaqueDataValue) {
        return res.status(400).json({ ok: false, error: 'Payment token is missing.' });
    }

    const config = PLANS[plan];

    try {
        if (config.type === 'charge') {
            const { transactionId } = await chargeCard({
                opaqueDataDescriptor,
                opaqueDataValue,
                amount:   config.amount,
                email:    emailClean,
                fullName: full_name || '',
            });
            // Pre-seed the license record as authorize_received so /api/submit/license
            // activates immediately without waiting for an Authorize.net webhook.
            try {
                await upsertLicense(transactionId, {
                    authorize_received:    true,
                    authorize_event_type:  'net.authorize.payment.authcapture.created',
                    last_source:           'charge',
                    updated_at:            nowISO(),
                });
            } catch (e) {
                console.error('[PaymentCharge] License pre-seed error:', e.message);
            }
            console.log(`✅ Payment charged (${plan}): ${emailClean} | txId=${transactionId}`);
            return res.json({ ok: true, transaction_id: transactionId });
        }

        if (config.type === 'subscription') {
            const { subscriptionId } = await createSubscription({
                opaqueDataDescriptor,
                opaqueDataValue,
                amount:         config.amount,
                intervalMonths: config.intervalMonths,
                planName:       config.planName,
                email:          emailClean,
                fullName:       full_name || '',
            });
            console.log(`✅ Subscription created (${plan}): ${emailClean} | subId=${subscriptionId}`);
            return res.json({ ok: true, subscription_id: subscriptionId });
        }

    } catch (e) {
        console.error(`[PaymentCharge][${plan}]`, e.message);
        // Return the Authorize.net error message directly so the frontend can display it
        return res.status(402).json({ ok: false, error: e.message });
    }
});

module.exports = router;
