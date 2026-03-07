'use strict';

require('dotenv').config();

const express = require('express');
const crypto  = require('crypto');
const Busboy  = require('busboy');
const { createClient } = require('@supabase/supabase-js');

const fetchFn = global.fetch
  ? global.fetch.bind(global)
  : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 8155;

const path = require('path');
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    etag: true,
    index: false
}));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options',  'nosniff');
    res.setHeader('X-Frame-Options',          'DENY');
    res.setHeader('X-XSS-Protection',         '1; mode=block');
    res.setHeader('Referrer-Policy',          'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy',       'geolocation=(), microphone=(), camera=()');
    res.removeHeader('X-Powered-By');
    next();
});

const _rl = new Map();
function rateLimit({ windowMs = 60000, max = 20 } = {}) {
    return (req, res, next) => {
        const key = `${req.ip}:${req.path}`;
        const now = Date.now();
        const r   = _rl.get(key);
        if (!r || now > r.resetAt) { _rl.set(key, { count: 1, resetAt: now + windowMs }); return next(); }
        if (++r.count > max) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        next();
    };
}
setInterval(() => { const n = Date.now(); for (const [k, r] of _rl) if (n > r.resetAt) _rl.delete(k); }, 300000);

const wh  = rateLimit({ max: 50 });
const frm = rateLimit({ max: 10 });
const adm = rateLimit({ max: 30 });

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTHORIZE_SIGNATURE_KEY   = process.env.AUTHORIZE_SIGNATURE_KEY || null;
const AUTHNET_API_LOGIN_ID      = process.env.AUTHNET_API_LOGIN_ID;
const AUTHNET_TRANSACTION_KEY   = process.env.AUTHNET_TRANSACTION_KEY;
const RESEND_API_KEY            = process.env.RESEND_API_KEY;
const FROM_EMAIL                = process.env.FROM_EMAIL || 'support@support.highvelocitytrading.com';
const APP_URL                   = process.env.APP_URL    || 'https://hvt-backend-production-ec41.up.railway.app';
const JOTFORM_SECRET            = process.env.JOTFORM_SECRET || null;
const ADMIN_SECRET              = process.env.ADMIN_SECRET   || 'HVT-ADMIN-FADBC551B512718D76F4B8744E54B621';

const DISCORD_BOT_TOKEN        = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID         = process.env.DISCORD_GUILD_ID         || '1460694720090083483';
const DISCORD_MONTHLY_ROLE_ID  = process.env.DISCORD_MONTHLY_ROLE_ID  || '1476634274424819897';
const DISCORD_LIFETIME_ROLE_ID = process.env.DISCORD_LIFETIME_ROLE_ID || '1476634362811384001';
const DISCORD_ROOM_ROLE_ID     = process.env.DISCORD_ROOM_ROLE_ID     || '';

const MEMBERSHIP_TABLE = process.env.SUPABASE_TABLE || 'membershipstab';
const LICENSE_TABLE    = 'license_keys';
const DISCORD_TABLE    = 'discord_members';

const NT_PRODUCT_ID = process.env.NT_PRODUCT_ID || '1196';
const NT_USERNAME   = process.env.NT_USERNAME   || '';
const NT_PASSWORD   = process.env.NT_PASSWORD   || '';
let   ntToken       = null;
let   ntAuthFails   = 0;

function ntScramblePassword(name, password) {
    const n = name.length % password.toString().length;
    const rotated = password.toString().slice(n) + password.toString().slice(0, n);
    const reversed = rotated.split('').reverse().join('');
    return Buffer.from(reversed).toString('base64');
}

function ntBuildPayload(name, password) {
    const scrambled = ntScramblePassword(name, password);
    const chl = `${Date.now() - 1581e9}`;
    const deviceId = 'hvt-backend-railway';
    const appId = 'arena';
    const hmac = crypto.createHmac('sha256', '035a1259-11e7-485a-aeae-9b6016579351');
    const data = [chl, deviceId, name, password, appId].join('');
    hmac.update(data);
    const sec = hmac.digest('hex');
    return { name, password: scrambled, enc: true, environment: 'live', appId, appVersion: '0.1.0', cid: '1', chl, deviceId, sec };
}

