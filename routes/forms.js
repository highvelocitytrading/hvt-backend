// routes/forms.js
// Direct form submission endpoints replacing all JotForm webhooks.
// These are called from the website's own forms via JSON POST.

'use strict';

const express = require('express');
const router  = express.Router();

const {
    MEMBERSHIP_TABLE, DISCORD_TABLE, ECHO_TABLE
} = require('../config/constants');
const { nowISO, now30days, genEchoKey } = require('../helpers/utils');
const { supabase, upsertLicense }       = require('../services/supabase');
const { ntCreateLicense }               = require('../services/ninjatrader');
const { sendWelcome, sendDiscordWelcome, sendEchoWelcome } = require('../services/email');
const { frm } = require('../middleware/rateLimiter');

// ─── INPUT HELPERS ────────────────────────────────────────────────────────────
function parseEmail(raw) {
    const e = (raw || '').toLowerCase().trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

function parseFields(body) {
    return {
        email:          parseEmail(body?.email),
        full_name:      (body?.full_name  || '').trim().slice(0, 100) || null,
        phone:          (body?.phone      || '').trim().slice(0, 30)  || null,
        transaction_id: (body?.transaction_id || '').trim().slice(0, 64) || null,
    };
}

// ─── MEMBERSHIP FORM ─────────────────────────────────────────────────────────
// POST /api/submit/membership
// Body: { email, full_name, phone }
router.post('/api/submit/membership', frm, express.json(), async (req, res) => {
    const d = parseFields(req.body);
    if (!d.email) return res.status(400).json({ ok: false, error: 'valid_email_required' });

    try {
        await supabase.from(MEMBERSHIP_TABLE).upsert({
            email:      d.email,
            full_name:  d.full_name,
            phone:      d.phone,
            plan_name:  'membership',
            status:     'active',
            source:     'site_form',
            expires_at: now30days(),
            updated_at: nowISO(),
        }, { onConflict: 'email' });

        try { await ntCreateLicense(d.email, 'monthly'); } catch (e) { console.error('[NT monthly form]', e.message); }
        try { await sendWelcome(d.email, d.full_name, 'monthly'); } catch (e) { console.error('[Welcome email form]', e.message); }

        console.log(`✅ Membership (form): ${d.email}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('[MemberForm]', e.message);
        res.status(500).json({ ok: false, error: 'server_error' });
    }
});

// ─── DISCORD FORM ─────────────────────────────────────────────────────────────
// POST /api/submit/discord
// Body: { email, full_name, phone }
router.post('/api/submit/discord', frm, express.json(), async (req, res) => {
    const d = parseFields(req.body);
    if (!d.email) return res.status(400).json({ ok: false, error: 'valid_email_required' });

    try {
        await supabase.from(DISCORD_TABLE).upsert({
            email:      d.email,
            full_name:  d.full_name,
            phone:      d.phone,
            plan_name:  'discord_monthly',
            status:     'active',
            source:     'site_form',
            expires_at: now30days(),
            updated_at: nowISO(),
        }, { onConflict: 'email' });

        try { await sendDiscordWelcome(d.email, d.full_name); } catch (e) { console.error('[Discord welcome form]', e.message); }

        console.log(`✅ Discord member (form): ${d.email}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('[DiscordForm]', e.message);
        res.status(500).json({ ok: false, error: 'server_error' });
    }
});

// ─── LIFETIME LICENSE FORM ────────────────────────────────────────────────────
// POST /api/submit/license
// Body: { email, full_name, phone, transaction_id }
// transaction_id comes from the Authorize.net payment response shown to the user.
router.post('/api/submit/license', frm, express.json(), async (req, res) => {
    const d = parseFields(req.body);
    if (!d.email)          return res.status(400).json({ ok: false, error: 'valid_email_required' });
    if (!d.transaction_id) return res.status(400).json({ ok: false, error: 'transaction_id_required' });

    try {
        const row = await upsertLicense(d.transaction_id, {
            jotform_received: true,
            last_source:      'site_form',
            email:            d.email,
            full_name:        d.full_name,
            phone:            d.phone,
            status:           'pending_authorize',
        });

        if (row.authorize_received) {
            const act = await upsertLicense(d.transaction_id, {
                jotform_received: true,
                email:            d.email    || row.email,
                full_name:        d.full_name || row.full_name,
                phone:            d.phone     || row.phone,
                status:           'active',
            });
            try { await sendWelcome(act.email, act.full_name, 'lifetime'); } catch (e) { console.error('[LicenseEmail form]', e.message); }
            console.log(`✅ License activated (form): ${act.email} | ${act.license_key}`);
            return res.json({ ok: true, transaction_id: d.transaction_id, license_key: act.license_key, status: act.status });
        }

        res.json({ ok: true, transaction_id: d.transaction_id, license_key: row.license_key, status: row.status });
    } catch (e) {
        console.error('[LicenseForm]', e.message);
        res.status(500).json({ ok: false, error: 'server_error' });
    }
});

// ─── ECHO FORM ────────────────────────────────────────────────────────────────
// POST /api/submit/echo
// Body: { email, full_name, transaction_id }
router.post('/api/submit/echo', frm, express.json(), async (req, res) => {
    const d = parseFields(req.body);
    if (!d.email) return res.status(400).json({ ok: false, error: 'valid_email_required' });

    try {
        const { data: existing } = await supabase
            .from(ECHO_TABLE)
            .select('id, license_key, status')
            .eq('email', d.email)
            .maybeSingle();

        let licenseKey;
        if (existing && existing.status === 'active') {
            licenseKey = existing.license_key;
            console.log(`[EchoForm] Existing license for ${d.email} — resending welcome`);
        } else {
            licenseKey = genEchoKey();
            const { error } = await supabase.from(ECHO_TABLE).upsert({
                email:          d.email,
                full_name:      d.full_name,
                license_key:    licenseKey,
                status:         'active',
                transaction_id: d.transaction_id || null,
                machine_id:     null,
                purchase_date:  nowISO(),
                updated_at:     nowISO(),
            }, { onConflict: 'email' }).select().single();

            if (error) {
                console.error('[EchoForm] DB error:', error.message);
                return res.status(500).json({ ok: false, error: 'db_error' });
            }
            console.log(`[EchoForm] ✅ Echo license created: ${d.email} | ${licenseKey}`);
        }

        try { await sendEchoWelcome(d.email, d.full_name, licenseKey); } catch (e) { console.error('[EchoForm] Email error:', e.message); }
        res.json({ ok: true, license_key: licenseKey });
    } catch (e) {
        console.error('[EchoForm]', e.message);
        res.status(500).json({ ok: false, error: 'server_error' });
    }
});

module.exports = router;
