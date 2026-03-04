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

const PORT = process.env.PORT || 8080;

// ─── SECURITY HEADERS ────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options',  'nosniff');
    res.setHeader('X-Frame-Options',          'DENY');
    res.setHeader('X-XSS-Protection',         '1; mode=block');
    res.setHeader('Referrer-Policy',          'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy',       'geolocation=(), microphone=(), camera=()');
    res.removeHeader('X-Powered-By');
    next();
});

// ─── RATE LIMITING ───────────────────────────────────────────────────────────
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

// ─── ENV ─────────────────────────────────────────────────────────────────────
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

// ─── NINJATRADER ECOSYSTEM API ────────────────────────────────────────────────
const NT_PRODUCT_ID = process.env.NT_PRODUCT_ID || '1196';
const NT_USERNAME   = process.env.NT_USERNAME   || '';
const NT_PASSWORD   = process.env.NT_PASSWORD   || '';
let   ntToken       = null;
let   ntAuthFails   = 0;

async function ntLogin() {
    if (!NT_USERNAME || !NT_PASSWORD) {
        console.warn('[NT] No credentials configured (NT_USERNAME / NT_PASSWORD missing)');
        return false;
    }
    try {
        console.log('[NT] Logging in with username/password...');
        // Encode password as base64 with enc:true — matches what the NT Ecosystem website sends
        const encodedPassword = Buffer.from(NT_PASSWORD).toString('base64');
        const deviceId = 'hvt-backend-railway-prod';
        const sec = crypto.createHash('md5').update(NT_USERNAME + NT_PASSWORD + deviceId).digest('hex');
        const r = await fetchFn('https://live.tradovateapi.com/v1/auth/accesstokenrequest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name:        NT_USERNAME,
                password:    encodedPassword,
                appId:       'arena',
                appVersion:  '0.1.0',
                cid:         '1',
                sec:         sec,
                deviceId:    deviceId,
                enc:         true,
                environment: 'live'
            })
        });
        const d = await r.json();
        if (d?.accessToken) {
            ntToken    = d.accessToken;
            ntAuthFails = 0;
            console.log(`[NT] ✅ Logged in successfully — token expires ${d.expirationTime}`);
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
    // Try to renew existing token first; fall back to full re-login
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
                console.log(`[NT] Token renewed ✓ expires ${d.expirationTime}`);
                return;
            }
            console.warn('[NT] Renewal returned no token — falling back to full login');
        } catch (e) {
            console.warn('[NT] Renewal error — falling back to full login:', e.message);
        }
    }
    // Full re-login (handles expired token, first run, or renewal failure)
    await ntLogin();
}

// Auto-login on startup, then re-authenticate every 45 minutes
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
        if (d?.errorText !== '') {
            console.error(`[NT] License creation failed for ${email}:`, JSON.stringify(d));
            return null;
        }
        console.log(`[NT] ✅ License created for ${email} | type=${type} | id=${d.result}`);
        return d.result; // NT license ID
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

// ─── SUPABASE ────────────────────────────────────────────────────────────────
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('[FATAL] Missing Supabase env'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
console.log(`[INIT] ${MEMBERSHIP_TABLE} | ${LICENSE_TABLE} | ${DISCORD_TABLE}`);

// ─── SHARED HELPERS ───────────────────────────────────────────────────────────
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

// ─── DISCORD API ─────────────────────────────────────────────────────────────
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

// ─── EMAIL ───────────────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
    const r = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(`Resend: ${JSON.stringify(d)}`);
    return d;
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
    <div style="height:3px;background:linear-gradient(90deg,#1e3a8a,#2563eb,#1e3a8a);"></div>
    <div style="padding:36px 32px;">${content}</div>
  </div>
  <div style="text-align:center;margin-top:24px;color:#334155;font-size:11px;line-height:1.8;">
    &copy; 2026 High Velocity Trading. All rights reserved.<br>
    <a href="https://highvelocitytrading.com" style="color:#64748b;text-decoration:none;">highvelocitytrading.com</a>
  </div>
</div></body></html>`;
}

async function sendWelcome(email, fullName, type) {
    const name     = fullName?.split(' ')[0] || 'Trader';
    const monthly  = type === 'monthly';
    const subject  = monthly ? 'Welcome to HVT Monthly Membership!' : 'Welcome to HVT Lifetime Access!';
    const badge    = monthly ? 'Monthly Membership Activation' : 'Lifetime Access Activation';
    const accent   = monthly ? '#2563eb' : '#f6ad55';
    const badgeBg  = monthly ? 'rgba(37,99,235,0.08)'  : 'rgba(246,173,85,0.08)';
    const badgeBrd = monthly ? 'rgba(37,99,235,0.2)'   : 'rgba(246,173,85,0.2)';
    const note     = monthly ? `<div style="background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.15);border-radius:10px;padding:14px 18px;margin-bottom:24px;">
      <p style="color:#f87171;font-size:13px;line-height:1.6;margin:0;">&#9888;&#65039; <strong>Please note:</strong> Your Trading Room and indicator access are tied to your active monthly membership. Access will be removed if payment stops.</p></div>` : '';
    const html = wrap(`
      <div style="text-align:center;margin-bottom:8px;">
        <div style="display:inline-block;background:${badgeBg};border:1px solid ${badgeBrd};border-radius:20px;padding:6px 18px;margin-bottom:20px;">
          <span style="color:${accent};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">${badge}</span>
        </div>
        <h2 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 8px;letter-spacing:1px;">Welcome, ${name}!</h2>
        <p style="color:#94a3b8;font-size:14px;margin:0;">We're grateful to have you with us.</p>
      </div>
      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.1),transparent);margin:28px 0;"></div>
      <p style="color:#94a3b8;font-size:14px;line-height:1.8;margin-bottom:24px;text-align:center;">Thank you for your purchase. You now have access to everything High Velocity Trading has to offer.</p>
      ${note}
      <div style="text-align:center;margin-bottom:28px;">
        <a href="${APP_URL}/trading-room" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:16px 48px;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;box-shadow:0 4px 24px rgba(37,99,235,0.4);">ACTIVATE TRADING ROOM</a>
      </div>
      <div style="background:rgba(37,99,235,0.04);border:1px solid rgba(37,99,235,0.12);border-radius:10px;padding:16px 20px;text-align:center;">
        <p style="color:#475569;font-size:13px;margin:0 0 8px;">Need help getting set up?</p>
        <p style="color:#94a3b8;font-size:15px;font-weight:700;margin:0;">&#128222; 786-461-4235</p>
      </div>`);
    await sendEmail(email, subject, html);
    console.log(`[Email] ${type} welcome → ${email}`);
}

async function sendDiscordWelcome(email, fullName) {
    const name = fullName?.split(' ')[0] || 'Trader';
    const activateLink = `${APP_URL}/trading-room`;
    const html = wrap(`
      <div style="text-align:center;margin-bottom:8px;">
        <div style="display:inline-block;background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.2);border-radius:20px;padding:6px 18px;margin-bottom:20px;">
          <span style="color:#2563eb;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Discord Trading Room Access</span>
        </div>
        <h2 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 8px;letter-spacing:1px;">You're In, ${name}!</h2>
        <p style="color:#94a3b8;font-size:14px;margin:0;">Your $37/month Trading Room membership is now active.</p>
      </div>
      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.1),transparent);margin:28px 0;"></div>
      <div style="background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.15);border-radius:10px;padding:14px 18px;margin-bottom:28px;">
        <p style="color:#f87171;font-size:13px;line-height:1.6;margin:0;">&#9888;&#65039; <strong>Access Note:</strong> Trading Room access is tied to your active $37/month subscription. Access will be removed if payment stops.</p>
      </div>
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:14px;font-weight:700;">ACTIVATE IN 2 EASY STEPS</div>
      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;margin-bottom:28px;">
        <div style="padding:22px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="display:flex;align-items:flex-start;gap:16px;">
            <div style="width:36px;height:36px;border-radius:50%;background:#2563eb;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;flex-shrink:0;margin-top:2px;">1</div>
            <div style="flex:1;">
              <div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:6px;">Join the HVT Discord Server</div>
              <div style="color:#94a3b8;font-size:13px;line-height:1.6;margin-bottom:16px;">Click the button below to visit our website and join the Discord server. <strong style="color:#fff;">You must join the server first</strong> before you can get your Trading Room role.</div>
              <a href="https://highvelocitytrading.com" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:13px 28px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">JOIN DISCORD SERVER &rarr;</a>
            </div>
          </div>
        </div>
        <div style="padding:22px 24px;">
          <div style="display:flex;align-items:flex-start;gap:16px;">
            <div style="width:36px;height:36px;border-radius:50%;background:#2563eb;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;flex-shrink:0;margin-top:2px;">2</div>
            <div style="flex:1;">
              <div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:6px;">Activate Your Trading Room Role</div>
              <div style="color:#94a3b8;font-size:13px;line-height:1.6;margin-bottom:16px;">Once you have joined the server, click the button below. You will enter <strong style="color:#fff;">this email address</strong> and your <strong style="color:#fff;">Discord username</strong> &mdash; your Trading Room role will be assigned instantly.</div>
              <a href="${activateLink}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:13px 28px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">ACTIVATE MY ROLE &rarr;</a>
            </div>
          </div>
        </div>
      </div>
      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px 18px;margin-bottom:20px;">
        <p style="color:#475569;font-size:12px;line-height:1.6;margin:0;">&#128161; <strong style="color:#94a3b8;">Finding your Discord username:</strong> Open Discord &rarr; click your profile photo at the bottom left &rarr; your username is shown below your display name (lowercase, may include numbers e.g. <em>johntrader22</em>).</p>
      </div>
      <div style="background:rgba(37,99,235,0.04);border:1px solid rgba(37,99,235,0.12);border-radius:10px;padding:16px 20px;text-align:center;">
        <p style="color:#475569;font-size:13px;margin:0 0 8px;">Need help? We will walk you through everything.</p>
        <p style="color:#94a3b8;font-size:15px;font-weight:700;margin:0;">&#128222; 786-461-4235</p>
      </div>`);
    await sendEmail(email, 'Your HVT Trading Room Access Is Ready — 2 Steps to Activate', html);
    console.log(`[Email] Discord welcome → ${email}`);
}