async function ntLogin() {
    if (!NT_USERNAME || !NT_PASSWORD) {
        console.warn('[NT] NT_USERNAME / NT_PASSWORD not set');
        return false;
    }
    try {
        console.log('[NT] Logging in...');
        const payload = ntBuildPayload(NT_USERNAME, NT_PASSWORD);
        const r = await fetchFn('https://live.tradovateapi.com/v1/auth/accesstokenrequest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const d = await r.json();
        if (d?.accessToken) {
            ntToken = d.accessToken;
            ntAuthFails = 0;
            console.log(`[NT] ✅ Logged in successfully — expires ${d.expirationTime}`);
            return true;
        }
        console.error('[NT] Login failed:', JSON.stringify(d));
        ntAuthFails++;
        return false;
    } catch (e) {
        console.error('[NT] Login error:', e.message);
        ntAuthFails++;
        return false;
    }
}

async function ntRenewToken() {
    if (ntToken) {
        try {
            const r = await fetchFn('https://live.tradovateapi.com/v1/auth/renewaccesstoken', {
                method: 'POST',
                headers: { Authorization: `Bearer ${ntToken}`, 'Content-Type': 'application/json' }
            });
            const d = await r.json();
            if (d?.accessToken) {
                ntToken = d.accessToken;
                ntAuthFails = 0;
                console.log(`[NT] ✅ Token renewed — expires ${d.expirationTime}`);
                return true;
            }
            console.warn('[NT] Renewal failed — re-logging in');
        } catch (e) {
            console.warn('[NT] Renewal error — re-logging in:', e.message);
        }
    }
    return ntLogin();
}

setTimeout(ntLogin, 3000);
setInterval(ntRenewToken, 45 * 60 * 1000);

async function ntCreateLicense(email, type) {
    if (!ntToken) { console.warn('[NT] No token — skipping license creation'); return null; }
    try {
        const expiry = new Date();
        if (type === 'lifetime') {
            expiry.setFullYear(expiry.getFullYear() + 99);
        } else {
            expiry.setDate(expiry.getDate() + 31);
        }
        const r = await fetchFn(`https://ecosystemapi.ninjatrader.com/v1/products/${NT_PRODUCT_ID}/licenses`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${ntToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                license: {
                    email,
                    licenseType: type === 'lifetime' ? 'Lifetime' : 'OneMonth',
                    expirationDateUTC: expiry.toISOString()
                }
            })
        });
        const d = await r.json();
        console.log(`[NT] License API response for ${email}:`, JSON.stringify(d));
        if (d?.errorText && d.errorText !== '') {
            console.error(`[NT] License creation failed for ${email}:`, JSON.stringify(d));
            return null;
        }
        if (!d?.result) {
            console.error(`[NT] License creation no result for ${email}:`, JSON.stringify(d));
            return null;
        }
        console.log(`[NT] ✅ License created for ${email} | type=${type} | nt_id=${d.result}`);
        return d.result;
    } catch (e) {
        console.error(`[NT] License creation error for ${email}:`, e.message);
        return null;
    }
}

