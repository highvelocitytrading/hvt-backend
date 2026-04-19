// routes/webhooks.js
// All incoming webhook endpoints: Jotform, Authorize.net, and Echo variants.
// These are called by external services when payments or form submissions occur.

'use strict';

const express = require('express');
const Busboy  = require('busboy');
const router  = express.Router();

const {
    MEMBERSHIP_TABLE, LICENSE_TABLE, DISCORD_TABLE, ECHO_TABLE,
    DISCORD_MONTHLY_ROLE_ID, DISCORD_ROOM_ROLE_ID, DISCORD_INVITE_URL
} = require('../config/constants');
const { pickFirst, huntData, verifyJF, verifyAuthnetSig, now30days, nowISO, genEchoKey } = require('../helpers/utils');
const { supabase, upsertLicense }            = require('../services/supabase');
const { ntCreateLicense }                    = require('../services/ninjatrader');
const { addRole }                            = require('../services/discord');
const { sendWelcome, sendDiscordWelcome, sendCancelConfirmEmail, sendEchoWelcome } = require('../services/email');

// ─── MEMBERSHIP: JOTFORM ─────────────────────────────────────────────────────
router.post('/membership-jotform', (req, res) => {
    if (!verifyJF(req)) return res.status(401).send('Unauthorized');
    const bb = Busboy({ headers: req.headers });
    let raw = '';
    bb.on('field', (n, v) => { raw += `\n[${n}]=${v}`; });
    bb.on('finish', async () => {
        try {
            const { email, full_name, phone } = huntData(raw);
            if (!email) return res.status(400).send('No email');
            await supabase.from(MEMBERSHIP_TABLE).upsert({ email, full_name, phone, plan_name: 'membership', status: 'active', source: 'jotform', expires_at: now30days(), updated_at: nowISO() }, { onConflict: 'email' });
            try { await ntCreateLicense(email, 'monthly'); } catch (e) { console.error('[NT monthly JF]', e.message); }
            try { await sendWelcome(email, full_name, 'monthly'); } catch (e) { console.error('[Welcome email]', e.message); }
            console.log(`✅ Membership (JF): ${email}`);
            res.status(200).send('OK');
        } catch (e) { console.error('[MemberJF]', e.message); res.status(500).send('Error'); }
    });
    req.pipe(bb);
});

// ─── MEMBERSHIP: AUTHORIZE.NET ────────────────────────────────────────────────
router.post('/membership-authnet', express.json(), async (req, res) => {
    res.status(200).send('OK');
    try {
        const { eventType = '', payload = {} } = req.body || {};
        const email = (payload?.customerDetails?.email || '').toLowerCase().trim();
        const subId = pickFirst(payload?.id);
        const CANCEL_EVENTS = ['net.authorize.customer.subscription.cancelled','net.authorize.customer.subscription.expired','net.authorize.customer.subscription.suspended','net.authorize.customer.subscription.terminated','net.authorize.customer.subscription.failed'];

        if (eventType === 'net.authorize.customer.subscription.created' || eventType === 'net.authorize.payment.capture.created') {
            if (!email) { console.warn('[MemberAN] No email in payload'); return; }
            const row = { email, plan_name: 'membership', status: 'active', source: 'authnet', expires_at: now30days(), updated_at: nowISO() };
            if (subId) row.authnet_subscription_id = subId;
            const { data: existing } = await supabase.from(MEMBERSHIP_TABLE).select('nt_license_id,discord_user_id').eq('email', email).maybeSingle();
            await supabase.from(MEMBERSHIP_TABLE).upsert(row, { onConflict: 'email' });
            if (!existing?.nt_license_id) {
                try {
                    const ntId = await ntCreateLicense(email, 'monthly');
                    if (ntId) await supabase.from(MEMBERSHIP_TABLE).update({ nt_license_id: ntId, updated_at: nowISO() }).eq('email', email);
                } catch (e) { console.error('[NT monthly AN]', e.message); }
            }
            if (existing?.discord_user_id) {
                try { await addRole(existing.discord_user_id, DISCORD_MONTHLY_ROLE_ID); } catch (e) { console.error('[MemberAN re-add role]', e.message); }
            }
            console.log(`✅ Membership (AN): ${email} (renewal=${!!existing})`);
        } else if (CANCEL_EVENTS.includes(eventType)) {
            const lookupKey = subId ? 'authnet_subscription_id' : 'email';
            const lookupVal = subId || email;
            if (!lookupVal) { console.warn('[MemberAN] No subId or email for cancel event'); return; }
            const { data: m } = await supabase.from(MEMBERSHIP_TABLE).select('discord_user_id,nt_license_id,email').eq(lookupKey, lookupVal).maybeSingle();
            const anCancelsAt = m?.expires_at || nowISO();
            await supabase.from(MEMBERSHIP_TABLE).update({ status: 'pending_cancel', cancels_at: anCancelsAt, updated_at: nowISO() }).eq(lookupKey, lookupVal);
            const cancelledEmail = m?.email || email;
            if (cancelledEmail) try { await sendCancelConfirmEmail(cancelledEmail, anCancelsAt); } catch(e) { console.error('[MemberAN cancel email]', e.message); }
            console.log('[MemberAN] Pending cancel: ' + (cancelledEmail || subId) + ' — access until ' + anCancelsAt);
        }
    } catch (e) { console.error('[MemberAN]', e.message); }
});