async function sendCourseEmail(email, token) {
    const url = `${APP_URL}/course/confirm?token=${token}`;
    const html = wrap(`
      <div style="text-align:center;margin-bottom:8px;">
        <div style="display:inline-block;background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.2);border-radius:20px;padding:6px 18px;margin-bottom:20px;">
          <span style="color:#2563eb;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Member Access</span>
        </div>
        <h2 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 8px;">Your Access Link is Ready</h2>
        <p style="color:#94a3b8;font-size:14px;margin:0;">Expires in <strong style="color:#fff;">24 hours</strong>. Do not share this link.</p>
      </div>
      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.1),transparent);margin:28px 0;"></div>
      <div style="text-align:center;margin-bottom:28px;">
        <a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:16px 48px;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;box-shadow:0 4px 24px rgba(37,99,235,0.35);">ACCESS MEMBER PORTAL</a>
      </div>
      <p style="text-align:center;color:#334155;font-size:12px;margin-bottom:24px;">Secure link &middot; Expires in 24 hours</p>
      <div style="background:rgba(37,99,235,0.04);border:1px solid rgba(37,99,235,0.12);border-radius:10px;padding:14px 18px;">
        <p style="color:#475569;font-size:13px;margin:0;">&#128274; If you did not request this, ignore this email.</p>
      </div>`);
    await sendEmail(email, 'Access Your HVT Member Portal', html);
}

async function sendMagicLink(email, token, type) {
    const url       = `${APP_URL}/${type}/confirm?token=${token}`;
    const isBilling = type === 'billing';
    const subject   = isBilling ? 'Access Your HVT Billing Portal' : 'Cancel Your HVT Membership';
    const title     = isBilling ? 'Billing Portal Access' : 'Membership Cancellation';
    const btnText   = isBilling ? 'VIEW MY BILLING' : 'CONFIRM CANCELLATION';
    const btnColor  = isBilling ? '#2563eb' : '#dc2626';
    const desc      = isBilling
        ? 'Click below to access your billing dashboard. Expires in <strong style="color:#fff;">1 hour</strong>.'
        : 'Click below to confirm cancellation of your HVT Membership. Expires in <strong style="color:#fff;">1 hour</strong>.';
    const html = wrap(`
      <div style="text-align:center;margin-bottom:24px;"><span style="font-size:20px;font-weight:700;color:#fff;">${title}</span></div>
      <p style="color:#94a3b8;font-size:14px;line-height:1.7;text-align:center;margin-bottom:32px;">${desc}</p>
      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.1),transparent);margin-bottom:32px;"></div>
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${url}" style="display:inline-block;background:${btnColor};color:#fff;text-decoration:none;padding:16px 48px;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;">${btnText}</a>
      </div>
      <p style="text-align:center;color:#334155;font-size:12px;margin-bottom:20px;">Secure link &middot; Expires in 1 hour</p>
      <div style="background:rgba(37,99,235,0.04);border:1px solid rgba(37,99,235,0.12);border-radius:10px;padding:14px 18px;">
        <p style="color:#475569;font-size:13px;margin:0;">&#128274; If you did not request this, ignore this email.</p>
      </div>`);
    await sendEmail(email, subject, html);
}

// ─── AUTHNET CANCEL ───────────────────────────────────────────────────────────
async function cancelSub(subId) {
    const r = await fetchFn('https://api.authorize.net/xml/v1/request.api', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ARBCancelSubscriptionRequest: { merchantAuthentication: { name: AUTHNET_API_LOGIN_ID, transactionKey: AUTHNET_TRANSACTION_KEY }, subscriptionId: String(subId) } })
    });
    const d = await r.json();
    if (d?.messages?.resultCode !== 'Ok') throw new Error(d?.messages?.message?.[0]?.text || 'Authnet cancel failed');
    return d;
}

// ─── HUNT DATA FROM JOTFORM ───────────────────────────────────────────────────
function huntData(raw) {
    const email = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0]?.toLowerCase() || null;
    const fn    = (raw.match(/\[q3[^\]]*\]=([^\n]+)/) || raw.match(/"q3[^"]*":"([^"]+)"/))?.[1]?.trim() || '';
    const ln    = (raw.match(/\[q4[^\]]*\]=([^\n]+)/) || raw.match(/"q4[^"]*":"([^"]+)"/))?.[1]?.trim() || '';
    let phone   = null;
    const rr    = raw.match(/\[rawRequest\]=(\{.*\})/s);
    if (rr) { try { const o = JSON.parse(rr[1]); const pf = Object.keys(o).find(k => k.startsWith('q7')); if (pf && o[pf]?.full) phone = o[pf].full.trim(); } catch {} }
    return { email, full_name: [fn, ln].filter(Boolean).join(' ') || null, phone };
}

// ─── LICENSE HELPERS ──────────────────────────────────────────────────────────
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

// ─── V LOGO SVG ───────────────────────────────────────────────────────────────
const V_LOGO_SVG = `<svg width="20" height="18" viewBox="0 0 20 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1L10 16.5L19 1" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ─── PAGE SHELL ──────────────────────────────────────────────────────────────
function shell(title, body) {
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} – High Velocity Trading</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Sans',sans-serif;background:#000;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 20px;color:#fff;position:relative;overflow-x:hidden;}
body::before{content:'';position:fixed;top:30%;left:50%;transform:translate(-50%,-50%);width:900px;height:700px;background:radial-gradient(ellipse,rgba(30,58,138,0.18) 0%,rgba(20,40,160,0.08) 25%,transparent 60%);border-radius:50%;filter:blur(80px);pointer-events:none;z-index:0;animation:glowPulse 12s ease-in-out infinite;}
body::after{content:'';position:fixed;top:45%;left:55%;transform:translate(-50%,-50%);width:600px;height:500px;background:radial-gradient(ellipse,rgba(37,99,235,0.1) 0%,transparent 55%);border-radius:50%;filter:blur(60px);pointer-events:none;z-index:0;animation:glowDrift 16s ease-in-out infinite;}
@keyframes glowPulse{0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.18}50%{transform:translate(-50%,-50%) scale(1.06);opacity:.25}}
@keyframes glowDrift{0%,100%{transform:translate(-50%,-50%) translate(0,0) scale(1);opacity:.08}33%{transform:translate(-50%,-50%) translate(30px,-20px) scale(1.05);opacity:.12}66%{transform:translate(-50%,-50%) translate(-20px,10px) scale(1.02);opacity:.09}}
.brand{text-align:center;margin-bottom:36px;position:relative;z-index:1;}
.brand-logo{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:4px;}
.brand-text{display:flex;flex-direction:column;gap:1px;}
.brand-text span{font-size:8.5px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:#fff;line-height:1;}
.brand-text .dim{color:rgba(255,255,255,0.5);}
.card{width:100%;max-width:460px;background:rgba(255,255,255,0.03);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.6);position:relative;z-index:1;}
.ct{height:3px;background:linear-gradient(90deg,#1e3a8a,#2563eb,#1e3a8a);}
.cb{padding:36px 32px;}
.ttl{font-size:22px;font-weight:700;letter-spacing:0.5px;color:#fff;margin-bottom:8px;}
.sub{color:#64748b;font-size:13px;line-height:1.6;margin-bottom:28px;}
.div{height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.1),transparent);margin-bottom:28px;}
label{display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:8px;}
input[type=email],input[type=text]{width:100%;padding:13px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:#fff;font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s;margin-bottom:20px;font-family:'DM Sans',sans-serif;}
input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,0.2);}
input::placeholder{color:#334155;}
.btn{width:100%;padding:14px;background:#2563eb;color:#fff;border:none;border-radius:999px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 20px rgba(37,99,235,0.3);transition:opacity .2s,transform .1s;}
.btn:hover{opacity:.9;transform:translateY(-1px);}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none;}
.btn-red{background:linear-gradient(135deg,#991b1b,#dc2626);box-shadow:0 4px 20px rgba(220,38,38,0.3);}
.msg{margin-top:16px;padding:12px 16px;border-radius:12px;font-size:13px;text-align:center;display:none;line-height:1.5;}
.msg.show{display:block;}
.ok{background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2);}
.er{background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2);}
.fl{text-align:center;margin-top:20px;font-size:12px;color:#334155;position:relative;z-index:1;}
.fl a{color:#64748b;text-decoration:none;}
.ntBadge{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:rgba(37,99,235,0.05);border:1px solid rgba(37,99,235,0.18);margin-bottom:18px;}
.ntIcon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:rgba(37,99,235,0.12);border:1px solid rgba(37,99,235,0.22);flex-shrink:0;}
.ntTitle{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#2563eb;font-weight:700;line-height:1;}
.ntDesc{color:#94a3b8;font-size:12.5px;line-height:1.55;margin-top:6px;}
</style></head><body>
<div class="brand">
  <div class="brand-logo">
    ${V_LOGO_SVG}
    <div class="brand-text">
      <span>High</span>
      <span>Velocity</span>
      <span class="dim">Trading</span>
    </div>
  </div>
</div>
${body}
<div class="fl" style="margin-top:20px;"><a href="https://highvelocitytrading.com">&larr; highvelocitytrading.com</a></div>
</body></html>`;
}

function resultPage(type, title, msg) {
    const m = { success:{i:'&#10003;',c:'#4ade80',b:'rgba(74,222,128,0.08)',r:'rgba(74,222,128,0.2)'}, error:{i:'&#10005;',c:'#f87171',b:'rgba(248,113,113,0.08)',r:'rgba(248,113,113,0.2)'}, info:{i:'&#8505;',c:'#60a5fa',b:'rgba(37,99,235,0.08)',r:'rgba(37,99,235,0.2)'} }[type] || {i:'&#10005;',c:'#f87171',b:'rgba(248,113,113,0.08)',r:'rgba(248,113,113,0.2)'};
    return shell(title, `<div class="card" style="max-width:460px;width:100%;"><div class="ct"></div><div class="cb" style="text-align:center;">
      <div style="width:56px;height:56px;border-radius:50%;background:${m.b};border:1px solid ${m.r};display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:22px;color:${m.c};">${m.i}</div>
      <div class="ttl" style="margin-bottom:16px;">${title}</div>
      <div style="background:${m.b};border:1px solid ${m.r};border-radius:10px;padding:16px;color:${m.c};font-size:14px;line-height:1.6;">${msg}</div>
    </div></div>`);
}