async function ntRevokeLicense(ntLicenseId) {
    if (!ntToken || !ntLicenseId) return;
    try {
        const r = await fetchFn(`https://ecosystemapi.ninjatrader.com/v1/products/${NT_PRODUCT_ID}/licenses/${ntLicenseId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${ntToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ license: { expirationDateUTC: new Date().toISOString() } })
        });
        const d = await r.json();
        console.log(`[NT] License ${ntLicenseId} revoked:`, JSON.stringify(d));
    } catch (e) { console.error('[NT] Revoke error:', e.message); }
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('[FATAL] Missing Supabase env'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
console.log(`[INIT] ${MEMBERSHIP_TABLE} | ${LICENSE_TABLE} | ${DISCORD_TABLE}`);

function pickFirst(...v) { for (const x of v) { if (typeof x === 'string' && x.trim()) return x.trim(); if (typeof x === 'number') return String(x); } return null; }
function genKey()        { return `HVT-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function now30days()     { return new Date(Date.now() + 30 * 86400000).toISOString(); }
function nowISO()        { return new Date().toISOString(); }

function verifyAuthnetSig(rawBody, hdr) {
    if (!AUTHORIZE_SIGNATURE_KEY) return { ok: true };
    if (!hdr) return { ok: false, reason: 'missing_header' };
    const provided = hdr.startsWith('sha512=') ? hdr.slice(7) : hdr;
    try {
        const computed = crypto.createHmac('sha512', AUTHORIZE_SIGNATURE_KEY).update(rawBody || '', 'utf8').digest('hex');
        const a = Buffer.from(provided, 'hex'), b = Buffer.from(computed, 'hex');
        if (a.length !== b.length) return { ok: false, reason: 'len_mismatch' };
        return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
    } catch { return { ok: false, reason: 'format_error' }; }
}
function verifyJF(req) {
    if (!JOTFORM_SECRET) return true;
    return (req.query.secret || req.headers['x-jotform-secret']) === JOTFORM_SECRET;
}

async function dc(method, path, body) {
    const r = await fetchFn(`https://discord.com/api/v10${path}`, {
        method,
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 204) return null;
    const d = await r.json();
    if (!r.ok) throw new Error(`Discord ${r.status}: ${JSON.stringify(d)}`);
    return d;
}
async function findUser(username) {
    try {
        const list = await dc('GET', `/guilds/${DISCORD_GUILD_ID}/members/search?query=${encodeURIComponent(username)}&limit=5`);
        if (!list?.length) return null;
        return list.find(m => m.user.username.toLowerCase() === username.toLowerCase() || m.nick?.toLowerCase() === username.toLowerCase()) || list[0];
    } catch (e) { console.error('[DC findUser]', e.message); return null; }
}
async function addRole(uid, rid)    { await dc('PUT',    `/guilds/${DISCORD_GUILD_ID}/members/${uid}/roles/${rid}`); }
async function stripRole(uid, rid)  { await dc('DELETE', `/guilds/${DISCORD_GUILD_ID}/members/${uid}/roles/${rid}`); }
async function getGuildAll() {
    try { return await dc('GET', `/guilds/${DISCORD_GUILD_ID}/members?limit=1000`) || []; }
    catch (e) { console.error('[DC getGuild]', e.message); return []; }
}

const SESSION_COOKIE = 'hvt_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const _sessions = new Map();
setInterval(() => { const n = Date.now(); for (const [k, s] of _sessions) if (n > s.expires) _sessions.delete(k); }, 3600000);

function createSession(email, name, plan) {
    const token = crypto.randomBytes(32).toString('hex');
    _sessions.set(token, { email, name, plan, expires: Date.now() + SESSION_TTL_MS });
    return token;
}
function getSession(req) {
    const raw = req.headers.cookie || '';
    const match = raw.match(new RegExp(`${SESSION_COOKIE}=([a-f0-9]{64})`));
    if (!match) return null;
    const s = _sessions.get(match[1]);
    if (!s || Date.now() > s.expires) return null;
    return s;
}
function requireSession(req, res, next) {
    if (getSession(req)) return next();
    res.redirect('/login');
}

app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect('/login');
});

async function sendEmail(to, subject, html) {
    if (!RESEND_API_KEY) { console.warn('[Email] RESEND_API_KEY not set'); return null; }
    try {
        const r = await fetchFn('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
            body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(`Resend: ${JSON.stringify(d)}`);
        return d;
    } catch (e) {
        console.error('[Email]', e.message);
        return null;
    }
}

function wrap(content) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000000;font-family:'DM Sans',Arial,sans-serif;">
<div style="max-width:600px;margin:40px auto;padding:20px;">
  <div style="text-align:center;margin-bottom:32px;">
    <div style="display:inline-block;border-top:1px solid rgba(255,255,255,0.1);border-bottom:1px solid rgba(255,255,255,0.1);padding:12px 32px;">
      <span style="font-size:18px;font-weight:700;color:#fff;letter-spacing:3px;text-transform:uppercase;">HIGH VELOCITY TRADING</span><br>
      <span style="font-size:10px;color:#64748b;letter-spacing:4px;text-transform:uppercase;">Member Services</span>
    </div>
  </div>
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
    <div style="height:3px;background:linear-gradient(90deg,#2254F5,#2254F5,#2254F5);"></div>
    <div style="padding:36px 32px;">${content}</div>
  </div>
  <div style="text-align:center;margin-top:24px;color:#334155;font-size:11px;line-height:1.8;">
    &copy; 2026 High Velocity Trading. All rights reserved.<br>
    <a href="https://highvelocitytrading.com" style="color:#64748b;text-decoration:none;">highvelocitytrading.com</a>
  </div>
</div></body></html>`;
}

async function sendWelcome(email, fullName, type) {
    const name    = fullName?.split(' ')[0] || 'Trader';
    const monthly = type === 'monthly';
    const subject = monthly
        ? `Welcome to the Team, ${name} — Your HVT Membership is Active`
        : `Welcome to the Team, ${name} — Your HVT Lifetime Access is Active`;
    const html = wrap(`<p>Welcome email for ${type}</p>`);
    return sendEmail(email, subject, html);
}

async function sendDiscordWelcome(email, fullName) {
    return sendEmail(email, 'Your HVT Trading Room Access Is Ready', wrap(`<p>Discord welcome</p>`));
}

async function sendCourseEmail(email, token) {
    const url = `${APP_URL}/course/confirm?token=${token}`;
    const html = wrap(`<a href="${url}">ACCESS MEMBER PORTAL</a>`);
    return sendEmail(email, 'Access Your HVT Member Portal', html);
}

async function sendMagicLink(email, token, type) {
    const url = `${APP_URL}/${type}/confirm?token=${token}`;
    return sendEmail(email, 'Access Link', wrap(`<a href="${url}">Click here</a>`));
}

async function cancelSub(subId) {
    if (!AUTHNET_API_LOGIN_ID || !AUTHNET_TRANSACTION_KEY) {
        console.warn('[Authnet] Missing credentials');
        return null;
    }
    try {
        const r = await fetchFn('https://api.authorize.net/xml/v1/request.api', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ARBCancelSubscriptionRequest: { merchantAuthentication: { name: AUTHNET_API_LOGIN_ID, transactionKey: AUTHNET_TRANSACTION_KEY }, subscriptionId: String(subId) } })
        });
        const d = await r.json();
        if (d?.messages?.resultCode !== 'Ok') throw new Error(d?.messages?.message?.[0]?.text || 'Authnet cancel failed');
        return d;
    } catch (e) {
        console.error('[Authnet]', e.message);
        return null;
    }
}

function huntData(raw) {
    const email = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0]?.toLowerCase() || null;
    const fn    = (raw.match(/\[q3[^\]]*\]=([^\n]+)/) || raw.match(/"q3[^"]*":"([^"]+)"/))?.[1]?.trim() || '';
    const ln    = (raw.match(/\[q4[^\]]*\]=([^\n]+)/) || raw.match(/"q4[^"]*":"([^"]+)"/))?.[1]?.trim() || '';
    let phone   = null;
    const rr    = raw.match(/\[rawRequest\]=(\{.*\})/s);
    if (rr) { try { const o = JSON.parse(rr[1]); const pf = Object.keys(o).find(k => k.startsWith('q7')); if (pf && o[pf]?.full) phone = o[pf].full.trim(); } catch {} }
    return { email, full_name: [fn, ln].filter(Boolean).join(' ') || null, phone };
}

async function getByTxn(txId) {
    const { data, error } = await supabase.from(LICENSE_TABLE).select('*').eq('transaction_id', txId).maybeSingle();
    if (error) throw error; return data || null;
}
async function upsertLicense(txId, patch) {
    const ex  = await getByTxn(txId);
    const row = { transaction_id: txId, license_key: ex?.license_key || genKey(), updated_at: nowISO(), ...patch };
    const { data, error } = await supabase.from(LICENSE_TABLE).upsert(row, { onConflict: 'transaction_id' }).select().single();
    if (error) throw error; return data;
}

function shell(title, body, hero) {
    return `<!DOCTYPE html><html><body>${body}</body></html>`;
}

function resultPage(type, title, msg) {
    return shell(title, `<div>${title}: ${msg}</div>`);
}

app.get('/health', rateLimit({ max: 30 }), (req, res) => res.json({ ok: true, ts: nowISO(), nt_token: ntToken ? 'active' : 'not_authenticated', nt_auth_fails: ntAuthFails }));

app.post('/webhooks/membership-jotform', wh, (req, res) => {
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

app.post('/webhooks/membership-authnet', wh, express.json(), async (req, res) => {
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
            await supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq(lookupKey, lookupVal);
            if (m?.discord_user_id) try { await stripRole(m.discord_user_id, DISCORD_MONTHLY_ROLE_ID); } catch (e) { console.error('[MemberAN strip role]', e.message); }
            if (m?.nt_license_id)   try { await ntRevokeLicense(m.nt_license_id); } catch (e) { console.error('[MemberAN revoke NT]', e.message); }
            console.log(`🚫 Membership cancelled (AN): ${m?.email || email || subId}`);
        }
    } catch (e) { console.error('[MemberAN]', e.message); }
});

app.post('/webhooks/discord-jotform', wh, (req, res) => {
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

app.post('/webhooks/discord-authnet', wh, express.json(), async (req, res) => {
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
            const rid = DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID;
            const { data: dm } = await supabase.from(DISCORD_TABLE).select('discord_user_id,email').eq(lookupKey, lookupVal).maybeSingle();
            await supabase.from(DISCORD_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq(lookupKey, lookupVal);
            if (dm?.discord_user_id) try { await stripRole(dm.discord_user_id, rid); } catch (e) { console.error('[DiscordAN strip role]', e.message); }
            console.log(`🚫 Discord cancelled (AN): ${dm?.email || email || subId}`);
        }
    } catch (e) { console.error('[DiscordAN]', e.message); }
});

app.post('/webhooks/authorize-net', wh, express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
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

app.post('/webhooks/jotform', wh, (req, res) => {
    if (!verifyJF(req)) return res.status(401).send('Unauthorized');
    const bb = Busboy({ headers: req.headers, limits: { fieldSize: 5 * 1024 * 1024 } });
    const fields = {}; let raw = '';
    bb.on('field', (n, v) => { fields[n] = v; raw += `\n[${n}]=${v}`; });
    bb.on('error',  e => { console.error('[LicenseJF busboy]', e); res.status(400).json({ ok: false, error: 'invalid_multipart' }); });
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

app.get('/login', (req, res) => {
    if (getSession(req)) return res.redirect('/member');
    res.send('<h1>Login Page</h1><p>Enter email to get magic link</p>');
});

app.post('/course/request', frm, express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const { data: mem } = await supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).maybeSingle();
        const { data: lic } = await supabase.from(LICENSE_TABLE).select('status').eq('email', email).maybeSingle();
        const isMonthly  = mem?.status === 'active' && new Date(mem.expires_at) > new Date();
        const isLifetime = lic?.status === 'active';
        if (!isMonthly && !isLifetime) return res.status(403).json({ error: 'No active membership found.' });
        const token   = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 86400000).toISOString();
        if (isMonthly) await supabase.from(MEMBERSHIP_TABLE).update({ course_token: token, course_token_expires: expires, updated_at: nowISO() }).eq('email', email);
        else           await supabase.from(LICENSE_TABLE).update({ course_token: token, course_token_expires: expires, updated_at: nowISO() }).eq('email', email);
        await sendCourseEmail(email, token);
        res.json({ ok: true });
    } catch (e) { console.error('[CourseReq]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/course/confirm', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.send(resultPage('error', 'Invalid Link', 'This access link is invalid.'));
    try {
        const { data: mData } = await supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,expires_at,course_token_expires').eq('course_token', token).maybeSingle();
        const { data: lData } = await supabase.from(LICENSE_TABLE).select('email,full_name,status,course_token_expires').eq('course_token', token).maybeSingle();
        const rec = mData || lData;
        if (!rec) return res.send(resultPage('error', 'Invalid Link', 'Invalid or expired.'));
        if (!rec.course_token_expires || new Date(rec.course_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'Expired.'));
        const isMonthly  = mData?.status === 'active' && new Date(mData.expires_at) > new Date();
        const isLifetime = lData?.status === 'active';
        if (!isMonthly && !isLifetime) return res.send(resultPage('error', 'Access Revoked', 'No longer active.'));
        const name    = (rec.full_name || 'Trader').split(' ')[0];
        const plan    = isLifetime ? 'Lifetime Access' : 'Monthly Membership';
        const sessToken = createSession(rec.email, name, plan);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7*24*3600}`);
        return res.redirect('/member');
    } catch (e) { console.error('[CourseConfirm]', e.message); res.send(resultPage('error', 'Error', 'Error.')); }
});

