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


// ─── LOGO EXPLICIT ROUTE (backup if static middleware misses it) ──────────────
app.get('/favicon.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon.png'));
});
app.get('/hvt-logo.cropped.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'hvt-logo.cropped.png'));
});
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
const DISCORD_INVITE_URL       = process.env.DISCORD_INVITE_URL       || 'https://discord.gg/highvelocitytrading';

const MEMBERSHIP_TABLE = process.env.SUPABASE_TABLE || 'membershipstab';
const LICENSE_TABLE    = 'license_keys';
const DISCORD_TABLE    = 'discord_members';
const JOURNAL_TABLE    = 'journal_trades';
const PROP_FIRM_TABLE  = 'prop_firm_activations';

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
function shell(title, body, hero) {
    const pill = (hero && hero.pill) ? hero.pill : 'MEMBER PORTAL';
    const heroTitle = (hero && hero.title) ? hero.title : 'Your Edge Starts Here';
    const heroSub = (hero && hero.sub) ? hero.sub : 'Access your live trading room, course, and billing — all in one place.';
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon.png?v=1">
<title>${title} – High Velocity Trading</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Bebas+Neue&family=Montserrat:wght@800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Sans',sans-serif;background:#000000;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:110px 20px 24px;color:#fff;position:relative;overflow-x:hidden;}
.hvt-bg{position:fixed;inset:0;z-index:0;pointer-events:none;background:#000000;}
.hvt-bg::before{content:'';position:absolute;top:0;left:0;width:65%;height:65%;background:radial-gradient(ellipse at 15% 30%,#00001C 0%,transparent 65%);pointer-events:none;}
.hero{text-align:center;margin-bottom:16px;position:relative;z-index:1;}
.hero-pill{display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.25);border-radius:999px;color:#2254F5;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-family:'DM Sans',sans-serif;padding:6px 18px;}
.hero h1{font-family:'DM Sans',sans-serif;font-weight:700;font-size:42px;color:#ffffff;line-height:1.15;letter-spacing:-0.5px;margin:16px 0 12px;}
.hero-sub{font-family:'DM Sans',sans-serif;font-weight:400;font-size:15px;color:#94a3b8;line-height:1.6;max-width:960px;margin:0 auto 0;}
.hero-div{height:1px;background:linear-gradient(90deg,transparent,rgba(34,84,245,0.3),transparent);margin:16px auto 0;max-width:200px;}
.topnav-wrap{position:fixed;top:0;left:0;right:0;z-index:10;}
.topnav{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:64px;width:100%;background:rgba(10,10,12,0.85);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.08);position:relative;}
.topnav-logo{display:flex;align-items:center;gap:0;text-decoration:none;}
.topnav-logo img{height:39px;width:auto;object-fit:contain;display:block;background:transparent;}
.topnav-left{display:flex;align-items:center;gap:12px;}
.topnav-left a.topnav-link{color:rgba(255,255,255,0.65);font-size:14px;font-weight:500;text-decoration:none;letter-spacing:0.2px;padding:8px 0;transition:color .2s;}
.topnav-left a.topnav-link:hover{color:rgba(255,255,255,0.85);}
.topnav-right{display:flex;align-items:center;gap:12px;flex-shrink:0;}
.topnav-right a.topnav-link,.topnav-right a.topnav-out{color:rgba(255,255,255,0.65);font-size:14px;font-weight:500;text-decoration:none;letter-spacing:0.2px;padding:8px 0;transition:color .2s;}
.topnav-right a.topnav-link:hover,.topnav-right a.topnav-out:hover{color:rgba(255,255,255,0.85);}
.topnav-cta{display:inline-block;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.9);font-size:13px;font-weight:500;text-decoration:none;padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);letter-spacing:0.2px;transition:background .2s,color .2s,border-color .2s;}
.topnav-cta:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.18);}
@media(max-width:600px){
  .topnav{padding:0 12px;}
  .topnav-left a.topnav-link{display:none;}
  .topnav-right a.topnav-link,.topnav-right a.topnav-out{display:none;}
  .topnav-right a.topnav-cta{display:inline-block;}
  .topnav-logo img{height:31px;}
}
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
.discord-join-btn{display:inline-flex;align-items:center;gap:10px;padding:12px 24px;background:#5865F2;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:8px;font-size:13px;font-weight:600;letter-spacing:0.3px;text-decoration:none;box-shadow:0 2px 12px rgba(88,101,242,0.25);transition:background .2s,box-shadow .2s,transform .2s;}
.discord-join-btn:hover{background:#4752C4;box-shadow:0 4px 20px rgba(88,101,242,0.35);transform:translateY(-1px);}
.discord-join-btn img{height:22px;width:auto;object-fit:contain;flex-shrink:0;display:block;}
</style></head><body>
<div class="hvt-bg" aria-hidden="true"></div>
<div class="topnav-wrap">
  <nav class="topnav">
    <div class="topnav-left">
      <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="topnav-logo"><img src="/hvt-logo.cropped.png" alt="High Velocity Trading" style="height:39px;width:auto;object-fit:contain;display:block;" onerror="this.onerror=null;this.style.display='none'" /></a>
    </div>
    <div class="topnav-right" style="display:flex;align-items:center;gap:12px;">
      ${hero && hero.hideNav ? '' : '<a href="/member" class="topnav-link" style="color:rgba(255,255,255,0.7);font-size:14px;font-weight:500;text-decoration:none;padding:8px 0;">Portal</a><a href="/prop-activation" style="display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,#2254F5,#3b6ff5);color:#fff;font-size:13px;font-weight:700;text-decoration:none;padding:7px 14px;border-radius:6px;border:1px solid rgba(34,84,245,0.5);letter-spacing:0.3px;box-shadow:0 0 12px rgba(34,84,245,0.45);">&#9670; Prop Firm</a><a href="/billing/confirm-session" class="topnav-out" style="color:rgba(255,255,255,0.7);font-size:14px;font-weight:500;text-decoration:none;padding:8px 0;">Billing</a><a href="/logout" class="topnav-out" style="color:rgba(255,255,255,0.7);font-size:14px;font-weight:500;text-decoration:none;padding:8px 0;">Log out</a>'}
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

// ─── DOWNLOADS ────────────────────────────────────────────────────────────────
app.get('/downloads/installer', frm, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
    try {
        // Try signed URL first
        const { data, error } = await supabase.storage.from('uploads').createSignedUrl('HVTMasterAccessNQ.zip', 300);
        if (error) {
            console.error('[DownloadInstaller] Signed URL error:', error.message, error.statusCode || '');
            // Fallback: try public URL
            const { data: pub } = supabase.storage.from('uploads').getPublicUrl('HVTMasterAccessNQ.zip');
            if (pub?.publicUrl) {
                console.log('[DownloadInstaller] Falling back to public URL');
                return res.redirect(302, pub.publicUrl);
            }
            return res.status(500).json({ error: 'Download unavailable. Please contact support.', detail: error.message });
        }
        const url = data.signedUrl + (data.signedUrl.includes('?') ? '&' : '?') + 'download=HVTMasterAccessNQ.zip';
        return res.redirect(302, url);
    } catch (e) {
        console.error('[DownloadInstaller] Exception:', e.message);
        return res.status(500).json({ error: 'Download unavailable. Please contact support.' });
    }
});

app.get('/downloads/template', frm, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
    try {
        // Try signed URL first
        const { data, error } = await supabase.storage.from('uploads').createSignedUrl('HVT NQ TEMPLATE.xml', 300);
        if (error) {
            console.error('[DownloadTemplate] Signed URL error:', error.message, error.statusCode || '');
            // Fallback: try public URL
            const { data: pub } = supabase.storage.from('uploads').getPublicUrl('HVT NQ TEMPLATE.xml');
            if (pub?.publicUrl) {
                console.log('[DownloadTemplate] Falling back to public URL');
                return res.redirect(302, pub.publicUrl + '?download=HVT_NQ_TEMPLATE.xml');
            }
            return res.status(500).json({ error: 'Download unavailable. Please contact support.', detail: error.message });
        }
        const url = data.signedUrl + (data.signedUrl.includes('?') ? '&' : '?') + 'download=HVT_NQ_TEMPLATE.xml';
        return res.redirect(302, url);
    } catch (e) {
        console.error('[DownloadTemplate] Exception:', e.message);
        return res.status(500).json({ error: 'Download unavailable. Please contact support.' });
    }
});

// ─── TRADING ROOM ─────────────────────────────────────────────────────────────
app.get('/trading-room', (req, res) => {
    res.send(shell('Get Started', `
<style>
.gs-wrap{width:100%;max-width:560px;display:flex;flex-direction:column;gap:16px;position:relative;z-index:1;}
.gs-step{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden;transition:border-color .2s;}
.gs-step.done{border-color:rgba(74,222,128,0.35);}
.gs-head{display:flex;align-items:center;gap:16px;padding:22px 24px;}
.gs-num{width:36px;height:36px;border-radius:50%;background:rgba(34,84,245,0.15);border:1px solid rgba(34,84,245,0.3);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#2254F5;flex-shrink:0;transition:all .3s;}
.gs-step.done .gs-num{background:rgba(74,222,128,0.15);border-color:rgba(74,222,128,0.4);color:#4ade80;}
.gs-head-text{flex:1;}
.gs-title{font-size:16px;font-weight:700;color:#fff;margin-bottom:3px;}
.gs-subtitle{font-size:13px;color:#64748b;line-height:1.5;}
.gs-check{width:22px;height:22px;border-radius:50%;background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.3);display:none;align-items:center;justify-content:center;color:#4ade80;font-size:13px;flex-shrink:0;}
.gs-step.done .gs-check{display:flex;}
.gs-body{padding:0 24px 24px;}
.gs-divider{height:1px;background:rgba(255,255,255,0.06);margin-bottom:20px;}
.gs-btn{width:100%;padding:13px;border:none;border-radius:12px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;transition:all .2s;letter-spacing:0.3px;}
.gs-btn-blue{background:#2254F5;color:#fff;box-shadow:0 4px 16px rgba(34,84,245,0.3);}
.gs-btn-blue:hover{background:#1d47d4;transform:translateY(-1px);}
.gs-btn-blue:disabled{opacity:.4;cursor:not-allowed;transform:none;}
.gs-btn-discord{background:#5865F2;color:#fff;box-shadow:0 4px 16px rgba(88,101,242,0.3);display:flex;align-items:center;justify-content:center;gap:12px;}
.gs-btn-discord:hover{background:#4752c4;transform:translateY(-1px);}
.gs-input{width:100%;padding:13px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:#fff;font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s;margin-bottom:12px;font-family:'DM Sans',sans-serif;}
.gs-input:focus{border-color:#2254F5;box-shadow:0 0 0 3px rgba(34,84,245,0.2);}
.gs-input::placeholder{color:#334155;}
.gs-label{display:block;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#475569;margin-bottom:8px;}
.gs-msg{margin-top:12px;padding:12px 16px;border-radius:10px;font-size:13px;text-align:center;display:none;line-height:1.5;}
.gs-msg.show{display:block;}
.gs-msg.ok{background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2);}
.gs-msg.er{background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2);}
.gs-dl-row{display:flex;flex-direction:column;gap:10px;}
.gs-dl-btn{display:flex;align-items:center;gap:12px;padding:14px 18px;background:rgba(34,84,245,0.06);border:1px solid rgba(34,84,245,0.18);border-radius:12px;color:#fff;text-decoration:none;font-size:14px;font-weight:600;transition:all .2s;}
.gs-dl-btn:hover{background:rgba(34,84,245,0.12);border-color:rgba(34,84,245,0.35);transform:translateX(3px);}
.gs-dl-icon{width:36px;height:36px;border-radius:9px;background:rgba(34,84,245,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.gs-dl-text{flex:1;}
.gs-dl-name{font-size:14px;font-weight:700;color:#fff;}
.gs-dl-desc{font-size:12px;color:#64748b;margin-top:1px;}
.gs-tip{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px 16px;margin-top:12px;}
.gs-tip p{color:#475569;font-size:12px;margin:0;line-height:1.7;}
.gs-nt-signup{display:inline-flex;align-items:center;gap:8px;margin-top:12px;padding:10px 18px;background:#D9452A;color:#fff;border-radius:9px;font-size:13px;font-weight:800;letter-spacing:1px;text-decoration:none;box-shadow:0 4px 14px rgba(217,69,42,0.35);transition:all .2s;}
.gs-nt-signup:hover{background:#c43d25;transform:translateY(-1px);}
.gs-discord-logo{width:28px;height:28px;object-fit:contain;display:block;flex-shrink:0;}
</style>

<div class="gs-wrap">

  <!-- HEADER -->
  <div style="text-align:center;margin-bottom:8px;">
    <div style="display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.2);border-radius:999px;padding:6px 20px;margin-bottom:14px;">
      <span style="color:#2254F5;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">Get Started</span>
    </div>
    <h1 style="font-size:28px;font-weight:800;color:#fff;margin:0 0 8px;letter-spacing:-0.5px;">3 Steps to Full Access</h1>
    <p style="color:#64748b;font-size:14px;margin:0;">Complete each step independently. Takes less than 5 minutes total.</p>
  </div>

  <!-- STEP 1 — NINJATRADER -->
  <div class="gs-step" id="step1">
    <div class="gs-head">
      <div class="gs-num">1</div>
      <div class="gs-head-text">
        <div class="gs-title">Activate Your Software</div>
        <div class="gs-subtitle">Verify your purchase and enter your NinjaTrader email to activate</div>
      </div>
      <div class="gs-check">&#10003;</div>
    </div>
    <div class="gs-body">
      <div class="gs-divider"></div>
      <div style="background:rgba(34,84,245,0.05);border:1px solid rgba(34,84,245,0.12);border-radius:12px;padding:14px 16px;margin-bottom:18px;display:flex;align-items:flex-start;gap:12px;">
        <div style="flex-shrink:0;margin-top:2px;">${ninjaLogoSVG()}</div>
        <div>
          <div style="font-size:12px;font-weight:700;color:#2254F5;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">NinjaTrader Required</div>
          <div style="font-size:13px;color:#94a3b8;line-height:1.6;">You need a free NinjaTrader account before activating. Don't have one?</div>
          <a href="https://lp.ninjatrader.com/platform?im_ref=XLAQAKxrwxyZWIqQPWQSz2P0Uku26HTRR1lDXQ0&sharedid=&irpid=7019303&irgwc=1&afsrc=1" target="_blank" rel="noopener noreferrer" class="gs-nt-signup">Create Free Account &rarr;</a>
        </div>
      </div>
      <label class="gs-label" for="nt-purchase-email">Purchase Email</label>
      <input class="gs-input" type="email" id="nt-purchase-email" placeholder="email you used to purchase HVT" />
      <label class="gs-label" for="ntemail">NinjaTrader Account Email</label>
      <input class="gs-input" type="email" id="ntemail" placeholder="email you use to log into NinjaTrader" />
      <button class="gs-btn gs-btn-blue" id="btn-nt" onclick="activateNT()">Activate Software</button>
      <div class="gs-msg" id="msg-nt"></div>
    </div>
  </div>

  <!-- STEP 2 — DOWNLOADS -->
  <div class="gs-step" id="step2">
    <div class="gs-head">
      <div class="gs-num">2</div>
      <div class="gs-head-text">
        <div class="gs-title">Download & Install Software</div>
        <div class="gs-subtitle">Install the HVT indicator package and chart template</div>
      </div>
      <div class="gs-check">&#10003;</div>
    </div>
    <div class="gs-body">
      <div class="gs-divider"></div>
      <div class="gs-dl-row">
        <a href="/downloads/installer" class="gs-dl-btn" id="dl-software" onclick="markStep2()">
          <div class="gs-dl-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2254F5" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>
          </div>
          <div class="gs-dl-text">
            <div class="gs-dl-name">HVT Indicator Package</div>
            <div class="gs-dl-desc">NinjaTrader 8 indicator suite — install this first</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </a>
        <a href="/downloads/template" class="gs-dl-btn" id="dl-template" onclick="markStep2()">
          <div class="gs-dl-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2254F5" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg>
          </div>
          <div class="gs-dl-text">
            <div class="gs-dl-name">NQ Chart Template</div>
            <div class="gs-dl-desc">Pre-built chart layout — import after installing indicators</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </a>
      </div>
      <div class="gs-tip" style="margin-top:14px;">
        <p>&#128161; <strong style="color:#94a3b8;">Install order matters:</strong> Install the indicator package first, then import the chart template. Both require NinjaTrader 8 to be installed.</p>
      </div>
    </div>
  </div>

  <!-- STEP 3 — DISCORD -->
  <div class="gs-step" id="step3">
    <div class="gs-head">
      <div class="gs-num">3</div>
      <div class="gs-head-text">
        <div class="gs-title">Join the Discord Trading Room</div>
        <div class="gs-subtitle">Get your member role and access the live trading room</div>
      </div>
      <div class="gs-check">&#10003;</div>
    </div>
    <div class="gs-body">
      <div class="gs-divider"></div>

      <!-- Join Discord first -->
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">Step A — Join the Server</div>
        <a href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener noreferrer" class="gs-btn gs-btn-discord" style="text-decoration:none;display:flex;" onclick="markDiscordJoined()">
          <img src="/discordlogo.png" alt="Discord" class="gs-discord-logo" />
          <span style="font-size:15px;font-weight:700;">Join HVT Discord Server</span>
        </a>
      </div>

      <!-- Then activate role -->
      <div style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">Step B — Activate Your Role</div>
      <label class="gs-label" for="email">Your Purchase Email</label>
      <input class="gs-input" type="email" id="email" placeholder="email you used to purchase" />
      <label class="gs-label" for="discord">Your Discord Username</label>
      <input class="gs-input" type="text" id="discord" placeholder="e.g. johntrader22" />
      <div class="gs-tip" style="margin-bottom:14px;">
        <p>&#128161; <strong style="color:#94a3b8;">Finding your username:</strong> In Discord, click your avatar at the bottom-left. Your username is below your display name — lowercase, may include numbers. <strong style="color:#94a3b8;">Not your display name — the actual username.</strong></p>
      </div>
      <button class="gs-btn gs-btn-blue" id="btn-discord" onclick="activateDiscord()">Assign My Discord Role</button>
      <div class="gs-msg" id="msg-discord"></div>
    </div>
  </div>

</div>

<script>
// ── STEP 1: NinjaTrader activation ────────────────────────────────────────────
async function activateNT() {
  const purchaseEmail = document.getElementById('nt-purchase-email').value.trim();
  const ntEmail = document.getElementById('ntemail').value.trim();
  const msg     = document.getElementById('msg-nt');
  const btn     = document.getElementById('btn-nt');
  msg.className = 'gs-msg';
  if (!purchaseEmail) { msg.className='gs-msg er show'; msg.textContent='Please enter your purchase email.'; return; }
  if (!ntEmail) { msg.className='gs-msg er show'; msg.textContent='Please enter your NinjaTrader account email.'; return; }
  btn.disabled = true; btn.textContent = 'Activating...';
  try {
    const r = await fetch('/trading-room/activate-nt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: purchaseEmail, ninjatrader_email: ntEmail })
    });
    const d = await r.json();
    if (r.ok) {
      msg.className = 'gs-msg ok show';
      msg.textContent = '\\u2713 Software activated! Open NinjaTrader &mdash; your HVT software is now live.';
      btn.textContent = 'Software Activated \\u2713';
      document.getElementById('step1').classList.add('done');
    } else {
      msg.className = 'gs-msg er show';
      msg.textContent = d.error || 'Something went wrong. Please try again.';
      btn.disabled = false; btn.textContent = 'Activate Software';
    }
  } catch { msg.className='gs-msg er show'; msg.textContent='Network error. Please try again.'; btn.disabled=false; btn.textContent='Activate Software'; }
}

// ── STEP 2: Mark downloads done ───────────────────────────────────────────────
function markStep2() {
  setTimeout(function(){ document.getElementById('step2').classList.add('done'); }, 1500);
}

// ── STEP 3: Discord role activation ──────────────────────────────────────────
function markDiscordJoined() {
  // Small delay to let them open Discord, then visually indicate they should come back
}

async function activateDiscord() {
  const email   = document.getElementById('email').value.trim();
  const disc    = document.getElementById('discord').value.trim();
  const msg     = document.getElementById('msg-discord');
  const btn     = document.getElementById('btn-discord');
  msg.className = 'gs-msg';
  if (!email) { msg.className='gs-msg er show'; msg.textContent='Please enter your purchase email.'; return; }
  if (!disc)  { msg.className='gs-msg er show'; msg.textContent='Please enter your Discord username.'; return; }
  btn.disabled = true; btn.textContent = 'Activating...';
  try {
    const r = await fetch('/trading-room/activate-discord', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, discord_username: disc })
    });
    const d = await r.json();
    if (r.ok) {
      msg.className = 'gs-msg ok show';
      msg.textContent = '\\u2713 Done! Your Discord role has been assigned. Check the HVT server — you now have full access.';
      btn.textContent = 'Role Assigned \\u2713';
      document.getElementById('step3').classList.add('done');
    } else {
      msg.className = 'gs-msg er show';
      msg.textContent = d.error || 'Something went wrong. Please try again.';
      btn.disabled = false; btn.textContent = 'Assign My Discord Role';
    }
  } catch { msg.className='gs-msg er show'; msg.textContent='Network error. Please try again.'; btn.disabled=false; btn.textContent='Assign My Discord Role'; }
}

// Enter key support
document.getElementById('ntemail').addEventListener('keydown', e => { if(e.key==='Enter') activateNT(); });
document.getElementById('discord').addEventListener('keydown', e => { if(e.key==='Enter') activateDiscord(); });
</script>`, { pill: 'GET STARTED', title: '3 Steps to Full Access', sub: 'Complete each step below to unlock everything.' }));
});

app.post('/trading-room/activate', frm, express.json(), async (req, res) => {
    try {
        const email   = (req.body.email || '').toLowerCase().trim();
        const discUser= (req.body.discord_username || '').trim();
        const ntEmail = (req.body.ninjatrader_email || '').toLowerCase().trim();
        if (!ntEmail)  return res.status(400).json({ error: 'NinjaTrader email is required' });
        if (!email)    return res.status(400).json({ error: 'Email is required' });
        if (!discUser) return res.status(400).json({ error: 'Discord username is required' });

        const [{ data: mem }, { data: licRows }, { data: dm }] = await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).select('status,expires_at,nt_license_id').eq('email', email).order('updated_at', { ascending: false }).limit(1),
            supabase.from(LICENSE_TABLE).select('status,nt_license_id').eq('email', email).order('updated_at', { ascending: false }).limit(1),
            supabase.from(DISCORD_TABLE).select('status,expires_at').eq('email', email).order('updated_at', { ascending: false }).limit(1)
        ]);
        const mem0 = mem?.[0] ?? null;
        const lic  = licRows?.[0] ?? null;
        const dm0  = dm?.[0] ?? null;
        const isMonthly  = mem0?.status === 'active' && new Date(mem0.expires_at) > new Date();
        const isLifetime = lic?.status === 'active';
        const isDiscord  = dm0?.status  === 'active' && new Date(dm0.expires_at)  > new Date();

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
        const existingNtId = isLifetime ? lic?.nt_license_id : mem0?.nt_license_id;
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

// ─── STEP 1: NinjaTrader ONLY activation (new split route) ───────────────────
app.post('/trading-room/activate-nt', frm, express.json(), async (req, res) => {
    try {
        const ntEmail = (req.body.ninjatrader_email || '').toLowerCase().trim();
        const email   = (req.body.email || '').toLowerCase().trim();
        if (!ntEmail) return res.status(400).json({ error: 'NinjaTrader email is required.' });

        // We need their purchase email to look up their membership
        // If not provided, try to find by NT email stored from a previous activation
        let mem = null, lic = null;
        if (email) {
            const [{ data: m }, { data: l }] = await Promise.all([
                supabase.from(MEMBERSHIP_TABLE).select('status,expires_at,nt_license_id,email').eq('email', email).maybeSingle(),
                supabase.from(LICENSE_TABLE).select('status,nt_license_id,email').eq('email', email).maybeSingle()
            ]);
            mem = m; lic = l;
        } else {
            // Try lookup by NT email previously stored
            const [{ data: m }, { data: l }] = await Promise.all([
                supabase.from(MEMBERSHIP_TABLE).select('status,expires_at,nt_license_id,email').eq('nt_email', ntEmail).maybeSingle(),
                supabase.from(LICENSE_TABLE).select('status,nt_license_id,email').eq('nt_email', ntEmail).maybeSingle()
            ]);
            mem = m; lic = l;
        }

        const isMonthly  = mem?.status === 'active' && new Date(mem.expires_at) > new Date();
        const isLifetime = lic?.status === 'active';
        if (!isMonthly && !isLifetime) return res.status(403).json({ error: 'No active membership found. Please also enter your purchase email, or contact support at 786-461-4235.' });

        const ntType       = isLifetime ? 'lifetime' : 'monthly';
        const existingNtId = isLifetime ? lic?.nt_license_id : mem?.nt_license_id;
        const memberEmail  = isLifetime ? lic.email : mem.email;

        if (existingNtId) {
            // Already has an NT license — just confirm success
            console.log(`[NT-only] Already has NT license: ${memberEmail}`);
            return res.json({ ok: true });
        }

        const ntId = await ntCreateLicense(ntEmail, ntType);
        if (!ntId) return res.status(500).json({ error: 'Failed to create NinjaTrader license. Please try again or contact support.' });

        if (isLifetime) await supabase.from(LICENSE_TABLE).update({ nt_license_id: ntId, nt_email: ntEmail, updated_at: nowISO() }).eq('email', memberEmail);
        else            await supabase.from(MEMBERSHIP_TABLE).update({ nt_license_id: ntId, nt_email: ntEmail, updated_at: nowISO() }).eq('email', memberEmail);

        console.log(`✅ NT-only activated: ${memberEmail} | NT email: ${ntEmail} | id: ${ntId}`);
        res.json({ ok: true });
    } catch (e) { console.error('[NT-only activate]', e.message); res.status(500).json({ error: 'Server error. Please try again or call 786-461-4235.' }); }
});

// ─── STEP 3: Discord ONLY activation (new split route) ───────────────────────
app.post('/trading-room/activate-discord', frm, express.json(), async (req, res) => {
    try {
        const email    = (req.body.email || '').toLowerCase().trim();
        const discUser = (req.body.discord_username || '').trim();
        if (!email)    return res.status(400).json({ error: 'Purchase email is required.' });
        if (!discUser) return res.status(400).json({ error: 'Discord username is required.' });

        const [{ data: memRows2 }, { data: licRows2 }, { data: dmRows2 }] = await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).order('updated_at', { ascending: false }).limit(1),
            supabase.from(LICENSE_TABLE).select('status').eq('email', email).order('updated_at', { ascending: false }).limit(1),
            supabase.from(DISCORD_TABLE).select('status,expires_at').eq('email', email).order('updated_at', { ascending: false }).limit(1)
        ]);
        const mem2 = memRows2?.[0] ?? null;
        const lic2 = licRows2?.[0] ?? null;
        const dm2  = dmRows2?.[0] ?? null;
        const isMonthly  = mem2?.status === 'active' && new Date(mem2.expires_at) > new Date();
        const isLifetime = lic2?.status === 'active';
        const isDiscord  = dm2?.status  === 'active' && new Date(dm2.expires_at) > new Date();

        if (!isMonthly && !isLifetime && !isDiscord)
            return res.status(403).json({ error: 'No active membership found for this email. Please check your email or contact support at 786-461-4235.' });

        const found = await findUser(discUser);
        if (!found) return res.status(404).json({ error: `Discord user "${discUser}" not found in the HVT server. Make sure you have joined first, then try again.` });

        const uid = found.user.id;
        const rid = isLifetime ? DISCORD_LIFETIME_ROLE_ID : (isDiscord ? (DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID) : DISCORD_MONTHLY_ROLE_ID);
        await addRole(uid, rid);

        if (isMonthly) await supabase.from(MEMBERSHIP_TABLE).update({ discord_user_id: uid, discord_username: discUser, updated_at: nowISO() }).eq('email', email);
        if (isDiscord) await supabase.from(DISCORD_TABLE).update({ discord_user_id: uid, discord_username: discUser, updated_at: nowISO() }).eq('email', email);
        if (isLifetime) await supabase.from(LICENSE_TABLE).update({ discord_user_id: uid, discord_username: discUser, updated_at: nowISO() }).eq('email', email);

        console.log(`✅ Discord-only: @${discUser} (${uid}) → ${email}`);
        res.json({ ok: true });
    } catch (e) { console.error('[Discord-only activate]', e.message); res.status(500).json({ error: 'Server error. Please try again or call 786-461-4235.' }); }
});

