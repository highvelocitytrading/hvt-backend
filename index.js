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

// ─── STATIC FILES (logo, images) ─────────────────────────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    etag: true,
    index: false   // don't serve index.html from public/
}));

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

// Exact password scramble from NT Ecosystem source (wr function)
function ntScramblePassword(name, password) {
    const n = name.length % password.toString().length;
    const rotated = password.toString().slice(n) + password.toString().slice(0, n);
    const reversed = rotated.split('').reverse().join('');
    return Buffer.from(reversed).toString('base64');
}

// Exact challenge-response from NT Ecosystem source (Kt function)
// HMAC secret key extracted from minified JS bundle
function ntBuildPayload(name, password) {
    const scrambled = ntScramblePassword(name, password);
    const chl = `${Date.now() - 1581e9}`;
    const deviceId = 'hvt-backend-railway';
    const appId = 'arena';
    const hmac = crypto.createHmac('sha256', '035a1259-11e7-485a-aeae-9b6016579351');
    const data = [chl, deviceId, name, password, appId].join(''); // HMAC uses raw password, not scrambled
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

// Login on startup, renew every 45 min — falls back to full re-login automatically
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
        // d.result = NT license ID (number), d.errorText = '' on success
        if (d?.errorText && d.errorText !== '') {
            console.error(`[NT] License creation failed for ${email}:`, JSON.stringify(d));
            return null;
        }
        if (!d?.result) {
            console.error(`[NT] License creation no result for ${email}:`, JSON.stringify(d));
            return null;
        }
        // The "license key" users enter in NinjaTrader is their EMAIL ADDRESS
        // d.result is the internal NT license ID used for revocation
        console.log(`[NT] ✅ License created for ${email} | type=${type} | nt_id=${d.result}`);
        return d.result; // NT license ID (store in nt_license_id column)
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

    // ── MONTHLY EMAIL ─────────────────────────────────────────────────────────
    const monthlyHtml = wrap(`
      <div style="text-align:center;padding-bottom:8px;">
        <div style="display:inline-block;background:rgba(34,84,245,0.1);border:1px solid rgba(34,84,245,0.25);border-radius:20px;padding:5px 18px;margin-bottom:22px;">
          <span style="color:#60a5fa;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">Monthly Membership — Active</span>
        </div>
        <h1 style="color:#ffffff;font-size:26px;font-weight:800;margin:0 0 10px;letter-spacing:-0.5px;">Welcome to the Team, ${name}.</h1>
        <p style="color:#64748b;font-size:14px;margin:0;">Thank you for joining High Velocity Trading. We're glad to have you.</p>
      </div>

      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.08),transparent);margin:28px 0;"></div>

      <p style="color:#94a3b8;font-size:14px;line-height:1.9;margin:0 0 28px;">Your monthly membership is now live. You have full access to our proprietary NinjaTrader indicator suite, the member course library, and the option to join our live Trading Room. Everything you need to get started is outlined below — take it one step at a time.</p>

      <div style="text-align:center;margin-bottom:32px;">
        <a href="${APP_URL}/login" style="display:inline-block;background:linear-gradient(135deg,#1a3fd4,#2254F5);color:#fff;text-decoration:none;padding:16px 44px;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:1px;box-shadow:0 4px 20px rgba(34,84,245,0.45);">ACCESS YOUR MEMBER PORTAL &rarr;</a>
        <p style="color:#334155;font-size:11px;margin-top:10px;">Enter your email on the portal to receive your secure login link.</p>
      </div>

      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent);margin:0 0 28px;"></div>

      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#475569;font-weight:700;margin-bottom:18px;">How to Get Set Up</div>

      <div style="border:1px solid rgba(255,255,255,0.07);border-radius:12px;overflow:hidden;margin-bottom:28px;">

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:#1e3a8a;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#93c5fd;margin-top:1px;">1</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Log into Your Member Portal</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;">Go to your member portal, enter your email, and click the secure link we send you. From there you can access the course library and your account at any time.</div>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:#1e3a8a;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#93c5fd;margin-top:1px;">2</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Set Up NinjaTrader &amp; Activate Your Indicators</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;margin-bottom:12px;">If you don't have NinjaTrader 8 yet, download it using our affiliate link below — it's free to get started. Once installed, your indicators are activated by simply entering the email address you used to purchase.</div>
              <a href="https://ninjatraderus.pxf.io/Pz0bWN" style="display:inline-block;background:rgba(34,84,245,0.12);border:1px solid rgba(34,84,245,0.3);color:#60a5fa;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:12px;font-weight:700;letter-spacing:1px;">DOWNLOAD NINJATRADER FREE &rarr;</a>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:#1e3a8a;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#93c5fd;margin-top:1px;">3</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Join the HVT Discord Server</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;margin-bottom:12px;">Our Discord is where the community lives. Join the server using the button at the top of our website, then head to your member portal to activate your Trading Room role — you'll need your Discord username to complete this step.</div>
              <a href="https://highvelocitytrading.com" style="display:inline-block;background:rgba(34,84,245,0.12);border:1px solid rgba(34,84,245,0.3);color:#60a5fa;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:12px;font-weight:700;letter-spacing:1px;">JOIN DISCORD &rarr;</a>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:#1e3a8a;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#93c5fd;margin-top:1px;">4</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Watch the Course &amp; Learn the System</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;">Your member portal includes full access to our course library. Start from the beginning — the foundation videos will make everything else click faster.</div>
            </div>
          </div>
        </div>

      </div>

      <div style="background:rgba(248,113,113,0.05);border:1px solid rgba(248,113,113,0.15);border-radius:10px;padding:14px 18px;margin-bottom:28px;">
        <p style="color:#fca5a5;font-size:12px;line-height:1.7;margin:0;"><strong>Membership Note:</strong> Your Trading Room access and indicator license are tied to your active monthly subscription. Should your payment lapse, access will be paused automatically.</p>
      </div>

      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px 20px;text-align:center;">
        <p style="color:#475569;font-size:13px;margin:0 0 4px;">Questions? We're here.</p>
        <p style="color:#94a3b8;font-size:15px;font-weight:700;margin:0;">&#128222;&nbsp; 786-461-4235</p>
      </div>`);

    // ── LIFETIME EMAIL ────────────────────────────────────────────────────────
    const lifetimeHtml = wrap(`
      <div style="text-align:center;padding-bottom:8px;">
        <div style="display:inline-block;background:rgba(246,173,85,0.1);border:1px solid rgba(246,173,85,0.3);border-radius:20px;padding:5px 18px;margin-bottom:22px;">
          <span style="color:#f6ad55;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">Lifetime Access — Active</span>
        </div>
        <h1 style="color:#ffffff;font-size:26px;font-weight:800;margin:0 0 10px;letter-spacing:-0.5px;">Welcome to the Team, ${name}.</h1>
        <p style="color:#64748b;font-size:14px;margin:0;">Thank you for investing in yourself. This is just the beginning.</p>
      </div>

      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(246,173,85,0.15),transparent);margin:28px 0;"></div>

      <p style="color:#94a3b8;font-size:14px;line-height:1.9;margin:0 0 28px;">Your lifetime membership is active — you now have permanent access to our full NinjaTrader indicator suite and the complete course library. As a lifetime member, you also receive <strong style="color:#f6ad55;">3 months of Trading Room access completely free</strong>. After that, you can continue at our monthly rate if you'd like to stay in the room. Everything you need to get going is below.</p>

      <div style="text-align:center;margin-bottom:32px;">
        <a href="${APP_URL}/login" style="display:inline-block;background:linear-gradient(135deg,#b45309,#d97706,#f6ad55);color:#0f172a;text-decoration:none;padding:16px 44px;border-radius:10px;font-size:15px;font-weight:800;letter-spacing:1px;box-shadow:0 4px 24px rgba(246,173,85,0.4);">ACCESS YOUR MEMBER PORTAL &rarr;</a>
        <p style="color:#334155;font-size:11px;margin-top:10px;">Enter your email on the portal to receive your secure login link.</p>
      </div>

      <div style="background:rgba(246,173,85,0.06);border:1px solid rgba(246,173,85,0.15);border-radius:12px;padding:16px 20px;margin-bottom:28px;text-align:center;">
        <div style="color:#f6ad55;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">&#127775; Lifetime Benefit</div>
        <div style="color:#e2e8f0;font-size:14px;line-height:1.7;">Your first <strong style="color:#f6ad55;">3 months of Trading Room access are included free</strong> with your lifetime membership. After 3 months, you can continue at the standard monthly rate — no obligation.</div>
      </div>

      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent);margin:0 0 28px;"></div>

      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#475569;font-weight:700;margin-bottom:18px;">How to Get Set Up</div>

      <div style="border:1px solid rgba(255,255,255,0.07);border-radius:12px;overflow:hidden;margin-bottom:28px;">

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(246,173,85,0.15);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#f6ad55;margin-top:1px;">1</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Log into Your Member Portal</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;">Visit your member portal, enter your email, and click the secure link we send you. From there you have lifetime access to the full course library and your account dashboard.</div>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(246,173,85,0.15);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#f6ad55;margin-top:1px;">2</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Set Up NinjaTrader &amp; Activate Your Indicators</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;margin-bottom:12px;">No NinjaTrader yet? Download it for free using our link below. Once installed, your lifetime indicator license activates automatically — just enter the email address you used at checkout.</div>
              <a href="https://ninjatraderus.pxf.io/Pz0bWN" style="display:inline-block;background:rgba(246,173,85,0.1);border:1px solid rgba(246,173,85,0.3);color:#f6ad55;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:12px;font-weight:700;letter-spacing:1px;">DOWNLOAD NINJATRADER FREE &rarr;</a>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(246,173,85,0.15);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#f6ad55;margin-top:1px;">3</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Join the HVT Discord &amp; Activate Your Free Trading Room Access</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;margin-bottom:12px;">Join the server from the button at the top of our website, then head to your member portal to activate your Trading Room role. You'll need your Discord username — it's found by clicking your profile picture at the bottom left of Discord.</div>
              <a href="https://highvelocitytrading.com" style="display:inline-block;background:rgba(246,173,85,0.1);border:1px solid rgba(246,173,85,0.3);color:#f6ad55;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:12px;font-weight:700;letter-spacing:1px;">JOIN DISCORD &rarr;</a>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(246,173,85,0.15);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#f6ad55;margin-top:1px;">4</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Start the Course</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;">Your portal has the complete course library waiting for you. Start from Module 1 — even experienced traders find the foundation material changes how they see the market.</div>
            </div>
          </div>
        </div>

      </div>

      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px 20px;text-align:center;">
        <p style="color:#475569;font-size:13px;margin:0 0 4px;">Questions? We're here.</p>
        <p style="color:#94a3b8;font-size:15px;font-weight:700;margin:0;">&#128222;&nbsp; 786-461-4235</p>
      </div>`);

    const html = monthly ? monthlyHtml : lifetimeHtml;
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
function shell(title, body) {
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} – High Velocity Trading</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
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
.topnav{display:flex;align-items:center;justify-content:space-between;padding:0 28px;height:72px;width:100%;background:rgba(10,10,12,0.6);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,0.06);position:relative;}
.topnav-logo{display:flex;align-items:center;gap:0;text-decoration:none;}
.topnav-logo img{height:28px;width:auto;}
.topnav-left{display:flex;align-items:center;gap:12px;}
.topnav-left a.topnav-link{color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;letter-spacing:0.2px;padding:8px 0;transition:color .2s;}
.topnav-left a.topnav-link:hover{color:rgba(255,255,255,0.85);}
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
</style></head><body>
<div class="hvt-bg" aria-hidden="true"></div>
<div class="topnav-wrap">
  <nav class="topnav">
    <div class="topnav-left">
      <a href="/login" class="topnav-logo"><img src="/hvt-logo-cropped.png" alt="High Velocity Trading" /></a>
      <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="topnav-link">Home</a>
    </div>
    <a href="tel:786-461-4235" class="topnav-cta">Call Us</a>
  </nav>