app.get('/member', requireSession, (req, res) => {
    const s = getSession(req);
    res.send(`<h1>Welcome ${s.name}</h1><p>Member Portal</p>`);
});

app.get('/course', requireSession, (req, res) => {
    res.send('<h1>Course</h1>');
});

app.get('/trading-journal', requireSession, (req, res) => {
    res.send('<h1>Trading Journal</h1>');
});

app.get('/trading-room', (req, res) => {
    res.send('<h1>Trading Room</h1>');
});

app.post('/trading-room/activate', frm, express.json(), async (req, res) => {
    try {
        const email   = (req.body.email || '').toLowerCase().trim();
        const discUser= (req.body.discord_username || '').trim();
        const ntEmail = (req.body.ninjatrader_email || '').toLowerCase().trim();
        if (!ntEmail)  return res.status(400).json({ error: 'NinjaTrader email is required' });
        if (!email)    return res.status(400).json({ error: 'Email is required' });
        if (!discUser) return res.status(400).json({ error: 'Discord username is required' });

        const [{ data: mem }, { data: lic }, { data: dm }] = await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).select('status,expires_at,nt_license_id').eq('email', email).maybeSingle(),
            supabase.from(LICENSE_TABLE).select('status,nt_license_id').eq('email', email).maybeSingle(),
            supabase.from(DISCORD_TABLE).select('status,expires_at').eq('email', email).maybeSingle()
        ]);
        const isMonthly  = mem?.status === 'active' && new Date(mem.expires_at) > new Date();
        const isLifetime = lic?.status === 'active';
        const isDiscord  = dm?.status  === 'active' && new Date(dm.expires_at)  > new Date();

        if (!isMonthly && !isLifetime && !isDiscord)
            return res.status(403).json({ error: 'No active membership found.' });

        const found = await findUser(discUser);
        if (!found) return res.status(404).json({ error: `Discord user not found.` });

        const uid  = found.user.id;
        const rid  = isLifetime ? DISCORD_LIFETIME_ROLE_ID : (isDiscord ? (DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID) : DISCORD_MONTHLY_ROLE_ID);
        await addRole(uid, rid);

        if (isMonthly) await supabase.from(MEMBERSHIP_TABLE).update({ discord_user_id: uid, updated_at: nowISO() }).eq('email', email);
        if (isDiscord) await supabase.from(DISCORD_TABLE).update({ discord_user_id: uid, discord_username: discUser, updated_at: nowISO() }).eq('email', email);

        const ntType = isLifetime ? 'lifetime' : 'monthly';
        const existingNtId = isLifetime ? lic?.nt_license_id : mem?.nt_license_id;
        if (!existingNtId) {
            try {
                const ntId = await ntCreateLicense(ntEmail, ntType);
                if (ntId) {
                    if (isLifetime) await supabase.from(LICENSE_TABLE).update({ nt_license_id: ntId, nt_email: ntEmail, updated_at: nowISO() }).eq('email', email);
                    else await supabase.from(MEMBERSHIP_TABLE).update({ nt_license_id: ntId, nt_email: ntEmail, updated_at: nowISO() }).eq('email', email);
                }
            } catch (e) { console.error('[NT activate]', e.message); }
        }

        console.log(`✅ Role assigned: @${discUser} (${uid}) → ${email} | NT: ${ntEmail}`);
        res.json({ ok: true });
    } catch (e) { console.error('[TRActivate]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/check-access', frm, async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    try {
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).maybeSingle();
        res.json({ active: data?.status === 'active' && new Date(data.expires_at) > new Date() });
    } catch (e) { console.error('[CheckAccess]', e.message); res.status(500).json({ active: false }); }
});