function ninjaLogoSVG() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 17.5V6.5L11 12l-5 5.5Z" fill="#2563eb" opacity="0.95"/><path d="M12.5 18V6l5.5 6-5.5 6Z" fill="#60a5fa" opacity="0.95"/><path d="M4.5 19.2h15" stroke="rgba(255,255,255,0.08)" stroke-width="1.2" opacity="0.9"/></svg>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/health', rateLimit({ max: 30 }), (req, res) => res.json({ ok: true, ts: nowISO(), nt_token: ntToken ? 'active' : 'not_authenticated', nt_auth_fails: ntAuthFails }));

// ─── MEMBERSHIP JOTFORM ───────────────────────────────────────────────────────
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
            // NT license for monthly membership
            try { await ntCreateLicense(email, 'monthly'); } catch (e) { console.error('[NT monthly JF]', e.message); }
            try { await sendWelcome(email, full_name, 'monthly'); } catch (e) { console.error('[Welcome email]', e.message); }
            console.log(`✅ Membership (JF): ${email}`);
            res.status(200).send('OK');
        } catch (e) { console.error('[MemberJF]', e.message); res.status(500).send('Error'); }
    });
    req.pipe(bb);
});

// ─── MEMBERSHIP AUTHNET ───────────────────────────────────────────────────────
app.post('/webhooks/membership-authnet', wh, express.json(), async (req, res) => {
    try {
        const { eventType = '', payload = {} } = req.body || {};
        const email = (payload?.customerDetails?.email || '').toLowerCase().trim();
        const subId = pickFirst(payload?.id);
        const CANCEL_EVENTS = ['net.authorize.customer.subscription.cancelled','net.authorize.customer.subscription.expired','net.authorize.customer.subscription.suspended','net.authorize.customer.subscription.terminated','net.authorize.customer.subscription.failed'];

        if (eventType === 'net.authorize.customer.subscription.created' || eventType === 'net.authorize.payment.capture.created') {
            if (!email) return res.status(400).send('No email');
            const row = { email, plan_name: 'membership', status: 'active', source: 'authnet', expires_at: now30days(), updated_at: nowISO() };
            if (subId) row.authnet_subscription_id = subId;
            await supabase.from(MEMBERSHIP_TABLE).upsert(row, { onConflict: 'email' });
            // NT license for monthly membership
            try {
                const ntId = await ntCreateLicense(email, 'monthly');
                if (ntId) await supabase.from(MEMBERSHIP_TABLE).update({ nt_license_id: ntId, updated_at: nowISO() }).eq('email', email);
            } catch (e) { console.error('[NT monthly AN]', e.message); }
            console.log(`✅ Membership (AN): ${email}`);
        } else if (CANCEL_EVENTS.includes(eventType)) {
            const q = subId ? supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('authnet_subscription_id', subId)
                            : email ? supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email) : null;
            if (q) {
                await q;
                const { data: m } = await supabase.from(MEMBERSHIP_TABLE).select('discord_user_id,nt_license_id').eq(subId ? 'authnet_subscription_id' : 'email', subId || email).maybeSingle();
                if (m?.discord_user_id) try { await stripRole(m.discord_user_id, DISCORD_MONTHLY_ROLE_ID); } catch {}
                if (m?.nt_license_id)   try { await ntRevokeLicense(m.nt_license_id); } catch {}
                console.log(`🚫 Membership cancelled (AN): ${email || subId}`);
            }
        }
        res.status(200).send('OK');
    } catch (e) { console.error('[MemberAN]', e.message); res.status(500).send('Error'); }
});

// ─── DISCORD $37 JOTFORM ─────────────────────────────────────────────────────
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

// ─── DISCORD $37 AUTHNET ──────────────────────────────────────────────────────
app.post('/webhooks/discord-authnet', wh, express.json(), async (req, res) => {
    try {
        const { eventType = '', payload = {} } = req.body || {};
        const email = (payload?.customerDetails?.email || '').toLowerCase().trim();
        const subId = pickFirst(payload?.id);
        const CANCEL_EVENTS = ['net.authorize.customer.subscription.cancelled','net.authorize.customer.subscription.expired','net.authorize.customer.subscription.suspended','net.authorize.customer.subscription.terminated','net.authorize.customer.subscription.failed'];

        if (eventType === 'net.authorize.customer.subscription.created' || eventType === 'net.authorize.payment.capture.created') {
            if (!email) return res.status(400).send('No email');
            const row = { email, plan_name: 'discord_monthly', status: 'active', source: 'authnet', expires_at: now30days(), updated_at: nowISO() };
            if (subId) row.authnet_subscription_id = subId;
            await supabase.from(DISCORD_TABLE).upsert(row, { onConflict: 'email' });
            console.log(`✅ Discord member renewed (AN): ${email}`);
        } else if (CANCEL_EVENTS.includes(eventType)) {
            const q = subId ? supabase.from(DISCORD_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('authnet_subscription_id', subId)
                            : email ? supabase.from(DISCORD_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email) : null;
            if (q) {
                await q;
                const rid = DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID;
                const { data: dm } = await supabase.from(DISCORD_TABLE).select('discord_user_id').eq(subId ? 'authnet_subscription_id' : 'email', subId || email).maybeSingle();
                if (dm?.discord_user_id) try { await stripRole(dm.discord_user_id, rid); } catch {}
                console.log(`🚫 Discord cancelled (AN): ${email || subId}`);
            }
        }
        res.status(200).send('OK');
    } catch (e) { console.error('[DiscordAN]', e.message); res.status(500).send('Error'); }
});

app.get('/check-access', frm, async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    const { data } = await supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).maybeSingle();
    res.json({ active: data?.status === 'active' && new Date(data.expires_at) > new Date() });
});

// ─── TRADING ROOM ─────────────────────────────────────────────────────────────
app.get('/trading-room', (req, res) => {
    res.send(shell('Activate Member Access', `
    <div class="card">
      <div class="ct"></div>
      <div class="cb">
        <div style="text-align:center;margin-bottom:24px;">
          <div style="display:inline-block;background:rgba(37,99,235,0.1);border:1px solid rgba(37,99,235,0.2);border-radius:20px;padding:6px 18px;margin-bottom:16px;">
            <span style="color:#2563eb;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Member Access Activation</span>
          </div>
          <div class="ttl" style="margin-bottom:8px;">Activate Your Member Access</div>
          <div class="sub" style="margin-bottom:0;">Takes less than 2 minutes. Please enter the information exactly.</div>
        </div>
        <div class="div"></div>
        <div class="ntBadge">
          <div class="ntIcon">${ninjaLogoSVG()}</div>
          <div style="flex:1;">
            <div class="ntTitle">NinjaTrader Activation</div>
            <div class="ntDesc">Enter the email tied to your <strong style="color:#fff;">NinjaTrader account</strong>. <strong style="color:#94a3b8;">You must have a NinjaTrader account created first</strong> before submitting this.</div>
          </div>
        </div>
        <label for="ntemail">NinjaTrader Account Email</label>
        <input type="email" id="ntemail" placeholder="email used for NinjaTrader" />
        <div style="background:rgba(37,99,235,0.05);border:1px solid rgba(37,99,235,0.15);border-radius:12px;padding:18px 20px;margin-bottom:24px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:14px;font-weight:700;">Discord Trading Room</div>
          <div style="display:flex;gap:12px;margin-bottom:12px;">
            <div style="width:24px;height:24px;border-radius:50%;background:#2563eb;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;margin-top:1px;">1</div>
            <div style="color:#94a3b8;font-size:13px;line-height:1.5;">Go to <strong style="color:#2563eb;">highvelocitytrading.com</strong>, click <strong style="color:#fff;">Join Discord</strong>, and join the server.</div>
          </div>
          <div style="display:flex;gap:12px;">
            <div style="width:24px;height:24px;border-radius:50%;background:#2563eb;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;margin-top:1px;">2</div>
            <div style="color:#94a3b8;font-size:13px;line-height:1.5;">Once you have joined, enter your <strong style="color:#fff;">purchase email</strong> and <strong style="color:#fff;">Discord username</strong> below and click Activate.</div>
          </div>
        </div>
        <label for="email">Purchase Email</label>
        <input type="email" id="email" placeholder="your@email.com" />
        <label for="discord">Discord Username</label>
        <input type="text" id="discord" placeholder="e.g. johntrader22" />
        <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px 16px;margin-bottom:20px;">
          <p style="color:#475569;font-size:12px;margin:0;line-height:1.7;">&#128161; <strong style="color:#94a3b8;">Where to find your username:</strong> Open Discord &rarr; click your profile picture at the <strong style="color:#94a3b8;">bottom-left</strong> &rarr; your username is the text below your display name (lowercase, may have numbers). <strong style="color:#94a3b8;">Not your display name &mdash; the actual username.</strong></p>
        </div>
        <button class="btn" id="btn" onclick="go()">Activate Member Access</button>
        <div class="msg" id="msg"></div>
      </div>
    </div>
    <script>
      async function go(){const email=document.getElementById('email').value.trim();const disc=document.getElementById('discord').value.trim();const ntEmail=document.getElementById('ntemail').value.trim();const msg=document.getElementById('msg');const btn=document.getElementById('btn');msg.className='msg';if(!ntEmail){msg.className='msg er show';msg.textContent='Please enter your NinjaTrader account email.';return}if(!email){msg.className='msg er show';msg.textContent='Please enter your purchase email.';return}if(!disc){msg.className='msg er show';msg.textContent='Please enter your Discord username.';return}btn.disabled=true;btn.textContent='Activating...';try{const r=await fetch('/trading-room/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,discord_username:disc,ninjatrader_email:ntEmail})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\\u2713 Done! Check Discord \\u2014 your role has been assigned. NinjaTrader indicators will activate automatically.';btn.textContent='Access Granted \\u2713'}else{msg.className='msg er show';msg.textContent=d.error||'Something went wrong.';btn.disabled=false;btn.textContent='Activate Member Access'}}catch{msg.className='msg er show';msg.textContent='Network error. Please try again.';btn.disabled=false;btn.textContent='Activate Member Access'}}
    </script>`));
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
            return res.status(403).json({ error: 'No active membership found for this email. Please check your email or contact support at 786-461-4235.' });

        const found = await findUser(discUser);
        if (!found) return res.status(404).json({ error: `Discord user "${discUser}" not found in the HVT server. Please make sure you have joined first at highvelocitytrading.com.` });

        const uid  = found.user.id;
        const rid  = isLifetime ? DISCORD_LIFETIME_ROLE_ID : (isDiscord ? (DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID) : DISCORD_MONTHLY_ROLE_ID);
        await addRole(uid, rid);

        if (isMonthly) await supabase.from(MEMBERSHIP_TABLE).update({ discord_user_id: uid, updated_at: nowISO() }).eq('email', email);
        if (isDiscord) await supabase.from(DISCORD_TABLE).update({ discord_user_id: uid, discord_username: discUser, updated_at: nowISO() }).eq('email', email);

        // Create NT license using the NinjaTrader email they provided
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
    } catch (e) { console.error('[TRActivate]', e.message); res.status(500).json({ error: 'Server error. Please try again or call 786-461-4235.' }); }
});