// ─── COURSE / MEMBER ACCESS ───────────────────────────────────────────────────
// ─── SESSION HELPERS ──────────────────────────────────────────────────────────
// Sessions are stored BOTH in-memory (fast) AND in Supabase (survives Railway restarts).
// On restart, the in-memory map is empty but the cookie is still valid — we fall back
// to Supabase to re-hydrate the session so the member stays logged in.
const SESSION_COOKIE = 'hvt_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const _sessions = new Map(); // token -> { email, name, plan, expires }
setInterval(() => { const n = Date.now(); for (const [k, s] of _sessions) if (n > s.expires) _sessions.delete(k); }, 3600000);

function createSession(email, name, plan) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + SESSION_TTL_MS;
    _sessions.set(token, { email, name, plan, expires });
    // Persist to Supabase so session survives server restarts
    const expiresISO = new Date(expires).toISOString();
    // Try membership table first, fall back to license table — fire-and-forget
    (async () => {
        try {
            const { data: mem } = await supabase.from(MEMBERSHIP_TABLE).select('email').eq('email', email).maybeSingle();
            if (mem) {
                await supabase.from(MEMBERSHIP_TABLE).update({ session_token: token, session_expires: expiresISO, updated_at: nowISO() }).eq('email', email);
            } else {
                await supabase.from(LICENSE_TABLE).update({ session_token: token, session_expires: expiresISO, updated_at: nowISO() }).eq('email', email);
            }
        } catch (e) { console.error('[Session persist]', e.message); }
    })();
    return token;
}