app.get('/billing/confirm-session', requireSession, async (req, res) => {
    res.send('<h1>Billing</h1>');
});

app.get('/billing', (req, res) => {
    res.send('<h1>Billing Portal</h1>');
});

app.post('/billing/request', frm, express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,status').eq('email', email).maybeSingle();
        if (!data) return res.status(404).json({ error: 'No membership found' });
        const token   = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000).toISOString();
        await supabase.from(MEMBERSHIP_TABLE).update({ billing_token: token, billing_token_expires: expires, updated_at: nowISO() }).eq('email', email);
        await sendMagicLink(email, token, 'billing');
        res.json({ ok: true });
    } catch (e) { console.error('[BillingReq]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/billing/confirm', async (req, res) => {
    res.send('<h1>Billing Details</h1>');
});

app.get('/cancel', (req, res) => {
    res.send('<h1>Cancel Membership</h1>');
});

app.post('/cancel/request', frm, express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,status').eq('email', email).maybeSingle();
        if (!data) return res.status(404).json({ error: 'No membership found' });
        if (data.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled' });
        const token   = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000).toISOString();
        await supabase.from(MEMBERSHIP_TABLE).update({ cancel_token: token, cancel_token_expires: expires, updated_at: nowISO() }).eq('email', email);
        await sendMagicLink(email, token, 'cancel');
        res.json({ ok: true });
    } catch (e) { console.error('[CancelReq]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/cancel/confirm', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.send('ERROR');
    try {
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,status,authnet_subscription_id,cancel_token_expires,discord_user_id,nt_license_id').eq('cancel_token', token).maybeSingle();
        if (!data) return res.send('ERROR');
        if (new Date(data.cancel_token_expires) < new Date()) return res.send('EXPIRED');
        if (data.status === 'cancelled') return res.send('ALREADY CANCELLED');
        if (data.authnet_subscription_id) try { await cancelSub(data.authnet_subscription_id); } catch (e) { console.error('[CancelSub]', e.message); }
        if (data.discord_user_id) try { await stripRole(data.discord_user_id, DISCORD_MONTHLY_ROLE_ID); } catch {}
        if (data.nt_license_id)   try { await ntRevokeLicense(data.nt_license_id); } catch {}
        await supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', cancel_token: null, cancel_token_expires: null, updated_at: nowISO() }).eq('cancel_token', token);
        console.log(`🚫 Cancelled: ${data.email}`);
        res.send('<h1>SUCCESS</h1>');
    } catch (e) { console.error('[CancelConfirm]', e.message); res.send('ERROR'); }
});

function adminGuard(req, res, next) {
    const k = req.query.key || req.body?.key;
    if (!k || k !== ADMIN_SECRET) return res.status(403).send('ACCESS DENIED');
    next();
}

app.post('/admin/refresh-nt-token', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const ok = await ntLogin();
        if (ok) return res.json({ ok: true, message: '✅ NT re-authenticated successfully' });
        res.status(500).json({ ok: false, message: '❌ NT login failed' });
    } catch (e) { console.error('[RefreshNT]', e.message); res.status(500).json({ ok: false, message: e.message }); }
});