// ─── DISCORD $37: JOTFORM ─────────────────────────────────────────────────────
router.post('/discord-jotform', (req, res) => {
    if (!verifyJF(req)) return res.status(401).send('Unauthorized');
    const bb = Busboy({ headers: req.headers });
    let raw = '';
    bb.on('field', (n, v) => { raw += `\n[${n}]=${v}`; });
    bb.on('finish', async () => {
        try {
            const { email, full_name, phone } = huntData(raw);
            if (!email) return res.status(400).send('No email');
            await supabase.from(DISCORD_TABLE).upsert({ email, full_name, phone, plan_name: 'discord_monthly', status: 'active', source: 'jotform', expires_at: now30days(), updated_at: nowISO() }, { onConflict: 'email' });
            try { await sendDiscordWelcome(email, full_name); } catch (e) { console.error('[Discord welcome email]', e.message); }
            console.log(`✅ Discord member (JF): ${email}`);
            res.status(200).send('OK');
        } catch (e) { console.error('[DiscordJF]', e.message); res.status(500).send('Error'); }
    });
    req.pipe(bb);
});

// ─── DISCORD $37: AUTHORIZE.NET ───────────────────────────────────────────────
router.post('/discord-authnet', express.json(), async (req, res) => {
    res.status(200).send('OK');
    try {
        const { eventType = '', payload = {} } = req.body || {};
        const email = (payload?.customerDetails?.email || '').toLowerCase().trim();
        const subId = pickFirst(payload?.id);
        const CANCEL_EVENTS = ['net.authorize.customer.subscription.cancelled','net.authorize.customer.subscription.expired','net.authorize.customer.subscription.suspended','net.authorize.customer.subscription.terminated','net.authorize.customer.subscription.failed'];

        if (eventType === 'net.authorize.customer.subscription.created' || eventType === 'net.authorize.payment.capture.created') {
            if (!email) { console.warn('[DiscordAN] No email in payload'); return; }
            const { data: existing } = await supabase.from(DISCORD_TABLE).select('discord_user_id').eq('email', email).maybeSingle();
            const row = { email, plan_name: 'discord_monthly', status: 'active', source: 'authnet', expires_at: now30days(), updated_at: nowISO() };
            if (subId) row.authnet_subscription_id = subId;
            await supabase.from(DISCORD_TABLE).upsert(row, { onConflict: 'email' });
            if (existing?.discord_user_id) {
                const rid = DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID;
                try { await addRole(existing.discord_user_id, rid); } catch (e) { console.error('[DiscordAN re-add role]', e.message); }
            }
            console.log(`✅ Discord member renewed (AN): ${email} (existing=${!!existing?.discord_user_id})`);
        } else if (CANCEL_EVENTS.includes(eventType)) {
            const lookupKey = subId ? 'authnet_subscription_id' : 'email';
            const lookupVal = subId || email;
            if (!lookupVal) { console.warn('[DiscordAN] No subId or email for cancel event'); return; }
            const { data: dm } = await supabase.from(DISCORD_TABLE).select('discord_user_id,email,expires_at').eq(lookupKey, lookupVal).maybeSingle();
            const discCancelsAt = dm?.expires_at || nowISO();
            await supabase.from(DISCORD_TABLE).update({ status: 'pending_cancel', cancels_at: discCancelsAt, updated_at: nowISO() }).eq(lookupKey, lookupVal);
            const discEmail = dm?.email || email;
            if (discEmail) try { await sendCancelConfirmEmail(discEmail, discCancelsAt); } catch(e) { console.error('[DiscordAN cancel email]', e.message); }
            console.log('[DiscordAN] Pending cancel: ' + (discEmail || subId) + ' access until ' + discCancelsAt);
        }
    } catch (e) { console.error('[DiscordAN]', e.message); }
});

