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
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8154;

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
const DISCORD_INVITE_URL       = process.env.DISCORD_INVITE_URL       || 'https://discord.com/invite/J3vjw4qz';
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

// Exact password scramble from NT Ecosystem source (wr function)
function ntScramblePassword(name, password) {
    const n = name.length % password.toString().length;
    const rotated = password.toString().slice(n) + password.toString().slice(0, n);
    const reversed = rotated.split('').reverse().join('');
    return Buffer.from(reversed).toString('base64');
}

// Exact challenge-response from NT Ecosystem source (Kt function)
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

// Login on startup, renew every 45 min
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

// ─── SUPABASE ────────────────────────────────────────────────────────────────
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    console.log(`[INIT] ${MEMBERSHIP_TABLE} | ${LICENSE_TABLE} | ${DISCORD_TABLE}`);
} else {
    console.warn('[WARN] Missing Supabase env. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env for login/membership. Server will start.');
}
// ─── SUPABASE STORAGE DOWNLOADS ──────────────────────────────────────────────
const DOWNLOAD_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';

// MUST match exactly the filenames in Supabase Storage
const FILES = {
  template: 'HVT NQ TEMPLATE.xml',
  master:   'HVTMasterAccessNQ.zip'
};

async function signedDownloadUrl(objectPath) {
  if (!supabase) throw new Error('Supabase client not configured');
  const { data, error } = await supabase.storage
    .from(DOWNLOAD_BUCKET)
    .createSignedUrl(objectPath, 60); // 60 seconds

  if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not create signed URL');
  return data.signedUrl;
}
// ─── SUPABASE STORAGE DOWNLOADS ──────────────────────────────────────────────
const DOWNLOAD_BUCKET = 'uploads';

// MUST match exactly the filenames in Supabase Storage
const FILES = {
  template: 'HVT NQ TEMPLATE.xml',
  master:   'HVTMasterAccessNQ.zip',
};

async function signedDownloadUrl(objectPath) {
  const { data, error } = await supabase
    .storage
    .from(DOWNLOAD_BUCKET)
    .createSignedUrl(objectPath, 60); // 60 seconds

  if (error || !data?.signedUrl) {
    throw new Error(error?.message || 'Could not create signed URL');
  }
  return data.signedUrl;
}