</div>
<div class="hero">
  <span class="hero-pill">MEMBER PORTAL</span>
  <h1>Your Edge Starts Here</h1>
  <p class="hero-sub">Access your live trading room, course, and billing — all in one place.</p>
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
    // ALWAYS respond 200 immediately — Authnet deactivates webhooks on repeated non-200 responses
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
            // Create NT license only if one doesn't already exist
            if (!existing?.nt_license_id) {
                try {
                    const ntId = await ntCreateLicense(email, 'monthly');
                    if (ntId) await supabase.from(MEMBERSHIP_TABLE).update({ nt_license_id: ntId, updated_at: nowISO() }).eq('email', email);
                } catch (e) { console.error('[NT monthly AN]', e.message); }
            }
            // Re-add Discord role on renewal if they had one (covers lapse + renewal case)
            if (existing?.discord_user_id) {
                try { await addRole(existing.discord_user_id, DISCORD_MONTHLY_ROLE_ID); } catch (e) { console.error('[MemberAN re-add role]', e.message); }
            }
            console.log(`✅ Membership (AN): ${email} (renewal=${!!existing})`);
        } else if (CANCEL_EVENTS.includes(eventType)) {
            // Step 1: fetch IDs BEFORE update so we can strip roles/licenses
            const lookupKey = subId ? 'authnet_subscription_id' : 'email';
            const lookupVal = subId || email;
            if (!lookupVal) { console.warn('[MemberAN] No subId or email for cancel event'); return; }
            const { data: m } = await supabase.from(MEMBERSHIP_TABLE).select('discord_user_id,nt_license_id,email').eq(lookupKey, lookupVal).maybeSingle();
            // Step 2: update status
            await supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq(lookupKey, lookupVal);
            // Step 3: strip Discord role and NT license
            if (m?.discord_user_id) try { await stripRole(m.discord_user_id, DISCORD_MONTHLY_ROLE_ID); } catch (e) { console.error('[MemberAN strip role]', e.message); }
            if (m?.nt_license_id)   try { await ntRevokeLicense(m.nt_license_id); } catch (e) { console.error('[MemberAN revoke NT]', e.message); }
            console.log(`🚫 Membership cancelled (AN): ${m?.email || email || subId}`);
        }
        // res already sent 200 above
    } catch (e) { console.error('[MemberAN]', e.message); /* res already sent */ }
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
    // ALWAYS respond 200 immediately — Authnet deactivates webhooks on repeated non-200 responses
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
            // Re-add Discord role on renewal if they had one (covers lapse + renewal case)
            if (existing?.discord_user_id) {
                const rid = DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID;
                try { await addRole(existing.discord_user_id, rid); } catch (e) { console.error('[DiscordAN re-add role]', e.message); }
            }
            console.log(`✅ Discord member renewed (AN): ${email} (existing=${!!existing?.discord_user_id})`);
        } else if (CANCEL_EVENTS.includes(eventType)) {
            // Step 1: fetch discord_user_id BEFORE update
            const lookupKey = subId ? 'authnet_subscription_id' : 'email';
            const lookupVal = subId || email;
            if (!lookupVal) { console.warn('[DiscordAN] No subId or email for cancel event'); return; }
            const rid = DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID;
            const { data: dm } = await supabase.from(DISCORD_TABLE).select('discord_user_id,email').eq(lookupKey, lookupVal).maybeSingle();
            // Step 2: update status
            await supabase.from(DISCORD_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq(lookupKey, lookupVal);
            // Step 3: strip Discord role
            if (dm?.discord_user_id) try { await stripRole(dm.discord_user_id, rid); } catch (e) { console.error('[DiscordAN strip role]', e.message); }
            console.log(`🚫 Discord cancelled (AN): ${dm?.email || email || subId}`);
        }
        // res already sent 200 above
    } catch (e) { console.error('[DiscordAN]', e.message); /* res already sent */ }
});