// ─── COURSE / MEMBER ACCESS ───────────────────────────────────────────────────
// ─── SESSION HELPERS ──────────────────────────────────────────────────────────
const SESSION_COOKIE = 'hvt_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const _sessions = new Map(); // token -> { email, name, plan, expires }
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

// ─── LOGIN PAGE (was /course) ─────────────────────────────────────────────────
app.get('/login', (req, res) => {
    if (getSession(req)) return res.redirect('/member');
    res.send(shell('Member Login', `
    <div style="width:100%;max-width:520px;">
      <div style="text-align:center;margin-bottom:32px;">
        <div style="display:inline-block;border-top:1px solid rgba(255,255,255,0.1);border-bottom:1px solid rgba(255,255,255,0.1);padding:10px 28px;margin-bottom:16px;">
          <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:0.5px;">High Velocity Trading</div>
          <div style="font-size:9px;font-weight:500;letter-spacing:4px;text-transform:uppercase;color:#64748b;margin-top:3px;">Member Portal</div>
        </div>
        <p style="color:#64748b;font-size:13px;margin:0;">Enter your membership email. We'll send a secure one-time login link.</p>
      </div>
      <div class="card" style="max-width:520px;">
        <div class="ct"></div>
        <div class="cb">
          <label for="email">Membership Email</label>
          <input type="email" id="email" placeholder="your@email.com" autocomplete="email" />
          <button class="btn" id="btn" onclick="go()">Send My Access Link</button>
          <div class="msg" id="msg"></div>
          <p style="text-align:center;color:#334155;font-size:11px;margin-top:20px;margin-bottom:0;">Not a member? <a href="https://highvelocitytrading.com/#packages" style="color:#2563eb;text-decoration:none;font-weight:600;">View Packages &rarr;</a></p>
        </div>
      </div>
    </div>
    <script>
      async function go(){const email=document.getElementById('email').value.trim();const msg=document.getElementById('msg');const btn=document.getElementById('btn');msg.className='msg';if(!email){msg.className='msg er show';msg.textContent='Please enter your email.';return}btn.disabled=true;btn.textContent='Sending...';try{const r=await fetch('/course/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\u2713 Check your email \u2014 your secure link is on the way!';btn.textContent='Link Sent \u2713'}else{msg.className='msg er show';msg.textContent=d.error||'Something went wrong.';btn.disabled=false;btn.textContent='Send My Access Link'}}catch{msg.className='msg er show';msg.textContent='Network error.';btn.disabled=false;btn.textContent='Send My Access Link'}}
      document.getElementById('email').addEventListener('keydown',e=>{if(e.key==='Enter')go();});
    </script>`));
});

// /course GET is defined below as the full course player (cookie-gated)

app.post('/course/request', frm, express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const { data: mem } = await supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).maybeSingle();
        const { data: lic } = await supabase.from(LICENSE_TABLE).select('status').eq('email', email).maybeSingle();
        const isMonthly  = mem?.status === 'active' && new Date(mem.expires_at) > new Date();
        const isLifetime = lic?.status === 'active';
        if (!isMonthly && !isLifetime) return res.status(403).json({ error: 'No active membership found. Visit highvelocitytrading.com or call 786-461-4235.' });
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
        if (!rec) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid or has expired.'));
        if (!rec.course_token_expires || new Date(rec.course_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/course" style="color:#2563eb;">Request a new one</a>.'));
        const isMonthly  = mData?.status === 'active' && new Date(mData.expires_at) > new Date();
        const isLifetime = lData?.status === 'active';
        if (!isMonthly && !isLifetime) return res.send(resultPage('error', 'Access Revoked', 'Your membership is no longer active.'));
        const name    = (rec.full_name || 'Trader').split(' ')[0];
        const plan    = isLifetime ? 'Lifetime Access' : 'Monthly Membership';
        // Set 7-day session cookie — member stays logged in across the portal
        const sessToken = createSession(rec.email, name, plan);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7*24*3600}`);
        return res.redirect('/member');
    } catch (e) { console.error('[CourseConfirm]', e.message); res.send(resultPage('error', 'Error', 'Something went wrong.')); }
});


// ─── MEMBER PORTAL (cookie-gated dashboard) ───────────────────────────────────
app.get('/member', requireSession, (req, res) => {
    const s = getSession(req);
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Member Portal — HVT</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080c14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:0 32px;height:60px;border-bottom:1px solid rgba(255,255,255,0.06);background:rgba(8,12,20,0.95);position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.logo{font-size:13px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#fff}
.logo span{color:#2563eb}
.user-badge{display:flex;align-items:center;gap:10px;font-size:13px;color:#64748b}
.user-badge strong{color:#94a3b8}
.plan-pill{background:rgba(37,99,235,0.1);border:1px solid rgba(37,99,235,0.25);border-radius:20px;padding:3px 10px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#2563eb}
.portal-wrap{max-width:880px;margin:0 auto;padding:56px 24px}
.portal-heading{text-align:center;margin-bottom:56px}
.portal-heading h1{font-size:32px;font-weight:700;letter-spacing:-0.5px;margin-bottom:8px}
.portal-heading p{color:#64748b;font-size:14px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.cards{grid-template-columns:1fr}}
.pcard{display:block;text-decoration:none;border-radius:20px;border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.02);overflow:hidden;transition:all .2s;position:relative}
.pcard:hover{transform:translateY(-3px);border-color:var(--c);box-shadow:0 12px 40px rgba(0,0,0,0.3)}
.pcard .bar{height:3px;background:linear-gradient(90deg,var(--c2),var(--c),var(--c2))}
.pcard .inner{padding:28px}
.pcard .icon{width:44px;height:44px;border-radius:12px;background:var(--cb);display:flex;align-items:center;justify-content:center;margin-bottom:16px}
.pcard h3{font-size:16px;font-weight:700;color:#fff;margin-bottom:6px}
.pcard p{color:#475569;font-size:13px;line-height:1.6;margin-bottom:20px}
.pcard .arrow{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--c);opacity:0.8}
.help{text-align:center;margin-top:56px;color:#334155;font-size:13px}
.help a{color:#2563eb;text-decoration:none}
</style></head><body>
<div class="topbar">
  <div class="logo">High <span>Velocity</span> Trading</div>
  <div class="user-badge"><strong>${s.name}</strong> <span class="plan-pill">${s.plan}</span></div>
</div>
<div class="portal-wrap">
  <div class="portal-heading">
    <h1>Welcome back, ${s.name}</h1>
    <p>Everything you need to trade at the highest level.</p>
  </div>
  <div class="cards">
    <a class="pcard" href="/course" style="--c:#f6ad55;--c2:#92610a;--cb:rgba(246,173,85,0.08);">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f6ad55" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/></svg>
        </div>
        <h3>Course Library</h3>
        <p>Step-by-step trading videos built on the HVT system. Learn at your own pace.</p>
        <div class="arrow">Watch Now &rarr;</div>
      </div>
    </a>
    <a class="pcard" href="/trading-room" style="--c:#2563eb;--c2:#1e3a8a;--cb:rgba(37,99,235,0.08);">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/></svg>
        </div>
        <h3>Trading Room</h3>
        <p>Activate your Discord access and trade live with the HVT team every market day.</p>
        <div class="arrow">Activate &rarr;</div>
      </div>
    </a>
    <a class="pcard" href="/billing/confirm-session" style="--c:#4ade80;--c2:#166534;--cb:rgba(74,222,128,0.08);">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z"/></svg>
        </div>
        <h3>Billing</h3>
        <p>View your subscription status, renewal date, and manage your membership.</p>
        <div class="arrow">View Billing &rarr;</div>
      </div>
    </a>
    <a class="pcard" href="https://highvelocitytrading.com" target="_blank" style="--c:#a78bfa;--c2:#4c1d95;--cb:rgba(167,139,250,0.08);">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253"/></svg>
        </div>
        <h3>HVT Website</h3>
        <p>Visit the main site for announcements, resources, and community updates.</p>
        <div class="arrow">Visit &rarr;</div>
      </div>
    </a>
  </div>
  <div class="help">Need help? Call <a href="tel:7864614235">786-461-4235</a> or email <a href="mailto:support@highvelocitytrading.com">support@highvelocitytrading.com</a></div>
</div>
</body></html>`);
});