function getSessionFromCookie(req) {
    const raw = req.headers.cookie || '';
    const match = raw.match(new RegExp(`${SESSION_COOKIE}=([a-f0-9]{64})`));
    if (!match) return { token: null, cached: null };
    const token = match[1];
    const s = _sessions.get(token);
    if (s && Date.now() <= s.expires) return { token, cached: s };
    // Token exists in cookie but not in memory (restart) — need DB lookup
    return { token, cached: null };
}

function getSession(req) {
    const { token, cached } = getSessionFromCookie(req);
    if (!token) return null;
    if (cached) return cached;
    // Token in memory has expired or memory was wiped — caller must handle async
    // For sync callers, return null (async version handles the restart case)
    return null;
}

// Async version — used in requireSession and route handlers
async function getSessionAsync(req) {
    const { token, cached } = getSessionFromCookie(req);
    if (!token) return null;
    if (cached) return cached;
    // Memory miss — re-hydrate from Supabase (handles Railway restart case)
    try {
        const now = new Date().toISOString();
        // Check membership table
        const { data: mem } = await supabase.from(MEMBERSHIP_TABLE)
            .select('email,full_name,status,expires_at,session_token,session_expires')
            .eq('session_token', token)
            .maybeSingle();
        if (mem && mem.session_expires && mem.session_expires > now) {
            const isActive = mem.status === 'active' && new Date(mem.expires_at) > new Date();
            const s = {
                email: mem.email,
                name: (mem.full_name || 'Trader').split(' ')[0],
                plan: 'Monthly Membership',
                expires: new Date(mem.session_expires).getTime()
            };
            _sessions.set(token, s); // re-hydrate memory cache
            console.log(`[Session] Re-hydrated from DB (monthly): ${mem.email}`);
            return s;
        }
        // Check lifetime license table
        const { data: lic } = await supabase.from(LICENSE_TABLE)
            .select('email,full_name,status,session_token,session_expires')
            .eq('session_token', token)
            .maybeSingle();
        if (lic && lic.session_expires && lic.session_expires > now) {
            const s = {
                email: lic.email,
                name: (lic.full_name || 'Trader').split(' ')[0],
                plan: 'Lifetime Access',
                expires: new Date(lic.session_expires).getTime()
            };
            _sessions.set(token, s); // re-hydrate memory cache
            console.log(`[Session] Re-hydrated from DB (lifetime): ${lic.email}`);
            return s;
        }
    } catch (e) { console.error('[Session re-hydrate]', e.message); }
    return null;
}

async function requireSession(req, res, next) {
    const s = await getSessionAsync(req);
    if (s) { req._session = s; return next(); }
    res.redirect('/login');
}

// ─── LOGIN PAGE (was /course) ─────────────────────────────────────────────────
app.get('/login', async (req, res) => {
    if (await getSessionAsync(req)) return res.redirect('/member');
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
        </div>
      </div>
    </div>
    <script>
      async function go(){const email=document.getElementById('email').value.trim();const msg=document.getElementById('msg');const btn=document.getElementById('btn');msg.className='msg';if(!email){msg.className='msg er show';msg.textContent='Please enter your email.';return}btn.disabled=true;btn.textContent='Sending...';try{const r=await fetch('/course/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\u2713 Check your email \u2014 your secure link is on the way!';btn.textContent='Link Sent \u2713'}else{msg.className='msg er show';msg.textContent=d.error||'Something went wrong.';btn.disabled=false;btn.textContent='Send My Access Link'}}catch{msg.className='msg er show';msg.textContent='Network error.';btn.disabled=false;btn.textContent='Send My Access Link'}}
      document.getElementById('email').addEventListener('keydown',e=>{if(e.key==='Enter')go();});
    </script>`, {hideNav:true, pill:'MEMBER LOGIN', title:'Member Access', sub:'Enter your email to receive a secure login link.'}));
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
        if (!rec.course_token_expires || new Date(rec.course_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/login" style="color:#2254F5;">Request a new one</a>.'));
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
.topnav{display:flex;align-items:center;justify-content:space-between;padding:0 28px;height:64px;width:100%;background:rgba(10,10,12,0.85);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.08);position:relative}
.topnav-logo{display:flex;align-items:center;text-decoration:none}
.topnav-logo img{height:39px;width:auto;object-fit:contain;display:block;background:transparent;}
.topnav-left{display:flex;align-items:center;gap:12px}
.topnav-left a.topnav-link{color:rgba(255,255,255,0.65);font-size:14px;font-weight:500;text-decoration:none;letter-spacing:0.2px;padding:8px 0;transition:color .2s}
.topnav-left a.topnav-link:hover{color:rgba(255,255,255,0.85)}
.topnav-right{display:flex;align-items:center;gap:12px}
.topnav-out{color:rgba(255,255,255,0.7);font-size:14px;font-weight:500;text-decoration:none;padding:8px 0;transition:color .2s}
.topnav-out:hover{color:rgba(255,255,255,0.85)}
.topnav-cta{display:inline-block;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.9);font-size:13px;font-weight:500;text-decoration:none;padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);letter-spacing:0.2px;transition:background .2s,color .2s,border-color .2s}
.topnav-cta:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.18)}
@media(max-width:600px){
  .topnav{padding:0 12px;}
  .topnav-left a.topnav-link{display:none;}
  .topnav-right a.topnav-out{display:none;}
  .topnav-right a.topnav-cta{display:inline-block;}
  .topnav-logo img{height:31px;}
}
.portal-wrap{position:relative;z-index:1;max-width:900px;margin:0 auto;padding:100px 24px 64px}
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
      <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="topnav-logo"><img src="/hvt-logo.cropped.png" alt="High Velocity Trading" style="height:39px;width:auto;object-fit:contain;display:block;" onerror="this.onerror=null;this.style.display='none'" /></a>
    </div>
    <div class="topnav-right">
      <a href="/prop-activation" style="display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,#2254F5,#3b6ff5);color:#fff;font-size:13px;font-weight:700;text-decoration:none;padding:7px 14px;border-radius:6px;border:1px solid rgba(34,84,245,0.5);letter-spacing:0.3px;box-shadow:0 0 12px rgba(34,84,245,0.45);">&#9670; Prop Firm</a>
      <a href="/billing/confirm-session" class="topnav-out">Billing</a>
      <a href="/logout" class="topnav-out">Log out</a>
      <a href="tel:786-461-4235" class="topnav-cta">Call Us</a>
    </div>
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
    <a class="pcard" href="/trading-room">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/></svg></div>
        <h3>Get Started</h3>
        <p>Activate your Discord access and NinjaTrader indicators. Takes less than 2 minutes.</p>
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

// ─── MEMBER PORTAL (session-gated dashboard) ─────────────────────────────────
app.get('/member', requireSession, (req, res) => {
    const s = req._session;
    res.send(memberPortalHtml(s));
});

// ─── TRADING JOURNAL (session-gated) ──────────────────────────────────────────
app.get('/trading-journal', requireSession, (req, res) => {
    const s = req._session;
    const hero = { pill: 'TRADING JOURNAL', title: 'Track. Review. Improve.', sub: `<span style="display:block;max-width:900px;margin:0 auto;">Every trade logged is a lesson earned.</span><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;max-width:900px;margin:20px auto 0;text-align:left;"><div style="background:#111827;border:2px solid #2254F5;border-radius:10px;padding:16px;"><div style="width:24px;height:24px;border-radius:50%;background:#2254F5;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;margin-bottom:8px;">1</div><div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:4px;">Download Indicator</div><div style="font-size:11px;color:#64748b;line-height:1.5;margin-bottom:10px;">Get HVTJournalSync from your member downloads.</div><a href="/download-indicator" style="display:inline-block;background:#2254F5;color:#fff;text-decoration:none;padding:6px 12px;border-radius:6px;font-size:11px;font-weight:700;">DOWNLOAD &rarr;</a></div><div style="background:#111827;border:2px solid #2254F5;border-radius:10px;padding:16px;"><div style="width:24px;height:24px;border-radius:50%;background:#2254F5;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;margin-bottom:8px;">2</div><div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:4px;">Import into NinjaTrader</div><div style="font-size:11px;color:#64748b;line-height:1.5;">NinjaTrader &rarr; <strong style="color:#e2e8f0;">Tools &rarr; Import &rarr; NinjaScript</strong> &rarr; select the file.</div></div><div style="background:#111827;border:2px solid #2254F5;border-radius:10px;padding:16px;"><div style="width:24px;height:24px;border-radius:50%;background:#2254F5;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;margin-bottom:8px;">3</div><div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:4px;">Add to Chart &amp; Enter Email</div><div style="font-size:11px;color:#64748b;line-height:1.5;">Right-click chart &rarr; <strong style="color:#e2e8f0;">Indicators</strong> &rarr; add HVTJournalSync &rarr; enter your Get Started email &rarr; OK.</div></div></div>` };
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

    </div>

    <style>
      body{justify-content:flex-start !important;padding-top:90px !important;}
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
        document.getElementById('cal-info').onclick = function(){ alert('Daily PnL: green = profit day, red = loss day. Live from NinjaTrader via HVTJournalSync.'); };
        render();
        var liveData={pnl:{},trades:{},recent:[],open:[]};
        function applyPeriodFilter(p){
          var now=new Date();
          var f=liveData.recent.filter(function(t){
            var d=new Date(t.exit_time);
            if(p==='day') return d.toDateString()===now.toDateString();
            if(p==='week'){var w=new Date(now);w.setDate(now.getDate()-now.getDay());w.setHours(0,0,0,0);return d>=w;}
            if(p==='month') return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();
            return true;
          });
          var wins=f.filter(function(t){return t.net_pnl>0;}),losses=f.filter(function(t){return t.net_pnl<=0;});
          var net=f.reduce(function(s,t){return s+(t.net_pnl||0);},0);
          var wp=f.length?Math.round(wins.length/f.length*100):null;
          var aw=wins.length?wins.reduce(function(s,t){return s+(t.net_pnl||0);},0)/wins.length:null;
          var al=losses.length?losses.reduce(function(s,t){return s+(t.net_pnl||0);},0)/losses.length:null;
          var gw=wins.reduce(function(s,t){return s+(t.net_pnl||0);},0);
          var gl=Math.abs(losses.reduce(function(s,t){return s+(t.net_pnl||0);},0));
          var pf=gl>0?gw/gl:(gw>0?999:null);
          var dk=Object.keys(liveData.pnl).sort();var ds=0;
          for(var i=dk.length-1;i>=0;i--){if(liveData.pnl[dk[i]]>0)ds++;else break;}
          var ts=0,sd=null;
          for(var j=liveData.recent.length-1;j>=0;j--){var ww=liveData.recent[j].net_pnl>0;if(sd===null)sd=ww;if(ww===sd)ts++;else break;}
          function s(id,txt,col){var e=document.getElementById(id);if(e){e.textContent=txt;if(col)e.style.color=col;}}
          s('stat-pnl',(net>=0?'+':'')+'$'+Math.abs(net).toFixed(2),net>0?'#4ade80':net<0?'#f87171':'#94a3b8');
          s('stat-avgwl',aw!==null?'+$'+aw.toFixed(0)+' / -$'+Math.abs(al||0).toFixed(0):'—',aw!==null?'#e2e8f0':'#94a3b8');
          s('stat-daystreak',ds+' day'+(ds!==1?'s':''),ds>0?'#4ade80':'#94a3b8');
          s('stat-wins',wp!==null?wp+'%':'—',wp!==null?(wp>=50?'#4ade80':'#f87171'):'#94a3b8');
          s('stat-pf',pf!==null?pf.toFixed(2):'—',pf!==null?(pf>=1?'#4ade80':'#f87171'):'#94a3b8');
          s('stat-tradestreak',ts+' trade'+(ts!==1?'s':''),ts>0&&sd===true?'#4ade80':ts>0&&sd===false?'#f87171':'#94a3b8');
          var tb=document.querySelector('#trades-recent table tbody');
          if(tb){if(!f.length){tb.innerHTML='<tr><td colspan="3" style="text-align:center;color:#64748b;padding:28px;">No trades recorded yet</td></tr>';}
          else{tb.innerHTML=f.slice().reverse().map(function(t){var c=t.net_pnl>0?'#4ade80':t.net_pnl<0?'#f87171':'#94a3b8';var d=new Date(t.exit_time);
            return '<tr><td>'+(t.instrument||'—')+'</td><td>'+(d.getMonth()+1)+'/'+d.getDate()+'/'+d.getFullYear()+'</td><td style="color:'+c+';font-weight:600;">'+(t.net_pnl>=0?'+':'')+' $'+Math.abs(t.net_pnl||0).toFixed(2)+'</td></tr>';}).join('');}}
          var ob=document.querySelector('#trades-open table tbody');
          if(ob){if(!liveData.open||!liveData.open.length){ob.innerHTML='<tr><td colspan="3" style="text-align:center;color:#64748b;padding:24px;">No open positions</td></tr>';}
          else{ob.innerHTML=liveData.open.map(function(p){var c=p.unrealized_pnl>=0?'#4ade80':'#f87171';
            return '<tr><td>'+(p.instrument||'—')+'</td><td style="color:'+(p.direction==='Long'?'#60a5fa':'#f6ad55')+';">'+(p.direction||'—')+'</td><td style="color:'+c+';font-weight:600;">'+(p.unrealized_pnl>=0?'+':'')+' $'+Math.abs(p.unrealized_pnl||0).toFixed(2)+'</td></tr>';}).join('');}}
          samplePnL=liveData.pnl;sampleTrades=liveData.trades;render();
        }
        function loadJournalData(){fetch('/api/journal/data',{credentials:'include'}).then(function(r){return r.ok?r.json():Promise.reject(r.status);}).then(function(d){liveData=d;applyPeriodFilter(period);}).catch(function(e){console.warn('[HVTJournal]',e);});}
        document.querySelectorAll('.journal-tab').forEach(function(btn){btn.addEventListener('click',function(){setTimeout(function(){applyPeriodFilter(period);},0);});});
        loadJournalData();
        setInterval(loadJournalData,10000);
      })();
    </script>`, hero));
});

// ─── JOURNAL API ──────────────────────────────────────────────────────────────
const JOURNAL_RATE = rateLimit({ max: 120 });

async function verifyJournalEmail(email) {
    if (!email) return null;
    const e = email.toLowerCase().trim();
    const [{ data: m }, { data: l }, { data: d }, { data: mNT }, { data: lNT }] = await Promise.all([
        supabase.from(MEMBERSHIP_TABLE).select('email,status,expires_at').eq('email', e).maybeSingle(),
        supabase.from(LICENSE_TABLE).select('email,status').eq('email', e).maybeSingle(),
        supabase.from(DISCORD_TABLE).select('email,status,expires_at').eq('email', e).maybeSingle(),
        supabase.from(MEMBERSHIP_TABLE).select('email,status,expires_at').eq('nt_email', e).maybeSingle(),
        supabase.from(LICENSE_TABLE).select('email,status').eq('nt_email', e).maybeSingle()
    ]);
    const isMonthly  = (m?.status==='active'&&new Date(m.expires_at)>new Date())||(mNT?.status==='active'&&new Date(mNT.expires_at)>new Date());
    const isLifetime = l?.status==='active'||lNT?.status==='active';
    const isDiscord  = d?.status==='active'&&new Date(d.expires_at)>new Date();
    if (!isMonthly&&!isLifetime&&!isDiscord) return null;
    return (m||mNT||l||lNT||d)?.email||e;
}

app.post('/api/journal/trade', JOURNAL_RATE, express.json(), async (req, res) => {
    try {
        const { email, trade } = req.body || {};
        const canonical = await verifyJournalEmail(email);
        if (!canonical) return res.status(401).json({ error: 'No active membership found for this email.' });
        if (!trade||!trade.trade_id) return res.status(400).json({ error: 'Missing trade data.' });
        const { error } = await supabase.from(JOURNAL_TABLE).upsert({
            email: canonical, account_name: trade.account_name||null, instrument: trade.instrument||null,
            direction: trade.direction||null, quantity: trade.quantity||0, entry_price: trade.entry_price||0,
            exit_price: trade.exit_price||0, entry_time: trade.entry_time||null, exit_time: trade.exit_time||null,
            pnl: trade.pnl||0, commission: trade.commission||0, net_pnl: trade.net_pnl||0,
            trade_id: trade.trade_id, is_open: false, unrealized_pnl: 0, updated_at: nowISO()
        }, { onConflict: 'trade_id' });
        if (error) { console.error('[Journal/trade]', error.message); return res.status(500).json({ error: 'DB error.' }); }
        res.json({ ok: true });
    } catch (e) { console.error('[Journal/trade]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/journal/positions', JOURNAL_RATE, express.json(), async (req, res) => {
    try {
        const { email, open_positions } = req.body || {};
        const canonical = await verifyJournalEmail(email);
        if (!canonical) return res.status(401).json({ error: 'No active membership found for this email.' });
        await supabase.from(JOURNAL_TABLE).update({ is_open: false, updated_at: nowISO() }).eq('email', canonical).eq('is_open', true);
        if (open_positions&&open_positions.length>0) {
            await supabase.from(JOURNAL_TABLE).insert(open_positions.map(p => ({
                email: canonical, account_name: p.account_name||null, instrument: p.instrument||null,
                direction: p.direction||null, quantity: p.quantity||0, entry_price: p.avg_price||0,
                exit_price: 0, entry_time: p.updated_at||nowISO(), exit_time: null,
                pnl: 0, commission: 0, net_pnl: 0,
                trade_id: `open_${canonical}_${p.instrument}_${Date.now()}`,
                is_open: true, unrealized_pnl: p.unrealized_pnl||0, updated_at: nowISO()
            })));
        }
        res.json({ ok: true });
    } catch (e) { console.error('[Journal/positions]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/journal/data', requireSession, async (req, res) => {
    try {
        const email = req._session.email.toLowerCase().trim();
        const { data: rows, error } = await supabase.from(JOURNAL_TABLE)
            .select('instrument,direction,quantity,entry_price,exit_price,entry_time,exit_time,pnl,commission,net_pnl,is_open,unrealized_pnl')
            .eq('email', email).order('exit_time', { ascending: false }).limit(2000);
        if (error) return res.status(500).json({ error: 'DB error.' });
        const closed=(rows||[]).filter(t=>!t.is_open), open=(rows||[]).filter(t=>t.is_open);
        const pnlMap={}, tradesMap={};
        closed.forEach(t => {
            if (!t.exit_time) return;
            const d=new Date(t.exit_time), k=d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();
            pnlMap[k]=Math.round(((pnlMap[k]||0)+(t.net_pnl||0))*100)/100;
            tradesMap[k]=(tradesMap[k]||0)+1;
        });
        res.json({ pnl:pnlMap, trades:tradesMap, recent:closed,
            open:open.map(p=>({instrument:p.instrument,direction:p.direction,quantity:p.quantity,unrealized_pnl:p.unrealized_pnl})) });
    } catch (e) { console.error('[Journal/data]', e.message); res.status(500).json({ error: 'Server error.' }); }
});


// ─── BILLING SHORTCUT VIA SESSION ─────────────────────────────────────────────
app.get('/billing/confirm-session', async (req, res, next) => {
    const _s = await getSessionAsync(req);
    if (_s) { req._session = _s; return next(); }
    res.redirect('/login');
}, async (req, res) => {
    const s = req._session;
    let status = 'active', exAt = null, nextLabel = 'N/A', days = 0, isLifetime = false;
    let cancelHtml = `<div style="margin-top:24px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);"><p style="color:#334155;font-size:12px;text-align:center;margin-bottom:16px;">Want to cancel?</p><a href="/cancel" style="display:block;width:100%;padding:12px;background:transparent;border:1px solid rgba(248,113,113,0.3);color:#f87171;border-radius:999px;font-size:14px;font-weight:700;text-align:center;text-decoration:none;">Cancel Membership</a></div>`;
    try {
        // Check monthly membership table first, then lifetime license table
        const [{ data: mem }, { data: lic }] = await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', s.email).maybeSingle(),
            supabase.from(LICENSE_TABLE).select('status').eq('email', s.email).maybeSingle()
        ]);
        isLifetime = lic?.status === 'active';
        if (isLifetime) {
            // Lifetime — no expiry date, always active
            status = 'active';
            nextLabel = 'Lifetime';
            days = 99999;
        } else if (mem) {
            status = mem.status || 'inactive';
            exAt = mem.expires_at ? new Date(mem.expires_at) : null;
            nextLabel = exAt ? exAt.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : 'N/A';
            days = exAt ? Math.max(0, Math.ceil((exAt - new Date()) / 86400000)) : 0;
            // If expiry has passed, mark as expired even if DB status is 'active'
            if (status === 'active' && exAt && exAt < new Date()) { status = 'expired'; days = 0; }
        } else {
            // No record found at all — membership ended
            status = 'ended';
        }
        // Status labels map: never show raw db values
        if (status !== 'active') {
            cancelHtml = `<div style="margin-top:24px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;"><p style="color:#64748b;font-size:13px;line-height:1.6;">Your membership has ended. To reactivate, visit <a href="https://highvelocitytrading.com/#packages" style="color:#2254F5;text-decoration:none;font-weight:600;">highvelocitytrading.com</a> or call <strong style="color:#94a3b8;">786-461-4235</strong>.</p></div>`;
        }
    } catch (e) { console.error('[BillingSession]', e.message); status = 'error'; }
    // Human-readable status labels
    const statusLabels = { active: '&#9679; Active', cancelled: 'Membership Ended', expired: 'Membership Ended', ended: 'Membership Ended', inactive: 'Membership Ended', error: 'Unable to Load' };
    const statusLabel = statusLabels[status] || 'Membership Ended';
    const isActive = status === 'active';
    const sc = isActive ? '#4ade80' : '#f87171';
    const sb = isActive ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)';
    const sbd = isActive ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)';
    const daysDisplay = isLifetime ? '<span style="color:#f6ad55;font-size:13px;font-weight:600;">Lifetime</span>' : `<span style="color:${days > 7 ? '#4ade80' : (days > 0 ? '#f6ad55' : '#f87171')};font-size:13px;font-weight:600;">${days > 0 ? days + ' days' : 'Expired'}</span>`;
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
            <div style="background:${sb};border:1px solid ${sbd};border-radius:20px;padding:6px 14px;font-size:12px;color:${sc};font-weight:600;">${statusLabel}</div>
          </div>
          <div class="div"></div>
          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Plan</span><span style="color:#94a3b8;font-size:13px;">${s.plan}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Email</span><span style="color:#94a3b8;font-size:13px;">${s.email}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Next Billing</span><span style="color:#94a3b8;font-size:13px;">${nextLabel}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;"><span style="color:#64748b;font-size:13px;">Days Remaining</span>${daysDisplay}</div>
          </div>${cancelHtml}
        </div></div>`));
});

