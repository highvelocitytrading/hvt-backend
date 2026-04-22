// routes/webhooks.js
// Authorize.net payment webhook endpoints.
// These are called by Authorize.net when subscription payments are created or cancelled.

'use strict';

const express = require('express');
const router  = express.Router();

const {
    MEMBERSHIP_TABLE, DISCORD_TABLE, ECHO_TABLE,
    DISCORD_MONTHLY_ROLE_ID, DISCORD_ROOM_ROLE_ID
} = require('../config/constants');
const { pickFirst, verifyAuthnetSig, now30days, nowISO, genEchoKey } = require('../helpers/utils');
const { supabase, upsertLicense }            = require('../services/supabase');
const { ntCreateLicense }                    = require('../services/ninjatrader');
const { addRole }                            = require('../services/discord');
const { sendWelcome, sendDiscordWelcome, sendCancelConfirmEmail, sendEchoWelcome } = require('../services/email');

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
        const row = await upsertLicense(txId, { authorize_received: true, last_source: 'authorize', authorize_event_type: eType, raw_authorize: rawBody, authorize_body_json: body, status: 'pending_form' });
        if (row.email && row.full_name) {
            const act = await upsertLicense(txId, { authorize_received: true, last_source: 'authorize', status: 'active' });
            console.log(`✅ License (AN): ${act.email}`);
            return;
        }
        console.log(`[AuthNet] Stored pending: ${txId} status=${row.status}`);
    } catch (e) { console.error('[LicenseAN]', e); }
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