// Billing shortcut via session (no re-auth needed)
app.get('/billing/confirm-session', requireSession, async (req, res) => {
    const s = getSession(req);
    try {
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,expires_at').eq('email', s.email).maybeSingle();
        const status  = data?.status || 'unknown';
        const exAt    = data?.expires_at ? new Date(data.expires_at) : null;
        const sc      = status === 'active' ? '#4ade80' : '#f87171';
        const sb      = status === 'active' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)';
        const sbd     = status === 'active' ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)';
        const next    = exAt ? exAt.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : 'N/A';
        const days    = exAt ? Math.max(0, Math.ceil((exAt - new Date()) / 86400000)) : 0;
        const cancel  = status === 'active'
            ? `<div style="margin-top:24px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);"><p style="color:#334155;font-size:12px;text-align:center;margin-bottom:16px;">Want to cancel?</p><a href="/cancel" style="display:block;width:100%;padding:12px;background:transparent;border:1px solid rgba(248,113,113,0.3);color:#f87171;border-radius:999px;font-size:14px;font-weight:700;text-align:center;text-decoration:none;">Cancel Membership</a></div>`
            : `<div style="margin-top:24px;text-align:center;"><p style="color:#64748b;font-size:13px;">Membership is no longer active.</p></div>`;
        res.send(shell('Billing', `
        <div class="card" style="max-width:480px;width:100%;"><div class="ct"></div><div class="cb">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <a href="/member" style="color:#2563eb;font-size:13px;text-decoration:none;">&larr; Back to Portal</a>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;margin-top:16px;">
            <div>
              <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:4px;">Welcome back</div>
              <div style="font-size:22px;font-weight:700;color:#fff;">${s.name}</div>
            </div>
            <div style="background:${sb};border:1px solid ${sbd};border-radius:20px;padding:6px 14px;font-size:12px;color:${sc};font-weight:600;">${status === 'active' ? '&#9679; Active' : status}</div>
          </div>
          <div class="div"></div>
          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Plan</span><span style="color:#94a3b8;font-size:13px;">${s.plan}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Email</span><span style="color:#94a3b8;font-size:13px;">${s.email}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Next Billing</span><span style="color:#94a3b8;font-size:13px;">${next}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;"><span style="color:#64748b;font-size:13px;">Days Remaining</span><span style="color:${days > 7 ? '#4ade80' : '#f6ad55'};font-size:13px;font-weight:600;">${days} days</span></div>
          </div>${cancel}
        </div></div>`));
    } catch(e) { console.error('[BillingSession]', e.message); res.redirect('/billing'); }
});