app.post('/admin/cancel', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        const type  = req.body.type || 'monthly';
        if (!email) return res.status(400).json({ error: 'Email required' });

        const result = { ok: true, type, email, db_updated: false, nt_revoked: false, discord_stripped: false, sub_cancelled: false };

        if (type === 'lifetime') {
            const { data: l } = await supabase.from(LICENSE_TABLE).select('nt_license_id,status,email').eq('email', email).maybeSingle();
            if (!l) return res.status(404).json({ error: 'Not found: ' + email });
            if (l.nt_license_id) {
                try { await ntRevokeLicense(l.nt_license_id); result.nt_revoked = true; }
                catch (e) { console.error('[AdminCancel NT]', e.message); }
            }
            const { error: updErr } = await supabase.from(LICENSE_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email);
            if (updErr) return res.status(500).json({ error: 'DB error: ' + updErr.message });
            result.db_updated = true;
        } else if (type === 'discord') {
            const { data: dm } = await supabase.from(DISCORD_TABLE).select('discord_user_id,authnet_subscription_id,status').eq('email', email).maybeSingle();
            if (!dm) return res.status(404).json({ error: 'Not found: ' + email });
            if (dm.authnet_subscription_id) {
                try { await cancelSub(dm.authnet_subscription_id); result.sub_cancelled = true; }
                catch (e) { console.error('[AdminCancel Sub]', e.message); }
            }
            const rid = DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID;
            if (dm.discord_user_id) {
                try { await stripRole(dm.discord_user_id, rid); result.discord_stripped = true; }
                catch (e) { console.error('[AdminCancel Discord]', e.message); }
            }
            const { error: updErr } = await supabase.from(DISCORD_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email);
            if (updErr) return res.status(500).json({ error: 'DB error: ' + updErr.message });
            result.db_updated = true;
        } else {
            const { data: m } = await supabase.from(MEMBERSHIP_TABLE).select('authnet_subscription_id,discord_user_id,nt_license_id,status,email').eq('email', email).maybeSingle();
            if (!m) return res.status(404).json({ error: 'Not found: ' + email });
            if (m.authnet_subscription_id) {
                try { await cancelSub(m.authnet_subscription_id); result.sub_cancelled = true; }
                catch (e) { console.error('[AdminCancel Sub]', e.message); }
            }
            if (m.discord_user_id) {
                try { await stripRole(m.discord_user_id, DISCORD_MONTHLY_ROLE_ID); result.discord_stripped = true; }
                catch (e) { console.error('[AdminCancel Discord]', e.message); }
            }
            if (m.nt_license_id) {
                try { await ntRevokeLicense(m.nt_license_id); result.nt_revoked = true; }
                catch (e) { console.error('[AdminCancel NT]', e.message); }
            }
            const { error: updErr } = await supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email);
            if (updErr) return res.status(500).json({ error: 'DB error: ' + updErr.message });
            result.db_updated = true;
        }

        res.json(result);
    } catch (e) {
        console.error('[AdminCancel]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/admin/remove-role', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const uid = req.body.discord_user_id;
        if (!uid) return res.status(400).json({ error: 'discord_user_id required' });
        const allRoles = [DISCORD_MONTHLY_ROLE_ID, DISCORD_LIFETIME_ROLE_ID, ...(DISCORD_ROOM_ROLE_ID ? [DISCORD_ROOM_ROLE_ID] : [])];
        for (const rid of allRoles) try { await stripRole(uid, rid); } catch {}
        await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('discord_user_id', uid),
            supabase.from(DISCORD_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('discord_user_id', uid)
        ]);
        console.log('[Admin] Roles stripped:', uid);
        res.json({ ok: true });
    } catch (e) { console.error('[AdminRemoveRole]', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/admin/god-add', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const email         = (req.body.email || '').trim().toLowerCase();
        const role          = req.body.role || 'monthly';
        const fullName      = (req.body.full_name || '').trim();
        const discordUser   = (req.body.discord_username || '').trim();
        const doEmail       = req.body.send_email !== false;
        const doNT          = req.body.create_nt !== false;
        const doDiscord     = req.body.assign_discord === true;

        if (!email) return res.status(400).json({ error: 'Email is required' });

        const result = { ok: true, supabase: false, nt_license: false, discord: false, email_sent: false };

        const isLifetime    = role === 'lifetime';
        const isDiscordOnly = role === 'discord';
        const expires       = isLifetime ? null : now30days();
        const table         = isLifetime ? LICENSE_TABLE : (isDiscordOnly ? DISCORD_TABLE : MEMBERSHIP_TABLE);

        const row = { email, full_name: fullName || null, status: 'active', plan_name: role, source: 'admin_grant', expires_at: expires, updated_at: nowISO() };
        if (isLifetime) {
            row.transaction_id = `admin_grant_${Date.now()}_${email}`;
            row.license_key    = `HVT-ADMIN-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
        }
        const { error: dbErr } = await supabase.from(table).upsert(row, { onConflict: isLifetime ? 'transaction_id' : 'email' });
        if (!dbErr) result.supabase = true;
        else console.error('[GodMode DB]', dbErr.message);

        if (doNT && !isDiscordOnly && ntToken) {
            try {
                const ntId = await ntCreateLicense(email, isLifetime ? 'lifetime' : 'monthly');
                if (ntId) {
                    result.nt_license = ntId;
                    await supabase.from(table).update({ nt_license_id: ntId, nt_email: email, updated_at: nowISO() }).eq('email', email);
                }
            } catch (e) { console.error('[GodMode NT]', e.message); }
        }

        if (doDiscord && discordUser) {
            try {
                const found = await findUser(discordUser);
                if (found) {
                    const uid = found.user.id;
                    const rid = isLifetime ? DISCORD_LIFETIME_ROLE_ID : (isDiscordOnly ? (DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID) : DISCORD_MONTHLY_ROLE_ID);
                    await addRole(uid, rid);
                    await supabase.from(table).update({ discord_user_id: uid, updated_at: nowISO() }).eq('email', email);
                    result.discord = true;
                }
            } catch (e) { console.error('[GodMode Discord]', e.message); }
        }

        if (doEmail) {
            try {
                const token    = crypto.randomBytes(32).toString('hex');
                const tokenExp = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                await supabase.from(table).update({ course_token: token, course_token_expires: tokenExp, updated_at: nowISO() }).eq('email', email);
                if (isDiscordOnly) await sendDiscordWelcome(email, fullName);
                else await sendWelcome(email, fullName, isLifetime ? 'lifetime' : 'monthly');
                result.email_sent = true;
            } catch (e) { console.error('[GodMode Email]', e.message); }
        }

        console.log(`[GodMode] ${email} | role=${role} | NT=${result.nt_license} | Discord=${result.discord} | Email=${result.email_sent}`);
        res.json(result);
    } catch (e) { console.error('[GodMode]', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/admin', adm, adminGuard, async (req, res) => {
    res.send('<h1>Admin Panel</h1>');
});

app.get('/admin/email-preview', adm, adminGuard, (req, res) => {
    res.send('<h1>Email Preview</h1>');
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

app.listen(PORT, () => console.log(`🚀 HVT Backend on port ${PORT}`));