// ─── LIFETIME LICENSE: AUTHORIZE.NET ─────────────────────────────────────────
router.post('/authorize-net', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    res.status(200).json({ ok: true, received: true });
    try {
        const rawBody = req.body?.toString('utf8') || '';
        const sig     = verifyAuthnetSig(rawBody, req.headers['x-anet-signature']);
        if (!sig.ok) { console.warn('[AuthNet] Invalid signature:', sig.reason); return; }
        let body = {};
        try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
        const txId  = pickFirst(body?.payload?.id);
        const eType = pickFirst(body?.eventType) || 'authorize_net';
        if (!txId) { console.warn('[AuthNet] No transaction ID in payload'); return; }
        const row = await upsertLicense(txId, { authorize_received: true, last_source: 'authorize', authorize_event_type: eType, raw_authorize: rawBody, authorize_body_json: body, status: 'pending_jotform' });
        if (row.email && row.full_name) {
            const act = await upsertLicense(txId, { authorize_received: true, last_source: 'authorize', status: 'active' });
            console.log(`✅ License (AN): ${act.email}`);
            return;
        }
        console.log(`[AuthNet] Stored pending: ${txId} status=${row.status}`);
    } catch (e) { console.error('[LicenseAN]', e); }
});

// ─── LIFETIME LICENSE: JOTFORM ────────────────────────────────────────────────
router.post('/jotform', (req, res) => {
    if (!verifyJF(req)) return res.status(401).send('Unauthorized');
    const bb = Busboy({ headers: req.headers, limits: { fieldSize: 5 * 1024 * 1024 } });
    const fields = {}; let raw = '';
    bb.on('field', (n, v) => { fields[n] = v; raw += `\n[${n}]=${v}`; });
    bb.on('error', e => { console.error('[LicenseJF busboy]', e); res.status(400).json({ ok: false, error: 'invalid_multipart' }); });
    bb.on('finish', async () => {
        try {
            let rr = {}; try { rr = fields.rawRequest ? JSON.parse(fields.rawRequest) : {}; } catch {}
            const first = pickFirst(rr?.q8_q8_fullname6?.first);
            const last  = pickFirst(rr?.q8_q8_fullname6?.last);
            const email = pickFirst(rr?.q11_email);
            const txId  = pickFirst(rr?.transactionId);
            const fname = [first, last].filter(Boolean).join(' ') || null;
            let phone   = null;
            const pf    = Object.keys(rr).find(k => k.startsWith('q12'));
            if (pf && rr[pf]?.full) phone = rr[pf].full.trim();
            if (!txId) return res.status(400).json({ ok: false, error: 'missing_transaction_id' });
            const row = await upsertLicense(txId, { jotform_received: true, last_source: 'jotform', email: email || null, full_name: fname || null, phone: phone || null, raw_jotform: raw, jotform_body_json: rr, status: 'pending_authorize' });
            if (row.authorize_received) {
                const act = await upsertLicense(txId, { jotform_received: true, email: email || row.email, full_name: fname || row.full_name, phone: phone || row.phone, status: 'active' });
                try { await sendWelcome(act.email, act.full_name, 'lifetime'); } catch (e) { console.error('[LicenseEmail]', e.message); }
                console.log(`✅ License activated: ${act.email} | ${act.license_key}`);
                return res.json({ ok: true, transaction_id: txId, license_key: act.license_key, status: act.status });
            }
            res.json({ ok: true, transaction_id: txId, license_key: row.license_key, status: row.status });
        } catch (e) { console.error('[LicenseJF]', e); res.status(500).json({ ok: false, error: 'server_error' }); }
    });
    req.pipe(bb);
});