app.get('/download/:which', frm, async (req, res) => {
  try {
    if (!supabase) return res.status(503).send('Supabase not configured');

    const which = req.params.which;
    const objectPath = FILES[which];
    if (!objectPath) return res.status(404).send('Invalid download');

    const url = await signedDownloadUrl(objectPath);

    // Redirect triggers the browser download
    return res.redirect(302, url);
  } catch (e) {
    console.error('[DOWNLOAD]', e.message);
    return res.status(500).send('Download error');
  }
});
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
    const name     = fullName?.split(' ')[0] || 'Trader';
    const monthly  = type === 'monthly';
    const subject  = monthly ? 'Welcome to HVT Monthly Membership!' : 'Welcome to HVT Lifetime Access!';
    const badge    = monthly ? 'Monthly Membership Activation' : 'Lifetime Access Activation';
    const accent   = monthly ? '#2254F5' : '#f6ad55';
    const badgeBg  = monthly ? 'rgba(34,84,245,0.08)'  : 'rgba(246,173,85,0.08)';
    const badgeBrd = monthly ? 'rgba(34,84,245,0.2)'   : 'rgba(246,173,85,0.2)';
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
        <a href="${APP_URL}/trading-room" style="display:inline-block;background:#2254F5;color:#fff;text-decoration:none;padding:16px 48px;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;box-shadow:0 4px 24px rgba(34,84,245,0.4);">ACTIVATE TRADING ROOM</a>
      </div>
      <div style="background:rgba(34,84,245,0.04);border:1px solid rgba(34,84,245,0.12);border-radius:10px;padding:16px 20px;text-align:center;">
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
        <div style="display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.2);border-radius:20px;padding:6px 18px;margin-bottom:20px;">
          <span style="color:#2254F5;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Discord Trading Room Access</span>
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
            <div style="width:36px;height:36px;border-radius:50%;background:#2254F5;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;flex-shrink:0;margin-top:2px;">1</div>
            <div style="flex:1;">
              <div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:6px;">Join the HVT Discord Server</div>
              <div style="color:#94a3b8;font-size:13px;line-height:1.6;margin-bottom:16px;">Click the button below to visit our website and join the Discord server. <strong style="color:#fff;">You must join the server first</strong> before you can get your Trading Room role.</div>
              <a href="https://highvelocitytrading.com" style="display:inline-block;background:#2254F5;color:#fff;text-decoration:none;padding:13px 28px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">JOIN DISCORD SERVER &rarr;</a>
            </div>
          </div>
        </div>
        <div style="padding:22px 24px;">
          <div style="display:flex;align-items:flex-start;gap:16px;">
            <div style="width:36px;height:36px;border-radius:50%;background:#2254F5;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;flex-shrink:0;margin-top:2px;">2</div>
            <div style="flex:1;">
              <div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:6px;">Activate Your Trading Room Role</div>
              <div style="color:#94a3b8;font-size:13px;line-height:1.6;margin-bottom:16px;">Once you have joined the server, click the button below. You will enter <strong style="color:#fff;">this email address</strong> and your <strong style="color:#fff;">Discord username</strong> &mdash; your Trading Room role will be assigned instantly.</div>
              <a href="${activateLink}" style="display:inline-block;background:#2254F5;color:#fff;text-decoration:none;padding:13px 28px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">ACTIVATE MY ROLE &rarr;</a>
            </div>
          </div>
        </div>
      </div>
      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px 18px;margin-bottom:20px;">
        <p style="color:#475569;font-size:12px;line-height:1.6;margin:0;">&#128161; <strong style="color:#94a3b8;">Finding your Discord username:</strong> Open Discord &rarr; click your profile photo at the bottom left &rarr; your username is shown below your display name (lowercase, may include numbers e.g. <em>johntrader22</em>).</p>
      </div>
      <div style="background:rgba(34,84,245,0.04);border:1px solid rgba(34,84,245,0.12);border-radius:10px;padding:16px 20px;text-align:center;">
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
        <div style="display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.2);border-radius:20px;padding:6px 18px;margin-bottom:20px;">
          <span style="color:#2254F5;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Member Access</span>
        </div>
        <h2 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 8px;">Your Access Link is Ready</h2>
        <p style="color:#94a3b8;font-size:14px;margin:0;">Expires in <strong style="color:#fff;">24 hours</strong>. Do not share this link.</p>
      </div>
      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.1),transparent);margin:28px 0;"></div>
      <div style="text-align:center;margin-bottom:28px;">
        <a href="${url}" style="display:inline-block;background:#2254F5;color:#fff;text-decoration:none;padding:16px 48px;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;box-shadow:0 4px 24px rgba(34,84,245,0.35);">ACCESS MEMBER PORTAL</a>
      </div>
      <p style="text-align:center;color:#334155;font-size:12px;margin-bottom:24px;">Secure link &middot; Expires in 24 hours</p>
      <div style="background:rgba(34,84,245,0.04);border:1px solid rgba(34,84,245,0.12);border-radius:10px;padding:14px 18px;">
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
    const btnColor  = isBilling ? '#2254F5' : '#dc2626';
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
      <div style="background:rgba(34,84,245,0.04);border:1px solid rgba(34,84,245,0.12);border-radius:10px;padding:14px 18px;">
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
function shell(title, body, hero) {
    const pill = (hero && hero.pill) ? hero.pill : 'MEMBER PORTAL';
    const heroTitle = (hero && hero.title) ? hero.title : 'Your Edge Starts Here';
    const heroSub = (hero && hero.sub) ? hero.sub : 'Access your live trading room, course, and billing — all in one place.';
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} – High Velocity Trading</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Bebas+Neue&family=Montserrat:wght@800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Sans',sans-serif;background:#000000;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:100px 20px 24px;color:#fff;position:relative;overflow-x:hidden;}
.hvt-bg{position:fixed;inset:0;z-index:0;pointer-events:none;background:#000000;}
.hvt-bg::before{content:'';position:absolute;top:0;left:0;width:65%;height:65%;background:radial-gradient(ellipse at 15% 30%,#00001C 0%,transparent 65%);pointer-events:none;}
.hero{text-align:center;margin-bottom:16px;position:relative;z-index:1;}
.hero-pill{display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.25);border-radius:999px;color:#2254F5;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-family:'DM Sans',sans-serif;padding:6px 18px;}
.hero h1{font-family:'DM Sans',sans-serif;font-weight:700;font-size:42px;color:#ffffff;line-height:1.15;letter-spacing:-0.5px;margin:16px 0 12px;}
.hero-sub{font-family:'DM Sans',sans-serif;font-weight:400;font-size:15px;color:#94a3b8;line-height:1.6;max-width:360px;margin:0 auto 0;}
.hero-div{height:1px;background:linear-gradient(90deg,transparent,rgba(34,84,245,0.3),transparent);margin:16px auto 0;max-width:200px;}
.topnav-wrap{position:fixed;top:0;left:0;right:0;z-index:10;}
.topnav{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:52px;width:100%;background:rgba(10,10,12,0.6);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,0.06);position:relative;}
.topnav-logo{display:flex;align-items:center;gap:0;text-decoration:none;}
.topnav-logo img{height:40px;width:auto;}
.topnav-left{display:flex;align-items:center;gap:12px;}
.topnav-left a.topnav-link{color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;letter-spacing:0.2px;padding:8px 0;transition:color .2s;}
.topnav-left a.topnav-link:hover{color:rgba(255,255,255,0.85);}
.topnav-right{display:flex;align-items:center;gap:12px;flex-shrink:0;}
.topnav-right a.topnav-link,.topnav-right a.topnav-out{color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;letter-spacing:0.2px;padding:8px 0;transition:color .2s;}
.topnav-right a.topnav-link:hover,.topnav-right a.topnav-out:hover{color:rgba(255,255,255,0.85);}
.topnav-cta{display:inline-block;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.9);font-size:13px;font-weight:500;text-decoration:none;padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);letter-spacing:0.2px;transition:background .2s,color .2s,border-color .2s;}
.topnav-cta:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.18);}
.card{width:100%;max-width:460px;background:rgba(255,255,255,0.03);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(34,84,245,0.2);border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.6);position:relative;z-index:1;}
.ct{height:3px;background:linear-gradient(90deg,#2254F5,#2254F5,#2254F5);}
.cb{padding:36px 32px;}
.ttl{font-size:22px;font-weight:700;letter-spacing:0.5px;color:#fff;margin-bottom:8px;}
.sub{color:#64748b;font-size:13px;line-height:1.6;margin-bottom:28px;}
.div{height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.1),transparent);margin-bottom:28px;}
label{display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:8px;}
input[type=email],input[type=text]{width:100%;padding:13px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:#fff;font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s;margin-bottom:20px;font-family:'DM Sans',sans-serif;}
input:focus{border-color:#2254F5;box-shadow:0 0 0 3px rgba(34,84,245,0.2);}
input::placeholder{color:#334155;}
.btn{width:100%;padding:14px;background:#2254F5;color:#fff;border:none;border-radius:999px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 20px rgba(34,84,245,0.3);transition:opacity .2s,transform .1s;}
.btn:hover{opacity:.9;transform:translateY(-1px);}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none;}
.btn-red{background:linear-gradient(135deg,#991b1b,#dc2626);box-shadow:0 4px 20px rgba(220,38,38,0.3);}
.msg{margin-top:16px;padding:12px 16px;border-radius:12px;font-size:13px;text-align:center;display:none;line-height:1.5;}
.msg.show{display:block;}
.ok{background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2);}
.er{background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2);}
.fl{text-align:center;margin-top:20px;font-size:12px;color:#334155;position:relative;z-index:1;}
.fl a{color:#64748b;text-decoration:none;}
.ntBadge{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:rgba(34,84,245,0.05);border:1px solid rgba(34,84,245,0.18);margin-bottom:18px;}
.ntIcon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:rgba(34,84,245,0.12);border:1px solid rgba(34,84,245,0.22);flex-shrink:0;}
.ntTitle{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#2254F5;font-weight:700;line-height:1;}
.ntDesc{color:#94a3b8;font-size:12.5px;line-height:1.55;margin-top:6px;}
.nt-signup-wrap{text-align:center;margin-top:12px;}
.nt-signup-btn{display:inline-block;padding:10px 18px;background:#D9452A;color:#000;border:none;border-radius:8px;font-family:'Montserrat',sans-serif;font-size:15px;font-weight:800;letter-spacing:1.5px;text-decoration:none;box-shadow:0 4px 16px rgba(217,69,42,0.4);transition:transform .2s ease,box-shadow .2s ease,background .2s ease;margin-left:-36px;}
.nt-signup-btn:hover{transform:scale(1.06);box-shadow:0 6px 24px rgba(217,69,42,0.5);background:#E04F35;}
.tr-install-btn{display:inline-block;padding:12px 24px;background:#2254F5;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:8px;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;letter-spacing:0.5px;text-decoration:none;box-shadow:0 2px 12px rgba(34,84,245,0.25);transition:background .2s,box-shadow .2s,transform .2s;}
.tr-install-btn:hover{background:#2d5cf7;box-shadow:0 4px 20px rgba(34,84,245,0.35);transform:translateY(-1px);}
.tr-install-btn:active{transform:translateY(0);box-shadow:0 1px 8px rgba(34,84,245,0.2);}
.discord-join-btn{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;background:#5865F2;color:#fff;border-radius:999px;font-size:13px;font-weight:700;text-decoration:none;transition:background .2s,transform .1s;}
.discord-join-btn:hover{background:#4752C4;transform:translateY(-1px);}
.discord-join-btn img{height:26px;width:auto;object-fit:contain;flex-shrink:0;display:block;}
</style></head><body>
<div class="hvt-bg" aria-hidden="true"></div>
<div class="topnav-wrap">
  <nav class="topnav">
    <div class="topnav-left">
      <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="topnav-logo"><img src="/hvt-logo.png" alt="High Velocity Trading" /></a>
    </div>
    <div class="topnav-right" style="display:flex;align-items:center;gap:12px;">
      <a href="/member" class="topnav-link" style="color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;padding:8px 0;">Portal</a>
      <a href="/billing/confirm-session" class="topnav-out" style="color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;padding:8px 0;">Billing</a>
      <a href="/logout" class="topnav-out" style="color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;padding:8px 0;">Log out</a>
      <a href="tel:786-461-4235" class="topnav-cta">Call Us</a>
    </div>
  </nav>
</div>
<div class="hero">
  <span class="hero-pill">${pill}</span>
  <h1>${heroTitle}</h1>
  <p class="hero-sub">${heroSub}</p>
  <div class="hero-div"></div>
</div>
${body}
<div class="fl" style="margin-top:20px;"><a href="https://highvelocitytrading.com">&larr; highvelocitytrading.com</a></div>
</body></html>`;
}

function resultPage(type, title, msg) {
    const m = { success:{i:'&#10003;',c:'#4ade80',b:'rgba(74,222,128,0.08)',r:'rgba(74,222,128,0.2)'}, error:{i:'&#10005;',c:'#f87171',b:'rgba(248,113,113,0.08)',r:'rgba(248,113,113,0.2)'}, info:{i:'&#8505;',c:'#2254F5',b:'rgba(34,84,245,0.08)',r:'rgba(34,84,245,0.2)'} }[type] || {i:'&#10005;',c:'#f87171',b:'rgba(248,113,113,0.08)',r:'rgba(248,113,113,0.2)'};
    return shell(title, `<div class="card" style="max-width:460px;width:100%;"><div class="ct"></div><div class="cb" style="text-align:center;">
      <div style="width:56px;height:56px;border-radius:50%;background:${m.b};border:1px solid ${m.r};display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:22px;color:${m.c};">${m.i}</div>
      <div class="ttl" style="margin-bottom:16px;">${title}</div>
      <div style="background:${m.b};border:1px solid ${m.r};border-radius:10px;padding:16px;color:${m.c};font-size:14px;line-height:1.6;">${msg}</div>
    </div></div>`);
}

function ninjaLogoSVG() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 17.5V6.5L11 12l-5 5.5Z" fill="#2254F5" opacity="0.95"/><path d="M12.5 18V6l5.5 6-5.5 6Z" fill="#2254F5" opacity="0.95"/><path d="M4.5 19.2h15" stroke="rgba(255,255,255,0.08)" stroke-width="1.2" opacity="0.9"/></svg>`;
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

// ─── DOWNLOADS (signed URL redirect; private bucket) ──────────────────────────
app.get('/downloads/installer', frm, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Service unavailable. Configure Supabase in .env and restart the server.' });
    try {
        const { data, error } = await supabase.storage.from('uploads').createSignedUrl('packages/HVTMasterAccessNQ.zip', 60);
        if (error) {
            console.error('[DownloadInstaller]', error.message);
            return res.status(500).json({ error: 'Failed to generate download link. Please try again later.' });
        }
        const url = data.signedUrl + (data.signedUrl.includes('?') ? '&' : '?') + 'download=HVTMasterAccessNQ.zip';
        return res.redirect(302, url);
    } catch (e) {
        console.error('[DownloadInstaller]', e.message);
        return res.status(500).json({ error: 'Failed to generate download link. Please try again later.' });
    }
});

app.get('/downloads/template', frm, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Service unavailable. Configure Supabase in .env and restart the server.' });
    try {
        const { data, error } = await supabase.storage.from('uploads').createSignedUrl('templates/HVT NQ TEMPLATE.xml', 60);
        if (error) {
            console.error('[DownloadTemplate]', error.message);
            return res.status(500).json({ error: 'Failed to generate download link. Please try again later.' });
        }
        const url = data.signedUrl + (data.signedUrl.includes('?') ? '&' : '?') + 'download=HVT_NQ_TEMPLATE.xml';
        return res.redirect(302, url);
    } catch (e) {
        console.error('[DownloadTemplate]', e.message);
        return res.status(500).json({ error: 'Failed to generate download link. Please try again later.' });
    }
});

// ─── TRADING ROOM ─────────────────────────────────────────────────────────────
app.get('/trading-room', (req, res) => {
    res.send(shell('Activate Member Access', `
    <div class="card">
      <div class="ct"></div>
      <div class="cb">
        <div style="text-align:center;margin-bottom:24px;">
          <div style="display:inline-block;background:rgba(34,84,245,0.1);border:1px solid rgba(34,84,245,0.2);border-radius:20px;padding:6px 18px;margin-bottom:16px;">
            <span style="color:#2254F5;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Member Access Activation</span>
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
            <div class="nt-signup-wrap"><a href="https://lp.ninjatrader.com/platform?im_ref=XLAQAKxrwxyZWIqQPWQSz2P0Uku26HTRR1lDXQ0&sharedid=&irpid=7019303&irgwc=1&afsrc=1" target="_blank" rel="noopener noreferrer" class="nt-signup-btn">Sign up</a></div>
          </div>
        </div>
        <label for="ntemail">NinjaTrader Account Email</label>
        <input type="email" id="ntemail" placeholder="email used for NinjaTrader" />
        <div style="background:rgba(34,84,245,0.05);border:1px solid rgba(34,84,245,0.15);border-radius:12px;padding:18px 20px;margin-bottom:24px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#2254F5;margin-bottom:8px;font-weight:700;">Install Software</div>
          <div style="color:#94a3b8;font-size:13px;line-height:1.5;">Download and install both the HVT software and the template package before activating Discord access.</div>
          <div style="margin-top:14px;text-align:center;"><a href="/downloads/installer" id="install-software-link" class="tr-install-btn">Install Software</a></div>
          <div style="margin-top:12px;text-align:center;"><a href="/downloads/template" id="install-template-link" class="tr-install-btn">Download Template</a></div>
        </div>
        <div style="background:rgba(34,84,245,0.05);border:1px solid rgba(34,84,245,0.15);border-radius:12px;padding:18px 20px;margin-bottom:24px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:14px;font-weight:700;">Discord Trading Room</div>
          <div style="display:flex;gap:12px;margin-bottom:12px;">
            <div style="width:24px;height:24px;border-radius:50%;background:#2254F5;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;margin-top:1px;">1</div>
            <div style="flex:1;color:#94a3b8;font-size:13px;line-height:1.5;">Join the HVT Discord server, then enter your details below and click Activate.</div>
          </div>
          <div style="text-align:center;margin-bottom:16px;"><a href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener noreferrer" class="discord-join-btn"><img src="/discordlogo.png" alt=""/><span>Join Discord</span></a></div>
          <div style="display:flex;gap:12px;">
            <div style="width:24px;height:24px;border-radius:50%;background:#2254F5;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;margin-top:1px;">2</div>
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
    </script>`, { pill: 'GET STARTED' }));
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

// ─── SESSION HELPERS ──────────────────────────────────────────────────────────
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

// ─── LOGIN PAGE ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
    if (getSession(req)) return res.redirect('/member');
    res.send(shell('Member Login', `
    <div style="width:100%;max-width:520px;">
      <div class="card" style="max-width:520px;">
        <div class="ct"></div>
        <div class="cb">
          <label for="email">Membership Email</label>
          <input type="email" id="email" placeholder="your@email.com" autocomplete="email" />
          <button class="btn" id="btn" onclick="go()">Send My Access Link</button>
          <div class="msg" id="msg"></div>
          <p style="text-align:center;color:#334155;font-size:11px;margin-top:20px;margin-bottom:0;">Not a member? <a href="https://highvelocitytrading.com/#packages" style="color:#2254F5;text-decoration:none;font-weight:600;">View Packages &rarr;</a></p>
          <p style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);"><a href="/member?demo=1" style="color:#94a3b8;font-size:13px;text-decoration:none;">Try the demo portal instead &rarr;</a></p>
        </div>
      </div>
    </div>
    <script>
      async function go(){const email=document.getElementById('email').value.trim();const msg=document.getElementById('msg');const btn=document.getElementById('btn');msg.className='msg';if(!email){msg.className='msg er show';msg.textContent='Please enter your email.';return}btn.disabled=true;btn.textContent='Sending...';try{const r=await fetch('/course/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\u2713 Check your email \u2014 your secure link is on the way!';btn.textContent='Link Sent \u2713'}else{msg.className='msg er show';msg.textContent=d.error||'Something went wrong.';btn.disabled=false;btn.textContent='Send My Access Link'}}catch{msg.className='msg er show';msg.textContent='Network error.';btn.disabled=false;btn.textContent='Send My Access Link'}}
      document.getElementById('email').addEventListener('keydown',e=>{if(e.key==='Enter')go();});
    </script>`));
});

app.post('/course/request', frm, express.json(), async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Service unavailable. Configure Supabase in .env and restart the server.' });
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
    if (!supabase) return res.send(resultPage('error', 'Service Unavailable', 'Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env and restart.'));
    const token = req.query.token;
    if (!token) return res.send(resultPage('error', 'Invalid Link', 'This access link is invalid.'));
    try {
        const { data: mData } = await supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,expires_at,course_token_expires').eq('course_token', token).maybeSingle();
        const { data: lData } = await supabase.from(LICENSE_TABLE).select('email,full_name,status,course_token_expires').eq('course_token', token).maybeSingle();
        const rec = mData || lData;
        if (!rec) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid or has expired.'));
        if (!rec.course_token_expires || new Date(rec.course_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/course" style="color:#2254F5;">Request a new one</a>.'));
        const isMonthly  = mData?.status === 'active' && new Date(mData.expires_at) > new Date();
        const isLifetime = lData?.status === 'active';
        if (!isMonthly && !isLifetime) return res.send(resultPage('error', 'Access Revoked', 'Your membership is no longer active.'));
        const name    = (rec.full_name || 'Trader').split(' ')[0];
        const plan    = isLifetime ? 'Lifetime Access' : 'Monthly Membership';
        const sessToken = createSession(rec.email, name, plan);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7*24*3600}`);
        return res.redirect('/member');
    } catch (e) { console.error('[CourseConfirm]', e.message); res.send(resultPage('error', 'Error', 'Something went wrong.')); }
});

// ─── MEMBER PORTAL HTML (Quartr-style nav + layout) ───────────────────────────
function memberPortalHtml(s) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Member Portal — HVT</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#000000;min-height:100vh;color:#fff;position:relative;overflow-x:hidden}
.member-bg{position:fixed;inset:0;z-index:0;pointer-events:none;background:#000000}
.member-bg::before{content:'';position:absolute;top:0;left:0;width:100%;height:100%;background:radial-gradient(ellipse 80% 50% at 50% -20%,rgba(34,84,245,0.18) 0%,transparent 50%),radial-gradient(ellipse 60% 40% at 20% 30%,#00001C 0%,transparent 55%);pointer-events:none}
.member-bg::after{content:'';position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:600px;height:200px;background:radial-gradient(ellipse 100% 100% at 50% 100%,rgba(34,84,245,0.08) 0%,transparent 70%);pointer-events:none}
.topnav-wrap{position:fixed;top:0;left:0;right:0;z-index:10}
.topnav{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:52px;width:100%;background:rgba(10,10,12,0.6);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,0.06);position:relative}
.topnav-logo{display:flex;align-items:center;text-decoration:none}
.topnav-logo img{height:40px;width:auto}
.topnav-left{display:flex;align-items:center;gap:12px}
.topnav-left a.topnav-link{color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;letter-spacing:0.2px;padding:8px 0;transition:color .2s}
.topnav-left a.topnav-link:hover{color:rgba(255,255,255,0.85)}
.topnav-right{display:flex;align-items:center;gap:12px}
.topnav-out{color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;padding:8px 0;transition:color .2s}
.topnav-out:hover{color:rgba(255,255,255,0.85)}
.topnav-cta{display:inline-block;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.9);font-size:13px;font-weight:500;text-decoration:none;padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);letter-spacing:0.2px;transition:background .2s,color .2s,border-color .2s}
.topnav-cta:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.18)}
.portal-wrap{position:relative;z-index:1;max-width:900px;margin:0 auto;padding:96px 24px 64px}
.hero-section{text-align:center;margin-bottom:32px;position:relative;padding:32px 20px 24px;border-radius:20px;box-shadow:0 0 0 1px rgba(34,84,245,0.06),0 0 60px rgba(34,84,245,0.08);animation:heroFade 0.6s ease-out}
@keyframes heroFade{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.hero-section .pill{display:inline-block;background:rgba(34,84,245,0.12);border:1px solid rgba(34,84,245,0.35);border-radius:999px;color:#2254F5;font-size:11px;letter-spacing:3px;text-transform:uppercase;padding:6px 18px;margin-bottom:18px;box-shadow:0 0 20px rgba(34,84,245,0.2);animation:heroFade 0.5s ease-out 0.1s both}
.hero-section h1{font-size:44px;font-weight:800;letter-spacing:-0.5px;margin-bottom:0;color:#fff;line-height:1.2;animation:heroFade 0.5s ease-out 0.15s both}
.hero-section .hero-name{background:linear-gradient(135deg,#60a5fa,#93c5fd);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero-section .hero-tagline{color:#94a3b8;font-size:17px;letter-spacing:0.3px;margin-top:12px;animation:heroFade 0.5s ease-out 0.2s both}
.hero-div{height:2px;background:linear-gradient(90deg,transparent,rgba(34,84,245,0.2),rgba(34,84,245,0.6),rgba(34,84,245,0.2),transparent);margin:20px auto 0;max-width:280px;border-radius:1px;animation:heroFade 0.5s ease-out 0.25s both}
.section-label{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#64748b;margin:0 0 16px;text-align:center}
.carousel-section{margin-bottom:40px}
.carousel-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;gap:16px;flex-wrap:wrap}
.carousel-heading{font-size:22px;font-weight:700;letter-spacing:-0.3px;color:#fff;line-height:1.3;max-width:480px}
.carousel-nav{display:flex;align-items:center;gap:8px;flex-shrink:0}
.carousel-btn{width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.7);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
.carousel-btn:hover{background:rgba(255,255,255,0.08);color:#fff;border-color:rgba(255,255,255,0.2)}
.carousel-btn svg{width:20px;height:20px}
.carousel-scroll{display:flex;gap:20px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;padding:12px 0 8px;-webkit-overflow-scrolling:touch}
.carousel-scroll::-webkit-scrollbar{height:6px}
.carousel-scroll::-webkit-scrollbar-track{background:rgba(255,255,255,0.04);border-radius:3px}
.carousel-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:3px}
.cards{display:contents}
.pcard{display:block;text-decoration:none;border-radius:20px;border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.03);overflow:hidden;transition:all .25s;position:relative;flex:0 0 300px;scroll-snap-align:start;min-height:260px;--c:#2254F5;--c2:#2254F5;--cb:rgba(34,84,245,0.12)}
.pcard:hover{transform:translateY(-4px);border-color:rgba(34,84,245,0.6);box-shadow:0 16px 48px rgba(34,84,245,0.25)}
.pcard .bar{height:3px;background:linear-gradient(90deg,var(--c2),var(--c),var(--c2))}
.pcard .inner{padding:28px;display:flex;flex-direction:column;height:100%;box-sizing:border-box}
.pcard .icon{width:48px;height:48px;border-radius:12px;background:var(--cb);display:flex;align-items:center;justify-content:center;margin-bottom:18px;flex-shrink:0;color:#2254F5}
.pcard h3{font-size:17px;font-weight:700;color:#fff;margin-bottom:8px}
.pcard p{color:#64748b;font-size:14px;line-height:1.6;margin-bottom:20px;flex:1}
.pcard .arrow{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--c);opacity:0.9;display:flex;align-items:center;gap:6px}
.pcard .arrow .arr{width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center}
@media(max-width:640px){.pcard{flex:0 0 260px}}
.help{text-align:center;margin-top:48px;padding-top:28px;border-top:1px solid rgba(255,255,255,0.06);color:#64748b;font-size:13px}
.help a{color:#94a3b8;text-decoration:none}
</style></head><body>
<div class="member-bg" aria-hidden="true"></div>
<div class="topnav-wrap">
  <nav class="topnav">
    <div class="topnav-left">
      <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="topnav-logo"><img src="/hvt-logo.png" alt="High Velocity Trading" /></a>
    </div>
    <div class="topnav-right">
      <a href="/billing/confirm-session" class="topnav-out">Billing</a>
      <a href="/logout" class="topnav-out">Log out</a>
      <a href="tel:786-461-4235" class="topnav-cta">Call Us</a>
    </div>
  </nav>
</div>
<div class="portal-wrap">
  <div class="hero-section">
    <span class="pill">MEMBER PORTAL</span>
    <h1>Welcome back, <span class="hero-name">${s.name}</span></h1>
    <p class="hero-tagline">Stay sharp. Stay ahead.</p>
    <div class="hero-div"></div>
  </div>
  <p class="section-label">Your dashboard</p>
  <div class="carousel-section">
    <div class="carousel-header">
      <h2 class="carousel-heading"></h2>
      <div class="carousel-nav">
        <button type="button" class="carousel-btn" id="carousel-prev" aria-label="Previous"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
        <button type="button" class="carousel-btn" id="carousel-next" aria-label="Next"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></button>
      </div>
    </div>
    <div class="carousel-scroll" id="carousel-scroll">
    <a class="pcard" href="/trading-room">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/></svg></div>
        <h3>Get Started</h3>
        <p>Activate your Discord access and trade live with the HVT team every market day.</p>
        <div class="arrow">Get Started <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
      </div>
    </a>
    <a class="pcard" href="/course">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/></svg></div>
        <h3>Course Library</h3>
        <p>Step-by-step trading videos built on the HVT system. Learn at your own pace.</p>
        <div class="arrow">Watch Now <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
      </div>
    </a>
    <a class="pcard" href="/trading-journal">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25"/></svg></div>
        <h3>Trading Journal</h3>
        <p>Log your trades, review performance, and track your progress with the HVT system.</p>
        <div class="arrow">Open Journal <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
      </div>
    </a>
  </div>
  </div>
  <div class="help">Need help? Call <a href="tel:7864614235">786-461-4235</a> or email <a href="mailto:alerts@highvelocitytrading.com">alerts@highvelocitytrading.com</a></div>
</div>
<script>
(function(){
  var el=document.getElementById('carousel-scroll');
  var prev=document.getElementById('carousel-prev');
  var next=document.getElementById('carousel-next');
  if(!el||!prev||!next)return;
  var cardWidth=320;
  prev.onclick=function(){ el.scrollBy({left:-cardWidth,behavior:'smooth'}); };
  next.onclick=function(){ el.scrollBy({left:cardWidth,behavior:'smooth'}); };
})();
</script>
</body></html>`;
}

// ─── MEMBER PORTAL (cookie-gated dashboard) ───────────────────────────────────
app.get('/member', (req, res, next) => {
    if (req.query.demo === '1' || !getSession(req)) {
        const s = getSession(req) || { name: 'Demo', plan: 'Monthly Membership', email: 'demo@example.com' };
        if (!getSession(req)) {
            const token = createSession(s.email, s.name, s.plan);
            res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7*24*3600}`);
        }
        return res.send(memberPortalHtml(s));
    }
    next();
}, (req, res) => {
    const s = getSession(req);
    res.send(memberPortalHtml(s));
});

// ─── BILLING SHORTCUT VIA SESSION ─────────────────────────────────────────────
app.get('/billing/confirm-session', (req, res, next) => {
    if (getSession(req)) return next();
    res.redirect('/member');
}, async (req, res) => {
    const s = getSession(req);
    let status = 'active', exAt = null, nextLabel = 'N/A', days = 0;
    let cancelHtml = `<div style="margin-top:24px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);"><p style="color:#334155;font-size:12px;text-align:center;margin-bottom:16px;">Want to cancel?</p><a href="/cancel" style="display:block;width:100%;padding:12px;background:transparent;border:1px solid rgba(248,113,113,0.3);color:#f87171;border-radius:999px;font-size:14px;font-weight:700;text-align:center;text-decoration:none;">Cancel Membership</a></div>`;
    try {
        if (supabase) {
            const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,expires_at').eq('email', s.email).maybeSingle();
            status = data?.status || 'unknown';
            exAt = data?.expires_at ? new Date(data.expires_at) : null;
            nextLabel = exAt ? exAt.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : 'N/A';
            days = exAt ? Math.max(0, Math.ceil((exAt - new Date()) / 86400000)) : 0;
            if (status !== 'active') cancelHtml = `<div style="margin-top:24px;text-align:center;"><p style="color:#64748b;font-size:13px;">Membership is no longer active.</p></div>`;
        } else {
            nextLabel = 'N/A';
            days = 0;
        }
    } catch (e) { console.error('[BillingSession]', e.message); }
    const sc = status === 'active' ? '#4ade80' : '#f87171';
    const sb = status === 'active' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)';
    const sbd = status === 'active' ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)';
    res.send(shell('Billing', `
        <div class="card" style="max-width:480px;width:100%;"><div class="ct"></div><div class="cb">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <a href="/member" style="color:#2254F5;font-size:13px;text-decoration:none;">&larr; Back to Portal</a>
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
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Next Billing</span><span style="color:#94a3b8;font-size:13px;">${nextLabel}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;"><span style="color:#64748b;font-size:13px;">Days Remaining</span><span style="color:${days > 7 ? '#4ade80' : '#f6ad55'};font-size:13px;font-weight:600;">${days} days</span></div>
          </div>${cancelHtml}
        </div></div>`, { pill: 'BILLING' }));
});

// ─── COURSE PLAYER (cookie-gated) ─────────────────────────────────────────────
app.get('/course', requireSession, (req, res) => {
    const s = getSession(req);
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Course — HVT</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;overflow:hidden}body{font-family:'DM Sans',sans-serif;background:#000;color:#fff;display:flex;flex-direction:column}
.member-bg{position:fixed;inset:0;z-index:0;pointer-events:none;background:#000}.member-bg::before{content:'';position:absolute;top:0;left:0;width:70%;height:60%;background:radial-gradient(ellipse at 20% 20%,#00001C 0%,transparent 60%);pointer-events:none}
.topnav-wrap{position:fixed;top:0;left:0;right:0;z-index:10}
.topnav{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:52px;width:100%;background:rgba(10,10,12,0.6);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,0.06);position:relative}
.topnav-logo{display:flex;align-items:center;text-decoration:none}
.topnav-logo img{height:40px;width:auto}
.topnav-left{display:flex;align-items:center;gap:12px}
.topnav-left a.topnav-link{color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;letter-spacing:0.2px;padding:8px 0;transition:color .2s}
.topnav-left a.topnav-link:hover{color:rgba(255,255,255,0.85)}
.topnav-right{display:flex;align-items:center;gap:12px}
.topnav-out{color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;padding:8px 0;transition:color .2s}
.topnav-out:hover{color:rgba(255,255,255,0.85)}
.topnav-cta{display:inline-block;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.9);font-size:13px;font-weight:500;text-decoration:none;padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);letter-spacing:0.2px;transition:background .2s,color .2s,border-color .2s}
.topnav-cta:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.18)}
.layout{display:flex;flex:1;overflow:hidden;position:relative;z-index:1;margin-top:52px}
.sidebar{width:280px;flex-shrink:0;border-right:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);display:flex;flex-direction:column;overflow:hidden}
.sidebar-header{padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0}
.sidebar-header h2{font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#64748b}
.sidebar-scroll{flex:1;overflow-y:auto;padding:8px 0}
.sidebar-scroll::-webkit-scrollbar{width:4px}.sidebar-scroll::-webkit-scrollbar-track{background:transparent}.sidebar-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:2px}
.section{margin-bottom:2px}
.section-header{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;cursor:pointer;user-select:none;transition:background .15s}.section-header:hover{background:rgba(255,255,255,0.03)}
.section-title{font-size:12px;font-weight:700;color:#94a3b8;letter-spacing:0.5px;flex:1}
.section-count{font-size:10px;color:#475569;font-weight:600;margin-right:8px}
.section-chevron{color:#475569;font-size:10px;transition:transform .2s}
.section.open .section-chevron{transform:rotate(90deg)}
.section-videos{display:none;padding:0 0 4px}.section.open .section-videos{display:block}
.video-item{display:flex;align-items:center;gap:12px;padding:9px 20px 9px 28px;cursor:pointer;transition:background .15s;position:relative}.video-item:hover{background:rgba(255,255,255,0.03)}
.video-item.active{background:rgba(34,84,245,0.08)}.video-item.active::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:#2254F5}
.video-thumb{width:48px;height:30px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.video-thumb img{width:100%;height:100%;object-fit:cover}
.play-icon{width:14px;height:14px;color:#475569}.video-item.active .play-icon{color:#2254F5}
.video-info{flex:1;min-width:0}
.video-title{font-size:12px;font-weight:600;color:#64748b;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.video-item.active .video-title{color:#e2e8f0}
.video-dur{font-size:10px;color:#475569;margin-top:2px;font-weight:500}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#000}
.player-wrap{flex:1;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);position:relative;min-height:0}
.player-wrap iframe{width:100%;height:100%;border:none}
.player-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#64748b;text-align:center;padding:40px}
.player-placeholder svg{opacity:0.4}.player-placeholder h3{font-size:18px;font-weight:700;color:#94a3b8}.player-placeholder p{font-size:13px;color:#64748b;max-width:320px;line-height:1.6}
.video-meta{padding:20px 28px;border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;background:rgba(255,255,255,0.02)}
.video-meta h2{font-size:18px;font-weight:700;color:#fff;margin-bottom:4px}
.video-meta-sub{display:flex;align-items:center;gap:16px;font-size:12px;color:#64748b}
.section-badge{background:rgba(34,84,245,0.12);border:1px solid rgba(34,84,245,0.2);border-radius:6px;padding:2px 10px;font-size:10px;font-weight:700;color:#2254F5;letter-spacing:1px;text-transform:uppercase}
@media(max-width:768px){.sidebar{position:fixed;left:-280px;top:52px;bottom:0;z-index:50;transition:left .25s;box-shadow:4px 0 24px rgba(0,0,0,0.4)}.sidebar.open{left:0}.layout{position:relative}.mob-menu{display:flex;align-items:center;justify-content:center;width:32px;height:32px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:6px;cursor:pointer;color:#94a3b8;font-size:16px}}
@media(min-width:769px){.mob-menu{display:none}}
</style></head><body>
<div class="member-bg" aria-hidden="true"></div>
<div class="topnav-wrap">
  <nav class="topnav">
    <div class="topnav-left">
      <button class="mob-menu" onclick="toggleSidebar()" title="Menu" aria-label="Menu">&#9776;</button>
      <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="topnav-logo"><img src="/hvt-logo.png" alt="High Velocity Trading" /></a>
    </div>
    <div class="topnav-right">
      <a href="/member" class="topnav-out">Portal</a>
      <a href="/billing/confirm-session" class="topnav-out">Billing</a>
      <a href="/logout" class="topnav-out">Log out</a>
      <a href="tel:786-461-4235" class="topnav-cta">Call Us</a>
    </div>
  </nav>
</div>
<div class="layout">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header"><h2>Course content</h2></div>
    <div class="sidebar-scroll" id="sidebarScroll"></div>
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
      <div class="video-meta-sub"><span class="section-badge" id="videoSection"></span><span id="videoDur"></span></div>
    </div>
  </div>
</div>
<script>
const COURSE=[{title:'Psychology',videos:[{title:'Welcome to HVT',duration:'1m',ytId:''},{title:'Why Traders Fail in the Long Run',duration:'4m',ytId:''},{title:'How to Set Yourself Up for Success',duration:'4m',ytId:''},{title:'Expand Your Horizon',duration:'3m',ytId:''},{title:'Next Steps',duration:'1m',ytId:''}]},{title:'Basic Technicals',videos:[{title:'Anatomy of a Candlestick',duration:'9m',ytId:''},{title:'Structure — Uptrend vs Downtrend',duration:'7m',ytId:''}]}];
let activeSection=0,activeVideo=0;const scroll=document.getElementById('sidebarScroll');
function buildSidebar(){scroll.innerHTML='';COURSE.forEach((sec,si)=>{const secEl=document.createElement('div');secEl.className='section'+(si===activeSection?' open':'');secEl.innerHTML='<div class="section-header" onclick="toggleSection('+si+')"><div class="section-title">'+sec.title+'</div><div class="section-count">'+sec.videos.length+' videos</div><div class="section-chevron">&#9654;</div></div><div class="section-videos">'+sec.videos.map((v,vi)=>'<div class="video-item'+(si===activeSection&&vi===activeVideo?' active':'')+'" onclick="playVideo('+si+','+vi+')"><div class="video-thumb">'+(v.ytId?'<img src="https://img.youtube.com/vi/'+v.ytId+'/mqdefault.jpg" alt="">':'<svg class="play-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"/></svg>')+'</div><div class="video-info"><div class="video-title">'+v.title+'</div><div class="video-dur">'+v.duration+'</div></div></div>').join('')+'</div>';scroll.appendChild(secEl)})}
function toggleSection(si){scroll.querySelectorAll('.section')[si].classList.toggle('open')}
function playVideo(si,vi){activeSection=si;activeVideo=vi;buildSidebar();const v=COURSE[si].videos[vi];const player=document.getElementById('player');const placeholder=document.getElementById('placeholder');const meta=document.getElementById('videoMeta');if(v.ytId){player.src='https://www.youtube.com/embed/'+v.ytId+'?autoplay=1&rel=0';player.style.display='block';placeholder.style.display='none'}else{player.style.display='none';placeholder.style.display='flex';placeholder.innerHTML='<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/></svg><h3>Coming Soon</h3><p>This video will be available shortly.</p>'}document.getElementById('videoTitle').textContent=v.title;document.getElementById('videoSection').textContent=COURSE[si].title;document.getElementById('videoDur').textContent=v.duration;meta.style.display='flex';if(window.innerWidth<769)document.getElementById('sidebar').classList.remove('open')}
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open')}
buildSidebar();
</script></body></html>`);
});

// ─── TRADING JOURNAL (session-gated) ──────────────────────────────────────────
app.get('/trading-journal', requireSession, (req, res) => {
    const s = getSession(req);
    const hero = { pill: 'TRADING JOURNAL', title: 'Track. Review. Improve.', sub: 'Every trade logged is a lesson earned.' };
    res.send(shell('Trading Journal', `
    <div class="journal-wrap" style="width:100%;max-width:1400px;margin:0 auto;padding:0 20px;box-sizing:border-box;">
      <div style="margin-top:8px;margin-bottom:16px;">
        <a href="/member" style="color:#2254F5;font-size:13px;text-decoration:none;font-weight:500;">&larr; Back to Portal</a>
      </div>

      <!-- Period filter -->
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <span style="font-size:12px;color:#64748b;font-weight:600;">Period:</span>
        <button type="button" class="journal-tab active" data-period="day">Today</button>
        <button type="button" class="journal-tab" data-period="week">This Week</button>
        <button type="button" class="journal-tab" data-period="month">This Month</button>
        <button type="button" class="journal-tab" data-period="all">All</button>
      </div>

      <!-- Row 1: Net P&L, Avg win/loss, Day Streak -->
      <div class="journal-metrics" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px;">
        <div class="card j-card" style="padding:18px 20px;">
          <div class="j-card-label">Net P&L</div>
          <div class="j-card-value" id="stat-pnl" style="color:#94a3b8;">$0.00</div>
          <div class="j-chart-line j-chart-empty" aria-hidden="true"></div>
        </div>
        <div class="card j-card" style="padding:18px 20px;">
          <div class="j-card-label">Avg win/loss trade</div>
          <div class="j-card-value" id="stat-avgwl" style="color:#94a3b8;">—</div>
          <div class="j-bar-wrap j-bar-empty"><div class="j-bar j-bar-win" style="width:0;"></div><div class="j-bar j-bar-loss" style="width:0;"></div></div>
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:6px;color:#64748b;"><span>—</span><span>—</span></div>
        </div>
        <div class="card j-card" style="padding:18px 20px;">
          <div class="j-card-label">Current Day Streak</div>
          <div class="j-card-value" id="stat-daystreak" style="color:#94a3b8;">0 days</div>
          <div style="display:flex;gap:12px;font-size:12px;margin-top:6px;color:#64748b;"><span>0W</span><span>0L</span></div>
        </div>
      </div>

      <!-- Row 2: Win %, Profit Factor, Trade Streak -->
      <div class="journal-metrics" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
        <div class="card j-card" style="padding:18px 20px;">
          <div class="j-card-label">Trade Win %</div>
          <div class="j-card-value" id="stat-wins" style="color:#94a3b8;">—</div>
          <div class="j-donut j-donut-half j-donut-empty" style="--p:0;" aria-hidden="true"></div>
          <div style="display:flex;justify-content:center;gap:16px;font-size:11px;margin-top:6px;color:#64748b;"><span>0</span><span>0</span></div>
        </div>
        <div class="card j-card" style="padding:18px 20px;">
          <div class="j-card-label">Profit Factor</div>
          <div class="j-card-value" id="stat-pf" style="color:#94a3b8;">—</div>
          <div class="j-donut j-donut-full j-donut-empty" style="--p:0;" aria-hidden="true"></div>
        </div>
        <div class="card j-card" style="padding:18px 20px;">
          <div class="j-card-label">Current Trade Streak</div>
          <div class="j-card-value" id="stat-tradestreak" style="color:#94a3b8;">0 trades</div>
          <div style="display:flex;gap:12px;font-size:12px;margin-top:6px;color:#64748b;"><span>0W</span><span>0L</span></div>
        </div>
      </div>

      <!-- Two columns: Trades table | Calendar -->
      <div class="journal-bottom-grid" style="display:grid;grid-template-columns:minmax(200px,280px) minmax(560px,1fr);gap:24px;align-items:start;min-width:0;">
        <!-- Trades panel -->
        <div class="card" style="overflow:hidden;max-width:100%;">
          <div class="ct"></div>
          <div style="padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:12px;font-weight:700;letter-spacing:1px;color:#e2e8f0;">Trades</span>
            <button type="button" class="j-info-btn" aria-label="Info">i</button>
          </div>
          <div style="display:flex;gap:0;border-bottom:1px solid rgba(255,255,255,0.06);">
            <button type="button" class="j-panel-tab active" data-tab="recent">Recent</button>
            <button type="button" class="j-panel-tab" data-tab="open">Open Positions</button>
          </div>
          <div id="trades-recent" class="j-trades-content">
            <table class="j-trades-table"><thead><tr><th>Symbol</th><th>Close Date</th><th>Net P&L</th></tr></thead><tbody>
              <tr><td colspan="3" style="text-align:center;color:#64748b;padding:28px 16px;">No trades recorded yet</td></tr>
            </tbody></table>
          </div>
          <div id="trades-open" class="j-trades-content" style="display:none;">
            <table class="j-trades-table"><thead><tr><th>Symbol</th><th>Side</th><th>Unrealized P&L</th></tr></thead><tbody><tr><td colspan="3" style="text-align:center;color:#64748b;padding:24px;">No open positions</td></tr></tbody></table>
          </div>
        </div>

        <!-- Calendar -->
      <div class="card journal-calendar-card" style="overflow:visible;width:100%;min-width:560px;">
        <div class="ct"></div>
        <div style="padding:0;">
          <div style="padding:10px 20px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <button type="button" id="cal-prev" aria-label="Previous month" class="cal-nav-btn">&#9664;</button>
              <button type="button" id="cal-prev-yr" aria-label="Previous year" class="cal-nav-btn" style="font-size:11px;">&#171;</button>
              <button type="button" id="cal-today" class="cal-today-btn">TODAY</button>
              <button type="button" id="cal-next-yr" aria-label="Next year" class="cal-nav-btn" style="font-size:11px;">&#187;</button>
              <button type="button" id="cal-next" aria-label="Next month" class="cal-nav-btn">&#9654;</button>
            </div>
            <span id="cal-month-year" style="flex:1;text-align:center;font-size:14px;font-weight:700;color:#fff;letter-spacing:0.5px;">March 2026</span>
            <button type="button" id="cal-info" aria-label="Info" class="j-info-btn">i</button>
          </div>
          <div style="padding:12px 20px 20px;">
            <div style="display:grid;grid-template-columns:repeat(7,minmax(72px,1fr));gap:10px;margin-bottom:10px;">
              <div style="text-align:center;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#e2e8f0;font-weight:700;padding:4px 0;">Sun</div>
              <div style="text-align:center;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#e2e8f0;font-weight:700;padding:4px 0;">Mon</div>
              <div style="text-align:center;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#e2e8f0;font-weight:700;padding:4px 0;">Tue</div>
              <div style="text-align:center;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#e2e8f0;font-weight:700;padding:4px 0;">Wed</div>
              <div style="text-align:center;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#e2e8f0;font-weight:700;padding:4px 0;">Thu</div>
              <div style="text-align:center;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#e2e8f0;font-weight:700;padding:4px 0;">Fri</div>
              <div style="text-align:center;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#e2e8f0;font-weight:700;padding:4px 0;">Sat</div>
            </div>
            <div id="cal-grid" style="display:grid;grid-template-columns:repeat(7,minmax(72px,1fr));gap:10px;min-width:0;"></div>
          </div>
        </div>
      </div>
      </div>

      <div id="cal-tooltip" style="display:none;position:fixed;z-index:100;background:#0f172a;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:12px 16px;box-shadow:0 20px 40px rgba(0,0,0,0.5);pointer-events:none;font-size:13px;">
        <div id="cal-tooltip-date" style="font-weight:700;color:#fff;margin-bottom:4px;"></div>
        <div id="cal-tooltip-pnl" style="font-weight:700;"></div>
        <div id="cal-tooltip-trades" style="color:#64748b;font-size:11px;margin-top:2px;"></div>
      </div>

      <p style="text-align:center;color:#334155;font-size:12px;margin-top:16px;">Daily PnL from closed trades. NinjaTrader connection coming soon.</p>
    </div>

    <style>
      .journal-wrap .card{max-width:none;}
      .journal-tab{padding:8px 18px;border-radius:999px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#94a3b8;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;font-family:'DM Sans',sans-serif;}
      .journal-tab:hover{background:rgba(255,255,255,0.08);color:#e2e8f0;}
      .journal-tab.active{background:rgba(34,84,245,0.15);border-color:rgba(34,84,245,0.35);color:#60a5fa;}
      .j-card-label{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#64748b;font-weight:600;margin-bottom:4px;}
      .j-card-value{font-size:22px;font-weight:700;}
      .j-chart-line{height:32px;margin-top:10px;border-radius:4px;overflow:hidden;}
      .j-chart-empty{background:rgba(255,255,255,0.04);}
      .j-bar-empty .j-bar{display:none;}
      .j-donut-empty{background:rgba(255,255,255,0.06) !important;}
      .j-bar-wrap{display:flex;height:8px;border-radius:4px;overflow:hidden;margin-top:8px;background:rgba(255,255,255,0.06);}
      .j-bar{height:100%;}.j-bar-win{background:#22c55e;}.j-bar-loss{background:#ef4444;}
      .j-donut{width:64px;height:32px;margin:8px auto 0;border-radius:32px 32px 0 0;background:conic-gradient(#22c55e calc(var(--p)*1.8deg),#ef4444 0);}
      .j-donut-full{width:56px;height:56px;margin:8px auto 0;border-radius:50%;background:conic-gradient(#22c55e calc(var(--p)*3.6deg),rgba(239,68,68,0.4) 0);}
      .j-info-btn{width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:#64748b;cursor:pointer;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;}
      .j-panel-tab{padding:10px 18px;border:none;background:transparent;color:#64748b;font-size:13px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;transition:all .2s;}
      .j-panel-tab:hover{color:#94a3b8;}
      .j-panel-tab.active{color:#2254F5;border-bottom-color:#2254F5;}
      .j-trades-table{width:100%;border-collapse:collapse;font-size:13px;}
      .j-trades-table th{text-align:left;padding:10px 14px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#64748b;border-bottom:1px solid rgba(255,255,255,0.06);}
      .j-trades-table td{padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.04);color:#e2e8f0;}
      .cal-nav-btn,.cal-today-btn{width:34px;height:34px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#94a3b8;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;transition:all .2s;}
      .cal-today-btn{width:auto;padding:5px 10px;font-size:11px;}
      #cal-prev:hover,#cal-next:hover,#cal-prev-yr:hover,#cal-next-yr:hover,#cal-today:hover{background:rgba(255,255,255,0.08);color:#fff;}
      .cal-day{aspect-ratio:1;min-width:0;border-radius:8px;display:flex;flex-direction:column;align-items:stretch;cursor:pointer;transition:all .15s;border:2px solid transparent;position:relative;padding:10px 8px;box-sizing:border-box;background:rgba(255,255,255,0.02);gap:6px;}
      .cal-day:hover{background:rgba(255,255,255,0.06);}
      .cal-day.other-month .cal-num{color:#334155;}
      .cal-day.has-pnl.profit{background:rgba(34,197,94,0.25);border-color:rgba(34,197,94,0.5);}
      .cal-day.has-pnl.profit:hover{background:rgba(34,197,94,0.35);}
      .cal-day.has-pnl.loss{background:rgba(239,68,68,0.25);border-color:rgba(239,68,68,0.5);}
      .cal-day.has-pnl.loss:hover{background:rgba(239,68,68,0.35);}
      .cal-day.is-today .cal-num{box-shadow:0 0 0 2px rgba(34,84,245,0.7);border-radius:50%;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;}
      .cal-num{font-size:15px;font-weight:700;color:#e2e8f0;flex-shrink:0;line-height:1;}
      .cal-day-content{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:0;overflow:hidden;padding:0 2px;}
      .cal-pnl{font-size:12px;font-weight:700;line-height:1.3;word-break:break-all;}
      .cal-trades{font-size:10px;color:inherit;opacity:0.9;margin-top:2px;line-height:1.2;}
      .cal-day.has-pnl.profit .cal-pnl,.cal-day.has-pnl.profit .cal-trades{color:#22c55e;}
      .cal-day.has-pnl.loss .cal-pnl,.cal-day.has-pnl.loss .cal-trades{color:#ef4444;}
      @media(max-width:900px){.journal-metrics{grid-template-columns:1fr !important;} .journal-bottom-grid{grid-template-columns:1fr !important;}}
    </style>
    <script>
      (function(){
        var period = 'day';
        document.querySelectorAll('.journal-tab').forEach(function(btn){
          btn.addEventListener('click', function(){
            document.querySelectorAll('.journal-tab').forEach(function(b){ b.classList.remove('active'); });
            btn.classList.add('active');
            period = btn.getAttribute('data-period');
          });
        });
        var cur = new Date();
        var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        var samplePnL = {};
        var sampleTrades = {};
        function dateKey(d){ return d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate(); }
        function formatPnl(n){ var a = Math.abs(n); if (a >= 1000) return (n >= 0 ? '' : '-') + '$' + (a/1000).toFixed(1) + 'k'; return (n >= 0 ? '+' : '') + '$' + n.toFixed(1); }
        var todayKey = dateKey(new Date());
        document.querySelectorAll('.j-panel-tab').forEach(function(btn){
          btn.addEventListener('click', function(){
            document.querySelectorAll('.j-panel-tab').forEach(function(b){ b.classList.remove('active'); });
            btn.classList.add('active');
            var t = btn.getAttribute('data-tab');
            document.getElementById('trades-recent').style.display = t === 'recent' ? 'block' : 'none';
            document.getElementById('trades-open').style.display = t === 'open' ? 'block' : 'none';
          });
        });
        function render(){
          var y = cur.getFullYear(), m = cur.getMonth();
          document.getElementById('cal-month-year').textContent = monthNames[m] + ' ' + y;
          var first = new Date(y, m, 1);
          var last = new Date(y, m + 1, 0);
          var startPad = first.getDay();
          var days = last.getDate();
          var prevLast = new Date(y, m, 0).getDate();
          var grid = document.getElementById('cal-grid');
          grid.innerHTML = '';
          for (var i = 0; i < startPad; i++) {
            var cell = document.createElement('div');
            cell.className = 'cal-day other-month';
            cell.innerHTML = '<span class="cal-num">' + (prevLast - startPad + i + 1) + '</span>';
            grid.appendChild(cell);
          }
          for (var d = 1; d <= days; d++) {
            var dt = new Date(y, m, d);
            var key = dateKey(dt);
            var pnl = samplePnL[key];
            var trades = sampleTrades[key] || 0;
            var cell = document.createElement('div');
            cell.className = 'cal-day' + (pnl != null ? ' has-pnl ' + (pnl >= 0 ? 'profit' : 'loss') : '') + (key === todayKey ? ' is-today' : '');
            cell.setAttribute('data-date', key);
            cell.setAttribute('data-pnl', pnl != null ? pnl : '');
            cell.setAttribute('data-trades', trades);
            var pnlStr = pnl != null ? formatPnl(pnl) : '';
            var tradesStr = (pnl != null ? trades : 0) + ' trade' + (trades !== 1 ? 's' : '');
            cell.innerHTML = '<span class="cal-num">' + d + '</span>' + (pnlStr ? '<div class="cal-day-content"><span class="cal-pnl">' + pnlStr + '</span><span class="cal-trades">' + tradesStr + '</span></div>' : '');
            cell.addEventListener('mouseenter', showTooltip);
            cell.addEventListener('mouseleave', hideTooltip);
            cell.addEventListener('mousemove', moveTooltip);
            grid.appendChild(cell);
          }
          var rest = (startPad + days <= 35 ? 35 : 42) - (startPad + days);
          for (var j = 0; j < rest; j++) {
            var cell = document.createElement('div');
            cell.className = 'cal-day other-month';
            cell.innerHTML = '<span class="cal-num">' + (j + 1) + '</span>';
            grid.appendChild(cell);
          }
        }
        function showTooltip(e){
          var el = e.target.closest('.cal-day');
          if (!el || el.classList.contains('other-month')) return;
          var dateStr = el.getAttribute('data-date');
          var pnl = el.getAttribute('data-pnl');
          var trades = el.getAttribute('data-trades') || '0';
          if (!dateStr) return;
          var parts = dateStr.split('-');
          var d = new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10));
          document.getElementById('cal-tooltip-date').textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
          if (pnl !== '' && pnl != null) {
            var n = parseFloat(pnl);
            document.getElementById('cal-tooltip-pnl').textContent = (n >= 0 ? '+' : '') + '$' + n.toFixed(2);
            document.getElementById('cal-tooltip-pnl').style.color = n >= 0 ? '#4ade80' : '#f87171';
          } else {
            document.getElementById('cal-tooltip-pnl').textContent = 'No trades';
            document.getElementById('cal-tooltip-pnl').style.color = '#64748b';
          }
          document.getElementById('cal-tooltip-trades').textContent = trades + ' trade(s) closed';
          document.getElementById('cal-tooltip').style.display = 'block';
        }
        function hideTooltip(){ document.getElementById('cal-tooltip').style.display = 'none'; }
        function moveTooltip(e){
          var tt = document.getElementById('cal-tooltip');
          tt.style.left = (e.clientX + 14) + 'px';
          tt.style.top = (e.clientY + 14) + 'px';
        }
        document.getElementById('cal-prev').onclick = function(){ cur.setMonth(cur.getMonth()-1); render(); };
        document.getElementById('cal-next').onclick = function(){ cur.setMonth(cur.getMonth()+1); render(); };
        document.getElementById('cal-prev-yr').onclick = function(){ cur.setFullYear(cur.getFullYear()-1); render(); };
        document.getElementById('cal-next-yr').onclick = function(){ cur.setFullYear(cur.getFullYear()+1); render(); };
        document.getElementById('cal-today').onclick = function(){ cur = new Date(); render(); };
        document.getElementById('cal-info').onclick = function(){ alert('Daily PnL shows realized profit/loss for each day. Green = profit, red = loss. Data from NinjaTrader when connected.'); };
        render();
      })();
    </script>`, hero));
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
    </script>`, { pill: 'BILLING' }));
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
        if (new Date(data.billing_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/billing" style="color:#2254F5;">Request a new one</a>.'));
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
        const ntBadge = m.nt_license_id ? `<span style="color:#2254F5;font-size:11px;">NT#${m.nt_license_id}</span>` : '<span style="color:#334155;font-size:11px;">—</span>';
        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);"><td style="padding:12px 14px;color:#94a3b8;font-size:13px;">${m.full_name || '—'}</td><td style="padding:12px 14px;color:#64748b;font-size:13px;">${m.email}</td><td style="padding:12px 14px;">${badge(m.status)}</td><td style="padding:12px 14px;color:#475569;font-size:12px;">${exp}</td><td style="padding:12px 14px;">${ntBadge}</td><td style="padding:12px 14px;">${m.status === 'active' ? cancelBtn(m.email, 'monthly', 'CANCEL') : '<span style="color:#334155;font-size:12px;">Inactive</span>'}</td></tr>`;
    }).join('');
    const licenseRows = (licenses || []).map(l => {
        const ntBadge = l.nt_license_id ? `<span style="color:#2254F5;font-size:11px;">NT#${l.nt_license_id}</span>` : '<span style="color:#334155;font-size:11px;">—</span>';
        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);"><td style="padding:12px 14px;color:#94a3b8;font-size:13px;">${l.full_name || '—'}</td><td style="padding:12px 14px;color:#64748b;font-size:13px;">${l.email}</td><td style="padding:12px 14px;">${badge(l.status, true)}</td><td style="padding:12px 14px;color:#475569;font-size:12px;font-family:monospace;">${l.license_key}</td><td style="padding:12px 14px;">${ntBadge}</td><td style="padding:12px 14px;">${l.status === 'active' ? cancelBtn(l.email, 'lifetime', 'REVOKE') : '<span style="color:#334155;font-size:12px;">Inactive</span>'}</td></tr>`;
    }).join('');
    const discordRows = (discordMems || []).map(d => {
        const exp = d.expires_at ? new Date(d.expires_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : 'N/A';
        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);"><td style="padding:12px 14px;color:#94a3b8;font-size:13px;">${d.full_name || '—'}</td><td style="padding:12px 14px;color:#64748b;font-size:13px;">${d.email}</td><td style="padding:12px 14px;">${badge(d.status)}</td><td style="padding:12px 14px;color:#475569;font-size:12px;">${exp}</td><td style="padding:12px 14px;color:#a78bfa;font-size:12px;">${d.discord_username || (d.discord_user_id ? '✓ Linked' : '—')}</td><td style="padding:12px 14px;">${d.status === 'active' ? cancelBtn(d.email, 'discord', 'CANCEL') : '<span style="color:#334155;font-size:12px;">Inactive</span>'}</td></tr>`;
    }).join('');
    const liveRows = liveHVT.map(m => `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);"><td style="padding:12px 14px;color:#94a3b8;font-size:13px;">${m.nick || '—'}</td><td style="padding:12px 14px;color:#a78bfa;font-size:13px;">@${m.user.username}</td><td style="padding:12px 14px;color:#475569;font-size:11px;font-family:monospace;">${m.user.id}</td><td style="padding:12px 14px;"><button onclick="removeRoleById('${m.user.id}','${m.user.username}')" style="background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;letter-spacing:1px;cursor:pointer;">REMOVE ROLE</button></td></tr>`).join('');

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>HVT Admin</title><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'DM Sans',sans-serif;background:#000;min-height:100vh;padding:32px 24px;color:#fff;}.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.06);}.brand{font-size:20px;font-weight:700;letter-spacing:3px;text-transform:uppercase;}.restricted{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:20px;padding:5px 14px;font-size:11px;color:#f87171;letter-spacing:2px;font-weight:700;}.sec{margin-bottom:36px;}.sec-ttl{font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#64748b;margin-bottom:16px;}.panel{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;}.pt{height:3px;background:linear-gradient(90deg,#2254F5,#2254F5,#2254F5);}.pt-red{background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d);}.pt-gold{background:linear-gradient(90deg,#92610a,#f6ad55,#92610a);}.pt-purple{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95);}.pt-green{background:linear-gradient(90deg,#14532d,#16a34a,#14532d);}.pt-cyan{background:linear-gradient(90deg,#164e63,#06b6d4,#164e63);}table{width:100%;border-collapse:collapse;}th{padding:12px 14px;text-align:left;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#334155;border-bottom:1px solid rgba(255,255,255,0.06);}.fc{padding:28px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;margin-bottom:20px;}.gc{padding:28px;background:rgba(124,58,237,0.05);border:1px solid rgba(124,58,237,0.15);border-radius:16px;margin-bottom:20px;}.ntc{padding:28px;background:rgba(6,182,212,0.04);border:1px solid rgba(6,182,212,0.15);border-radius:16px;margin-bottom:20px;}.bar{height:3px;margin:-28px -28px 24px;border-radius:16px 16px 0 0;}.bar-red{background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d);}.bar-purple{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95);}.bar-cyan{background:linear-gradient(90deg,#164e63,#06b6d4,#164e63);}input[type=email],input[type=text],input[type=password],select,textarea{width:100%;padding:12px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#fff;font-size:14px;outline:none;font-family:'DM Sans',sans-serif;margin-bottom:12px;}input:focus,select:focus,textarea:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,0.15);}input::placeholder,textarea::placeholder{color:#334155;}.btn-red{padding:12px 32px;background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 20px rgba(220,38,38,0.3);}.btn-purple{padding:12px 32px;background:linear-gradient(135deg,#4c1d95,#7c3aed);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 20px rgba(124,58,237,0.35);}.btn-cyan{padding:12px 32px;background:linear-gradient(135deg,#164e63,#06b6d4);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 20px rgba(6,182,212,0.3);}.msg{margin-top:12px;padding:12px 16px;border-radius:10px;font-size:13px;display:none;line-height:1.5;}.msg.show{display:block;}.ok{background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2);}.er{background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2);}.tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;}.tab{padding:8px 18px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;border:1px solid rgba(255,255,255,0.08);color:#64748b;background:transparent;transition:all .2s;}.tab.active{background:rgba(34,84,245,0.1);border-color:rgba(34,84,245,0.3);color:#2254F5;}.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:1000;align-items:center;justify-content:center;}.overlay.show{display:flex;}.modal{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:32px;max-width:420px;width:90%;text-align:center;backdrop-filter:blur(20px);}.mttl{font-size:20px;font-weight:700;color:#fff;margin-bottom:12px;}.msub{color:#94a3b8;font-size:14px;line-height:1.6;margin-bottom:24px;}.mbtns{display:flex;gap:12px;}.mok{flex:1;padding:12px;background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;cursor:pointer;}.mno{flex:1;padding:12px;background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.1);border-radius:999px;font-size:14px;font-weight:700;cursor:pointer;}label{display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;}.lred{color:#64748b;}.lpurp{color:#7c3aed;}.lcyan{color:#06b6d4;}</style></head><body>
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