app.get('/check-access', frm, async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    try {
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).maybeSingle();
        res.json({ active: data?.status === 'active' && new Date(data.expires_at) > new Date() });
    } catch (e) { console.error('[CheckAccess]', e.message); res.status(500).json({ active: false }); }
});

// ─── TRADING ROOM ─────────────────────────────────────────────────────────────
app.get('/trading-room', (req, res) => {
    res.send(shell('Activate Your Access', `
    <div style="max-width:560px;width:100%;margin:0 auto;">

      <!-- Header -->
      <div style="text-align:center;margin-bottom:32px;">
        <div style="display:inline-block;background:rgba(34,84,245,0.1);border:1px solid rgba(34,84,245,0.25);border-radius:20px;padding:5px 18px;margin-bottom:18px;">
          <span style="color:#60a5fa;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">Access Activation</span>
        </div>
        <div class="ttl" style="font-size:24px;margin-bottom:8px;">Activate Your Indicators &amp; Discord</div>
        <div class="sub">This is where your NinjaTrader indicators get turned on and your Discord Trading Room role gets assigned. Takes 2 minutes.</div>
      </div>

      <!-- BEFORE YOU START -->
      <div style="background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.2);border-radius:14px;padding:20px 22px;margin-bottom:28px;">
        <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#fbbf24;font-weight:700;margin-bottom:14px;">&#9888;&#65039; Before You Fill This Out</div>
        <div style="display:flex;flex-direction:column;gap:12px;">

          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:28px;height:28px;border-radius:7px;background:rgba(251,191,36,0.12);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fbbf24;flex-shrink:0;">1</div>
            <div>
              <div style="color:#e2e8f0;font-size:13px;font-weight:700;margin-bottom:3px;">You need a NinjaTrader account first</div>
              <div style="color:#64748b;font-size:12px;line-height:1.6;margin-bottom:8px;">Don't have one? Download NinjaTrader 8 for free — it only takes a few minutes to set up. Use our link below.</div>
              <a href="https://ninjatraderus.pxf.io/Pz0bWN" target="_blank" style="display:inline-flex;align-items:center;gap:6px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);color:#fbbf24;text-decoration:none;padding:8px 16px;border-radius:8px;font-size:11px;font-weight:700;letter-spacing:1px;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>
                DOWNLOAD NINJATRADER 8 — FREE
              </a>
            </div>
          </div>

          <div style="height:1px;background:rgba(255,255,255,0.05);"></div>

          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:28px;height:28px;border-radius:7px;background:rgba(251,191,36,0.12);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fbbf24;flex-shrink:0;">2</div>
            <div>
              <div style="color:#e2e8f0;font-size:13px;font-weight:700;margin-bottom:3px;">You need to join our Discord server first</div>
              <div style="color:#64748b;font-size:12px;line-height:1.6;margin-bottom:8px;">Join via the button at the top of our website. Once you're in the server, come back here to activate your Trading Room role.</div>
              <a href="https://highvelocitytrading.com" target="_blank" style="display:inline-flex;align-items:center;gap:6px;background:rgba(88,101,242,0.08);border:1px solid rgba(88,101,242,0.25);color:#a5b4fc;text-decoration:none;padding:8px 16px;border-radius:8px;font-size:11px;font-weight:700;letter-spacing:1px;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/></svg>
                JOIN HVT DISCORD SERVER
              </a>
            </div>
          </div>

        </div>
      </div>

      <!-- FORM CARD -->
      <div class="card" style="margin-bottom:0;">
        <div class="ct"></div>
        <div class="cb">
          <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#475569;font-weight:700;margin-bottom:20px;">Activation Form — Fill Out Once</div>

          <!-- NT section -->
          <div style="background:rgba(34,84,245,0.04);border:1px solid rgba(34,84,245,0.12);border-radius:10px;padding:14px 16px;margin-bottom:20px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
              <div style="width:28px;height:28px;border-radius:7px;background:rgba(34,84,245,0.12);display:flex;align-items:center;justify-content:center;flex-shrink:0;">${ninjaLogoSVG()}</div>
              <div>
                <div style="color:#fff;font-size:13px;font-weight:700;">NinjaTrader Indicator Activation</div>
                <div style="color:#475569;font-size:11px;">Enter the email tied to your NinjaTrader account</div>
              </div>
            </div>
          </div>
          <label for="ntemail">NinjaTrader Account Email</label>
          <input type="email" id="ntemail" placeholder="email used on NinjaTrader" />

          <!-- Discord section -->
          <div style="background:rgba(88,101,242,0.04);border:1px solid rgba(88,101,242,0.12);border-radius:10px;padding:14px 16px;margin-bottom:20px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
              <div style="width:28px;height:28px;border-radius:7px;background:rgba(88,101,242,0.12);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#a5b4fc"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
              </div>
              <div>
                <div style="color:#fff;font-size:13px;font-weight:700;">Discord Trading Room Role</div>
                <div style="color:#475569;font-size:11px;">Must have joined the server already</div>
              </div>
            </div>
          </div>
          <label for="email">Purchase Email</label>
          <input type="email" id="email" placeholder="email you used to purchase" />
          <label for="discord">Discord Username</label>
          <input type="text" id="discord" placeholder="e.g. johntrader22" />

          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px 16px;margin-bottom:20px;">
            <p style="color:#475569;font-size:12px;margin:0;line-height:1.7;">&#128161; <strong style="color:#64748b;">Finding your Discord username:</strong> Open Discord &rarr; click your profile picture at the <strong style="color:#94a3b8;">bottom-left</strong> &rarr; your username is shown below your display name (lowercase, may include numbers). <strong style="color:#94a3b8;">Use the username, not your display name.</strong></p>
          </div>

          <button class="btn" id="btn" onclick="go()">Activate My Access</button>
          <div class="msg" id="msg"></div>
        </div>
      </div>

    </div>
    <script>
      async function go(){const email=document.getElementById('email').value.trim();const disc=document.getElementById('discord').value.trim();const ntEmail=document.getElementById('ntemail').value.trim();const msg=document.getElementById('msg');const btn=document.getElementById('btn');msg.className='msg';if(!ntEmail){msg.className='msg er show';msg.textContent='Please enter your NinjaTrader account email.';return}if(!email){msg.className='msg er show';msg.textContent='Please enter your purchase email.';return}if(!disc){msg.className='msg er show';msg.textContent='Please enter your Discord username.';return}btn.disabled=true;btn.textContent='Activating...';try{const r=await fetch('/trading-room/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,discord_username:disc,ninjatrader_email:ntEmail})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\u2713 Done! Check Discord \u2014 your role has been assigned. Your NinjaTrader indicators are now active.';btn.textContent='Access Granted \u2713'}else{msg.className='msg er show';msg.textContent=d.error||'Something went wrong.';btn.disabled=false;btn.textContent='Activate My Access'}}catch{msg.className='msg er show';msg.textContent='Network error. Please try again.';btn.disabled=false;btn.textContent='Activate My Access'}}
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
    <div style="width:100%;max-width:460px;">
      <div class="card">
        <div class="ct"></div>
        <div class="cb">
          <div style="text-align:center;margin-bottom:24px;">
            <div style="font-size:20px;font-weight:700;color:#fff;margin-bottom:6px;">Member Login</div>
            <p style="color:#64748b;font-size:13px;margin:0;line-height:1.6;">Enter your membership email and we'll send you a secure one-time login link.</p>
          </div>
          <div class="div"></div>
          <label for="email">Membership Email</label>
          <input type="email" id="email" placeholder="your@email.com" autocomplete="email" />
          <button class="btn" id="btn" onclick="go()">Send My Access Link</button>
          <div class="msg" id="msg"></div>
          <p style="text-align:center;color:#334155;font-size:11px;margin-top:20px;margin-bottom:0;">Not a member? <a href="https://highvelocitytrading.com/#packages" style="color:#2254F5;text-decoration:none;font-weight:600;">View Packages &rarr;</a></p>
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
        if (!rec.course_token_expires || new Date(rec.course_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/course" style="color:#2254F5;">Request a new one</a>.'));
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


// ─── MEMBER PORTAL HTML (carousel layout) ────────────────────────────────────
function memberPortalHtml(s) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Member Portal — HVT</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#000000;min-height:100vh;color:#fff;position:relative;overflow-x:hidden}
.member-bg{position:fixed;inset:0;z-index:0;pointer-events:none;background:#000000}
.member-bg::before{content:'';position:absolute;top:0;left:0;width:70%;height:60%;background:radial-gradient(ellipse at 20% 20%,#00001C 0%,transparent 60%);pointer-events:none}
.topnav-wrap{position:fixed;top:0;left:0;right:0;z-index:10}
.topnav{display:flex;align-items:center;justify-content:space-between;padding:0 28px;height:72px;width:100%;background:rgba(10,10,12,0.6);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,0.06);position:relative}
.topnav-logo{display:flex;align-items:center;text-decoration:none}
.topnav-logo img{height:28px;width:auto;}
.topnav-left{display:flex;align-items:center;gap:12px}
.topnav-left a.topnav-link{color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;letter-spacing:0.2px;padding:8px 0;transition:color .2s}
.topnav-left a.topnav-link:hover{color:rgba(255,255,255,0.85)}
.topnav-right{display:flex;align-items:center;gap:12px}
.topnav-out{color:rgba(255,255,255,0.55);font-size:13px;font-weight:500;text-decoration:none;padding:8px 0;transition:color .2s}
.topnav-out:hover{color:rgba(255,255,255,0.85)}
.topnav-cta{display:inline-block;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.9);font-size:13px;font-weight:500;text-decoration:none;padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);letter-spacing:0.2px;transition:background .2s,color .2s,border-color .2s}
.topnav-cta:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.18)}
.portal-wrap{position:relative;z-index:1;max-width:900px;margin:0 auto;padding:96px 24px 64px}
.hero-section{text-align:center;margin-bottom:32px}
.hero-section .pill{display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.25);border-radius:999px;color:#2254F5;font-size:11px;letter-spacing:3px;text-transform:uppercase;padding:6px 18px;margin-bottom:14px}
.hero-section h1{font-size:38px;font-weight:700;letter-spacing:-0.5px;margin-bottom:0;color:#fff}
.hero-section p{color:#94a3b8;font-size:16px;line-height:1.5}
.hero-div{height:1px;background:linear-gradient(90deg,transparent,rgba(34,84,245,0.3),transparent);margin:16px auto 0;max-width:200px}
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
      <a href="/member" class="topnav-logo"><img src="/hvt-logo-cropped.png" alt="High Velocity Trading" /></a>
      <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="topnav-link">Home</a>
      <a href="/logout" class="topnav-out">Log out</a>
    </div>
    <a href="tel:786-461-4235" class="topnav-cta">Call Us</a>
  </nav>
</div>
<div class="portal-wrap">
  <div class="hero-section">
    <span class="pill">MEMBER PORTAL</span>
    <h1>Welcome back, ${s.name}</h1>
    <p style="font-family:'DM Sans',sans-serif;font-weight:400;font-size:17px;color:#4a6a8a;text-align:center;letter-spacing:0.2px;margin:10px 0 0 0">Stay sharp. Stay ahead.</p>
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
    <a class="pcard" href="/course">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/></svg></div>
        <h3>Course Library</h3>
        <p>Step-by-step trading videos built on the HVT system. Learn at your own pace.</p>
        <div class="arrow">Watch Now <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
      </div>
    </a>
    <a class="pcard" href="/trading-room">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/></svg></div>
        <h3>Trading Room</h3>
        <p>Activate your Discord access and trade live with the HVT team every market day.</p>
        <div class="arrow">Activate <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
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
    <a class="pcard" href="/billing/confirm-session">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z"/></svg></div>
        <h3>Billing</h3>
        <p>View your subscription status, renewal date, and manage your membership.</p>
        <div class="arrow">View Billing <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
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

// ─── TRADING JOURNAL (session-gated) ──────────────────────────────────────────
app.get('/trading-journal', requireSession, (req, res) => {
    const s = getSession(req);
    // Journal page — session data available: s.email, s.name, s.plan
    // Tomorrow: full journal UI with Supabase trade logging will be built here
    res.send(shell('Trading Journal', `
    <div class="card" style="max-width:560px;">
      <div class="ct"></div>
      <div class="cb">
        <div style="margin-bottom:24px;">
          <a href="/member" style="color:#2254F5;font-size:13px;text-decoration:none;">&larr; Back to Portal</a>
        </div>
        <div style="display:inline-block;background:rgba(34,84,245,0.1);border:1px solid rgba(34,84,245,0.2);border-radius:20px;padding:6px 18px;margin-bottom:16px;">
          <span style="color:#2254F5;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Trading Journal</span>
        </div>
        <div class="ttl" style="margin-bottom:8px;">Your Trading Journal</div>
        <div class="sub" style="margin-bottom:24px;">Log your trades, review performance, and track your progress with the HVT system.</div>
        <div class="div"></div>
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px;text-align:center;">
          <p style="color:#64748b;font-size:14px;line-height:1.6;margin:0;">Full trading journal launching soon. Your account: <strong style="color:#fff;">${s.email}</strong></p>
        </div>
      </div>
    </div>`));
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
        </div></div>`));
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
    // Respond 200 immediately so Authnet never deactivates the webhook
    // Process the payload asynchronously after responding
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
    } catch (e) { console.error('[LicenseAN]', e); /* res already sent */ }
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
    try {
        const ok = await ntLogin();
        if (ok) return res.json({ ok: true, message: '✅ NT re-authenticated successfully' });
        res.status(500).json({ ok: false, message: '❌ NT login failed — check NT_USERNAME / NT_PASSWORD in Railway env vars' });
    } catch (e) { console.error('[RefreshNT]', e.message); res.status(500).json({ ok: false, message: e.message }); }
});