// ─── ECHO: JOTFORM ───────────────────────────────────────────────────────────
router.post('/echo-jotform', (req, res) => {
    if (!verifyJF(req)) return res.status(401).send('Unauthorized');
    const bb = Busboy({ headers: req.headers, limits: { fieldSize: 5 * 1024 * 1024 } });
    const fields = {}; let raw = '';
    bb.on('field', (n, v) => { fields[n] = v; raw += `\n[${n}]=${v}`; });
    bb.on('error', e => { console.error('[EchoJF busboy]', e); res.status(400).send('Bad request'); });
    bb.on('finish', async () => {
        try {
            let rr = {}; try { rr = fields.rawRequest ? JSON.parse(fields.rawRequest) : {}; } catch {}
            const { email, full_name } = huntData(raw);
            const submissionId = fields.submissionID || fields.submission_id || null;
            const txId = pickFirst(rr?.transactionId) || pickFirst(rr?.transaction_id) || null;
            if (!email) { console.error('[EchoJF] No email in submission'); return res.status(400).send('No email'); }
            const { data: existing } = await supabase.from(ECHO_TABLE).select('id, license_key, status').eq('email', email.toLowerCase().trim()).maybeSingle();
            let licenseKey;
            if (existing && existing.status === 'active') {
                licenseKey = existing.license_key;
                console.log(`[EchoJF] Existing license found for ${email} — resending welcome`);
            } else {
                licenseKey = genEchoKey();
                const { data: newRecord, error: insertErr } = await supabase.from(ECHO_TABLE).upsert({
                    email: email.toLowerCase().trim(), full_name: full_name || null, license_key: licenseKey,
                    status: 'active', jotform_submission_id: submissionId, transaction_id: txId,
                    machine_id: null, purchase_date: nowISO(), updated_at: nowISO()
                }, { onConflict: 'email' }).select().single();
                if (insertErr) { console.error('[EchoJF] DB error:', insertErr.message); return res.status(500).send('DB error'); }
                console.log(`[EchoJF] ✅ New Echo license created: ${email} | ${licenseKey}`);
            }
            try { await sendEchoWelcome(email, full_name, licenseKey); } catch (e) { console.error('[EchoJF] Email error:', e.message); }
            res.status(200).send('OK');
        } catch (e) { console.error('[EchoJF] Fatal error:', e.message); res.status(500).send('Error'); }
    });
    req.pipe(bb);
});

// ─── ECHO: AUTHORIZE.NET ──────────────────────────────────────────────────────
router.post('/echo-authnet', express.json(), async (req, res) => {
    res.status(200).send('OK');
    try {
        const { eventType = '', payload = {} } = req.body || {};
        const email = (payload?.customerDetails?.email || '').toLowerCase().trim();
        const subId = pickFirst(payload?.id);
        const CANCEL_EVENTS = ['net.authorize.customer.subscription.cancelled','net.authorize.customer.subscription.expired','net.authorize.customer.subscription.suspended','net.authorize.customer.subscription.terminated','net.authorize.customer.subscription.failed'];
        if (eventType === 'net.authorize.customer.subscription.created' || eventType === 'net.authorize.payment.capture.created') {
            if (!email) { console.warn('[EchoAN] No email in payload'); return; }
            const { data: existing } = await supabase.from(ECHO_TABLE).select('id, license_key, status').eq('email', email).maybeSingle();
            if (existing && existing.status === 'active') { console.log(`[EchoAN] Already active for ${email} — skipping`); return; }
            const licenseKey = genEchoKey();
            const { error } = await supabase.from(ECHO_TABLE).upsert({
                email, license_key: licenseKey, status: 'active', transaction_id: subId,
                machine_id: null, purchase_date: nowISO(), updated_at: nowISO()
            }, { onConflict: 'email' }).select().single();
            if (error) { console.error('[EchoAN] DB error:', error.message); return; }
            try { await sendEchoWelcome(email, null, licenseKey); } catch (e) { console.error('[EchoAN] Email error:', e.message); }
            console.log(`[EchoAN] ✅ Echo license created: ${email} | ${licenseKey}`);
        } else if (CANCEL_EVENTS.includes(eventType)) {
            if (!email && !subId) { console.warn('[EchoAN] No identifier for cancel'); return; }
            const lookupKey = subId ? 'transaction_id' : 'email';
            const lookupVal = subId || email;
            await supabase.from(ECHO_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq(lookupKey, lookupVal);
            console.log(`[EchoAN] Echo license cancelled: ${lookupVal}`);
        }
    } catch (e) { console.error('[EchoAN] Error:', e.message); }
});

module.exports = router;