// ─── COURSE PLAYER (cookie-gated) ─────────────────────────────────────────────
app.get('/course', requireSession, (req, res) => {
    // Always enter through the portal — /course is accessed via the portal card
    // If someone hits /course directly (bookmark, stale link), send to portal first
    if (!req.headers.referer || !req.headers.referer.includes('/member')) {
        // Allow direct access from member portal card only
        // For all other entry points (direct URL, email links, bookmarks) → portal
        const ref = req.headers.referer || '';
        if (!ref.includes('/member') && !ref.includes('/course')) {
            return res.redirect(302, '/member');
        }
    }
    const s = req._session;
    const LOGO_URL = '/hvt-logo.cropped.png';
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Course Library — HVT</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{background:#060810;color:#fff;font-family:'DM Sans',-apple-system,sans-serif;display:flex;flex-direction:column}

/* ── TOPBAR ── */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:60px;border-bottom:1px solid rgba(255,255,255,0.07);background:rgba(6,8,16,0.95);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);flex-shrink:0;z-index:200;position:relative}
.topbar-left{display:flex;align-items:center;gap:0;min-width:0;flex-shrink:0}
.topbar-logo{display:flex;align-items:center;text-decoration:none;flex-shrink:0}
.topbar-logo img{height:39px;width:auto;object-fit:contain;display:block;flex-shrink:0}
.topbar-divider{width:1px;height:24px;background:rgba(255,255,255,0.1);margin:0 16px;flex-shrink:0}
.back-btn{display:flex;align-items:center;gap:6px;color:#475569;font-size:12px;font-weight:600;letter-spacing:0.5px;text-decoration:none;white-space:nowrap;transition:color .15s;flex-shrink:0}
.back-btn:hover{color:#94a3b8}
.back-btn svg{flex-shrink:0}
.topbar-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.course-label{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#f6ad55;opacity:0.9;white-space:nowrap}
.user-pill{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:5px 13px;font-size:11px;color:#64748b;font-weight:600;white-space:nowrap;flex-shrink:0}
.mob-menu{display:none;align-items:center;justify-content:center;width:36px;height:36px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;cursor:pointer;color:#94a3b8;font-size:18px;flex-shrink:0;transition:background .15s}
.mob-menu:hover{background:rgba(255,255,255,0.09)}

/* ── LAYOUT ── */
.layout{display:flex;flex:1;overflow:hidden;position:relative}

/* ── SIDEBAR ── */
.sidebar{width:288px;flex-shrink:0;border-right:1px solid rgba(255,255,255,0.07);background:#060810;display:flex;flex-direction:column;overflow:hidden;transition:transform .25s ease}
.sidebar-header{padding:16px 20px 14px;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0}
.sidebar-header h2{font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#334155}
.sidebar-scroll{flex:1;overflow-y:auto;padding:6px 0 16px}
.sidebar-scroll::-webkit-scrollbar{width:3px}
.sidebar-scroll::-webkit-scrollbar-track{background:transparent}
.sidebar-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.07);border-radius:2px}

/* ── SECTION ── */
.section{margin-bottom:1px}
.section-header{display:flex;align-items:center;gap:8px;padding:10px 18px;cursor:pointer;user-select:none;transition:background .15s}
.section-header:hover{background:rgba(255,255,255,0.025)}
.section-dot{width:6px;height:6px;border-radius:50%;background:#1e2d3d;flex-shrink:0;transition:background .2s}
.section.open .section-dot{background:#f6ad55}
.section-title{font-size:11px;font-weight:700;color:#64748b;letter-spacing:0.8px;text-transform:uppercase;flex:1;transition:color .2s}
.section.open .section-title{color:#94a3b8}
.section-count{font-size:10px;color:#1e2d3d;font-weight:600;margin-right:4px}
.section-chevron{color:#1e2d3d;font-size:9px;transition:transform .2s,color .2s}
.section.open .section-chevron{transform:rotate(90deg);color:#334155}
.section-videos{display:none;padding:2px 0 4px}
.section.open .section-videos{display:block}

/* ── VIDEO ITEM ── */
.video-item{display:flex;align-items:center;gap:11px;padding:8px 18px 8px 26px;cursor:pointer;transition:background .12s;position:relative}
.video-item:hover{background:rgba(255,255,255,0.025)}
.video-item.active{background:rgba(246,173,85,0.05)}
.video-item.active::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:#f6ad55;border-radius:0 2px 2px 0}
.video-thumb{width:52px;height:32px;border-radius:5px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.video-thumb img{width:100%;height:100%;object-fit:cover}
.play-icon{width:13px;height:13px;color:#2d3f52}
.video-item.active .play-icon{color:#f6ad55}
.video-info{flex:1;min-width:0}
.video-title{font-size:12px;font-weight:500;color:#475569;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .15s}
.video-item:hover .video-title{color:#64748b}
.video-item.active .video-title{color:#e2e8f0;font-weight:600}
.video-dur{font-size:10px;color:#1e2d3d;margin-top:1px;font-weight:500}

/* ── MAIN CONTENT ── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#060810;min-width:0}
.player-wrap{flex:1;display:flex;align-items:center;justify-content:center;background:#000;position:relative;min-height:0}
.player-wrap iframe{width:100%;height:100%;border:none;display:block}
.player-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#0f1623;text-align:center;padding:40px;width:100%;height:100%}
.player-placeholder svg{opacity:0.25}
.player-placeholder h3{font-size:18px;font-weight:700;color:#0f1623}
.player-placeholder p{font-size:13px;color:#0f1623;max-width:300px;line-height:1.6}
.video-meta{padding:16px 24px;border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;background:#060810;display:none;align-items:center;gap:14px;flex-wrap:wrap}
.video-meta h2{font-size:16px;font-weight:700;color:#fff;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.video-meta-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.section-badge{background:rgba(246,173,85,0.08);border:1px solid rgba(246,173,85,0.18);border-radius:20px;padding:3px 11px;font-size:10px;font-weight:700;color:#f6ad55;letter-spacing:1.5px;text-transform:uppercase;white-space:nowrap}
.video-dur-meta{font-size:12px;color:#334155;font-weight:500;white-space:nowrap}

/* ── SIDEBAR OVERLAY (mobile) ── */
.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:149;backdrop-filter:blur(2px)}
.sidebar-overlay.show{display:block}

/* ── MOBILE ── */
@media(max-width:768px){
  .topbar{padding:0 12px;height:56px}
  .topbar-logo img{height:31px;}
  .topbar-divider{margin:0 10px}
  .course-label{display:none}
  .mob-menu{display:flex}
  .sidebar{position:fixed;left:0;top:56px;bottom:0;width:280px;z-index:150;transform:translateX(-100%);box-shadow:4px 0 32px rgba(0,0,0,0.6)}
  .sidebar.open{transform:translateX(0)}
  .video-meta{padding:12px 16px}
  .video-meta h2{font-size:14px}
}
@media(max-width:400px){
  .topbar-logo img{height:28px;}
  .topbar-divider{margin:0 8px}
  .user-pill{display:none}
}
</style>
</head><body>

<div class="topbar">
  <div class="topbar-left">
    <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="topbar-logo">
      <img src="${LOGO_URL}" alt="High Velocity Trading" style="height:39px;width:auto;object-fit:contain;display:block;" onerror="this.onerror=null;this.style.display='none'" />
    </a>
    <div class="topbar-divider"></div>
    <a class="back-btn" href="/member">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg>
      Portal
    </a>
  </div>
  <div class="topbar-right">
    <span class="course-label">Course Library</span>
    <div class="user-pill">${s.name}</div>
    <button class="mob-menu" id="mobMenu" aria-label="Toggle course menu">&#9776;</button>
  </div>
</div>

<div class="sidebar-overlay" id="sidebarOverlay"></div>

<div class="layout">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header"><h2>Course Content</h2></div>
    <div class="sidebar-scroll" id="sidebarScroll"></div>
  </div>
  <div class="main">
    <div class="player-wrap" id="playerWrap">
      <div class="player-placeholder" id="placeholder">
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.8">
          <path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/>
        </svg>
        <h3>Select a lesson</h3>
        <p>Choose a video from the course menu to get started.</p>
      </div>
      <iframe id="player" style="display:none" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture;web-share" allowfullscreen></iframe>
    </div>
    <div class="video-meta" id="videoMeta">
      <h2 id="videoTitle"></h2>
      <div class="video-meta-right">
        <span class="section-badge" id="videoSection"></span>
        <span class="video-dur-meta" id="videoDur"></span>
      </div>
    </div>
  </div>
</div>

<script>
(function(){
// ── COURSE DATA ──────────────────────────────────────────────────────────────
// To add a video: add ytId: 'YOUTUBE_VIDEO_ID' to any video object
// To add a section: copy the section block pattern below
var COURSE = [
  { title: 'Psychology', videos: [
    { title: 'Welcome to HVT',                      dur: '1m',  ytId: '' },
    { title: 'Why Traders Fail in the Long Run',    dur: '4m',  ytId: '' },
    { title: 'How to Set Yourself Up for Success',  dur: '4m',  ytId: '' },
    { title: 'Expand Your Horizon',                 dur: '3m',  ytId: '' },
    { title: 'Next Steps',                          dur: '1m',  ytId: '' }
  ]},
  { title: 'Basic Technicals', videos: [
    { title: 'Anatomy of a Candlestick',            dur: '9m',  ytId: '' },
    { title: 'Structure \u2014 Uptrend vs Downtrend', dur: '7m', ytId: '' }
  ]}
  // ADD MORE SECTIONS HERE:
  // ,{ title: 'Section Name', videos: [
  //   { title: 'Video Title', dur: '5m', ytId: 'YOUTUBE_ID' }
  // ]}
];

// ── STATE ────────────────────────────────────────────────────────────────────
var activeSec = 0, activeVid = 0;
var sidebarEl  = document.getElementById('sidebar');
var overlayEl  = document.getElementById('sidebarOverlay');
var scrollEl   = document.getElementById('sidebarScroll');
var playerEl   = document.getElementById('player');
var placeholderEl = document.getElementById('placeholder');
var metaEl     = document.getElementById('videoMeta');
var titleEl    = document.getElementById('videoTitle');
var sectionEl  = document.getElementById('videoSection');
var durEl      = document.getElementById('videoDur');

// ── SIDEBAR TOGGLE ───────────────────────────────────────────────────────────
document.getElementById('mobMenu').addEventListener('click', function(){
  var open = sidebarEl.classList.toggle('open');
  overlayEl.classList.toggle('show', open);
});
overlayEl.addEventListener('click', function(){
  sidebarEl.classList.remove('open');
  overlayEl.classList.remove('show');
});

// ── BUILD SIDEBAR ────────────────────────────────────────────────────────────
function buildSidebar(){
  scrollEl.innerHTML = '';
  COURSE.forEach(function(sec, si){
    var secEl = document.createElement('div');
    secEl.className = 'section' + (si === activeSec ? ' open' : '');

    var header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML =
      '<div class="section-dot"></div>' +
      '<div class="section-title">' + esc(sec.title) + '</div>' +
      '<div class="section-count">' + sec.videos.length + '</div>' +
      '<div class="section-chevron">&#9654;</div>';
    header.addEventListener('click', function(){ toggleSection(si); });

    var vids = document.createElement('div');
    vids.className = 'section-videos';
    sec.videos.forEach(function(v, vi){
      var item = document.createElement('div');
      item.className = 'video-item' + (si===activeSec && vi===activeVid ? ' active' : '');
      var thumb = v.ytId
        ? '<img src="https://img.youtube.com/vi/' + v.ytId + '/mqdefault.jpg" alt="" loading="lazy">'
        : '<svg class="play-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"/></svg>';
      item.innerHTML =
        '<div class="video-thumb">' + thumb + '</div>' +
        '<div class="video-info">' +
          '<div class="video-title">' + esc(v.title) + '</div>' +
          '<div class="video-dur">' + esc(v.dur) + '</div>' +
        '</div>';
      item.addEventListener('click', function(){ playVideo(si, vi); });
      vids.appendChild(item);
    });

    secEl.appendChild(header);
    secEl.appendChild(vids);
    scrollEl.appendChild(secEl);
  });
}

// ── TOGGLE SECTION ───────────────────────────────────────────────────────────
function toggleSection(si){
  var els = scrollEl.querySelectorAll('.section');
  if(els[si]) els[si].classList.toggle('open');
}

// ── PLAY VIDEO ───────────────────────────────────────────────────────────────
function playVideo(si, vi){
  activeSec = si; activeVid = vi;
  buildSidebar();
  var v = COURSE[si].videos[vi];
  if(v.ytId){
    playerEl.src = 'https://www.youtube.com/embed/' + v.ytId + '?autoplay=1&rel=0&modestbranding=1';
    playerEl.style.display = 'block';
    placeholderEl.style.display = 'none';
  } else {
    playerEl.style.display = 'none';
    playerEl.src = '';
    placeholderEl.style.display = 'flex';
    placeholderEl.innerHTML =
      '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.8" style="opacity:.2">' +
      '<path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/></svg>' +
      '<h3>Coming Soon</h3><p>This lesson will be available shortly. Check back soon.</p>';
  }
  titleEl.textContent   = v.title;
  sectionEl.textContent = COURSE[si].title;
  durEl.textContent     = v.dur;
  metaEl.style.display  = 'flex';
  // Close mobile sidebar after selection
  if(window.innerWidth < 769){
    sidebarEl.classList.remove('open');
    overlayEl.classList.remove('show');
  }
}

// ── HTML ESCAPE ──────────────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── INIT ─────────────────────────────────────────────────────────────────────
buildSidebar();
})();
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
        if (!data.billing_token_expires || new Date(data.billing_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/billing" style="color:#2254F5;">Request a new one</a>.'));
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
            const { data: lRows, error: fetchErr } = await supabase.from(LICENSE_TABLE).select('nt_license_id,status,email').eq('email', email).order('updated_at', { ascending: false }).limit(1);
            console.log('[AdminCancel] lifetime fetch:', lRows, fetchErr?.message);
            const l = (lRows && lRows.length > 0) ? lRows[0] : null;
            if (!l) return res.status(404).json({ error: 'No lifetime license found for: ' + email });

            // 2. Revoke NT license
            if (l.nt_license_id) {
                try { await ntRevokeLicense(l.nt_license_id); result.nt_revoked = true; }
                catch (e) { console.error('[AdminCancel] NT revoke failed:', e.message); }
            }

            // 3. Update Supabase — license_keys constraint only allows: active, pending_jotform, pending_authorize, inactive
            const { data: upd, error: updErr } = await supabase.from(LICENSE_TABLE).update({ status: 'inactive', updated_at: nowISO() }).eq('email', email).select();
            console.log('[AdminCancel] lifetime update result:', upd, updErr?.message);
            if (updErr) return res.status(500).json({ error: 'DB update failed: ' + updErr.message });
            result.db_updated = true;

        } else if (type === 'discord') {
            // 1. Fetch record
            const { data: dmRows, error: fetchErr } = await supabase.from(DISCORD_TABLE).select('discord_user_id,authnet_subscription_id,status').eq('email', email).order('updated_at', { ascending: false }).limit(1);
            console.log('[AdminCancel] discord fetch:', dmRows, fetchErr?.message);
            const dm = (dmRows && dmRows.length > 0) ? dmRows[0] : null;
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
            const { data: mRows, error: fetchErr } = await supabase.from(MEMBERSHIP_TABLE).select('authnet_subscription_id,discord_user_id,nt_license_id,status,email').eq('email', email).order('updated_at', { ascending: false }).limit(1);
            console.log('[AdminCancel] monthly fetch:', mRows, fetchErr?.message);
            const m = (mRows && mRows.length > 0) ? mRows[0] : null;
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
        // For lifetime: prevent duplicate rows — check existing email, update or insert
        let dbErr = null;
        if (isLifetime) {
            const { data: existingRows } = await supabase.from(table).select('id').eq('email', email).order('updated_at', { ascending: false }).limit(1);
            const existing = existingRows && existingRows.length > 0 ? existingRows[0] : null;
            if (existing) {
                // Update existing record, preserve original transaction_id & license_key
                const { error: updErr } = await supabase.from(table).update({ full_name: row.full_name, status: row.status, plan_name: row.plan_name, source: row.source, updated_at: row.updated_at }).eq('id', existing.id);
                dbErr = updErr;
            } else {
                const { error: insErr } = await supabase.from(table).insert(row);
                dbErr = insErr;
            }
        } else {
            const { error: upsErr } = await supabase.from(table).upsert(row, { onConflict: 'email' });
            dbErr = upsErr;
        }
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
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const key = req.query.key || '';
    const BUILD_TS = 'v' + new Date().toISOString().slice(0,16).replace('T',' '); // e.g. v2026-03-07 22:05
    try {
    const [{ data: members }, { data: licenses }, { data: discordMems }] = await Promise.all([
        supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,plan_name,expires_at,discord_user_id,nt_license_id').order('updated_at', { ascending: false }).limit(100),
        supabase.from(LICENSE_TABLE).select('email,full_name,status,license_key,nt_license_id').order('updated_at', { ascending: false }).limit(100),
        supabase.from(DISCORD_TABLE).select('email,full_name,status,expires_at,discord_user_id,discord_username').order('updated_at', { ascending: false }).limit(100)
    ]);

    let guildMembers = [];
    try { guildMembers = await getGuildAll(); } catch {}
    const allRoles = [DISCORD_MONTHLY_ROLE_ID, DISCORD_LIFETIME_ROLE_ID, ...(DISCORD_ROOM_ROLE_ID ? [DISCORD_ROOM_ROLE_ID] : [])];
    const liveHVT  = guildMembers.filter(m => m.roles && m.roles.some(r => allRoles.includes(r)));
    const ntStatus = ntToken ? '\u2713 Authenticated' : '\u2717 Not Authenticated';
    const ntColor  = ntToken ? '#4ade80' : '#f87171';

    function badge(st, gold) {
        const a = st === 'active';
        const c  = a ? (gold ? '#f6ad55' : '#4ade80') : '#f87171';
        const bg = a ? (gold ? 'rgba(246,173,85,0.08)' : 'rgba(74,222,128,0.08)') : 'rgba(248,113,113,0.08)';
        const bd = a ? (gold ? 'rgba(246,173,85,0.2)' : 'rgba(74,222,128,0.2)') : 'rgba(248,113,113,0.2)';
        return '<span style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:20px;padding:3px 10px;font-size:11px;color:' + c + ';letter-spacing:1px;font-weight:600;">' + st + '</span>';
    }

    function actionBtn(email, type, label) {
        const safeEmail = email.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
        return '<button class="abtn" data-email="' + safeEmail + '" data-type="' + type + '" data-label="' + label + '">' + label + '</button>';
    }

    const memberRows = (members || []).map(m => {
        const exp = m.expires_at ? new Date(m.expires_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'N/A';
        const ntB = m.nt_license_id ? '<span style="color:#60a5fa;font-size:11px;">NT#' + m.nt_license_id + '</span>' : '<span style="color:#334155;">\u2014</span>';
        const act = m.status === 'active' ? actionBtn(m.email,'monthly','CANCEL') : '<span style="color:#334155;font-size:12px;">Inactive</span>';
        return '<tr><td>' + (m.full_name||'\u2014') + '</td><td class="em">' + m.email + '</td><td>' + badge(m.status) + '</td><td class="dt">' + exp + '</td><td>' + ntB + '</td><td>' + act + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">No records</td></tr>';

    const licenseRows = (licenses || []).map(l => {
        const ntB = l.nt_license_id ? '<span style="color:#60a5fa;font-size:11px;">NT#' + l.nt_license_id + '</span>' : '<span style="color:#334155;">\u2014</span>';
        const act = l.status === 'active' ? actionBtn(l.email,'lifetime','REVOKE') : '<span style="color:#334155;font-size:12px;">Inactive</span>';
        return '<tr><td>' + (l.full_name||'\u2014') + '</td><td class="em">' + l.email + '</td><td>' + badge(l.status,true) + '</td><td class="dt" style="font-family:monospace;font-size:11px;">' + (l.license_key||'') + '</td><td>' + ntB + '</td><td>' + act + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">No records</td></tr>';

    const discordRows = (discordMems || []).map(d => {
        const exp = d.expires_at ? new Date(d.expires_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'N/A';
        const act = d.status === 'active' ? actionBtn(d.email,'discord','CANCEL') : '<span style="color:#334155;font-size:12px;">Inactive</span>';
        return '<tr><td>' + (d.full_name||'\u2014') + '</td><td class="em">' + d.email + '</td><td>' + badge(d.status) + '</td><td class="dt">' + exp + '</td><td style="color:#a78bfa;font-size:12px;">' + (d.discord_username||(d.discord_user_id?'Linked':'\u2014')) + '</td><td>' + act + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">No records</td></tr>';

    const liveRows = liveHVT.map(m => {
        const safeId   = (m.user.id||'').replace(/"/g,'&quot;');
        const safeUser = (m.user.username||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
        return '<tr><td>' + (m.nick||'\u2014') + '</td><td style="color:#a78bfa;">@' + m.user.username + '</td><td style="font-family:monospace;font-size:11px;color:#475569;">' + m.user.id + '</td><td><button class="abtn abtn-rm" data-uid="' + safeId + '" data-uname="' + safeUser + '">REMOVE</button></td></tr>';
    }).join('') || '<tr><td colspan="4" class="empty">No live members</td></tr>';

    const activeMonthly  = (members  || []).filter(m => m.status === 'active').length;
    const activeLifetime = (licenses || []).filter(l => l.status === 'active').length;
    const activeDiscord  = (discordMems || []).filter(d => d.status === 'active').length;
    const totalActive    = activeMonthly + activeLifetime + activeDiscord;
    const mCount  = (members  || []).length;
    const lCount  = (licenses || []).length;
    const dCount  = (discordMems || []).length;
    const lvCount = liveHVT.length;

    // Build JS as a plain string — NOT inside the HTML template literal
    // This guarantees no escaping issues and no template literal nesting problems
    const adminJS = [
        'var K=' + JSON.stringify(key) + ';',
        '',
        'function el(id){return document.getElementById(id);}',
        'function on(id,ev,fn){var e=el(id);if(e)e.addEventListener(ev,fn);}',
        '',
        'function showMsg(id,ok,text){',
        '  var e=el(id);if(!e)return;',
        '  e.className="msg "+(ok?"ok":"er")+" show";',
        '  e.textContent=text;',
        '}',
        '',
        'function post(url,body,okCb,errCb){',
        '  fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({key:K},body))})',
        '    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})',
        '    .then(function(x){x.ok?okCb(x.d):errCb(x.d.error||JSON.stringify(x.d));})',
        '    .catch(function(e){errCb("Network error: "+e.message);});',
        '}',
        '',
        '// TABS',
        'document.querySelectorAll(".tab").forEach(function(btn){',
        '  btn.addEventListener("click",function(){',
        '    document.querySelectorAll(".tab").forEach(function(b){b.classList.remove("on");});',
        '    document.querySelectorAll(".tp").forEach(function(p){p.style.display="none";});',
        '    btn.classList.add("on");',
        '    var p=el("tp-"+btn.dataset.tab);',
        '    if(p)p.style.display="block";',
        '  });',
        '});',
        '',
        '// FORCE RE-LOGIN',
        'on("btnRefreshNT","click",function(){',
        '  var btn=el("btnRefreshNT");',
        '  if(btn)btn.disabled=true;',
        '  showMsg("ntMsg",true,"Reconnecting...");',
        '  fetch("/admin/refresh-nt-token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:K})})',
        '    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})',
        '    .then(function(x){showMsg("ntMsg",x.ok,x.d.message||(x.ok?"Done":"Error"));})',
        '    .catch(function(e){showMsg("ntMsg",false,"Network error: "+e.message);})',
        '    .finally(function(){var b=el("btnRefreshNT");if(b)b.disabled=false;});',
        '});',
        '',
        '// TEST STORAGE',
        'on("btnTestStorage","click",function(){',
        '  var btn=el("btnTestStorage");',
        '  if(btn)btn.disabled=true;',
        '  showMsg("storageMsg",true,"Testing...");',
        '  fetch("/admin/test-storage?key="+encodeURIComponent(K))',
        '    .then(function(r){return r.json();})',
        '    .then(function(d){',
        '      var t=["Buckets: "+JSON.stringify(d.buckets),"Uploads: "+JSON.stringify(d.uploads_root),"Installer: "+(d.installer_signed_url||"N/A"),"Template: "+(d.template_signed_url||"N/A")];',
        '      showMsg("storageMsg",!!(d.installer_signed_url&&d.installer_signed_url.length>10),t.join("\\n"));',
        '    })',
        '    .catch(function(e){showMsg("storageMsg",false,"Error: "+e.message);})',
        '    .finally(function(){var b=el("btnTestStorage");if(b)b.disabled=false;});',
        '});',
        '',
        '// GRANT ACCESS',
        'on("btnGodMode","click",function(){',
        '  var email=(el("godEmail").value||"").trim();',
        '  if(!email){showMsg("godMsg",false,"Email is required.");return;}',
        '  var btn=el("btnGodMode");if(btn)btn.disabled=true;',
        '  showMsg("godMsg",true,"Granting access...");',
        '  post("/admin/god-add",{',
        '    email:email,',
        '    role:(el("godRole").value||"monthly"),',
        '    full_name:(el("godName").value||"").trim(),',
        '    discord_username:(el("godUser").value||"").trim(),',
        '    send_email:el("godSendEmail").checked,',
        '    create_nt:el("godNT").checked,',
        '    assign_discord:el("godDiscord").checked',
        '  },function(d){',
        '    var p=[];',
        '    if(d.supabase)p.push("\\u2713 DB");',
        '    if(d.nt_license)p.push("\\u2713 NT");',
        '    if(d.discord)p.push("\\u2713 Discord");',
        '    if(d.email_sent)p.push("\\u2713 Email");',
        '    showMsg("godMsg",true,"\\u26a1 Done! "+(p.length?p.join(" | "):"Access granted"));',
        '    ["godEmail","godName","godUser"].forEach(function(i){var e=el(i);if(e)e.value="";});',
        '    var b=el("btnGodMode");if(b)b.disabled=false;',
        '  },function(e){',
        '    showMsg("godMsg",false,"Error: "+e);',
        '    var b=el("btnGodMode");if(b)b.disabled=false;',
        '  });',
        '});',
        '',
        '// MANUAL CANCEL',
        'on("btnCancel","click",function(){',
        '  var email=(el("manualEmail").value||"").trim();',
        '  var type=(el("manualType").value||"monthly");',
        '  if(!email){showMsg("cancelMsg",false,"Enter an email first.");return;}',
        '  doCancel(email,type);',
        '});',
        '',
        'function doCancel(email,type){',
        '  showMsg("cancelMsg",true,"Cancelling "+email+"...");',
        '  post("/admin/cancel",{email:email,type:type},',
        '    function(d){showMsg("cancelMsg",true,"\\u2713 Cancelled: "+email+(d.db_updated?" \\u2014 DB updated":""));setTimeout(function(){location.reload();},1500);},',
        '    function(e){showMsg("cancelMsg",false,"Error: "+e);}',
        '  );',
        '}',
        '',
        '// TABLE BUTTONS (event delegation)',
        'document.addEventListener("click",function(e){',
        '  var btn=e.target.closest(".abtn");',
        '  if(!btn)return;',
        '  if(btn.classList.contains("abtn-rm")){',
        '    if(btn.dataset.confirm!=="yes"){',
        '      btn.textContent="CONFIRM?";btn.dataset.confirm="yes";',
        '      btn.style.background="linear-gradient(135deg,#92400e,#d97706)";',
        '      setTimeout(function(){if(btn.dataset.confirm==="yes"){btn.textContent="REMOVE";btn.dataset.confirm="";btn.style.background="";}},3000);',
        '      return;',
        '    }',
        '    btn.disabled=true;btn.textContent="...";',
        '    showMsg("cancelMsg",true,"Removing roles from @"+btn.dataset.uname+"...");',
        '    post("/admin/remove-role",{discord_user_id:btn.dataset.uid},',
        '      function(){showMsg("cancelMsg",true,"\\u2713 Removed @"+btn.dataset.uname);setTimeout(function(){location.reload();},1500);},',
        '      function(e){showMsg("cancelMsg",false,"Error: "+e);btn.disabled=false;btn.textContent="REMOVE";}',
        '    );',
        '    return;',
        '  }',
        '  if(btn.dataset.email){',
        '    if(btn.dataset.confirm!=="yes"){',
        '      btn.dataset.confirm="yes";',
        '      var orig=btn.textContent;',
        '      btn.textContent="CONFIRM?";',
        '      btn.style.background="linear-gradient(135deg,#92400e,#d97706)";',
        '      setTimeout(function(){if(btn.dataset.confirm==="yes"){btn.textContent=orig;btn.dataset.confirm="";btn.style.background="";}},3000);',
        '      return;',
        '    }',
        '    btn.disabled=true;btn.textContent="...";',
        '    doCancel(btn.dataset.email,btn.dataset.type);',
        '  }',
        '});',
        '',
        'console.log("[HVT Admin] JS loaded OK. Key present:", !!K);',
    ].join('\n');

    const css = `*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#000;min-height:100vh;padding:28px 20px;color:#fff}
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,0.06)}
.brand{font-size:18px;font-weight:700;letter-spacing:3px;text-transform:uppercase}
.restricted{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:20px;padding:5px 14px;font-size:11px;color:#f87171;letter-spacing:2px;font-weight:700}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin-bottom:28px}
.sc{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:18px 20px;position:relative;overflow:hidden}
.sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.sc-b::before{background:linear-gradient(90deg,#1e3a8a,#2254F5,#1e3a8a)}
.sc-g::before{background:linear-gradient(90deg,#92610a,#f6ad55,#92610a)}
.sc-p::before{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95)}
.sc-gr::before{background:linear-gradient(90deg,#14532d,#16a34a,#14532d)}
.sc-c::before{background:linear-gradient(90deg,#164e63,#06b6d4,#164e63)}
.snum{font-size:32px;font-weight:700;color:#fff;line-height:1}
.slbl{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#475569;margin-top:5px;font-weight:600}
.sec{margin-bottom:28px}
.sec-ttl{font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#64748b;margin-bottom:14px}
.box{border-radius:14px;padding:24px;margin-bottom:16px}
.box-nt{background:rgba(6,182,212,0.04);border:1px solid rgba(6,182,212,0.15)}
.box-gr{background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.15)}
.box-pu{background:rgba(124,58,237,0.05);border:1px solid rgba(124,58,237,0.15)}
.box-re{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08)}
.bbar{height:2px;margin:-24px -24px 20px;border-radius:14px 14px 0 0}
.bbar-cy{background:linear-gradient(90deg,#164e63,#06b6d4,#164e63)}
.bbar-gr{background:linear-gradient(90deg,#14532d,#16a34a,#14532d)}
.bbar-pu{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95)}
.bbar-re{background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d)}
.boxtitle{font-size:15px;font-weight:700;margin-bottom:4px}
.boxsub{color:#64748b;font-size:13px;margin-bottom:18px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
@media(max-width:600px){.row2{grid-template-columns:1fr}}
label{display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:7px}
input,select{width:100%;padding:11px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:9px;color:#fff;font-size:14px;outline:none;font-family:'DM Sans',sans-serif;margin-bottom:12px}
input:focus,select:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,0.15)}
input::placeholder{color:#334155}
select option{background:#111}
.chks{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:18px}
.chk{display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:13px;cursor:pointer}
.chk input{width:16px;height:16px;margin:0;accent-color:#a78bfa}
.btn{padding:11px 28px;border:none;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;transition:opacity .15s}
.btn:hover{opacity:.8}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-cy{background:linear-gradient(135deg,#164e63,#06b6d4);color:#fff}
.btn-gr{background:linear-gradient(135deg,#14532d,#16a34a);color:#fff}
.btn-pu{background:linear-gradient(135deg,#4c1d95,#7c3aed);color:#fff}
.btn-re{background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff}
.msg{margin-top:14px;padding:11px 14px;border-radius:9px;font-size:13px;display:none;line-height:1.5;white-space:pre-wrap;word-break:break-all}
.msg.show{display:block}
.ok{background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2)}
.er{background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2)}
.tabs{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}
.tab{padding:7px 16px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;border:1px solid rgba(255,255,255,0.08);color:#64748b;background:transparent;transition:all .15s}
.tab.on{background:rgba(34,84,245,0.12);border-color:rgba(37,99,235,0.35);color:#2254F5}
.tp{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:14px;overflow:hidden}
.pt{height:3px}
.pt-b{background:linear-gradient(90deg,#1e3a8a,#2254F5,#1e3a8a)}
.pt-g{background:linear-gradient(90deg,#92610a,#f6ad55,#92610a)}
.pt-p{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95)}
.pt-gr{background:linear-gradient(90deg,#14532d,#16a34a,#14532d)}
table{width:100%;border-collapse:collapse}
th{padding:11px 13px;text-align:left;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#334155;border-bottom:1px solid rgba(255,255,255,0.05)}
td{padding:11px 13px;border-bottom:1px solid rgba(255,255,255,0.03);font-size:13px}
tr:last-child td{border-bottom:none}
.em{color:#64748b}
.dt{color:#475569;font-size:12px}
td.empty{padding:20px;text-align:center;color:#334155}
.abtn{background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:6px;padding:5px 13px;font-size:11px;font-weight:700;letter-spacing:1px;cursor:pointer;transition:opacity .15s}
.abtn:hover{opacity:.8}
.abtn:disabled{opacity:.4;cursor:not-allowed}
.ntbadge{display:inline-flex;align-items:center;gap:8px;background:rgba(6,182,212,0.08);border:1px solid rgba(6,182,212,0.2);border-radius:20px;padding:5px 14px;font-size:13px;font-weight:700}`;

    const html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1.0">\n<title>HVT Admin</title>\n<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">\n<style>\n' + css + '\n</style>\n</head>\n<body>\n\n<div class="hdr">\n  <div>\n    <div class="brand">High Velocity Trading</div>\n    <div style="font-size:10px;color:#334155;letter-spacing:3px;text-transform:uppercase;margin-top:2px;">Admin Control Panel &mdash; ' + BUILD_TS + '</div>\n  </div>\n  <div style="display:flex;align-items:center;gap:12px;">\n    <span style="font-size:12px;color:' + ntColor + ';font-weight:600;">NT ' + ntStatus + '</span>\n    <div class="restricted">&#9888; RESTRICTED</div>\n  </div>\n</div>\n\n<div class="stats">\n  <div class="sc sc-b"><div class="snum">' + totalActive + '</div><div class="slbl">Total Active</div></div>\n  <div class="sc sc-b"><div class="snum">' + activeMonthly + '</div><div class="slbl">Monthly Active</div></div>\n  <div class="sc sc-g"><div class="snum">' + activeLifetime + '</div><div class="slbl">Lifetime Active</div></div>\n  <div class="sc sc-p"><div class="snum">' + activeDiscord + '</div><div class="slbl">Discord $37</div></div>\n  <div class="sc sc-gr"><div class="snum">' + lvCount + '</div><div class="slbl">Live on Discord</div></div>\n  <div class="sc sc-c"><div class="snum" style="color:' + ntColor + ';">' + (ntToken ? '&#10003;' : '&#10007;') + '</div><div class="slbl">NT API Status</div></div>\n</div>\n\n<div class="sec">\n  <div class="sec-ttl">&#9670; NinjaTrader API</div>\n  <div class="box box-nt">\n    <div class="bbar bbar-cy"></div>\n    <div class="boxtitle" style="color:#67e8f9;">NT Ecosystem API</div>\n    <div class="boxsub">Auto-authenticates every 45 min. Auth failures: ' + ntAuthFails + '</div>\n    <div style="margin-bottom:16px;"><span class="ntbadge" style="color:' + ntColor + ';">' + ntStatus + '</span></div>\n    <button class="btn btn-cy" id="btnRefreshNT">&#8635; FORCE RE-LOGIN</button>\n    <div class="msg" id="ntMsg"></div>\n  </div>\n  <div class="box box-gr">\n    <div class="bbar bbar-gr"></div>\n    <div class="boxtitle" style="color:#4ade80;">Supabase Storage</div>\n    <div class="boxsub">Test bucket access and file paths for downloads.</div>\n    <button class="btn btn-gr" id="btnTestStorage">&#128196; TEST STORAGE</button>\n    <div class="msg" id="storageMsg"></div>\n  </div>\n</div>\n\n<div class="sec">\n  <div class="sec-ttl">&#9889; God Mode \u2014 Grant Access</div>\n  <div class="box box-pu">\n    <div class="bbar bbar-pu"></div>\n    <div class="boxtitle" style="color:#c4b5fd;">Grant Full Access Instantly</div>\n    <div class="boxsub">Creates Supabase record, NT license, Discord role, sends magic login link.</div>\n    <div class="row2">\n      <div><label>Email *</label><input type="text" id="godEmail" placeholder="their@email.com"></div>\n      <div><label>Access Type</label><select id="godRole"><option value="monthly">Monthly Member</option><option value="lifetime">Lifetime Member</option><option value="discord">Discord Room ($37)</option></select></div>\n    </div>\n    <div class="row2">\n      <div><label>Full Name</label><input type="text" id="godName" placeholder="John Smith"></div>\n      <div><label>Discord Username</label><input type="text" id="godUser" placeholder="username"></div>\n    </div>\n    <div class="chks">\n      <label class="chk"><input type="checkbox" id="godSendEmail" checked> Send login email</label>\n      <label class="chk"><input type="checkbox" id="godNT" checked> Create NT license</label>\n      <label class="chk"><input type="checkbox" id="godDiscord"> Assign Discord role</label>\n    </div>\n    <button class="btn btn-pu" id="btnGodMode">&#9889; GRANT ACCESS NOW</button>\n    <div class="msg" id="godMsg"></div>\n  </div>\n</div>\n\n<div class="sec">\n  <div class="sec-ttl">Manual Access Removal</div>\n  <div class="box box-re">\n    <div class="bbar bbar-re"></div>\n    <div class="boxtitle">Cancel / Revoke by Email</div>\n    <div class="boxsub">Cancels Authnet sub, removes Discord role, revokes NT license, marks cancelled in Supabase.</div>\n    <label>Member Email</label>\n    <input type="email" id="manualEmail" placeholder="member@email.com">\n    <label>Membership Type</label>\n    <select id="manualType"><option value="monthly">Monthly Membership</option><option value="lifetime">Lifetime License</option><option value="discord">Discord Room ($37)</option></select>\n    <button class="btn btn-re" id="btnCancel">&#128293; CANCEL ACCESS</button>\n    <div class="msg" id="cancelMsg"></div>\n  </div>\n</div>\n\n<div class="sec">\n  <div class="sec-ttl">Member Management</div>\n  <div class="tabs">\n    <button class="tab on" data-tab="monthly">Monthly (' + mCount + ')</button>\n    <button class="tab" data-tab="lifetime">Lifetime (' + lCount + ')</button>\n    <button class="tab" data-tab="discord37">Discord $37 (' + dCount + ')</button>\n    <button class="tab" data-tab="live">Live on Discord (' + lvCount + ')</button>\n  </div>\n  <div id="tp-monthly" class="tp"><div class="pt pt-b"></div><div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Expires</th><th>NT</th><th>Action</th></tr></thead><tbody>' + memberRows + '</tbody></table></div></div>\n  <div id="tp-lifetime" class="tp" style="display:none"><div class="pt pt-g"></div><div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>License Key</th><th>NT</th><th>Action</th></tr></thead><tbody>' + licenseRows + '</tbody></table></div></div>\n  <div id="tp-discord37" class="tp" style="display:none"><div class="pt pt-p"></div><div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Expires</th><th>Discord</th><th>Action</th></tr></thead><tbody>' + discordRows + '</tbody></table></div></div>\n  <div id="tp-live" class="tp" style="display:none"><div class="pt pt-gr"></div><div style="overflow-x:auto"><table><thead><tr><th>Display Name</th><th>Username</th><th>Discord ID</th><th>Action</th></tr></thead><tbody>' + liveRows + '</tbody></table></div></div>\n</div>\n\n<script>\n' + adminJS + '\n</script>\n</body>\n</html>';

    res.send(html);
    } catch (e) { console.error('[AdminPanel]', e.message, e.stack); res.status(500).send('<h1 style="color:red">Admin panel error: ' + e.message + '</h1>'); }
})
app.get('/admin/test-storage', adm, adminGuard, async (req, res) => {
    const results = {};
    try {
        // List buckets
        const { data: buckets, error: bErr } = await supabase.storage.listBuckets();
        results.buckets = bErr ? { error: bErr.message } : (buckets || []).map(b => b.name);

        // List files in uploads bucket root
        const { data: files, error: fErr } = await supabase.storage.from('uploads').list('', { limit: 20 });
        results.uploads_root = fErr ? { error: fErr.message } : (files || []).map(f => f.name);

        // List packages folder
        const { data: pkg, error: pErr } = await supabase.storage.from('uploads').list('packages', { limit: 20 });
        results.packages_folder = pErr ? { error: pErr.message } : (pkg || []).map(f => f.name);

        // List templates folder
        const { data: tpl, error: tErr } = await supabase.storage.from('uploads').list('templates', { limit: 20 });
        results.templates_folder = tErr ? { error: tErr.message } : (tpl || []).map(f => f.name);

        // Try signed URL for installer
        const { data: sd, error: sErr } = await supabase.storage.from('uploads').createSignedUrl('HVTMasterAccessNQ.zip', 60);
        results.installer_signed_url = sErr ? { error: sErr.message } : 'OK — ' + sd.signedUrl.substring(0, 80) + '...';

        // Try signed URL for template
        const { data: td, error: tde } = await supabase.storage.from('uploads').createSignedUrl('HVT NQ TEMPLATE.xml', 60);
        results.template_signed_url = tde ? { error: tde.message } : 'OK — ' + td.signedUrl.substring(0, 80) + '...';

    } catch (e) {
        results.exception = e.message;
    }
    res.json(results);
});

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

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
app.get('/logout', async (req, res) => {
    // Clear from memory
    const { token } = getSessionFromCookie(req);
    if (token) _sessions.delete(token);
    // Clear from Supabase (both tables) — fire-and-forget
    if (token) {
        try {
            await Promise.all([
                supabase.from(MEMBERSHIP_TABLE).update({ session_token: null, session_expires: null, updated_at: nowISO() }).eq('session_token', token),
                supabase.from(LICENSE_TABLE).update({ session_token: null, session_expires: null, updated_at: nowISO() }).eq('session_token', token)
            ]);
        } catch (e) { console.error('[Logout DB clear]', e.message); }
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect(302, 'https://highvelocitytrading.com');
});


// ─── PROP FIRM ACTIVATION PAGE ───────────────────────────────────────────────
app.get('/prop-activation', requireSession, (req, res) => {
    const s = req._session;
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon.png?v=1">
<title>Activate Prop Account – High Velocity Trading</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#000;min-height:100vh;color:#fff;padding:90px 20px 60px;overflow-x:hidden}
.bg{position:fixed;inset:0;z-index:0;pointer-events:none;background:#000}
.bg::before{content:'';position:absolute;top:0;left:0;width:65%;height:65%;background:radial-gradient(ellipse at 15% 30%,#00001C 0%,transparent 65%)}
.topnav-wrap{position:fixed;top:0;left:0;right:0;z-index:10}
.topnav{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:64px;width:100%;background:rgba(10,10,12,0.85);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.08)}
.topnav-logo img{height:39px;width:auto;object-fit:contain;display:block}
.topnav-right{display:flex;align-items:center;gap:14px}
.nav-link{color:rgba(255,255,255,0.7);font-size:14px;font-weight:500;text-decoration:none;padding:8px 0;transition:color .2s}
.nav-link:hover{color:#fff}
.nav-cta{display:inline-block;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.9);font-size:13px;font-weight:500;text-decoration:none;padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);transition:background .2s}
.nav-cta:hover{background:rgba(255,255,255,0.12)}
.wrap{max-width:700px;margin:0 auto;position:relative;z-index:1;padding-top:20px}
.back{color:#2254F5;font-size:13px;text-decoration:none;font-weight:500;display:inline-block;margin-bottom:28px}
.back:hover{color:#3b6ff5}
.hero{text-align:center;margin-bottom:32px}
.pill{display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.25);border-radius:999px;color:#2254F5;font-size:11px;letter-spacing:3px;text-transform:uppercase;padding:6px 18px;margin-bottom:16px}
.hero h1{font-size:38px;font-weight:700;color:#fff;letter-spacing:-.5px;margin-bottom:10px}
.hero p{font-size:15px;color:#64748b;max-width:520px;margin:0 auto}
.hero-div{height:1px;background:linear-gradient(90deg,transparent,rgba(34,84,245,0.3),transparent);max-width:200px;margin:18px auto 0}
.card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px;margin-bottom:20px}
.card-label{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:16px}
.steps{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.step{background:#0d1117;border:1px solid rgba(34,84,245,0.22);border-radius:10px;padding:16px}
.step-num{width:22px;height:22px;border-radius:50%;background:#2254F5;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;margin-bottom:10px}
.step h4{font-size:13px;font-weight:700;color:#fff;margin-bottom:5px}
.step p{font-size:12px;color:#64748b;line-height:1.5}
.step strong{color:#e2e8f0}
.form-row{margin-bottom:16px}
label{display:block;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;margin-bottom:8px}
input,select{width:100%;background:#0d1117;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:12px 14px;color:#fff;font-size:14px;font-family:'DM Sans',sans-serif;outline:none;transition:border-color .2s,box-shadow .2s;appearance:none;-webkit-appearance:none}
input:focus,select:focus{border-color:#2254F5;box-shadow:0 0 0 3px rgba(34,84,245,0.15)}
input::placeholder{color:#334155}
select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%2364748b' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;padding-right:36px}
select option{background:#0d1117}
.divider{height:1px;background:rgba(255,255,255,0.07);margin:20px 0}
#prop-msg{display:none;padding:14px 16px;border-radius:8px;font-size:14px;font-weight:500;margin-bottom:20px;line-height:1.6}
.submit-btn{width:100%;background:linear-gradient(135deg,#2254F5,#3b6ff5);color:#fff;border:none;border-radius:8px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;letter-spacing:0.3px;transition:all .2s;box-shadow:0 4px 20px rgba(34,84,245,0.35);font-family:'DM Sans',sans-serif}
.submit-btn:hover{transform:translateY(-1px);box-shadow:0 6px 28px rgba(34,84,245,0.5)}
.submit-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
.act-row{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.05)}
.act-row:last-child{border-bottom:none}
.act-firm{font-size:14px;font-weight:600;color:#fff}
.act-email{font-size:12px;color:#64748b;margin-top:3px}
.act-status{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px}
.act-date{font-size:11px;color:#475569;margin-top:3px}
@media(max-width:600px){.steps{grid-template-columns:1fr}.nav-link{display:none}}
</style></head><body>
<div class="bg" aria-hidden="true"></div>
<div class="topnav-wrap">
  <nav class="topnav">
    <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer"><img src="/hvt-logo.cropped.png" alt="High Velocity Trading" style="height:39px;" onerror="this.onerror=null;this.style.display='none'"/></a>
    <div class="topnav-right">
      <a href="/member" class="nav-link">Portal</a>
      <a href="/billing/confirm-session" class="nav-link">Billing</a>
      <a href="/logout" class="nav-link">Log out</a>
      <a href="tel:786-461-4235" class="nav-cta">Call Us</a>
    </div>
  </nav>
</div>

<div class="wrap">
  <a href="/member" class="back">&larr; Back to Portal</a>

  <div class="hero">
    <div class="pill">PROP FIRM</div>
    <h1>Activate Prop Account</h1>
    <p>Authorize your HVT email to run indicators on any prop firm platform — no machine ID needed.</p>
    <div class="hero-div"></div>
  </div>

  <div class="card">
    <div class="card-label">How it works</div>
    <div class="steps">
      <div class="step"><div class="step-num">1</div><h4>Activate Below</h4><p>Enter your HVT email and prop firm, then click Activate</p></div>
      <div class="step"><div class="step-num">2</div><h4>Open NinjaTrader</h4><p>Go to <strong>Help &rarr; 3rd Party Licensing</strong> in NinjaTrader 8</p></div>
      <div class="step"><div class="step-num">3</div><h4>Enter Your Email</h4><p>Vendor: <strong>High Velocity Trading</strong> &mdash; License Key: your HVT email</p></div>
    </div>
  </div>

  <div class="card">
    <div class="card-label">Activate your account</div>
    <div id="prop-msg"></div>
    <div class="form-row">
      <label>Your HVT Purchase Email</label>
      <input id="prop-email" type="email" placeholder="email@example.com" value="${s.email || ''}"/>
    </div>
    <div class="form-row">
      <label>Prop Firm</label>
      <select id="prop-firm-name">
        <option value="">Select your prop firm...</option>
        <option>Apex Trader Funding</option>
        <option>TopstepTrader</option>
        <option>MyFundedFutures</option>
        <option>Bulenox</option>
        <option>Take Profit Trader</option>
        <option>Leeloo Trading</option>
        <option>Earn2Trade</option>
        <option>The Trading Pit</option>
        <option>TradeDay</option>
        <option>Other</option>
      </select>
    </div>
    <div class="divider"></div>
    <button class="submit-btn" id="prop-submit" onclick="submitPropActivation()">Activate Now</button>
  </div>

  <div class="card">
    <div class="card-label">Your Activations</div>
    <div id="activations-list"><div style="color:#64748b;font-size:14px;">Loading...</div></div>
  </div>
</div>

<script>
function showMsg(msg,ok){
  var el=document.getElementById('prop-msg');
  el.style.display='block';
  el.style.background=ok?'rgba(34,197,94,0.08)':'rgba(239,68,68,0.08)';
  el.style.border='1px solid '+(ok?'rgba(34,197,94,0.3)':'rgba(239,68,68,0.3)');
  el.style.color=ok?'#4ade80':'#f87171';
  el.innerHTML=msg;
  el.scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function submitPropActivation(){
  var email=document.getElementById('prop-email').value.trim();
  var firmName=document.getElementById('prop-firm-name').value.trim();
  var btn=document.getElementById('prop-submit');
  if(!email) return showMsg('Please enter your HVT purchase email.',false);
  if(!firmName) return showMsg('Please select your prop firm.',false);
  btn.disabled=true;btn.textContent='Activating...';
  try{
    var r=await fetch('/api/prop-activation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,firmName:firmName})});
    var d=await r.json();
    if(d.ok){
      showMsg('<strong>&#10003; Activation complete!</strong><br>In NinjaTrader go to <strong>Help &rarr; 3rd Party Licensing</strong>, enter <strong>High Velocity Trading</strong> as vendor and <strong>'+email+'</strong> as the license key.',true);
      loadActivations();
    } else {
      showMsg(d.error||'Activation failed. Please contact support.',false);
    }
  } catch(e){ showMsg('Network error. Please try again.',false); }
  btn.disabled=false;btn.textContent='Activate Now';
}
async function loadActivations(){
  try{
    var r=await fetch('/api/prop-activations/mine');
    var d=await r.json();
    var el=document.getElementById('activations-list');
    if(!d.ok||!d.activations||!d.activations.length){el.innerHTML='<div style="color:#64748b;font-size:14px;">No activations yet.</div>';return;}
    el.innerHTML=d.activations.map(function(a){
      var sc=a.status==='active'?'#4ade80':'#f87171';
      return '<div class="act-row"><div><div class="act-firm">'+a.firm_name+'</div><div class="act-email">'+a.email+'</div></div><div style="text-align:right;flex-shrink:0;margin-left:16px;"><div class="act-status" style="color:'+sc+';">'+a.status+'</div><div class="act-date">'+new Date(a.created_at).toLocaleDateString()+'</div></div></div>';
    }).join('');
  } catch(e){ document.getElementById('activations-list').innerHTML='<div style="color:#64748b;font-size:14px;">Could not load activations.</div>'; }
}
loadActivations();
</script>
</body></html>`);
});

// ─── PROP ACTIVATION API ─────────────────────────────────────────────────────
app.post('/api/prop-activation', requireSession, frm, express.json(), async (req, res) => {
    const s                   = req._session;
    const { email, firmName } = req.body || {};

    if (!email || !firmName)
        return res.status(400).json({ ok: false, error: 'Email and prop firm are required.' });

    const cleanEmail = email.trim().toLowerCase();
    const cleanFirm  = firmName.trim();

    // ── Verify email is an active HVT member (check both tables) ──
    const [{ data: m1 }, { data: m2 }] = await Promise.all([
        supabase.from(MEMBERSHIP_TABLE).select('email, status').eq('email', cleanEmail).maybeSingle(),
        supabase.from(LICENSE_TABLE).select('email, status').eq('email', cleanEmail).maybeSingle()
    ]);

    const member = m1 || m2;
    if (!member)
        return res.status(403).json({ ok: false, error: 'Email not found in HVT membership. Please use the email you purchased with.' });

    if (member.status !== 'active')
        return res.status(403).json({ ok: false, error: 'Your HVT membership is not currently active. Please contact support.' });

    // ── Check if this email already has an active prop activation ──
    const { data: existing } = await supabase
        .from(PROP_FIRM_TABLE)
        .select('id, firm_name, status')
        .eq('email', cleanEmail)
        .eq('status', 'active')
        .maybeSingle();

    if (existing) {
        // Already activated — just return success so they can get the NT instructions
        return res.json({ ok: true, alreadyActive: true });
    }

    // ── Create NT Ecosystem license for this email ──
    if (!ntToken) await ntLogin();
    if (!ntToken) return res.status(500).json({ ok: false, error: 'Could not connect to NinjaTrader. Please try again in a moment.' });

    let ntLicenseId = null;
    try {
        const expiry = new Date();
        expiry.setFullYear(expiry.getFullYear() + 99); // effectively permanent
        const r = await fetchFn(`https://ecosystemapi.ninjatrader.com/v1/products/${NT_PRODUCT_ID}/licenses`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${ntToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                license: {
                    email:               cleanEmail,
                    licenseType:         'Lifetime',
                    expirationDateUTC:   expiry.toISOString()
                }
            })
        });
        const d = await r.json();
        console.log(`[PropActivation] NT API response for ${cleanEmail}:`, JSON.stringify(d));

        if (d?.errorText && d.errorText !== '') {
            // NT may return "already licensed" — treat as success
            if (d.errorText.toLowerCase().includes('already')) {
                console.log(`[PropActivation] Already licensed in NT for ${cleanEmail} — proceeding`);
            } else {
                console.error(`[PropActivation] NT error for ${cleanEmail}:`, d.errorText);
                return res.status(500).json({ ok: false, error: 'NinjaTrader licensing failed. Please contact support.' });
            }
        }

        if (d?.result) ntLicenseId = String(d.result);

    } catch (e) {
        console.error('[PropActivation] NT API error:', e.message);
        return res.status(500).json({ ok: false, error: 'Could not reach NinjaTrader. Please try again.' });
    }

    // ── Save to Supabase ──
    const { error: dbErr } = await supabase.from(PROP_FIRM_TABLE).insert({
        email:         cleanEmail,
        member_name:   s.name || '',
        firm_name:     cleanFirm,
        nt_license_id: ntLicenseId,
        status:        'active',
        created_at:    nowISO(),
        updated_at:    nowISO()
    });

    if (dbErr) {
        console.error('[PropActivation] Supabase insert error:', dbErr.message);
        // NT license was created — log it but don't fail the user
        console.error('[PropActivation] NT license created but DB log failed. NT ID:', ntLicenseId);
    }

    console.log(`[PropActivation] ✅ ${cleanEmail} | ${cleanFirm} | nt_id=${ntLicenseId}`);
    res.json({ ok: true });
});

// ─── MY PROP ACTIVATIONS ─────────────────────────────────────────────────────
app.get('/api/prop-activations/mine', requireSession, async (req, res) => {
    const s = req._session;
    const { data, error } = await supabase
        .from(PROP_FIRM_TABLE)
        .select('email, firm_name, status, created_at')
        .eq('email', s.email.toLowerCase())
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, activations: data || [] });
});

// ─── ADMIN: VIEW ALL PROP ACTIVATIONS ────────────────────────────────────────
app.get('/admin/prop-activations', adm, async (req, res) => {
    const secret = req.query.secret || req.headers['x-admin-secret'];
    if (secret !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { data, error } = await supabase
        .from(PROP_FIRM_TABLE)
        .select('*')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ ok: false, error: error.message });

    const total    = (data || []).length;
    const active   = (data || []).filter(r => r.status === 'active').length;
    const revoked  = total - active;

    const firmCounts = {};
    (data || []).forEach(r => { firmCounts[r.firm_name] = (firmCounts[r.firm_name] || 0) + 1; });
    const topFirms = Object.entries(firmCounts).sort((a,b) => b[1]-a[1]).slice(0,5)
        .map(([name, count]) => `<span style="display:inline-block;background:#111827;border:1px solid #1e293b;border-radius:6px;padding:4px 10px;font-size:12px;color:#94a3b8;margin:2px;">${name} <strong style="color:#fff;">${count}</strong></span>`).join(' ');

    const rows = (data || []).map(r => `
        <tr>
          <td style="padding:11px 14px;color:#e2e8f0;font-size:13px;">${r.email}</td>
          <td style="padding:11px 14px;color:#94a3b8;font-size:13px;">${r.member_name || '—'}</td>
          <td style="padding:11px 14px;color:#60a5fa;font-size:13px;font-weight:600;">${r.firm_name}</td>
          <td style="padding:11px 14px;">
            <span style="padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;
              background:${r.status==='active'?'rgba(34,197,94,0.1)':'rgba(239,68,68,0.1)'};
              color:${r.status==='active'?'#4ade80':'#f87171'};">${r.status}</span>
          </td>
          <td style="padding:11px 14px;color:#475569;font-size:12px;">${new Date(r.created_at).toLocaleString()}</td>
          <td style="padding:11px 14px;">
            ${r.status === 'active'
              ? `<button onclick="revokeRow('${r.id}',this)" style="background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.25);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:600;transition:background .15s;">Revoke</button>`
              : '<span style="color:#334155;font-size:12px;">—</span>'}
          </td>
        </tr>`).join('');

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>HVT — Prop Activations</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#000;color:#fff;padding:36px 28px;min-height:100vh}
h1{font-size:22px;font-weight:700;letter-spacing:-.3px;margin-bottom:4px}
.sub{color:#64748b;font-size:14px;margin-bottom:28px}
.stats{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.stat{background:#0d1117;border:1px solid #1e293b;border-radius:10px;padding:16px 22px;min-width:120px}
.stat-val{font-size:26px;font-weight:700;color:#fff}
.stat-lbl{font-size:12px;color:#64748b;margin-top:2px;text-transform:uppercase;letter-spacing:.8px}
.firms{margin-bottom:24px}
.firms-lbl{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.search-wrap{margin-bottom:16px}
.search-wrap input{background:#0d1117;border:1px solid #1e293b;border-radius:8px;padding:10px 14px;color:#fff;font-size:14px;width:320px;outline:none}
.search-wrap input:focus{border-color:#2254F5}
table{width:100%;border-collapse:collapse;background:#0d1117;border-radius:12px;overflow:hidden;border:1px solid #1e293b}
th{padding:11px 14px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;background:#111827;border-bottom:1px solid #1e293b}
tr{border-bottom:1px solid #0f172a}
tr:hover td{background:rgba(255,255,255,0.015)}
tr:last-child{border-bottom:none}
</style>
</head><body>
<h1>Prop Firm Activations</h1>
<div class="sub">All accounts authorized through the Prop Firm Activation system</div>
<div class="stats">
  <div class="stat"><div class="stat-val">${total}</div><div class="stat-lbl">Total</div></div>
  <div class="stat"><div class="stat-val" style="color:#4ade80">${active}</div><div class="stat-lbl">Active</div></div>
  <div class="stat"><div class="stat-val" style="color:#f87171">${revoked}</div><div class="stat-lbl">Revoked</div></div>
</div>
${topFirms ? `<div class="firms"><div class="firms-lbl">By Prop Firm</div>${topFirms}</div>` : ''}
<div class="search-wrap"><input type="text" id="srch" placeholder="Search email or firm..." oninput="filterRows(this.value)"/></div>
<table id="tbl">
  <thead><tr>
    <th>Email</th><th>Name</th><th>Prop Firm</th><th>Status</th><th>Date</th><th>Action</th>
  </tr></thead>
  <tbody id="tbody">${rows}</tbody>
</table>
<script>
function filterRows(q) {
  q = q.toLowerCase();
  document.querySelectorAll('#tbody tr').forEach(function(tr) {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}
async function revokeRow(id, btn) {
  if (!confirm('Revoke this activation? The user will lose indicator access.')) return;
  btn.disabled = true; btn.textContent = 'Revoking...';
  try {
    var r = await fetch('/admin/prop-activations/' + id + '/revoke', {
      method: 'POST',
      headers: { 'x-admin-secret': '${ADMIN_SECRET}' }
    });
    var d = await r.json();
    if (d.ok) {
      var td = btn.closest('tr').querySelectorAll('td')[3];
      td.innerHTML = '<span style="padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;background:rgba(239,68,68,0.1);color:#f87171;">REVOKED</span>';
      btn.style.display = 'none';
    } else {
      alert(d.error || 'Revoke failed. Try again.');
      btn.disabled = false; btn.textContent = 'Revoke';
    }
  } catch(e) {
    alert('Network error. Try again.');
    btn.disabled = false; btn.textContent = 'Revoke';
  }
}
</script>
</body></html>`);
});

// ─── ADMIN: REVOKE A PROP ACTIVATION ─────────────────────────────────────────
app.post('/admin/prop-activations/:id/revoke', adm, express.json(), async (req, res) => {
    const secret = req.query.secret || req.headers['x-admin-secret'];
    if (secret !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { id } = req.params;

    const { data: record, error: fetchErr } = await supabase
        .from(PROP_FIRM_TABLE)
        .select('nt_license_id, status')
        .eq('id', id)
        .maybeSingle();

    if (fetchErr || !record)
        return res.status(404).json({ ok: false, error: 'Activation not found.' });

    if (record.status === 'revoked')
        return res.json({ ok: true, message: 'Already revoked.' });

    // Revoke from NT Ecosystem
    if (record.nt_license_id) await ntRevokeLicense(record.nt_license_id);

    const { error } = await supabase
        .from(PROP_FIRM_TABLE)
        .update({ status: 'revoked', updated_at: nowISO() })
        .eq('id', id);

    if (error) return res.status(500).json({ ok: false, error: error.message });

    console.log(`[PropRevoke] ✅ Revoked activation id=${id}`);
    res.json({ ok: true });
});

// ─── ROOT ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect(302, '/login'));

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

app.listen(PORT, () => console.log(`🚀 HVT Backend on port ${PORT}`));