// ─── ADMIN: CANCEL / REVOKE ───────────────────────────────────────────────────
app.post('/admin/cancel', adm, express.json(), async (req, res) => {
    console.log('[AdminCancel] body:', JSON.stringify(req.body));
    if (req.body?.key !== ADMIN_SECRET) {
        console.log('[AdminCancel] UNAUTHORIZED — key mismatch. Got:', req.body?.key, 'Expected:', ADMIN_SECRET);
        return res.status(403).json({ error: 'Unauthorized' });
    }
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        const type  = req.body.type || 'monthly';
        console.log('[AdminCancel] email:', email, 'type:', type);
        if (!email) return res.status(400).json({ error: 'Email required' });

        const result = { ok: true, type, email, db_updated: false, nt_revoked: false, discord_stripped: false, sub_cancelled: false };

        if (type === 'lifetime') {
            // 1. Fetch record
            const { data: l, error: fetchErr } = await supabase.from(LICENSE_TABLE).select('nt_license_id,status,email').eq('email', email).maybeSingle();
            console.log('[AdminCancel] lifetime fetch:', l, fetchErr?.message);
            if (!l) return res.status(404).json({ error: 'No lifetime license found for: ' + email });

            // 2. Revoke NT license
            if (l.nt_license_id) {
                try { await ntRevokeLicense(l.nt_license_id); result.nt_revoked = true; }
                catch (e) { console.error('[AdminCancel] NT revoke failed:', e.message); }
            }

            // 3. Update Supabase
            const { data: upd, error: updErr } = await supabase.from(LICENSE_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email).select();
            console.log('[AdminCancel] lifetime update result:', upd, updErr?.message);
            if (updErr) return res.status(500).json({ error: 'DB update failed: ' + updErr.message });
            result.db_updated = true;

        } else if (type === 'discord') {
            // 1. Fetch record
            const { data: dm, error: fetchErr } = await supabase.from(DISCORD_TABLE).select('discord_user_id,authnet_subscription_id,status').eq('email', email).maybeSingle();
            console.log('[AdminCancel] discord fetch:', dm, fetchErr?.message);
            if (!dm) return res.status(404).json({ error: 'No Discord membership found for: ' + email });

            // 2. Cancel Authnet sub
            if (dm.authnet_subscription_id) {
                try { await cancelSub(dm.authnet_subscription_id); result.sub_cancelled = true; }
                catch (e) { console.error('[AdminCancel] Sub cancel failed:', e.message); }
            }

            // 3. Strip Discord role
            const rid = DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID;
            if (dm.discord_user_id) {
                try { await stripRole(dm.discord_user_id, rid); result.discord_stripped = true; }
                catch (e) { console.error('[AdminCancel] Discord strip failed:', e.message); }
            }

            // 4. Update Supabase
            const { data: upd, error: updErr } = await supabase.from(DISCORD_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email).select();
            console.log('[AdminCancel] discord update result:', upd, updErr?.message);
            if (updErr) return res.status(500).json({ error: 'DB update failed: ' + updErr.message });
            result.db_updated = true;

        } else {
            // monthly
            // 1. Fetch record
            const { data: m, error: fetchErr } = await supabase.from(MEMBERSHIP_TABLE).select('authnet_subscription_id,discord_user_id,nt_license_id,status,email').eq('email', email).maybeSingle();
            console.log('[AdminCancel] monthly fetch:', m, fetchErr?.message);
            if (!m) return res.status(404).json({ error: 'No monthly membership found for: ' + email });

            // 2. Cancel Authnet sub
            if (m.authnet_subscription_id) {
                try { await cancelSub(m.authnet_subscription_id); result.sub_cancelled = true; }
                catch (e) { console.error('[AdminCancel] Sub cancel failed:', e.message); }
            }

            // 3. Strip Discord role
            if (m.discord_user_id) {
                try { await stripRole(m.discord_user_id, DISCORD_MONTHLY_ROLE_ID); result.discord_stripped = true; }
                catch (e) { console.error('[AdminCancel] Discord strip failed:', e.message); }
            }

            // 4. Revoke NT license
            if (m.nt_license_id) {
                try { await ntRevokeLicense(m.nt_license_id); result.nt_revoked = true; }
                catch (e) { console.error('[AdminCancel] NT revoke failed:', e.message); }
            }

            // 5. Update Supabase — this MUST succeed
            const { data: upd, error: updErr } = await supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email).select();
            console.log('[AdminCancel] monthly update result:', upd, updErr?.message);
            if (updErr) return res.status(500).json({ error: 'DB update failed: ' + updErr.message });
            result.db_updated = true;
        }

        console.log('[AdminCancel] SUCCESS:', result);
        res.json(result);
    } catch (e) {
        console.error('[AdminCancel] FATAL:', e.message, e.stack);
        res.status(500).json({ error: e.message });
    }
});