// ─── COURSE PLAYER (cookie-gated) ─────────────────────────────────────────────
app.get('/course', requireSession, (req, res) => {
    const s = getSession(req);
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Course — HVT</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{background:#080c14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;flex-direction:column}
/* TOPBAR */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:54px;border-bottom:1px solid rgba(255,255,255,0.07);background:#080c14;flex-shrink:0;z-index:100}
.topbar-left{display:flex;align-items:center;gap:16px}
.back-btn{display:flex;align-items:center;gap:6px;color:#475569;font-size:12px;text-decoration:none;font-weight:600;letter-spacing:0.5px;transition:color .15s}
.back-btn:hover{color:#94a3b8}
.logo{font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#fff;border-left:1px solid rgba(255,255,255,0.1);padding-left:16px}
.logo span{color:#f6ad55}
.user-pill{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:4px 12px;font-size:11px;color:#64748b;font-weight:600}
/* LAYOUT */
.layout{display:flex;flex:1;overflow:hidden}
/* SIDEBAR */
.sidebar{width:280px;flex-shrink:0;border-right:1px solid rgba(255,255,255,0.07);background:#080c14;display:flex;flex-direction:column;overflow:hidden}
.sidebar-header{padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0}
.sidebar-header h2{font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#475569}
.sidebar-scroll{flex:1;overflow-y:auto;padding:8px 0}
.sidebar-scroll::-webkit-scrollbar{width:4px}
.sidebar-scroll::-webkit-scrollbar-track{background:transparent}
.sidebar-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:2px}
/* SECTION */
.section{margin-bottom:2px}
.section-header{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;cursor:pointer;user-select:none;transition:background .15s}
.section-header:hover{background:rgba(255,255,255,0.03)}
.section-title{font-size:12px;font-weight:700;color:#94a3b8;letter-spacing:0.5px;flex:1}
.section-count{font-size:10px;color:#334155;font-weight:600;margin-right:8px}
.section-chevron{color:#334155;font-size:10px;transition:transform .2s}
.section.open .section-chevron{transform:rotate(90deg)}
.section-videos{display:none;padding:0 0 4px}
.section.open .section-videos{display:block}
/* VIDEO ITEM */
.video-item{display:flex;align-items:center;gap:12px;padding:9px 20px 9px 28px;cursor:pointer;transition:background .15s;position:relative}
.video-item:hover{background:rgba(255,255,255,0.03)}
.video-item.active{background:rgba(246,173,85,0.06)}
.video-item.active::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:#f6ad55}
.video-thumb{width:48px;height:30px;border-radius:5px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.video-thumb img{width:100%;height:100%;object-fit:cover}
.play-icon{width:14px;height:14px;color:#475569}
.video-item.active .play-icon{color:#f6ad55}
.video-info{flex:1;min-width:0}
.video-title{font-size:12px;font-weight:600;color:#64748b;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.video-item.active .video-title{color:#e2e8f0}
.video-dur{font-size:10px;color:#334155;margin-top:2px;font-weight:500}
/* MAIN */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#080c14}
.player-wrap{flex:1;display:flex;align-items:center;justify-content:center;background:#000;position:relative;min-height:0}
.player-wrap iframe{width:100%;height:100%;border:none}
.player-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#1e293b;text-align:center;padding:40px}
.player-placeholder svg{opacity:0.3}
.player-placeholder h3{font-size:20px;font-weight:700;color:#1e293b}
.player-placeholder p{font-size:13px;color:#1e293b;max-width:320px;line-height:1.6}
.video-meta{padding:20px 28px;border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;background:#080c14}
.video-meta h2{font-size:18px;font-weight:700;color:#fff;margin-bottom:4px}
.video-meta-sub{display:flex;align-items:center;gap:16px;font-size:12px;color:#475569}
.section-badge{background:rgba(246,173,85,0.1);border:1px solid rgba(246,173,85,0.2);border-radius:20px;padding:2px 10px;font-size:10px;font-weight:700;color:#f6ad55;letter-spacing:1px;text-transform:uppercase}
/* MOBILE */
@media(max-width:768px){
  .sidebar{position:fixed;left:-280px;top:54px;bottom:0;z-index:50;transition:left .25s;box-shadow:4px 0 24px rgba(0,0,0,0.4)}
  .sidebar.open{left:0}
  .layout{position:relative}
  .mob-menu{display:flex;align-items:center;justify-content:center;width:32px;height:32px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;cursor:pointer;color:#94a3b8;font-size:16px}
}
@media(min-width:769px){.mob-menu{display:none}}
</style></head><body>
<div class="topbar">
  <div class="topbar-left">
    <button class="mob-menu" onclick="toggleSidebar()" title="Menu">&#9776;</button>
    <a class="back-btn" href="/member">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>
      Portal
    </a>
    <div class="logo">HVT <span>Course</span></div>
  </div>
  <div class="user-pill">${s.name}</div>
</div>
<div class="layout">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header"><h2>Course Content</h2></div>
    <div class="sidebar-scroll" id="sidebarScroll">
      <!-- Sections injected by JS -->
    </div>
  </div>
  <div class="main">
    <div class="player-wrap" id="playerWrap">
      <div class="player-placeholder" id="placeholder">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/></svg>
        <h3>Select a lesson</h3>
        <p>Choose a video from the course menu on the left to get started.</p>
      </div>
      <iframe id="player" style="display:none" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen></iframe>
    </div>
    <div class="video-meta" id="videoMeta" style="display:none">
      <h2 id="videoTitle"></h2>
      <div class="video-meta-sub">
        <span class="section-badge" id="videoSection"></span>
        <span id="videoDur"></span>
      </div>
    </div>
  </div>
</div>
<script>
// ── COURSE DATA (add sections/videos here) ──────────────────────────────────
const COURSE = [
  {
    title: 'Psychology',
    videos: [
      { title: 'Welcome to HVT', duration: '1m', ytId: '' },
      { title: 'Why Traders Fail in the Long Run', duration: '4m', ytId: '' },
      { title: 'How to Set Yourself Up for Success', duration: '4m', ytId: '' },
      { title: 'Expand Your Horizon', duration: '3m', ytId: '' },
      { title: 'Next Steps', duration: '1m', ytId: '' },
    ]
  },
  {
    title: 'Basic Technicals',
    videos: [
      { title: 'Anatomy of a Candlestick', duration: '9m', ytId: '' },
      { title: 'Structure — Uptrend vs Downtrend', duration: '7m', ytId: '' },
    ]
  },
  // ── ADD MORE SECTIONS BELOW ──
  // { title: 'Section Name', videos: [ { title: 'Video Title', duration: '5m', ytId: 'YOUTUBE_ID' } ] }
];

// ── BUILD SIDEBAR ─────────────────────────────────────────────────────────────
let activeSection = 0, activeVideo = 0;
const scroll = document.getElementById('sidebarScroll');

function buildSidebar() {
  scroll.innerHTML = '';
  COURSE.forEach((sec, si) => {
    const secEl = document.createElement('div');
    secEl.className = 'section' + (si === activeSection ? ' open' : '');
    secEl.innerHTML = \`
      <div class="section-header" onclick="toggleSection(\${si})">
        <div class="section-title">\${sec.title}</div>
        <div class="section-count">\${sec.videos.length} videos</div>
        <div class="section-chevron">&#9654;</div>
      </div>
      <div class="section-videos">\${sec.videos.map((v, vi) => \`
        <div class="video-item\${si===activeSection&&vi===activeVideo?' active':''}" onclick="playVideo(\${si},\${vi})">
          <div class="video-thumb">
            \${v.ytId ? \`<img src="https://img.youtube.com/vi/\${v.ytId}/mqdefault.jpg" alt="">\` : \`<svg class="play-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"/></svg>\`}
          </div>
          <div class="video-info">
            <div class="video-title">\${v.title}</div>
            <div class="video-dur">\${v.duration}</div>
          </div>
        </div>\`).join('')}
      </div>\`;
    scroll.appendChild(secEl);
  });
}

function toggleSection(si) {
  const els = scroll.querySelectorAll('.section');
  els[si].classList.toggle('open');
}

function playVideo(si, vi) {
  activeSection = si; activeVideo = vi;
  buildSidebar();
  const v = COURSE[si].videos[vi];
  const player = document.getElementById('player');
  const placeholder = document.getElementById('placeholder');
  const meta = document.getElementById('videoMeta');
  if (v.ytId) {
    player.src = \`https://www.youtube.com/embed/\${v.ytId}?autoplay=1&rel=0\`;
    player.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    player.style.display = 'none';
    placeholder.style.display = 'flex';
    placeholder.innerHTML = \`<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/></svg><h3>Coming Soon</h3><p>This video will be available shortly.</p>\`;
  }
  document.getElementById('videoTitle').textContent = v.title;
  document.getElementById('videoSection').textContent = COURSE[si].title;
  document.getElementById('videoDur').textContent = v.duration;
  meta.style.display = 'flex';
  // Close sidebar on mobile after selection
  if (window.innerWidth < 769) document.getElementById('sidebar').classList.remove('open');
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

buildSidebar();
</script>
</body></html>`);
});

// ─── BILLING PORTAL ───────────────────────────────────────────────────────────
app.get('/billing', (req, res) => {
    res.send(shell('Billing Portal', `
    <div class="card"><div class="ct"></div><div class="cb">
      <div class="ttl">Billing Portal</div>
      <div class="sub">Enter your email and we'll send a secure link to your billing dashboard.</div>
      <div class="div"></div>
      <label for="email">Email Address</label>
      <input type="email" id="email" placeholder="your@email.com" />
      <button class="btn" id="btn" onclick="go()">Send Access Link</button>
      <div class="msg" id="msg"></div>
    </div></div>
    <script>
      async function go(){const email=document.getElementById('email').value.trim();const msg=document.getElementById('msg');const btn=document.getElementById('btn');msg.className='msg';if(!email){msg.className='msg er show';msg.textContent='Please enter your email.';return}btn.disabled=true;btn.textContent='Sending...';try{const r=await fetch('/billing/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\\u2713 Check your email! A secure link has been sent.';btn.textContent='Email Sent'}else{msg.className='msg er show';msg.textContent=d.error||'Something went wrong.';btn.disabled=false;btn.textContent='Send Access Link'}}catch{msg.className='msg er show';msg.textContent='Network error.';btn.disabled=false;btn.textContent='Send Access Link'}}
    </script>`));
});

app.post('/billing/request', frm, express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,status').eq('email', email).maybeSingle();
        if (!data) return res.status(404).json({ error: 'No membership found for this email' });
        const token   = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000).toISOString();
        await supabase.from(MEMBERSHIP_TABLE).update({ billing_token: token, billing_token_expires: expires, updated_at: nowISO() }).eq('email', email);
        await sendMagicLink(email, token, 'billing');
        res.json({ ok: true });
    } catch (e) { console.error('[BillingReq]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/billing/confirm', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid.'));
    try {
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,expires_at,billing_token_expires').eq('billing_token', token).maybeSingle();
        if (!data) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid or has expired.'));
        if (new Date(data.billing_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/billing" style="color:#2563eb;">Request a new one</a>.'));
        const { status, email, full_name: name = 'Member', expires_at } = data;
        const exAt    = expires_at ? new Date(expires_at) : null;
        const sc      = status === 'active' ? '#4ade80' : '#f87171';
        const sb      = status === 'active' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)';
        const sbd     = status === 'active' ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)';
        const next    = exAt ? exAt.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }) : 'N/A';
        const days    = exAt ? Math.max(0, Math.ceil((exAt - new Date()) / 86400000)) : 0;
        const cancel  = status === 'active' ? `<div style="margin-top:24px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);"><p style="color:#334155;font-size:12px;text-align:center;margin-bottom:16px;">Want to cancel?</p><a href="/cancel" style="display:block;width:100%;padding:12px;background:transparent;border:1px solid rgba(248,113,113,0.3);color:#f87171;border-radius:999px;font-size:14px;font-weight:700;text-align:center;text-decoration:none;">Cancel Membership</a></div>` : `<div style="margin-top:24px;text-align:center;"><p style="color:#64748b;font-size:13px;">Membership is no longer active.</p></div>`;
        res.send(shell('My Billing', `
        <div class="card" style="max-width:480px;width:100%;"><div class="ct"></div><div class="cb">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
            <div>
              <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:4px;">Welcome back</div>
              <div style="font-size:22px;font-weight:700;color:#fff;">${name}</div>
            </div>
            <div style="background:${sb};border:1px solid ${sbd};border-radius:20px;padding:6px 14px;font-size:12px;color:${sc};font-weight:600;">${status === 'active' ? '&#9679; Active' : status}</div>
          </div>
          <div class="div"></div>
          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Plan</span><span style="color:#94a3b8;font-size:13px;">HVT Monthly Membership</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Email</span><span style="color:#94a3b8;font-size:13px;">${email}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Next Billing</span><span style="color:#94a3b8;font-size:13px;">${next}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;"><span style="color:#64748b;font-size:13px;">Days Remaining</span><span style="color:${days > 7 ? '#4ade80' : '#f6ad55'};font-size:13px;font-weight:600;">${days} days</span></div>
          </div>${cancel}
        </div></div>`));
    } catch (e) { console.error('[BillingConfirm]', e.message); res.send(resultPage('error', 'Error', 'Something went wrong.')); }
});

// ─── CANCEL ───────────────────────────────────────────────────────────────────
app.get('/cancel', (req, res) => {
    res.send(shell('Cancel Membership', `
    <div class="card">
      <div class="ct" style="background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d);"></div>
      <div class="cb">
        <div class="ttl">Cancel Membership</div>
        <div class="sub">Enter your email and we'll send a secure one-time cancellation link.</div>
        <div class="div"></div>
        <label for="email">Email Address</label>
        <input type="email" id="email" placeholder="your@email.com" />
        <button class="btn btn-red" id="btn" onclick="go()">Send Cancellation Link</button>
        <div class="msg" id="msg"></div>
      </div>
    </div>
    <script>
      async function go(){const email=document.getElementById('email').value.trim();const msg=document.getElementById('msg');const btn=document.getElementById('btn');msg.className='msg';if(!email){msg.className='msg er show';msg.textContent='Please enter your email.';return}btn.disabled=true;btn.textContent='Sending...';try{const r=await fetch('/cancel/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\\u2713 Check your email! A secure cancellation link has been sent.';btn.textContent='Email Sent'}else{msg.className='msg er show';msg.textContent=d.error||'Something went wrong.';btn.disabled=false;btn.textContent='Send Cancellation Link'}}catch{msg.className='msg er show';msg.textContent='Network error.';btn.disabled=false;btn.textContent='Send Cancellation Link'}}
    </script>`));
});

app.post('/cancel/request', frm, express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,status').eq('email', email).maybeSingle();
        if (!data) return res.status(404).json({ error: 'No membership found for this email' });
        if (data.status === 'cancelled') return res.status(400).json({ error: 'This membership is already cancelled' });
        const token   = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000).toISOString();
        await supabase.from(MEMBERSHIP_TABLE).update({ cancel_token: token, cancel_token_expires: expires, updated_at: nowISO() }).eq('email', email);
        await sendMagicLink(email, token, 'cancel');
        res.json({ ok: true });
    } catch (e) { console.error('[CancelReq]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/cancel/confirm', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid.'));
    try {
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,status,authnet_subscription_id,cancel_token_expires,discord_user_id,nt_license_id').eq('cancel_token', token).maybeSingle();
        if (!data) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid or has expired.'));
        if (new Date(data.cancel_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/cancel" style="color:#f87171;">Request a new one</a>.'));
        if (data.status === 'cancelled') return res.send(resultPage('info', 'Already Cancelled', 'Your membership is already cancelled.'));
        if (data.authnet_subscription_id) try { await cancelSub(data.authnet_subscription_id); } catch (e) { console.error('[CancelSub]', e.message); }
        if (data.discord_user_id) try { await stripRole(data.discord_user_id, DISCORD_MONTHLY_ROLE_ID); } catch {}
        if (data.nt_license_id)   try { await ntRevokeLicense(data.nt_license_id); } catch {}
        await supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', cancel_token: null, cancel_token_expires: null, updated_at: nowISO() }).eq('cancel_token', token);
        console.log(`🚫 Cancelled: ${data.email}`);
        res.send(resultPage('success', 'Membership Cancelled', 'Your membership has been successfully cancelled.<br><br>You will retain access until the end of your current billing period.'));
    } catch (e) { console.error('[CancelConfirm]', e.message); res.send(resultPage('error', 'Error', 'Something went wrong. Please contact support.')); }
});

// ─── LIFETIME LICENSE WEBHOOKS ────────────────────────────────────────────────
app.post('/webhooks/authorize-net', wh, express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    try {
        const rawBody = req.body?.toString('utf8') || '';
        const sig     = verifyAuthnetSig(rawBody, req.headers['x-anet-signature']);
        if (!sig.ok) return res.status(401).json({ ok: false, error: 'invalid_signature', reason: sig.reason });
        let body = {};
        try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
        const txId  = pickFirst(body?.payload?.id);
        const eType = pickFirst(body?.eventType) || 'authorize_net';
        if (!txId) return res.status(400).json({ ok: false, error: 'missing_transaction_id' });
        const row = await upsertLicense(txId, { authorize_received: true, last_source: 'authorize', authorize_event_type: eType, raw_authorize: rawBody, authorize_body_json: body, status: 'pending_jotform' });
        if (row.email && row.full_name) {
            const act = await upsertLicense(txId, { authorize_received: true, last_source: 'authorize', status: 'active' });
            console.log(`✅ License (AN): ${act.email}`);
            return res.json({ ok: true, transaction_id: txId, status: act.status });
        }
        return res.json({ ok: true, transaction_id: txId, status: row.status });
    } catch (e) { console.error('[LicenseAN]', e); res.status(500).json({ ok: false, error: 'server_error' }); }
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
                // NT lifetime license — will be created when user activates via /trading-room using their NT email
                try { await sendWelcome(act.email, act.full_name, 'lifetime'); } catch (e) { console.error('[LicenseEmail]', e.message); }
                console.log(`✅ License activated: ${act.email} | ${act.license_key}`);
                return res.json({ ok: true, transaction_id: txId, license_key: act.license_key, status: act.status });
            }
            res.json({ ok: true, transaction_id: txId, license_key: row.license_key, status: row.status });
        } catch (e) { console.error('[LicenseJF]', e); res.status(500).json({ ok: false, error: 'server_error' }); }
    });
    req.pipe(bb);
});

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
function adminGuard(req, res, next) {
    const k = req.query.key || req.body?.key;
    if (!k || k !== ADMIN_SECRET) return res.status(403).send(resultPage('error', 'Access Denied', 'Invalid or missing admin key.'));
    next();
}

// ─── ADMIN: REFRESH NT TOKEN ──────────────────────────────────────────────────
app.post('/admin/refresh-nt-token', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    const ok = await ntLogin();
    if (ok) return res.json({ ok: true, message: '✅ NT re-authenticated successfully' });
    res.status(500).json({ ok: false, message: '❌ NT login failed — check NT_USERNAME / NT_PASSWORD in Railway env vars' });
});

app.get('/admin', adm, adminGuard, async (req, res) => {
    const key = req.query.key;
    const [{ data: members }, { data: licenses }, { data: discordMems }] = await Promise.all([
        supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,plan_name,expires_at,discord_user_id,nt_license_id').order('updated_at', { ascending: false }).limit(100),
        supabase.from(LICENSE_TABLE).select('email,full_name,status,license_key,nt_license_id').order('updated_at', { ascending: false }).limit(100),
        supabase.from(DISCORD_TABLE).select('email,full_name,status,expires_at,discord_user_id,discord_username').order('updated_at', { ascending: false }).limit(100)
    ]);
    let guildMembers = [];
    try { guildMembers = await getGuildAll(); } catch {}
    const allRoles = [DISCORD_MONTHLY_ROLE_ID, DISCORD_LIFETIME_ROLE_ID, ...(DISCORD_ROOM_ROLE_ID ? [DISCORD_ROOM_ROLE_ID] : [])];
    const liveHVT  = guildMembers.filter(m => m.roles?.some(r => allRoles.includes(r)));
    const ntStatus = ntToken ? '✓ Authenticated' : '✗ Not Authenticated';
    const ntColor  = ntToken ? '#4ade80' : '#f87171';

    const badge = (s, gold = false) => {
        const a = s === 'active';
        const c = a ? (gold ? '#f6ad55' : '#4ade80') : '#f87171';
        const b = a ? (gold ? 'rgba(246,173,85,0.08)' : 'rgba(74,222,128,0.08)') : 'rgba(248,113,113,0.08)';
        const d = a ? (gold ? 'rgba(246,173,85,0.2)' : 'rgba(74,222,128,0.2)') : 'rgba(248,113,113,0.2)';
        return `<span style="background:${b};border:1px solid ${d};border-radius:20px;padding:3px 10px;font-size:11px;color:${c};letter-spacing:1px;font-weight:600;">${s}</span>`;
    };
    const cancelBtn = (email, type, lbl) => `<button onclick="fireUser('${email}','${type}')" style="background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;letter-spacing:1px;cursor:pointer;">${lbl}</button>`;

    const memberRows = (members || []).map(m => {
        const exp = m.expires_at ? new Date(m.expires_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : 'N/A';
        const ntBadge = m.nt_license_id ? `<span style="color:#60a5fa;font-size:11px;">NT#${m.nt_license_id}</span>` : '<span style="color:#334155;font-size:11px;">—</span>';
        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);"><td style="padding:12px 14px;color:#94a3b8;font-size:13px;">${m.full_name || '—'}</td><td style="padding:12px 14px;color:#64748b;font-size:13px;">${m.email}</td><td style="padding:12px 14px;">${badge(m.status)}</td><td style="padding:12px 14px;color:#475569;font-size:12px;">${exp}</td><td style="padding:12px 14px;">${ntBadge}</td><td style="padding:12px 14px;">${m.status === 'active' ? cancelBtn(m.email, 'monthly', 'CANCEL') : '<span style="color:#334155;font-size:12px;">Inactive</span>'}</td></tr>`;
    }).join('');
    const licenseRows = (licenses || []).map(l => {
        const ntBadge = l.nt_license_id ? `<span style="color:#60a5fa;font-size:11px;">NT#${l.nt_license_id}</span>` : '<span style="color:#334155;font-size:11px;">—</span>';
        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);"><td style="padding:12px 14px;color:#94a3b8;font-size:13px;">${l.full_name || '—'}</td><td style="padding:12px 14px;color:#64748b;font-size:13px;">${l.email}</td><td style="padding:12px 14px;">${badge(l.status, true)}</td><td style="padding:12px 14px;color:#475569;font-size:12px;font-family:monospace;">${l.license_key}</td><td style="padding:12px 14px;">${ntBadge}</td><td style="padding:12px 14px;">${l.status === 'active' ? cancelBtn(l.email, 'lifetime', 'REVOKE') : '<span style="color:#334155;font-size:12px;">Inactive</span>'}</td></tr>`;
    }).join('');
    const discordRows = (discordMems || []).map(d => {
        const exp = d.expires_at ? new Date(d.expires_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : 'N/A';
        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);"><td style="padding:12px 14px;color:#94a3b8;font-size:13px;">${d.full_name || '—'}</td><td style="padding:12px 14px;color:#64748b;font-size:13px;">${d.email}</td><td style="padding:12px 14px;">${badge(d.status)}</td><td style="padding:12px 14px;color:#475569;font-size:12px;">${exp}</td><td style="padding:12px 14px;color:#a78bfa;font-size:12px;">${d.discord_username || (d.discord_user_id ? '✓ Linked' : '—')}</td><td style="padding:12px 14px;">${d.status === 'active' ? cancelBtn(d.email, 'discord', 'CANCEL') : '<span style="color:#334155;font-size:12px;">Inactive</span>'}</td></tr>`;
    }).join('');
    const liveRows = liveHVT.map(m => `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);"><td style="padding:12px 14px;color:#94a3b8;font-size:13px;">${m.nick || '—'}</td><td style="padding:12px 14px;color:#a78bfa;font-size:13px;">@${m.user.username}</td><td style="padding:12px 14px;color:#475569;font-size:11px;font-family:monospace;">${m.user.id}</td><td style="padding:12px 14px;"><button onclick="removeRoleById('${m.user.id}','${m.user.username}')" style="background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;letter-spacing:1px;cursor:pointer;">REMOVE ROLE</button></td></tr>`).join('');

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>HVT Admin</title><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'DM Sans',sans-serif;background:#000;min-height:100vh;padding:32px 24px;color:#fff;}.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.06);}.brand{font-size:20px;font-weight:700;letter-spacing:3px;text-transform:uppercase;}.restricted{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:20px;padding:5px 14px;font-size:11px;color:#f87171;letter-spacing:2px;font-weight:700;}.sec{margin-bottom:36px;}.sec-ttl{font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#64748b;margin-bottom:16px;}.panel{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;}.pt{height:3px;background:linear-gradient(90deg,#1e3a8a,#2563eb,#1e3a8a);}.pt-red{background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d);}.pt-gold{background:linear-gradient(90deg,#92610a,#f6ad55,#92610a);}.pt-purple{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95);}.pt-green{background:linear-gradient(90deg,#14532d,#16a34a,#14532d);}.pt-cyan{background:linear-gradient(90deg,#164e63,#06b6d4,#164e63);}table{width:100%;border-collapse:collapse;}th{padding:12px 14px;text-align:left;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#334155;border-bottom:1px solid rgba(255,255,255,0.06);}.fc{padding:28px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;margin-bottom:20px;}.gc{padding:28px;background:rgba(124,58,237,0.05);border:1px solid rgba(124,58,237,0.15);border-radius:16px;margin-bottom:20px;}.ntc{padding:28px;background:rgba(6,182,212,0.04);border:1px solid rgba(6,182,212,0.15);border-radius:16px;margin-bottom:20px;}.bar{height:3px;margin:-28px -28px 24px;border-radius:16px 16px 0 0;}.bar-red{background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d);}.bar-purple{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95);}.bar-cyan{background:linear-gradient(90deg,#164e63,#06b6d4,#164e63);}input[type=email],input[type=text],input[type=password],select,textarea{width:100%;padding:12px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#fff;font-size:14px;outline:none;font-family:'DM Sans',sans-serif;margin-bottom:12px;}input:focus,select:focus,textarea:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,0.15);}input::placeholder,textarea::placeholder{color:#334155;}.btn-red{padding:12px 32px;background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 20px rgba(220,38,38,0.3);}.btn-purple{padding:12px 32px;background:linear-gradient(135deg,#4c1d95,#7c3aed);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 20px rgba(124,58,237,0.35);}.btn-cyan{padding:12px 32px;background:linear-gradient(135deg,#164e63,#06b6d4);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 20px rgba(6,182,212,0.3);}.msg{margin-top:12px;padding:12px 16px;border-radius:10px;font-size:13px;display:none;line-height:1.5;}.msg.show{display:block;}.ok{background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2);}.er{background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2);}.tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;}.tab{padding:8px 18px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;border:1px solid rgba(255,255,255,0.08);color:#64748b;background:transparent;transition:all .2s;}.tab.active{background:rgba(37,99,235,0.1);border-color:rgba(37,99,235,0.3);color:#2563eb;}.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:1000;align-items:center;justify-content:center;}.overlay.show{display:flex;}.modal{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:32px;max-width:420px;width:90%;text-align:center;backdrop-filter:blur(20px);}.mttl{font-size:20px;font-weight:700;color:#fff;margin-bottom:12px;}.msub{color:#94a3b8;font-size:14px;line-height:1.6;margin-bottom:24px;}.mbtns{display:flex;gap:12px;}.mok{flex:1;padding:12px;background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;cursor:pointer;}.mno{flex:1;padding:12px;background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.1);border-radius:999px;font-size:14px;font-weight:700;cursor:pointer;}label{display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;}.lred{color:#64748b;}.lpurp{color:#7c3aed;}.lcyan{color:#06b6d4;}</style></head><body>
<div class="hdr"><div><div class="brand">High Velocity Trading</div><div style="font-size:10px;color:#334155;letter-spacing:4px;text-transform:uppercase;margin-top:3px;">Admin Control Panel</div></div><div style="display:flex;align-items:center;gap:12px;"><span style="font-size:12px;color:${ntColor};font-weight:600;">NT ${ntStatus}</span><div class="restricted">&#9888; RESTRICTED</div></div></div>

<div class="sec"><div class="sec-ttl">&#9670; NinjaTrader API Status</div><div class="ntc"><div class="bar bar-cyan"></div><div style="margin-bottom:20px;"><div style="font-size:16px;font-weight:700;color:#67e8f9;margin-bottom:4px;">NT Ecosystem API</div><div style="color:#64748b;font-size:13px;">Auto-authenticates every 45 min using stored credentials. Click below to force re-login immediately.</div></div><div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;"><div style="background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.2);border-radius:20px;padding:6px 16px;font-size:13px;color:${ntColor};font-weight:700;">${ntStatus}</div><div style="color:#334155;font-size:12px;">Auth failures: ${ntAuthFails}</div></div><button class="btn-cyan" onclick="refreshNT()">&#8635; FORCE RE-LOGIN NOW</button><div class="msg" id="ntMsg"></div></div></div>

<div class="sec"><div class="sec-ttl">&#9889; God Mode — Instant Discord Role</div><div class="gc"><div class="bar bar-purple"></div><div style="font-size:16px;font-weight:700;color:#c4b5fd;margin-bottom:6px;">Add Any Discord User Instantly</div><div style="color:#64748b;font-size:13px;margin-bottom:20px;">Bypasses everything. Type a Discord username, pick the role, done. They must already be in the server.</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;"><div><label class="lpurp">Discord Username</label><input type="text" id="godUser" placeholder="theirDiscordUsername" style="margin-bottom:0;" /></div><div><label class="lpurp">Role to Assign</label><select id="godRole" style="margin-bottom:0;"><option value="monthly">Monthly Member</option><option value="lifetime">Lifetime Member</option><option value="discord">Discord Room ($37)</option></select></div></div><button class="btn-purple" onclick="godMode()">&#9889; ASSIGN ROLE NOW</button><div class="msg" id="godMsg"></div></div></div>
<div class="sec"><div class="sec-ttl">Manual Access Removal</div><div class="fc"><div class="bar bar-red"></div><div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px;">Cancel / Revoke by Email</div><div style="color:#64748b;font-size:13px;margin-bottom:20px;">Cancels subscription, removes Discord role, revokes NT license, marks account cancelled.</div><label class="lred">Member Email</label><input type="email" id="manualEmail" placeholder="member@email.com" /><label class="lred">Membership Type</label><select id="manualType"><option value="monthly">Monthly Membership</option><option value="lifetime">Lifetime License</option><option value="discord">Discord Room ($37)</option></select><button class="btn-red" onclick="openModal()">&#128293; CANCEL ACCESS</button><div class="msg" id="manualMsg"></div></div></div>
<div class="sec"><div class="sec-ttl">Member Management</div><div class="tabs"><button class="tab active" onclick="showTab('monthly',this)">Monthly (${(members||[]).length})</button><button class="tab" onclick="showTab('lifetime',this)">Lifetime (${(licenses||[]).length})</button><button class="tab" onclick="showTab('discord37',this)">Discord $37 (${(discordMems||[]).length})</button><button class="tab" onclick="showTab('live',this)">Live on Discord (${liveHVT.length})</button></div>
<div id="tab-monthly" class="panel"><div class="pt"></div><div style="overflow-x:auto;"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Expires</th><th>NT License</th><th>Action</th></tr></thead><tbody>${memberRows || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#334155;">No records</td></tr>'}</tbody></table></div></div>
<div id="tab-lifetime" class="panel" style="display:none;"><div class="pt pt-gold"></div><div style="overflow-x:auto;"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>License Key</th><th>NT License</th><th>Action</th></tr></thead><tbody>${licenseRows || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#334155;">No records</td></tr>'}</tbody></table></div></div>
<div id="tab-discord37" class="panel" style="display:none;"><div class="pt pt-purple"></div><div style="overflow-x:auto;"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Expires</th><th>Discord Username</th><th>Action</th></tr></thead><tbody>${discordRows || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#334155;">No records</td></tr>'}</tbody></table></div></div>
<div id="tab-live" class="panel" style="display:none;"><div class="pt pt-green"></div><div style="padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><p style="color:#64748b;font-size:12px;">Members currently in your Discord server with an HVT role. REMOVE ROLE strips all HVT roles instantly.</p></div><div style="overflow-x:auto;"><table><thead><tr><th>Display Name</th><th>Username</th><th>Discord ID</th><th>Action</th></tr></thead><tbody>${liveRows || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#334155;">No members with HVT roles found</td></tr>'}</tbody></table></div></div></div>
<div class="overlay" id="overlay"><div class="modal"><div style="font-size:32px;margin-bottom:16px;">&#9888;&#65039;</div><div class="mttl">Confirm Action</div><div class="msub" id="modalSub"></div><div class="mbtns"><button class="mno" onclick="closeModal()">BACK</button><button class="mok" onclick="confirm()">CONFIRM</button></div></div></div>
<script>const KEY='${key}';let pending=null;
async function refreshNT(){const msg=document.getElementById('ntMsg');msg.className='msg';try{const r=await fetch('/admin/refresh-nt-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent=d.message||'\u2713 Done'}else{msg.className='msg er show';msg.textContent=d.message||'Error.'}}catch{msg.className='msg er show';msg.textContent='Network error.'}}
function showTab(n,el){['monthly','lifetime','discord37','live'].forEach(t=>document.getElementById('tab-'+t).style.display='none');document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));document.getElementById('tab-'+n).style.display='block';el.classList.add('active')}function openModal(){const email=document.getElementById('manualEmail').value.trim();const type=document.getElementById('manualType').value;if(!email){const m=document.getElementById('manualMsg');m.className='msg er show';m.textContent='Please enter an email.';return}pending={action:'cancel',email,type};document.getElementById('modalSub').innerHTML='Cancel access for:<br><strong style="color:#f87171;">'+email+'</strong><br><br>Discord role and NT license will be removed immediately.';document.getElementById('overlay').classList.add('show')}function closeModal(){document.getElementById('overlay').classList.remove('show');pending=null}async function confirm(){closeModal();if(!pending)return;if(pending.action==='cancel')await doCancel(pending.email,pending.type);if(pending.action==='removeRole')await doRemoveRole(pending.uid,pending.username)}function fireUser(email,type){document.getElementById('manualEmail').value=email;document.getElementById('manualType').value=type;openModal()}async function doCancel(email,type){const msg=document.getElementById('manualMsg');msg.className='msg';try{const r=await fetch('/admin/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,type,key:KEY})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\\u2713 Cancelled: '+email;setTimeout(()=>location.reload(),1800)}else{msg.className='msg er show';msg.textContent=d.error||'Error.'}}catch{msg.className='msg er show';msg.textContent='Network error.'}}function removeRoleById(uid,username){pending={action:'removeRole',uid,username};document.getElementById('modalSub').innerHTML='Strip ALL HVT roles from:<br><strong style="color:#a78bfa;">@'+username+'</strong><br><br>They will lose Discord access immediately.';document.getElementById('overlay').classList.add('show')}async function doRemoveRole(uid,username){const msg=document.getElementById('manualMsg');msg.className='msg';try{const r=await fetch('/admin/remove-role',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({discord_user_id:uid,key:KEY})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\\u2713 Roles removed from @'+username;setTimeout(()=>location.reload(),1800)}else{msg.className='msg er show';msg.textContent=d.error||'Error.'}}catch{msg.className='msg er show';msg.textContent='Network error.'}}async function godMode(){const username=document.getElementById('godUser').value.trim();const role=document.getElementById('godRole').value;const msg=document.getElementById('godMsg');msg.className='msg';if(!username){msg.className='msg er show';msg.textContent='Please enter a Discord username.';return}try{const r=await fetch('/admin/god-add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({discord_username:username,role,key:KEY})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\\u26a1 Role assigned to @'+username+'!'}else{msg.className='msg er show';msg.textContent=d.error||'Error.'}}catch{msg.className='msg er show';msg.textContent='Network error.'}}document.getElementById('overlay').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal()});</script></body></html>`);
});

app.post('/admin/cancel', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        const type  = req.body.type || 'monthly';
        if (!email) return res.status(400).json({ error: 'Email required' });
        if (type === 'lifetime') {
            const { data: l } = await supabase.from(LICENSE_TABLE).select('nt_license_id').eq('email', email).maybeSingle();
            if (l?.nt_license_id) try { await ntRevokeLicense(l.nt_license_id); } catch {}
            await supabase.from(LICENSE_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email);
            console.log(`[Admin] Lifetime revoked: ${email}`);
        } else if (type === 'discord') {
            const { data: dm } = await supabase.from(DISCORD_TABLE).select('discord_user_id,authnet_subscription_id').eq('email', email).maybeSingle();
            if (!dm) return res.status(404).json({ error: 'No Discord membership found' });
            if (dm.authnet_subscription_id) try { await cancelSub(dm.authnet_subscription_id); } catch {}
            const rid = DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID;
            if (dm.discord_user_id) try { await stripRole(dm.discord_user_id, rid); } catch {}
            await supabase.from(DISCORD_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email);
            console.log(`[Admin] Discord cancelled: ${email}`);
        } else {
            const { data: m } = await supabase.from(MEMBERSHIP_TABLE).select('authnet_subscription_id,discord_user_id,nt_license_id').eq('email', email).maybeSingle();
            if (!m) return res.status(404).json({ error: 'No membership found' });
            if (m.authnet_subscription_id) try { await cancelSub(m.authnet_subscription_id); } catch {}
            if (m.discord_user_id) try { await stripRole(m.discord_user_id, DISCORD_MONTHLY_ROLE_ID); } catch {}
            if (m.nt_license_id)   try { await ntRevokeLicense(m.nt_license_id); } catch {}
            await supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email);
            console.log(`[Admin] Monthly cancelled: ${email}`);
        }
        res.json({ ok: true });
    } catch (e) { console.error('[AdminCancel]', e.message); res.status(500).json({ error: e.message }); }
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
        console.log(`[Admin] All roles stripped: ${uid}`);
        res.json({ ok: true });
    } catch (e) { console.error('[AdminRemoveRole]', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/admin/god-add', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const username = (req.body.discord_username || '').trim();
        const role     = req.body.role || 'monthly';
        if (!username) return res.status(400).json({ error: 'discord_username required' });
        const found = await findUser(username);
        if (!found) return res.status(404).json({ error: `@${username} not found in the HVT server. They must join the server first.` });
        const uid = found.user.id;
        const rid = role === 'lifetime' ? DISCORD_LIFETIME_ROLE_ID : (role === 'discord' ? (DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID) : DISCORD_MONTHLY_ROLE_ID);
        await addRole(uid, rid);
        console.log(`[God Mode] @${username} (${uid}) → role: ${role} (${rid})`);
        res.json({ ok: true, discord_user_id: uid, role });
    } catch (e) { console.error('[GodMode]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

app.listen(PORT, () => console.log(`🚀 HVT Backend on port ${PORT}`));