// ─── ADMIN: REMOVE DISCORD ROLE ───────────────────────────────────────────────
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
        console.log('[Admin] All roles stripped:', uid);
        res.json({ ok: true });
    } catch (e) { console.error('[AdminRemoveRole]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: GOD MODE GRANT ────────────────────────────────────────────────────
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
        else console.error('[GodMode] DB error:', dbErr.message);

        if (doNT && !isDiscordOnly && ntToken) {
            try {
                const ntId = await ntCreateLicense(email, isLifetime ? 'lifetime' : 'monthly');
                if (ntId) {
                    result.nt_license = ntId;
                    await supabase.from(table).update({ nt_license_id: ntId, nt_email: email, updated_at: nowISO() }).eq('email', email);
                }
            } catch (e) { console.error('[GodMode] NT error:', e.message); }
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
            } catch (e) { console.error('[GodMode] Discord error:', e.message); }
        }

        if (doEmail) {
            try {
                // Save a 24-hour login token so the member can access the portal immediately
                const token    = crypto.randomBytes(32).toString('hex');
                const tokenExp = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                await supabase.from(table).update({ course_token: token, course_token_expires: tokenExp, updated_at: nowISO() }).eq('email', email);
                // Send the full branded welcome email (same as webhook flow)
                if (isDiscordOnly) {
                    await sendDiscordWelcome(email, fullName);
                } else {
                    await sendWelcome(email, fullName, isLifetime ? 'lifetime' : 'monthly');
                }
                result.email_sent = true;
            } catch (e) { console.error('[GodMode] Email error:', e.message); }
        }

        console.log(`[GodMode] ${email} | role=${role} | NT=${result.nt_license} | Discord=${result.discord} | Email=${result.email_sent}`);
        res.json(result);
    } catch (e) { console.error('[GodMode]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: PANEL HTML ────────────────────────────────────────────────────────
app.get('/admin', adm, adminGuard, async (req, res) => {
    const key = req.query.key || '';
    try {
    const [{ data: members }, { data: licenses }, { data: discordMems }] = await Promise.all([
        supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,plan_name,expires_at,discord_user_id,nt_license_id').order('updated_at', { ascending: false }).limit(100),
        supabase.from(LICENSE_TABLE).select('email,full_name,status,license_key,nt_license_id').order('updated_at', { ascending: false }).limit(100),
        supabase.from(DISCORD_TABLE).select('email,full_name,status,expires_at,discord_user_id,discord_username').order('updated_at', { ascending: false }).limit(100)
    ]);

    let guildMembers = [];
    try { guildMembers = await getGuildAll(); } catch {}
    const allRoles = [DISCORD_MONTHLY_ROLE_ID, DISCORD_LIFETIME_ROLE_ID, ...(DISCORD_ROOM_ROLE_ID ? [DISCORD_ROOM_ROLE_ID] : [])];
    const liveHVT  = guildMembers.filter(m => m.roles?.some(r => allRoles.includes(r)));
    const ntStatus = ntToken ? '\u2713 Authenticated' : '\u2717 Not Authenticated';
    const ntColor  = ntToken ? '#4ade80' : '#f87171';

    function badge(s, gold) {
        const a = s === 'active';
        const c = a ? (gold ? '#f6ad55' : '#4ade80') : '#f87171';
        const bg = a ? (gold ? 'rgba(246,173,85,0.08)' : 'rgba(74,222,128,0.08)') : 'rgba(248,113,113,0.08)';
        const bd = a ? (gold ? 'rgba(246,173,85,0.2)' : 'rgba(74,222,128,0.2)') : 'rgba(248,113,113,0.2)';
        return '<span style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:20px;padding:3px 10px;font-size:11px;color:' + c + ';letter-spacing:1px;font-weight:600;">' + s + '</span>';
    }

    // CANCEL button — calls cancelMember(email, type) directly, no modal needed
    function cancelBtn(email, type, label) {
        const safe = email.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return '<button onclick="cancelMember(\'' + safe + '\',\'' + type + '\')" style="background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;letter-spacing:1px;cursor:pointer;transition:opacity .2s;" onmouseover="this.style.opacity=.8" onmouseout="this.style.opacity=1">' + label + '</button>';
    }

    const memberRows = (members || []).map(m => {
        const exp     = m.expires_at ? new Date(m.expires_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'N/A';
        const ntBadge = m.nt_license_id ? '<span style="color:#60a5fa;font-size:11px;">NT#' + m.nt_license_id + '</span>' : '<span style="color:#334155;">—</span>';
        const action  = m.status === 'active' ? cancelBtn(m.email, 'monthly', 'CANCEL') : '<span style="color:#334155;font-size:12px;">Inactive</span>';
        return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
            '<td style="padding:12px 14px;color:#94a3b8;font-size:13px;">' + (m.full_name || '—') + '</td>' +
            '<td style="padding:12px 14px;color:#64748b;font-size:13px;">' + m.email + '</td>' +
            '<td style="padding:12px 14px;">' + badge(m.status) + '</td>' +
            '<td style="padding:12px 14px;color:#475569;font-size:12px;">' + exp + '</td>' +
            '<td style="padding:12px 14px;">' + ntBadge + '</td>' +
            '<td style="padding:12px 14px;">' + action + '</td></tr>';
    }).join('');

    const licenseRows = (licenses || []).map(l => {
        const ntBadge = l.nt_license_id ? '<span style="color:#60a5fa;font-size:11px;">NT#' + l.nt_license_id + '</span>' : '<span style="color:#334155;">—</span>';
        const action  = l.status === 'active' ? cancelBtn(l.email, 'lifetime', 'REVOKE') : '<span style="color:#334155;font-size:12px;">Inactive</span>';
        return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
            '<td style="padding:12px 14px;color:#94a3b8;font-size:13px;">' + (l.full_name || '—') + '</td>' +
            '<td style="padding:12px 14px;color:#64748b;font-size:13px;">' + l.email + '</td>' +
            '<td style="padding:12px 14px;">' + badge(l.status, true) + '</td>' +
            '<td style="padding:12px 14px;color:#475569;font-size:12px;font-family:monospace;">' + (l.license_key || '') + '</td>' +
            '<td style="padding:12px 14px;">' + ntBadge + '</td>' +
            '<td style="padding:12px 14px;">' + action + '</td></tr>';
    }).join('');

    const discordRows = (discordMems || []).map(d => {
        const exp    = d.expires_at ? new Date(d.expires_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'N/A';
        const action = d.status === 'active' ? cancelBtn(d.email, 'discord', 'CANCEL') : '<span style="color:#334155;font-size:12px;">Inactive</span>';
        return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
            '<td style="padding:12px 14px;color:#94a3b8;font-size:13px;">' + (d.full_name || '—') + '</td>' +
            '<td style="padding:12px 14px;color:#64748b;font-size:13px;">' + d.email + '</td>' +
            '<td style="padding:12px 14px;">' + badge(d.status) + '</td>' +
            '<td style="padding:12px 14px;color:#475569;font-size:12px;">' + exp + '</td>' +
            '<td style="padding:12px 14px;color:#a78bfa;font-size:12px;">' + (d.discord_username || (d.discord_user_id ? 'Linked' : '—')) + '</td>' +
            '<td style="padding:12px 14px;">' + action + '</td></tr>';
    }).join('');

    const liveRows = liveHVT.map(m => {
        const safe = m.user.username.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">' +
            '<td style="padding:12px 14px;color:#94a3b8;font-size:13px;">' + (m.nick || '—') + '</td>' +
            '<td style="padding:12px 14px;color:#a78bfa;font-size:13px;">@' + m.user.username + '</td>' +
            '<td style="padding:12px 14px;color:#475569;font-size:11px;font-family:monospace;">' + m.user.id + '</td>' +
            '<td style="padding:12px 14px;"><button onclick="removeRole(\'' + m.user.id + '\',\'' + safe + '\')" style="background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;">REMOVE</button></td></tr>';
    }).join('');

    const mCount  = (members || []).length;
    const lCount  = (licenses || []).length;
    const dCount  = (discordMems || []).length;
    const lvCount = liveHVT.length;

    // Embed the admin secret directly in the page so fetch calls always have it
    // The page is already protected by adminGuard, so this is safe
    const SECRET = JSON.stringify(key);

    const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#000;min-height:100vh;padding:32px 24px;color:#fff}
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.06)}
.brand{font-size:20px;font-weight:700;letter-spacing:3px;text-transform:uppercase}
.restricted{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:20px;padding:5px 14px;font-size:11px;color:#f87171;letter-spacing:2px;font-weight:700}
.sec{margin-bottom:36px}.sec-ttl{font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#64748b;margin-bottom:16px}
.panel{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden}
.pt{height:3px;background:linear-gradient(90deg,#2254F5,#2254F5)}
.pt-gold{background:linear-gradient(90deg,#92610a,#f6ad55,#92610a)}
.pt-purple{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95)}
.pt-green{background:linear-gradient(90deg,#14532d,#16a34a,#14532d)}
table{width:100%;border-collapse:collapse}
th{padding:12px 14px;text-align:left;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#334155;border-bottom:1px solid rgba(255,255,255,0.06)}
.fc{padding:28px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;margin-bottom:20px}
.gc{padding:28px;background:rgba(124,58,237,0.05);border:1px solid rgba(124,58,237,0.15);border-radius:16px;margin-bottom:20px}
.ntc{padding:28px;background:rgba(6,182,212,0.04);border:1px solid rgba(6,182,212,0.15);border-radius:16px;margin-bottom:20px}
.bar{height:3px;margin:-28px -28px 24px;border-radius:16px 16px 0 0}
.bar-red{background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d)}
.bar-purple{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95)}
.bar-cyan{background:linear-gradient(90deg,#164e63,#06b6d4,#164e63)}
input[type=email],input[type=text],select{width:100%;padding:12px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#fff;font-size:14px;outline:none;font-family:'DM Sans',sans-serif;margin-bottom:12px}
input:focus,select:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,0.15)}
input::placeholder{color:#334155}
.btn-red{padding:12px 32px;background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer}
.btn-purple{padding:12px 32px;background:linear-gradient(135deg,#4c1d95,#7c3aed);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer}
.btn-cyan{padding:12px 32px;background:linear-gradient(135deg,#164e63,#06b6d4);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer}
.msg{margin-top:14px;padding:12px 16px;border-radius:10px;font-size:13px;display:none;line-height:1.5}
.msg.show{display:block}
.ok{background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2)}
.er{background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2)}
.tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.tab{padding:8px 18px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;border:1px solid rgba(255,255,255,0.08);color:#64748b;background:transparent}
.tab.active{background:rgba(34,84,245,0.1);border-color:rgba(37,99,235,0.3);color:#2254F5}
`;

    // The JS — written as a regular JS string with template literals
    // The SECRET variable is safely embedded server-side
    const adminScript = `
var ADMIN_KEY = ${SECRET};

function showTab(n, el) {
  ['monthly','lifetime','discord37','live'].forEach(function(t) {
    document.getElementById('tab-' + t).style.display = 'none';
  });
  document.querySelectorAll('.tab').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('tab-' + n).style.display = 'block';
  el.classList.add('active');
}

function showMsg(id, ok, text) {
  var el = document.getElementById(id);
  if (!el) return;
  el.className = 'msg ' + (ok ? 'ok' : 'er') + ' show';
  el.textContent = text;
}

function cancelMember(email, type) {
  if (!confirm('Cancel ' + type + ' access for ' + email + '?')) return;
  var msgId = 'cancelMsg';
  showMsg(msgId, true, 'Working...');
  fetch('/admin/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, type: type, key: ADMIN_KEY })
  })
  .then(function(r) {
    return r.json().then(function(d) { return { status: r.status, d: d }; });
  })
  .then(function(x) {
    if (x.d.ok) {
      showMsg(msgId, true, '\\u2713 Cancelled: ' + email + ' (' + type + ')' + (x.d.db_updated ? ' — DB updated' : ''));
      setTimeout(function() { location.reload(); }, 2000);
    } else {
      showMsg(msgId, false, 'Error (' + x.status + '): ' + (x.d.error || JSON.stringify(x.d)));
    }
  })
  .catch(function(err) {
    showMsg(msgId, false, 'Network error: ' + err.message);
  });
}

function cancelManual() {
  var email = document.getElementById('manualEmail').value.trim();
  var type  = document.getElementById('manualType').value;
  if (!email) { showMsg('cancelMsg', false, 'Enter an email first.'); return; }
  cancelMember(email, type);
}

function removeRole(uid, username) {
  if (!confirm('Remove ALL HVT roles from @' + username + '?')) return;
  showMsg('cancelMsg', true, 'Working...');
  fetch('/admin/remove-role', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discord_user_id: uid, key: ADMIN_KEY })
  })
  .then(function(r) { return r.json().then(function(d) { return { status: r.status, d: d }; }); })
  .then(function(x) {
    if (x.d.ok) {
      showMsg('cancelMsg', true, '\\u2713 Roles removed from @' + username);
      setTimeout(function() { location.reload(); }, 2000);
    } else {
      showMsg('cancelMsg', false, 'Error: ' + (x.d.error || JSON.stringify(x.d)));
    }
  })
  .catch(function(err) { showMsg('cancelMsg', false, 'Network error: ' + err.message); });
}

function refreshNT() {
  showMsg('ntMsg', true, 'Working...');
  fetch('/admin/refresh-nt-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: ADMIN_KEY })
  })
  .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
  .then(function(x) { showMsg('ntMsg', x.ok, x.d.message || (x.ok ? 'Done' : 'Error')); })
  .catch(function(err) { showMsg('ntMsg', false, 'Network error: ' + err.message); });
}

function godMode() {
  var email   = document.getElementById('godEmail').value.trim();
  var role    = document.getElementById('godRole').value;
  var name    = document.getElementById('godName').value.trim();
  var duser   = document.getElementById('godUser').value.trim();
  var doEmail = document.getElementById('godSendEmail').checked;
  var doNT    = document.getElementById('godNT').checked;
  var doDC    = document.getElementById('godDiscord').checked;
  if (!email) { showMsg('godMsg', false, 'Email is required.'); return; }
  showMsg('godMsg', true, 'Working...');
  fetch('/admin/god-add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, role: role, full_name: name, discord_username: duser, send_email: doEmail, create_nt: doNT, assign_discord: doDC, key: ADMIN_KEY })
  })
  .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
  .then(function(x) {
    if (x.ok) {
      var parts = [];
      if (x.d.supabase)   parts.push('\\u2713 DB');
      if (x.d.nt_license) parts.push('\\u2713 NT');
      if (x.d.discord)    parts.push('\\u2713 Discord');
      if (x.d.email_sent) parts.push('\\u2713 Email');
      showMsg('godMsg', true, '\\u26a1 Done! ' + parts.join(' | '));
      document.getElementById('godEmail').value = '';
      document.getElementById('godName').value  = '';
      document.getElementById('godUser').value  = '';
    } else {
      showMsg('godMsg', false, 'Error: ' + (x.d.error || JSON.stringify(x.d)));
    }
  })
  .catch(function(err) { showMsg('godMsg', false, 'Network error: ' + err.message); });
}
`;

    // Compute live stats for the stats cards
    const activeMonthly  = (members || []).filter(m => m.status === 'active').length;
    const activeLifetime = (licenses || []).filter(l => l.status === 'active').length;
    const activeDiscord  = (discordMems || []).filter(d => d.status === 'active').length;
    const totalActive    = activeMonthly + activeLifetime + activeDiscord;

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>HVT Admin</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${css}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:36px;}
.stat-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:20px 22px;position:relative;overflow:hidden;}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
.stat-blue::before{background:linear-gradient(90deg,#1e3a8a,#2254F5,#1e3a8a);}
.stat-gold::before{background:linear-gradient(90deg,#92610a,#f6ad55,#92610a);}
.stat-purple::before{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95);}
.stat-green::before{background:linear-gradient(90deg,#14532d,#16a34a,#14532d);}
.stat-cyan::before{background:linear-gradient(90deg,#164e63,#06b6d4,#164e63);}
.stat-num{font-size:36px;font-weight:700;letter-spacing:-1px;color:#fff;line-height:1;}
.stat-lbl{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#475569;margin-top:6px;font-weight:600;}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <div class="brand">High Velocity Trading</div>
    <div style="font-size:10px;color:#334155;letter-spacing:4px;text-transform:uppercase;margin-top:3px;">Admin Control Panel</div>
  </div>
  <div style="display:flex;align-items:center;gap:12px;">
    <span style="font-size:12px;color:${ntColor};font-weight:600;">NT ${ntStatus}</span>
    <div class="restricted">&#9888; RESTRICTED</div>
  </div>
</div>

<!-- STATS OVERVIEW -->
<div class="stats-grid">
  <div class="stat-card stat-blue">
    <div class="stat-num">${totalActive}</div>
    <div class="stat-lbl">Total Active</div>
  </div>
  <div class="stat-card stat-blue">
    <div class="stat-num">${activeMonthly}</div>
    <div class="stat-lbl">Monthly Active</div>
  </div>
  <div class="stat-card stat-gold">
    <div class="stat-num">${activeLifetime}</div>
    <div class="stat-lbl">Lifetime Active</div>
  </div>
  <div class="stat-card stat-purple">
    <div class="stat-num">${activeDiscord}</div>
    <div class="stat-lbl">Discord $37</div>
  </div>
  <div class="stat-card stat-green">
    <div class="stat-num">${lvCount}</div>
    <div class="stat-lbl">Live on Discord</div>
  </div>
  <div class="stat-card stat-cyan">
    <div class="stat-num" style="color:${ntColor};">${ntToken ? '✓' : '✗'}</div>
    <div class="stat-lbl">NT API Status</div>
  </div>
</div>

<!-- NT STATUS -->
<div class="sec">
  <div class="sec-ttl">&#9670; NinjaTrader API Status</div>
  <div class="ntc">
    <div class="bar bar-cyan"></div>
    <div style="font-size:16px;font-weight:700;color:#67e8f9;margin-bottom:4px;">NT Ecosystem API</div>
    <div style="color:#64748b;font-size:13px;margin-bottom:16px;">Auto-authenticates every 45 min.</div>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
      <span style="background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.2);border-radius:20px;padding:6px 16px;font-size:13px;color:${ntColor};font-weight:700;">${ntStatus}</span>
      <span style="color:#334155;font-size:12px;">Auth failures: ${ntAuthFails}</span>
    </div>
    <button class="btn-cyan" onclick="refreshNT()">&#8635; FORCE RE-LOGIN</button>
    <div class="msg" id="ntMsg"></div>
  </div>
</div>

<!-- GOD MODE -->
<div class="sec">
  <div class="sec-ttl">&#9889; God Mode &mdash; Grant Access</div>
  <div class="gc">
    <div class="bar bar-purple"></div>
    <div style="font-size:16px;font-weight:700;color:#c4b5fd;margin-bottom:6px;">Grant Full Access Instantly</div>
    <div style="color:#64748b;font-size:13px;margin-bottom:20px;">Creates Supabase record, NT license, Discord role, sends magic login link.</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
      <div><label style="display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#7c3aed;margin-bottom:8px;">Email *</label><input type="text" id="godEmail" placeholder="their@email.com"/></div>
      <div><label style="display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#7c3aed;margin-bottom:8px;">Access Type</label>
        <select id="godRole"><option value="monthly">Monthly Member</option><option value="lifetime">Lifetime Member</option><option value="discord">Discord Room ($37)</option></select></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
      <div><label style="display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#7c3aed;margin-bottom:8px;">Full Name</label><input type="text" id="godName" placeholder="John Smith"/></div>
      <div><label style="display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#7c3aed;margin-bottom:8px;">Discord Username</label><input type="text" id="godUser" placeholder="username"/></div>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px;">
      <label style="display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:13px;cursor:pointer;"><input type="checkbox" id="godSendEmail" checked style="accent-color:#a78bfa;width:16px;height:16px;"> Send login email</label>
      <label style="display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:13px;cursor:pointer;"><input type="checkbox" id="godNT" checked style="accent-color:#a78bfa;width:16px;height:16px;"> Create NT license</label>
      <label style="display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:13px;cursor:pointer;"><input type="checkbox" id="godDiscord" style="accent-color:#a78bfa;width:16px;height:16px;"> Assign Discord role</label>
    </div>
    <button class="btn-purple" onclick="godMode()">&#9889; GRANT ACCESS NOW</button>
    <div class="msg" id="godMsg"></div>
  </div>
</div>

<!-- CANCEL / REVOKE -->
<div class="sec">
  <div class="sec-ttl">Manual Access Removal</div>
  <div class="fc">
    <div class="bar bar-red"></div>
    <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px;">Cancel / Revoke by Email</div>
    <div style="color:#64748b;font-size:13px;margin-bottom:20px;">Cancels Authnet sub, removes Discord role, revokes NT license, marks account cancelled in Supabase.</div>
    <label style="display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Member Email</label>
    <input type="email" id="manualEmail" placeholder="member@email.com"/>
    <label style="display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Membership Type</label>
    <select id="manualType">
      <option value="monthly">Monthly Membership</option>
      <option value="lifetime">Lifetime License</option>
      <option value="discord">Discord Room ($37)</option>
    </select>
    <button class="btn-red" onclick="cancelManual()" style="margin-top:4px;">&#128293; CANCEL ACCESS</button>
    <div class="msg" id="cancelMsg"></div>
  </div>
</div>

<!-- MEMBER TABLES -->
<div class="sec">
  <div class="sec-ttl">Member Management</div>
  <div class="tabs">
    <button class="tab active" onclick="showTab('monthly',this)">Monthly (${mCount})</button>
    <button class="tab" onclick="showTab('lifetime',this)">Lifetime (${lCount})</button>
    <button class="tab" onclick="showTab('discord37',this)">Discord $37 (${dCount})</button>
    <button class="tab" onclick="showTab('live',this)">Live on Discord (${lvCount})</button>
  </div>

  <div id="tab-monthly" class="panel"><div class="pt"></div>
    <div style="overflow-x:auto;"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Expires</th><th>NT License</th><th>Action</th></tr></thead>
      <tbody>${memberRows || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#334155;">No records</td></tr>'}</tbody>
    </table></div>
  </div>

  <div id="tab-lifetime" class="panel" style="display:none;"><div class="pt pt-gold"></div>
    <div style="overflow-x:auto;"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>License Key</th><th>NT License</th><th>Action</th></tr></thead>
      <tbody>${licenseRows || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#334155;">No records</td></tr>'}</tbody>
    </table></div>
  </div>

  <div id="tab-discord37" class="panel" style="display:none;"><div class="pt pt-purple"></div>
    <div style="overflow-x:auto;"><table>
      <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Expires</th><th>Discord</th><th>Action</th></tr></thead>
      <tbody>${discordRows || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#334155;">No records</td></tr>'}</tbody>
    </table></div>
  </div>

  <div id="tab-live" class="panel" style="display:none;"><div class="pt pt-green"></div>
    <div style="padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);color:#64748b;font-size:12px;">Discord members with active HVT roles.</div>
    <div style="overflow-x:auto;"><table>
      <thead><tr><th>Display Name</th><th>Username</th><th>Discord ID</th><th>Action</th></tr></thead>
      <tbody>${liveRows || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#334155;">No members found</td></tr>'}</tbody>
    </table></div>
  </div>
</div>

<script>${adminScript}</script>
</body>
</html>`;

    res.send(html);
    } catch (e) { console.error('[AdminPanel]', e.message, e.stack); res.status(500).send('<h1 style="color:red">Admin panel error: ' + e.message + '</h1>'); }
});

// ─── EMAIL PREVIEW (admin only) ───────────────────────────────────────────────
app.get('/admin/email-preview', adm, adminGuard, (req, res) => {
    const type    = req.query.type || 'monthly';
    const name    = 'Alex';
    const monthly = type === 'monthly';

    const wrapPreview = content => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
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

    const toggleBar = `<div style="background:#0f172a;border-bottom:1px solid #1e293b;padding:12px 20px;display:flex;gap:12px;align-items:center;position:sticky;top:0;z-index:100;">
      <span style="color:#64748b;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Preview:</span>
      <a href="/admin/email-preview?type=monthly" style="padding:6px 16px;border-radius:6px;font-size:12px;font-weight:700;text-decoration:none;${monthly ? 'background:#1d4ed8;color:#fff;' : 'background:#1e293b;color:#64748b;'}">Monthly</a>
      <a href="/admin/email-preview?type=lifetime" style="padding:6px 16px;border-radius:6px;font-size:12px;font-weight:700;text-decoration:none;${!monthly ? 'background:#d97706;color:#fff;' : 'background:#1e293b;color:#64748b;'}">Lifetime</a>
      <span style="color:#334155;font-size:11px;margin-left:auto;">Admin preview only — not a real email</span>
    </div>`;

    const emailBody = wrapPreview(monthly
        ? `<div style="text-align:center;padding-bottom:8px;"><div style="display:inline-block;background:rgba(34,84,245,0.1);border:1px solid rgba(34,84,245,0.25);border-radius:20px;padding:5px 18px;margin-bottom:22px;"><span style="color:#60a5fa;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">Monthly Membership — Active</span></div><h1 style="color:#ffffff;font-size:26px;font-weight:800;margin:0 0 10px;letter-spacing:-0.5px;">Welcome to the Team, ${name}.</h1><p style="color:#64748b;font-size:14px;margin:0;">Thank you for joining High Velocity Trading.</p></div>`
        : `<div style="text-align:center;padding-bottom:8px;"><div style="display:inline-block;background:rgba(246,173,85,0.1);border:1px solid rgba(246,173,85,0.3);border-radius:20px;padding:5px 18px;margin-bottom:22px;"><span style="color:#f6ad55;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">Lifetime Access — Active</span></div><h1 style="color:#ffffff;font-size:26px;font-weight:800;margin:0 0 10px;letter-spacing:-0.5px;">Welcome to the Team, ${name}.</h1><p style="color:#64748b;font-size:14px;margin:0;">Thank you for investing in yourself.</p></div>`
    );
    res.send(toggleBar + emailBody);
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

app.listen(PORT, () => console.log(`🚀 HVT Backend on port ${PORT}`));
