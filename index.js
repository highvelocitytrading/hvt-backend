'use strict';

require('dotenv').config();

const express = require('express');
const crypto  = require('crypto');
const Busboy  = require('busboy');
const { createClient } = require('@supabase/supabase-js');

// Node 18+ has fetch. Add a safe fallback for older runtimes.
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
const APP_URL                   = process.env.APP_URL    || '[https://hvt-backend-production-ec41.up.railway.app](https://hvt-backend-production-ec41.up.railway.app/)';
const JOTFORM_SECRET            = process.env.JOTFORM_SECRET || null;

// NOTE: Keeping your existing default so nothing breaks today.
// Recommended later: remove default + rotate, and never email admin keys.
const ADMIN_SECRET              = process.env.ADMIN_SECRET   || 'HVT-ADMIN-FADBC551B512718D76F4B8744E54B621';

const DISCORD_BOT_TOKEN        = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID         = process.env.DISCORD_GUILD_ID         || '1460694720090083483';
const DISCORD_MONTHLY_ROLE_ID  = process.env.DISCORD_MONTHLY_ROLE_ID  || '1476634274424819897';
const DISCORD_LIFETIME_ROLE_ID = process.env.DISCORD_LIFETIME_ROLE_ID || '1476634362811384001';
const DISCORD_ROOM_ROLE_ID     = process.env.DISCORD_ROOM_ROLE_ID     || '';   // $37 Discord-only role

const MEMBERSHIP_TABLE = process.env.SUPABASE_TABLE || 'membershipstab';
const LICENSE_TABLE    = 'license_keys';
const DISCORD_TABLE    = 'discord_members';

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
return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head> <body style="margin:0;padding:0;background:#060e1f;font-family:Arial,sans-serif;"> <div style="max-width:600px;margin:40px auto;padding:20px;">   <div style="text-align:center;margin-bottom:32px;">     <div style="display:inline-block;border-top:1px solid #1e3a6e;border-bottom:1px solid #1e3a6e;padding:12px 32px;">       <span style="font-size:18px;font-weight:700;color:#fff;letter-spacing:3px;text-transform:uppercase;">HIGH VELOCITY TRADING</span><br>       <span style="font-size:10px;color:#3a6ea8;letter-spacing:4px;text-transform:uppercase;">Member Services</span>     </div>   </div>   <div style="background:linear-gradient(145deg,#0d1f42,#091526);border:1px solid #1a3060;border-radius:16px;overflow:hidden;">     <div style="height:3px;background:linear-gradient(90deg,#1a3a8e,#4a9eff,#1a3a8e);"></div>     <div style="padding:36px 32px;">${content}</div>   </div>   <div style="text-align:center;margin-top:24px;color:#1e3a5e;font-size:11px;line-height:1.8;">     © 2026 High Velocity Trading. All rights reserved.<br>     <a href="<https://highvelocitytrading.com>" style="color:#2d4a6e;text-decoration:none;">highvelocitytrading.com</a>   </div> </div></body></html>`;
}

// Welcome email — monthly / lifetime
async function sendWelcome(email, fullName, type) {
const name     = fullName?.split(' ')[0] || 'Trader';
const monthly  = type === 'monthly';
const subject  = monthly ? 'Welcome to HVT Monthly Membership!' : 'Welcome to HVT Lifetime Access!';
const badge    = monthly ? 'Monthly Membership Activation' : 'Lifetime Access Activation';
const accent   = monthly ? '#4a9eff' : '#f6ad55';
const badgeBg  = monthly ? 'rgba(74,158,255,0.08)'  : 'rgba(246,173,85,0.08)';
const badgeBrd = monthly ? 'rgba(74,158,255,0.2)'   : 'rgba(246,173,85,0.2)';
const note     = monthly ? `<div style="background:rgba(229,62,62,0.06);border:1px solid rgba(229,62,62,0.15);border-radius:10px;padding:14px 18px;margin-bottom:24px;">       <p style="color:#fc8181;font-size:13px;line-height:1.6;margin:0;">⚠️ <strong>Please note:</strong> Your Trading Room and indicator access are tied to your active monthly membership. Access will be removed if payment stops.</p></div>` : '';
const html = wrap(       `<div style="text-align:center;margin-bottom:8px;">         <div style="display:inline-block;background:${badgeBg};border:1px solid ${badgeBrd};border-radius:20px;padding:6px 18px;margin-bottom:20px;">           <span style="color:${accent};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">${badge}</span>         </div>         <h2 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 8px;letter-spacing:1px;">Welcome, ${name}!</h2>         <p style="color:#6b8db8;font-size:14px;margin:0;">We're grateful to have you with us.</p>       </div>       <div style="height:1px;background:linear-gradient(90deg,transparent,#1e3a6e,transparent);margin:28px 0;"></div>       <p style="color:#8aafd4;font-size:14px;line-height:1.8;margin-bottom:24px;text-align:center;">Thank you for your purchase. You now have access to everything High Velocity Trading has to offer.</p>       ${note}       <div style="text-align:center;margin-bottom:28px;">         <a href="${APP_URL}/trading-room" style="display:inline-block;background:linear-gradient(135deg,#1a3a8e,#2a5aae);color:#fff;text-decoration:none;padding:16px 48px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;box-shadow:0 4px 24px rgba(42,90,174,0.4);">ACTIVATE TRADING ROOM</a>       </div>       <div style="background:rgba(74,158,255,0.04);border:1px solid rgba(74,158,255,0.12);border-radius:10px;padding:16px 20px;text-align:center;">         <p style="color:#4a6a8a;font-size:13px;margin:0 0 8px;">Need help getting set up?</p>         <p style="color:#90b8e8;font-size:15px;font-weight:700;margin:0;">📞 786-461-4235</p>       </div>`);
await sendEmail(email, subject, html);
console.log(`[Email] ${type} welcome → ${email}`);
}

// Discord $37 welcome — 2 clear step buttons
async function sendDiscordWelcome(email, fullName) {
const name = fullName?.split(' ')[0] || 'Trader';
const adminLink    = `https://hvt-backend-production-ec41.up.railway.app/admin?key=${encodeURIComponent(ADMIN_SECRET)}`;
const activateLink = `${APP_URL}/trading-room`;
const html = wrap(`
<div style="text-align:center;margin-bottom:8px;">
<div style="display:inline-block;background:rgba(74,158,255,0.08);border:1px solid rgba(74,158,255,0.2);border-radius:20px;padding:6px 18px;margin-bottom:20px;">
<span style="color:#4a9eff;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Discord Trading Room Access</span>
</div>
<h2 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 8px;letter-spacing:1px;">You're In, ${name}!</h2>
<p style="color:#6b8db8;font-size:14px;margin:0;">Your $37/month Trading Room membership is now active.</p>
</div>
<div style="height:1px;background:linear-gradient(90deg,transparent,#1e3a6e,transparent);margin:28px 0;"></div>
<div style="background:rgba(229,62,62,0.06);border:1px solid rgba(229,62,62,0.15);border-radius:10px;padding:14px 18px;margin-bottom:28px;">
<p style="color:#fc8181;font-size:13px;line-height:1.6;margin:0;">⚠️ <strong>Access Note:</strong> Trading Room access is tied to your active $37/month subscription. Access will be removed if payment stops.</p>
</div>

```
  <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#2d5a8e;margin-bottom:14px;font-weight:700;">ACTIVATE IN 2 EASY STEPS</div>

  <div style="background:rgba(255,255,255,0.02);border:1px solid #1a3060;border-radius:12px;overflow:hidden;margin-bottom:28px;">

    <div style="padding:22px 24px;border-bottom:1px solid #1a3060;">
      <div style="display:flex;align-items:flex-start;gap:16px;">
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#1a3a8e,#2a5aae);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;flex-shrink:0;margin-top:2px;">1</div>
        <div style="flex:1;">
          <div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:6px;">Join the HVT Discord Server</div>
          <div style="color:#6b8db8;font-size:13px;line-height:1.6;margin-bottom:16px;">Click the button below to visit our website and join the Discord server. <strong style="color:#90b8e8;">You must join the server first</strong> before you can get your Trading Room role.</div>
          <a href="<https://highvelocitytrading.com>" style="display:inline-block;background:linear-gradient(135deg,#1a3a8e,#2a5aae);color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;box-shadow:0 4px 16px rgba(42,90,174,0.4);">JOIN DISCORD SERVER →</a>
        </div>
      </div>
    </div>

    <div style="padding:22px 24px;">
      <div style="display:flex;align-items:flex-start;gap:16px;">
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#1a3a8e,#2a5aae);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;flex-shrink:0;margin-top:2px;">2</div>
        <div style="flex:1;">
          <div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:6px;">Activate Your Trading Room Role</div>
          <div style="color:#6b8db8;font-size:13px;line-height:1.6;margin-bottom:16px;">Once you have joined the server, click the button below. You will enter <strong style="color:#90b8e8;">this email address</strong> and your <strong style="color:#90b8e8;">Discord username</strong> — your Trading Room role will be assigned instantly.</div>
          <a href="${activateLink}" style="display:inline-block;background:linear-gradient(135deg,#1a3a8e,#2a5aae);color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;box-shadow:0 4px 16px rgba(42,90,174,0.4);">ACTIVATE MY ROLE →</a>
        </div>
      </div>
    </div>

  </div>

  <div style="background:rgba(255,255,255,0.02);border:1px solid #1a3060;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
    <p style="color:#4a6a8a;font-size:12px;line-height:1.6;margin:0;">💡 <strong style="color:#6b8db8;">Finding your Discord username:</strong> Open Discord → click your profile photo at the bottom left → your username is shown below your display name (lowercase, may include numbers e.g. <em>johntrader22</em>).</p>
  </div>

  <div style="background:rgba(74,158,255,0.04);border:1px solid rgba(74,158,255,0.12);border-radius:10px;padding:16px 20px;text-align:center;">
    <p style="color:#4a6a8a;font-size:13px;margin:0 0 8px;">Need help? We will walk you through everything.</p>
    <p style="color:#90b8e8;font-size:15px;font-weight:700;margin:0;">📞 786-461-4235</p>
  </div>`);
await sendEmail(email, 'Your HVT Trading Room Access Is Ready — 2 Steps to Activate', html);
console.log(`[Email] Discord welcome → ${email}`);
```

}

async function sendCourseEmail(email, token) {
const url = `${APP_URL}/course/confirm?token=${token}`;
const html = wrap(       `<div style="text-align:center;margin-bottom:8px;">         <div style="display:inline-block;background:rgba(74,158,255,0.08);border:1px solid rgba(74,158,255,0.2);border-radius:20px;padding:6px 18px;margin-bottom:20px;">           <span style="color:#4a9eff;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Member Access</span>         </div>         <h2 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 8px;">Your Access Link is Ready</h2>         <p style="color:#6b8db8;font-size:14px;margin:0;">Expires in <strong style="color:#90b8e8;">24 hours</strong>. Do not share this link.</p>       </div>       <div style="height:1px;background:linear-gradient(90deg,transparent,#1e3a6e,transparent);margin:28px 0;"></div>       <div style="text-align:center;margin-bottom:28px;">         <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#4a9eff,#2a5aae);color:#fff;text-decoration:none;padding:16px 48px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;box-shadow:0 4px 24px rgba(74,158,255,0.35);">ACCESS MEMBER PORTAL</a>       </div>       <p style="text-align:center;color:#2d4a6e;font-size:12px;margin-bottom:24px;">Secure link · Expires in 24 hours</p>       <div style="background:rgba(74,158,255,0.04);border:1px solid rgba(74,158,255,0.12);border-radius:10px;padding:14px 18px;">         <p style="color:#4a6a8a;font-size:13px;margin:0;">🔒 If you did not request this, ignore this email.</p>       </div>`);
await sendEmail(email, 'Access Your HVT Member Portal', html);
}

async function sendMagicLink(email, token, type) {
const url       = `${APP_URL}/${type}/confirm?token=${token}`;
const isBilling = type === 'billing';
const subject   = isBilling ? 'Access Your HVT Billing Portal' : 'Cancel Your HVT Membership';
const title     = isBilling ? 'Billing Portal Access' : 'Membership Cancellation';
const btnText   = isBilling ? 'VIEW MY BILLING' : 'CONFIRM CANCELLATION';
const btnColor  = isBilling ? 'linear-gradient(135deg,#1a3a8e,#2a5aae)' : 'linear-gradient(135deg,#b91c1c,#dc2626)';
const desc      = isBilling
? 'Click below to access your billing dashboard. Expires in <strong style="color:#90b8e8;">1 hour</strong>.'
: 'Click below to confirm cancellation of your HVT Membership. Expires in <strong style="color:#90b8e8;">1 hour</strong>.';
const html = wrap(       `<div style="text-align:center;margin-bottom:24px;"><span style="font-size:20px;font-weight:700;color:#fff;">${title}</span></div>       <p style="color:#6b8db8;font-size:14px;line-height:1.7;text-align:center;margin-bottom:32px;">${desc}</p>       <div style="height:1px;background:linear-gradient(90deg,transparent,#1e3a6e,transparent);margin-bottom:32px;"></div>       <div style="text-align:center;margin-bottom:24px;">         <a href="${url}" style="display:inline-block;background:${btnColor};color:#fff;text-decoration:none;padding:16px 48px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:2px;">${btnText}</a>       </div>       <p style="text-align:center;color:#2d4a6e;font-size:12px;margin-bottom:20px;">Secure link · Expires in 1 hour</p>       <div style="background:rgba(74,158,255,0.04);border:1px solid rgba(74,158,255,0.12);border-radius:10px;padding:14px 18px;">         <p style="color:#4a6a8a;font-size:13px;margin:0;">🔒 If you did not request this, ignore this email.</p>       </div>`);
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

// ─── PAGE SHELL ───────────────────────────────────────────────────────────────
function shell(title, body) {
return `<!DOCTYPE html><html lang="en"><head> <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"> <title>${title} – High Velocity Trading</title> <link href="<https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Inter:wght@300;400;500&display=swap>" rel="stylesheet"> <style> *{box-sizing:border-box;margin:0;padding:0;} body{font-family:'Inter',sans-serif;background:radial-gradient(ellipse at 50% 0%,#0d2150 0%,#060e1f 55%,#020810 100%);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 20px;color:#fff;} .brand{text-align:center;margin-bottom:36px;} .brand h1{font-family:'Rajdhani',sans-serif;font-size:24px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:#fff;} .brand p{font-family:'Rajdhani',sans-serif;font-size:10px;color:#2d5a8e;letter-spacing:5px;text-transform:uppercase;margin-top:4px;} .card{width:100%;max-width:460px;background:linear-gradient(145deg,#0d1f42,#091526);border:1px solid #1a3060;border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.6);} .ct{height:3px;background:linear-gradient(90deg,#1a3a8e,#4a9eff,#1a3a8e);} .cb{padding:36px 32px;} .ttl{font-family:'Rajdhani',sans-serif;font-size:22px;font-weight:700;letter-spacing:1px;color:#fff;margin-bottom:8px;} .sub{color:#4a6a8a;font-size:13px;line-height:1.6;margin-bottom:28px;} .div{height:1px;background:linear-gradient(90deg,transparent,#1a3060,transparent);margin-bottom:28px;} label{display:block;font-family:'Rajdhani',sans-serif;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#3a6a9a;margin-bottom:8px;} input[type=email],input[type=text]{width:100%;padding:13px 16px;background:rgba(255,255,255,0.03);border:1px solid #1a3060;border-radius:10px;color:#fff;font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s;margin-bottom:20px;font-family:'Inter',sans-serif;} input:focus{border-color:#2a5aae;box-shadow:0 0 0 3px rgba(42,90,174,0.15);} input::placeholder{color:#1e3a5e;} .btn{width:100%;padding:13px;background:linear-gradient(135deg,#1a3a8e,#2a5aae);color:#fff;border:none;border-radius:10px;font-family:'Rajdhani',sans-serif;font-size:15px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 20px rgba(42,90,174,0.3);transition:opacity .2s,transform .1s;} .btn:hover{opacity:.9;transform:translateY(-1px);} .btn:disabled{opacity:.4;cursor:not-allowed;transform:none;} .msg{margin-top:16px;padding:12px 16px;border-radius:10px;font-size:13px;text-align:center;display:none;line-height:1.5;} .msg.show{display:block;} .ok{background:rgba(56,161,105,0.08);color:#68d391;border:1px solid rgba(56,161,105,0.2);} .er{background:rgba(229,62,62,0.08);color:#fc8181;border:1px solid rgba(229,62,62,0.2);} .fl{text-align:center;margin-top:20px;font-size:12px;color:#1e3a5e;} .fl a{color:#2d4a6e;text-decoration:none;} /* small inline badge for NinjaTrader */ .ntBadge{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:rgba(74,158,255,0.05);border:1px solid rgba(74,158,255,0.18);margin-bottom:18px;} .ntIcon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:rgba(74,158,255,0.12);border:1px solid rgba(74,158,255,0.22);flex-shrink:0;} .ntTitle{font-family:'Rajdhani',sans-serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#4a9eff;font-weight:700;line-height:1;} .ntDesc{color:#8aafd4;font-size:12.5px;line-height:1.55;margin-top:6px;} </style></head><body> <div class="brand"><h1>High Velocity Trading</h1><p>Member Portal</p></div> ${body} <div class="fl" style="margin-top:20px;"><a href="<https://highvelocitytrading.com>">← highvelocitytrading.com</a></div> </body></html>`;
}

function resultPage(type, title, msg) {
const m = { success:{i:'✓',c:'#68d391',b:'rgba(56,161,105,0.08)',r:'rgba(56,161,105,0.2)'}, error:{i:'✕',c:'#fc8181',b:'rgba(229,62,62,0.08)',r:'rgba(229,62,62,0.2)'}, info:{i:'ℹ',c:'#90cdf4',b:'rgba(74,158,255,0.08)',r:'rgba(74,158,255,0.2)'} }[type] || {i:'✕',c:'#fc8181',b:'rgba(229,62,62,0.08)',r:'rgba(229,62,62,0.2)'};
return shell(title, `<div class="card" style="max-width:460px;width:100%;"><div class="ct"></div><div class="cb" style="text-align:center;">       <div style="width:56px;height:56px;border-radius:50%;background:${m.b};border:1px solid ${m.r};display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:22px;color:${m.c};">${m.i}</div>       <div class="ttl" style="margin-bottom:16px;">${title}</div>       <div style="background:${m.b};border:1px solid ${m.r};border-radius:10px;padding:16px;color:${m.c};font-size:14px;line-height:1.6;">${msg}</div>     </div></div>`);
}

// Inline NinjaTrader “logo” (clean, professional, no external assets).
// This is NOT an official trademarked asset—just a tasteful NT mark for UI.
function ninjaLogoSVG() {
return    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">     <path d="M6 17.5V6.5L11 12l-5 5.5Z" fill="#4a9eff" opacity="0.95"/>     <path d="M12.5 18V6l5.5 6-5.5 6Z" fill="#90cdf4" opacity="0.95"/>     <path d="M4.5 19.2h15" stroke="#1a3060" stroke-width="1.2" opacity="0.9"/>   </svg>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/health', rateLimit({ max: 30 }), (req, res) => res.json({ ok: true, ts: nowISO() }));

// ─── MEMBERSHIP JOTFORM ───────────────────────────────────────────────────────
app.post('/webhooks/membership-jotform', wh, (req, res) => {
if (!verifyJF(req)) return res.status(401).send('Unauthorized');
const bb = Busboy({ headers: req.headers });
let raw = '';
bb.on('field', (n, v) => { raw += `\\n[${n}]=${v}`; });
bb.on('finish', async () => {
try {
const { email, full_name, phone } = huntData(raw);
if (!email) return res.status(400).send('No email');
await supabase.from(MEMBERSHIP_TABLE).upsert({ email, full_name, phone, plan_name: 'membership', status: 'active', source: 'jotform', expires_at: now30days(), updated_at: nowISO() }, { onConflict: 'email' });
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
const CANCEL_EVENTS = [
'net.authorize.customer.subscription.cancelled',
'net.authorize.customer.subscription.expired',
'net.authorize.customer.subscription.suspended',
'net.authorize.customer.subscription.terminated',
'net.authorize.customer.subscription.failed'
];

```
    if (eventType === 'net.authorize.customer.subscription.created' || eventType === 'net.authorize.payment.capture.created') {
        if (!email) return res.status(400).send('No email');
        const row = { email, plan_name: 'membership', status: 'active', source: 'authnet', expires_at: now30days(), updated_at: nowISO() };
        if (subId) row.authnet_subscription_id = subId;
        await supabase.from(MEMBERSHIP_TABLE).upsert(row, { onConflict: 'email' });
        console.log(`✅ Membership (AN): ${email}`);
    } else if (CANCEL_EVENTS.includes(eventType)) {
        const q = subId ? supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('authnet_subscription_id', subId)
                        : email ? supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email) : null;
        if (q) {
            await q;
            const { data: m } = await supabase.from(MEMBERSHIP_TABLE).select('discord_user_id').eq(subId ? 'authnet_subscription_id' : 'email', subId || email).maybeSingle();
            if (m?.discord_user_id) try { await stripRole(m.discord_user_id, DISCORD_MONTHLY_ROLE_ID); } catch {}
            console.log(`🚫 Membership cancelled (AN): ${email || subId}`);
        }
    }
    res.status(200).send('OK');
} catch (e) { console.error('[MemberAN]', e.message); res.status(500).send('Error'); }
```

});

// ─── DISCORD $37 JOTFORM ─────────────────────────────────────────────────────
app.post('/webhooks/discord-jotform', wh, (req, res) => {
if (!verifyJF(req)) return res.status(401).send('Unauthorized');
const bb = Busboy({ headers: req.headers });
let raw = '';
bb.on('field', (n, v) => { raw += `\\n[${n}]=${v}`; });
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
const CANCEL_EVENTS = [
'net.authorize.customer.subscription.cancelled',
'net.authorize.customer.subscription.expired',
'net.authorize.customer.subscription.suspended',
'net.authorize.customer.subscription.terminated',
'net.authorize.customer.subscription.failed'
];

```
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
```

});

app.get('/check-access', frm, async (req, res) => {
const email = req.query.email?.toLowerCase().trim();
if (!email) return res.status(400).json({ active: false });
const { data } = await supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).maybeSingle();
res.json({ active: data?.status === 'active' && new Date(data.expires_at) > new Date() });
});

// ─── TRADING ROOM ─────────────────────────────────────────────────────────────
// UPDATED UI:
// - Adds NinjaTrader email field + requirement note + simple inline “NT” mark.
// - Keeps theme consistent.
// - Sends ninjatrader_email in payload (backend can implement tomorrow).
app.get('/trading-room', (req, res) => {
res.send(shell('Activate Member Access', `
<div class="card">
<div class="ct"></div>
<div class="cb">
<div style="text-align:center;margin-bottom:24px;">
<div style="display:inline-block;background:rgba(74,158,255,0.08);border:1px solid rgba(74,158,255,0.2);border-radius:20px;padding:6px 18px;margin-bottom:16px;">
<span style="color:#4a9eff;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Member Access Activation</span>
</div>
<div class="ttl" style="margin-bottom:8px;">Activate Your Member Access</div>
<div class="sub" style="margin-bottom:0;">Takes less than 2 minutes. Please enter the information exactly.</div>
</div>
<div class="div"></div>

```
    <!-- NinjaTrader Activation (display only for now) -->
    <div class="ntBadge">
      <div class="ntIcon">${ninjaLogoSVG()}</div>
      <div style="flex:1;">
        <div class="ntTitle">NinjaTrader Activation</div>
        <div class="ntDesc">
          Enter the email tied to your <strong style="color:#fff;">NinjaTrader account</strong>.
          <strong style="color:#90b8e8;">You must have a NinjaTrader account created first</strong> before submitting this.
        </div>
      </div>
    </div>

    <label for="ntemail">NinjaTrader Account Email</label>
    <input type="email" id="ntemail" placeholder="email used for NinjaTrader" />

    <div style="background:rgba(74,158,255,0.05);border:1px solid rgba(74,158,255,0.2);border-radius:12px;padding:18px 20px;margin-bottom:24px;">
      <div style="font-family:'Rajdhani',sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#2d5a8e;margin-bottom:14px;font-weight:700;">Discord Trading Room</div>
      <div style="display:flex;gap:12px;margin-bottom:12px;">
        <div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#1a3a8e,#2a5aae);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;margin-top:1px;">1</div>
        <div style="color:#8aafd4;font-size:13px;line-height:1.5;">Go to <strong style="color:#4a9eff;">highvelocitytrading.com</strong>, click <strong style="color:#fff;">Join Discord</strong>, and join the server.</div>
      </div>
      <div style="display:flex;gap:12px;">
        <div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#1a3a8e,#2a5aae);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;margin-top:1px;">2</div>
        <div style="color:#8aafd4;font-size:13px;line-height:1.5;">Once you have joined, enter your <strong style="color:#fff;">purchase email</strong> and <strong style="color:#fff;">Discord username</strong> below and click Activate.</div>
      </div>
    </div>

    <label for="email">Purchase Email</label>
    <input type="email" id="email" placeholder="your@email.com" />
    <label for="discord">Discord Username</label>
    <input type="text" id="discord" placeholder="e.g. johntrader22" />

    <div style="background:rgba(255,255,255,0.02);border:1px solid #1a3060;border-radius:8px;padding:12px 16px;margin-bottom:20px;">
      <p style="color:#4a6a8a;font-size:12px;margin:0;line-height:1.7;">💡 <strong style="color:#6b8db8;">Where to find your username:</strong> Open Discord → click your profile picture at the <strong style="color:#6b8db8;">bottom-left</strong> → your username is the text below your display name (lowercase, may have numbers). <strong style="color:#6b8db8;">Not your display name — the actual username.</strong></p>
    </div>

    <button class="btn" id="btn" onclick="go()">Activate Member Access</button>
    <div class="msg" id="msg"></div>
  </div>
</div>
<script>
  async function go() {
    const email   = document.getElementById('email').value.trim();
    const disc    = document.getElementById('discord').value.trim();
    const ntEmail = document.getElementById('ntemail').value.trim();
    const msg     = document.getElementById('msg');
    const btn     = document.getElementById('btn');
    msg.className = 'msg';

    if (!ntEmail) { msg.className='msg er show'; msg.textContent='Please enter your NinjaTrader account email.'; return; }
    if (!email)   { msg.className='msg er show'; msg.textContent='Please enter your purchase email.'; return; }
    if (!disc)    { msg.className='msg er show'; msg.textContent='Please enter your Discord username.'; return; }

    btn.disabled = true; btn.textContent = 'Activating...';
    try {
      const r = await fetch('/trading-room/activate', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email, discord_username: disc, ninjatrader_email: ntEmail })
      });
      const d = await r.json();
      if (r.ok) {
        msg.className='msg ok show';
        msg.textContent='✓ Done! Check Discord — your role has been assigned. NinjaTrader activation will be processed next.';
        btn.textContent='Access Granted ✓';
      } else {
        msg.className='msg er show';
        msg.textContent=d.error||'Something went wrong.';
        btn.disabled=false;
        btn.textContent='Activate Member Access';
      }
    } catch {
      msg.className='msg er show';
      msg.textContent='Network error. Please try again.';
      btn.disabled=false;
      btn.textContent='Activate Member Access';
    }
  }
</script>`));
```

});

app.post('/trading-room/activate', frm, express.json(), async (req, res) => {
try {
const email   = (req.body.email || '').toLowerCase().trim();
const discUser= (req.body.discord_username || '').trim();

```
    // Display-only for now; accepted but not used yet (you said backend tomorrow)
    const ntEmail = (req.body.ninjatrader_email || '').toLowerCase().trim();

    if (!ntEmail)  return res.status(400).json({ error: 'NinjaTrader email is required' });
    if (!email)    return res.status(400).json({ error: 'Email is required' });
    if (!discUser) return res.status(400).json({ error: 'Discord username is required' });

    const [{ data: mem }, { data: lic }, { data: dm }] = await Promise.all([
        supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).maybeSingle(),
        supabase.from(LICENSE_TABLE).select('status').eq('email', email).maybeSingle(),
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

    console.log(`✅ Role assigned: @${discUser} (${uid}) → ${email} | NT email captured: ${ntEmail}`);
    res.json({ ok: true });
} catch (e) {
    console.error('[TRActivate]', e.message);
    res.status(500).json({ error: 'Server error. Please try again or call 786-461-4235.' });
}
```

});

// ─── COURSE / MEMBER ACCESS ───────────────────────────────────────────────────
// UPDATED UI:
// - Buttons are light blue (no gold).
// - Renamed to "Member Access" (not just course).
app.get('/course', (req, res) => {
res.send(shell('Member Access',      `<div style="width:100%;max-width:560px;">       <div class="card" style="max-width:560px;">         <div class="ct"></div>         <div class="cb">           <div style="text-align:center;margin-bottom:24px;">             <div style="display:inline-block;background:rgba(74,158,255,0.08);border:1px solid rgba(74,158,255,0.2);border-radius:20px;padding:6px 18px;margin-bottom:16px;">               <span style="color:#4a9eff;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Member Access Only</span>             </div>             <div class="ttl" style="margin-bottom:8px;">HVT Member Access</div>             <div class="sub" style="margin-bottom:0;">Enter your membership email and we’ll send you a secure link to access your member portal.</div>           </div>           <div class="div"></div>           <label for="email">Membership Email</label>           <input type="email" id="email" placeholder="your@email.com" />           <button class="btn" id="btn" style="background:linear-gradient(135deg,#4a9eff,#2a5aae);box-shadow:0 4px 20px rgba(74,158,255,0.35);" onclick="go()">Send My Access Link</button>           <div class="msg" id="msg"></div>         </div>       </div>       <div style="margin-top:28px;background:linear-gradient(145deg,#0d1f42,#091526);border:1px solid #1a3060;border-radius:20px;overflow:hidden;">         <div style="height:3px;background:linear-gradient(90deg,#1a3a8e,#4a9eff,#1a3a8e);"></div>         <div style="padding:32px;">           <div style="text-align:center;margin-bottom:24px;">             <div style="font-family:'Rajdhani',sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#4a9eff;margin-bottom:10px;">Not a Member Yet?</div>             <div style="font-family:'Rajdhani',sans-serif;font-size:24px;font-weight:700;color:#fff;line-height:1.3;">Get Full Access to the<br>HVT Course & Trading Room</div>           </div>           <div style="height:1px;background:linear-gradient(90deg,transparent,#1e3a6e,transparent);margin-bottom:24px;"></div>           <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:28px;">             <div style="display:flex;align-items:flex-start;gap:12px;">               <div style="width:28px;height:28px;border-radius:50%;background:rgba(74,158,255,0.1);border:1px solid rgba(74,158,255,0.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;">📹</div>               <div><div style="color:#fff;font-size:14px;font-weight:600;margin-bottom:2px;">Full Video Course</div><div style="color:#4a6a8a;font-size:12px;line-height:1.5;">Step-by-step trading videos built on our proven HVT strategies.</div></div>             </div>             <div style="display:flex;align-items:flex-start;gap:12px;">               <div style="width:28px;height:28px;border-radius:50%;background:rgba(74,158,255,0.1);border:1px solid rgba(74,158,255,0.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;">📊</div>               <div><div style="color:#fff;font-size:14px;font-weight:600;margin-bottom:2px;">Proprietary Indicators & Software</div><div style="color:#4a6a8a;font-size:12px;line-height:1.5;">Exclusive HVT tools for a professional edge every session.</div></div>             </div>             <div style="display:flex;align-items:flex-start;gap:12px;">               <div style="width:28px;height:28px;border-radius:50%;background:rgba(74,158,255,0.1);border:1px solid rgba(74,158,255,0.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;">🎙️</div>               <div><div style="color:#fff;font-size:14px;font-weight:600;margin-bottom:2px;">Live Trading Room Access</div><div style="color:#4a6a8a;font-size:12px;line-height:1.5;">Trade alongside the HVT team in real time, every market day.</div></div>             </div>           </div>           <div style="height:1px;background:linear-gradient(90deg,transparent,#1e3a6e,transparent);margin-bottom:24px;"></div>           <div style="text-align:center;">             <a href="<https://highvelocitytrading.com/#packages>" style="display:inline-block;background:linear-gradient(135deg,#4a9eff,#2a5aae);color:#fff;text-decoration:none;padding:14px 40px;border-radius:10px;font-family:'Rajdhani',sans-serif;font-size:15px;font-weight:700;letter-spacing:2px;text-transform:uppercase;box-shadow:0 4px 20px rgba(74,158,255,0.35);">VIEW PACKAGES →</a>             <p style="color:#2d4a6e;font-size:11px;margin-top:14px;">Questions? Call <strong style="color:#4a6a8a;">786-461-4235</strong></p>           </div>         </div>       </div>     </div>     <script>       async function go() {         const email = document.getElementById('email').value.trim();         const msg   = document.getElementById('msg');         const btn   = document.getElementById('btn');         msg.className='msg';         if (!email) { msg.className='msg er show'; msg.textContent='Please enter your email.'; return; }         btn.disabled=true; btn.textContent='Sending...';         try {           const r = await fetch('/course/request', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email }) });           const d = await r.json();           if (r.ok) { msg.className='msg ok show'; msg.textContent='✓ Check your email! Your secure access link has been sent.'; btn.textContent='Link Sent ✓'; }           else      { msg.className='msg er show'; msg.textContent=d.error||'Something went wrong.'; btn.disabled=false; btn.textContent='Send My Access Link'; }         } catch { msg.className='msg er show'; msg.textContent='Network error.'; btn.disabled=false; btn.textContent='Send My Access Link'; }       }     </script>`));
});

app.post('/course/request', frm, express.json(), async (req, res) => {
try {
const email = (req.body.email || '').toLowerCase().trim();
if (!email) return res.status(400).json({ error: 'Email is required' });
const { data: mem } = await supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).maybeSingle();
const { data: lic } = await supabase.from(LICENSE_TABLE).select('status').eq('email', email).maybeSingle();
const isMonthly  = mem?.status === 'active' && new Date(mem.expires_at) > new Date();
const isLifetime = lic?.status === 'active';
if (!isMonthly && !isLifetime) return res.status(403).json({ error: 'No active membership found. Visit [highvelocitytrading.com](http://highvelocitytrading.com/) or call 786-461-4235.' });

```
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 86400000).toISOString();

    if (isMonthly) await supabase.from(MEMBERSHIP_TABLE).update({ course_token: token, course_token_expires: expires, updated_at: nowISO() }).eq('email', email);
    else           await supabase.from(LICENSE_TABLE).update({ course_token: token, course_token_expires: expires, updated_at: nowISO() }).eq('email', email);

    await sendCourseEmail(email, token);
    res.json({ ok: true });
} catch (e) { console.error('[CourseReq]', e.message); res.status(500).json({ error: 'Server error.' }); }
```

});

app.get('/course/confirm', async (req, res) => {
const token = req.query.token;
if (!token) return res.send(resultPage('error', 'Invalid Link', 'This access link is invalid.'));
try {
const { data: mData } = await supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,expires_at,course_token_expires').eq('course_token', token).maybeSingle();
const { data: lData } = await supabase.from(LICENSE_TABLE).select('email,full_name,status,course_token_expires').eq('course_token', token).maybeSingle();
const rec = mData || lData;
if (!rec) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid or has expired.'));
if (!rec.course_token_expires || new Date(rec.course_token_expires) < new Date())
return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/course" style="color:#4a9eff;">Request a new one</a>.'));

```
    const isMonthly  = mData?.status === 'active' && new Date(mData.expires_at) > new Date();
    const isLifetime = lData?.status === 'active';
    if (!isMonthly && !isLifetime) return res.send(resultPage('error', 'Access Revoked', 'Your membership is no longer active.'));

    const name     = (rec.full_name || 'Trader').split(' ')[0];
    const planLbl  = isLifetime ? 'Lifetime Access' : 'Monthly Membership';
    const planClr  = isLifetime ? '#90cdf4' : '#4a9eff';
    const planBg   = isLifetime ? 'rgba(74,158,255,0.08)' : 'rgba(74,158,255,0.08)';
    const planBrd  = isLifetime ? 'rgba(74,158,255,0.2)'  : 'rgba(74,158,255,0.2)';

    res.send(shell('Member Access', `
    <div style="width:100%;max-width:680px;">
      <div style="text-align:center;margin-bottom:32px;">
        <div style="display:inline-block;background:${planBg};border:1px solid ${planBrd};border-radius:20px;padding:6px 18px;margin-bottom:12px;">
          <span style="color:${planClr};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">${planLbl}</span>
        </div>
        <div style="font-family:'Rajdhani',sans-serif;font-size:28px;font-weight:700;color:#fff;">Welcome back, ${name}.</div>
      </div>
      <div class="card" style="max-width:680px;">
        <div class="ct"></div>
        <div class="cb" style="text-align:center;padding:56px 32px;">
          <div style="width:72px;height:72px;border-radius:50%;background:rgba(74,158,255,0.08);border:1px solid rgba(74,158,255,0.25);display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:30px;">🔐</div>
          <div style="font-family:'Rajdhani',sans-serif;font-size:28px;font-weight:700;letter-spacing:2px;color:#fff;margin-bottom:8px;">MEMBER PORTAL</div>
          <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(74,158,255,0.3),transparent);margin:20px 0;"></div>
          <p style="color:#8aafd4;font-size:14px;line-height:1.8;max-width:520px;margin:0 auto 28px;">
            Your member access is confirmed. If you’re here for Discord activation and NinjaTrader setup, head to:
            <a href="/trading-room" style="color:#4a9eff;text-decoration:none;font-weight:700;">/trading-room</a>
          </p>
          <div style="background:rgba(74,158,255,0.04);border:1px solid rgba(74,158,255,0.12);border-radius:10px;padding:14px 20px;">
            <p style="color:#4a6a8a;font-size:13px;margin:0 0 6px;">Need help? We will walk you through everything.</p>
            <p style="color:#90b8e8;font-size:15px;font-weight:700;margin:0;">📞 786-461-4235</p>
          </div>
        </div>
      </div>
    </div>`));
} catch (e) { console.error('[CourseConfirm]', e.message); res.send(resultPage('error', 'Error', 'Something went wrong.')); }
```

});

// ─── BILLING PORTAL ───────────────────────────────────────────────────────────
app.get('/billing', (req, res) => {
res.send(shell('Billing Portal',      `<div class="card"><div class="ct"></div><div class="cb">       <div class="ttl">Billing Portal</div>       <div class="sub">Enter your email and we'll send a secure link to your billing dashboard.</div>       <div class="div"></div>       <label for="email">Email Address</label>       <input type="email" id="email" placeholder="your@email.com" />       <button class="btn" id="btn" onclick="go()">Send Access Link</button>       <div class="msg" id="msg"></div>     </div></div>     <script>       async function go() {         const email = document.getElementById('email').value.trim();         const msg   = document.getElementById('msg');         const btn   = document.getElementById('btn');         msg.className='msg';         if (!email) { msg.className='msg er show'; msg.textContent='Please enter your email.'; return; }         btn.disabled=true; btn.textContent='Sending...';         try {           const r = await fetch('/billing/request', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email }) });           const d = await r.json();           if (r.ok) { msg.className='msg ok show'; msg.textContent='✓ Check your email! A secure link has been sent.'; btn.textContent='Email Sent'; }           else      { msg.className='msg er show'; msg.textContent=d.error||'Something went wrong.'; btn.disabled=false; btn.textContent='Send Access Link'; }         } catch { msg.className='msg er show'; msg.textContent='Network error.'; btn.disabled=false; btn.textContent='Send Access Link'; }       }     </script>`));
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
if (new Date(data.billing_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/billing" style="color:#4a9eff;">Request a new one</a>.'));
const { status, email, full_name: name = 'Member', expires_at } = data;
const exAt    = expires_at ? new Date(expires_at) : null;
const sc      = status === 'active' ? '#68d391' : '#fc8181';
const sb      = status === 'active' ? 'rgba(56,161,105,0.08)' : 'rgba(229,62,62,0.08)';
const sbd     = status === 'active' ? 'rgba(56,161,105,0.2)' : 'rgba(229,62,62,0.2)';
const next    = exAt ? exAt.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }) : 'N/A';
const days    = exAt ? Math.max(0, Math.ceil((exAt - new Date()) / 86400000)) : 0;
const cancel  = status === 'active'
? `<div style="margin-top:24px;padding-top:24px;border-top:1px solid #1a3060;"><p style="color:#2d4a6e;font-size:12px;text-align:center;margin-bottom:16px;">Want to cancel?</p><a href="/cancel" style="display:block;width:100%;padding:12px;background:transparent;border:1px solid rgba(229,62,62,0.3);color:#fc8181;border-radius:10px;font-family:'Rajdhani',sans-serif;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;text-align:center;text-decoration:none;">Cancel Membership</a></div>`
: `<div style="margin-top:24px;text-align:center;"><p style="color:#4a6a8a;font-size:13px;">Membership is no longer active.</p></div>`;
res.send(shell('My Billing',          `<div class="card" style="max-width:480px;width:100%;"><div class="ct"></div><div class="cb">           <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">             <div>               <div style="font-family:'Rajdhani',sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#2d5a8e;margin-bottom:4px;">Welcome back</div>               <div style="font-family:'Rajdhani',sans-serif;font-size:22px;font-weight:700;color:#fff;">${name}</div>             </div>             <div style="background:${sb};border:1px solid ${sbd};border-radius:20px;padding:6px 14px;font-size:12px;color:${sc};font-family:'Rajdhani',sans-serif;font-weight:600;">${status === 'active' ? '● Active' : status}</div>           </div>           <div class="div"></div>           <div style="background:rgba(255,255,255,0.02);border:1px solid #1a3060;border-radius:12px;overflow:hidden;margin-bottom:16px;">             <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #1a3060;"><span style="color:#4a6a8a;font-size:13px;">Plan</span><span style="color:#90b8e8;font-size:13px;">HVT Monthly Membership</span></div>             <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #1a3060;"><span style="color:#4a6a8a;font-size:13px;">Email</span><span style="color:#90b8e8;font-size:13px;">${email}</span></div>             <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #1a3060;"><span style="color:#4a6a8a;font-size:13px;">Next Billing</span><span style="color:#90b8e8;font-size:13px;">${next}</span></div>             <div style="display:flex;justify-content:space-between;padding:14px 18px;"><span style="color:#4a6a8a;font-size:13px;">Days Remaining</span><span style="color:${days > 7 ? '#68d391' : '#f6ad55'};font-size:13px;font-weight:600;">${days} days</span></div>           </div>${cancel}         </div></div>`));
} catch (e) { console.error('[BillingConfirm]', e.message); res.send(resultPage('error', 'Error', 'Something went wrong.')); }
});

// ─── CANCEL ───────────────────────────────────────────────────────────────────
app.get('/cancel', (req, res) => {
res.send(shell('Cancel Membership',      `<div class="card">       <div class="ct" style="background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d);"></div>       <div class="cb">         <div class="ttl">Cancel Membership</div>         <div class="sub">Enter your email and we'll send a secure one-time cancellation link.</div>         <div class="div"></div>         <label for="email">Email Address</label>         <input type="email" id="email" placeholder="your@email.com" />         <button class="btn" id="btn" style="background:linear-gradient(135deg,#991b1b,#dc2626);" onclick="go()">Send Cancellation Link</button>         <div class="msg" id="msg"></div>       </div>     </div>     <script>       async function go() {         const email = document.getElementById('email').value.trim();         const msg   = document.getElementById('msg');         const btn   = document.getElementById('btn');         msg.className='msg';         if (!email) { msg.className='msg er show'; msg.textContent='Please enter your email.'; return; }         btn.disabled=true; btn.textContent='Sending...';         try {           const r = await fetch('/cancel/request', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email }) });           const d = await r.json();           if (r.ok) { msg.className='msg ok show'; msg.textContent='✓ Check your email! A secure cancellation link has been sent.'; btn.textContent='Email Sent'; }           else      { msg.className='msg er show'; msg.textContent=d.error||'Something went wrong.'; btn.disabled=false; btn.textContent='Send Cancellation Link'; }         } catch { msg.className='msg er show'; msg.textContent='Network error.'; btn.disabled=false; btn.textContent='Send Cancellation Link'; }       }     </script>`));
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
const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,status,authnet_subscription_id,cancel_token_expires,discord_user_id').eq('cancel_token', token).maybeSingle();
if (!data) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid or has expired.'));
if (new Date(data.cancel_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/cancel" style="color:#fc8181;">Request a new one</a>.'));
if (data.status === 'cancelled') return res.send(resultPage('info', 'Already Cancelled', 'Your membership is already cancelled.'));
if (data.authnet_subscription_id) try { await cancelSub(data.authnet_subscription_id); } catch (e) { console.error('[CancelSub]', e.message); }
if (data.discord_user_id) try { await stripRole(data.discord_user_id, DISCORD_MONTHLY_ROLE_ID); } catch {}
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
bb.on('field', (n, v) => { fields[n] = v; raw += `\\n[${n}]=${v}`; });
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

// ─── ADMIN PANEL (UNCHANGED CORE LOGIC) ───────────────────────────────────────
// Keeping as-is to avoid breaking current operations. You can harden later.
function adminGuard(req, res, next) {
const k = req.query.key || req.body?.key;
if (!k || k !== ADMIN_SECRET) return res.status(403).send(resultPage('error', 'Access Denied', 'Invalid or missing admin key.'));
next();
}

app.get('/admin', adm, adminGuard, async (req, res) => {
const key = req.query.key;

```
const [{ data: members }, { data: licenses }, { data: discordMems }] = await Promise.all([
    supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,plan_name,expires_at,discord_user_id').order('updated_at', { ascending: false }).limit(100),
    supabase.from(LICENSE_TABLE).select('email,full_name,status,license_key').order('updated_at', { ascending: false }).limit(100),
    supabase.from(DISCORD_TABLE).select('email,full_name,status,expires_at,discord_user_id,discord_username').order('updated_at', { ascending: false }).limit(100)
]);

let guildMembers = [];
try { guildMembers = await getGuildAll(); } catch {}
const allRoles = [DISCORD_MONTHLY_ROLE_ID, DISCORD_LIFETIME_ROLE_ID, ...(DISCORD_ROOM_ROLE_ID ? [DISCORD_ROOM_ROLE_ID] : [])];
const liveHVT  = guildMembers.filter(m => m.roles?.some(r => allRoles.includes(r)));

const badge = (s, gold = false) => {
    const a = s === 'active';
    const c = a ? (gold ? '#f6ad55' : '#68d391') : '#fc8181';
    const b = a ? (gold ? 'rgba(246,173,85,0.08)' : 'rgba(56,161,105,0.08)') : 'rgba(229,62,62,0.08)';
    const d = a ? (gold ? 'rgba(246,173,85,0.2)' : 'rgba(56,161,105,0.2)') : 'rgba(229,62,62,0.2)';
    return `<span style="background:${b};border:1px solid ${d};border-radius:20px;padding:3px 10px;font-size:11px;color:${c};font-family:'Rajdhani',sans-serif;letter-spacing:1px;font-weight:600;">${s}</span>`;
};
const cancelBtn = (email, type, lbl) => `<button onclick="fireUser('${email}','${type}')" style="background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-family:'Rajdhani',sans-serif;font-size:12px;font-weight:700;letter-spacing:1px;cursor:pointer;">${lbl}</button>`;

const memberRows = (members || []).map(m => {
    const exp = m.expires_at ? new Date(m.expires_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : 'N/A';
    return `<tr style="border-bottom:1px solid #0f2040;">
      <td style="padding:12px 14px;color:#90b8e8;font-size:13px;">${m.full_name || '—'}</td>
      <td style="padding:12px 14px;color:#6b8db8;font-size:13px;">${m.email}</td>
      <td style="padding:12px 14px;">${badge(m.status)}</td>
      <td style="padding:12px 14px;color:#4a6a8a;font-size:12px;">${exp}</td>
      <td style="padding:12px 14px;color:#4a6a8a;font-size:12px;">${m.discord_user_id ? '✓' : '—'}</td>
      <td style="padding:12px 14px;">${m.status === 'active' ? cancelBtn(m.email, 'monthly', 'CANCEL') : '<span style="color:#2d4a6e;font-size:12px;">Inactive</span>'}</td>
    </tr>`;
}).join('');

const licenseRows = (licenses || []).map(l => `<tr style="border-bottom:1px solid #0f2040;">
  <td style="padding:12px 14px;color:#90b8e8;font-size:13px;">${l.full_name || '—'}</td>
  <td style="padding:12px 14px;color:#6b8db8;font-size:13px;">${l.email}</td>
  <td style="padding:12px 14px;">${badge(l.status, true)}</td>
  <td style="padding:12px 14px;color:#4a6a8a;font-size:12px;font-family:monospace;">${l.license_key}</td>
  <td style="padding:12px 14px;">${l.status === 'active' ? cancelBtn(l.email, 'lifetime', 'REVOKE') : '<span style="color:#2d4a6e;font-size:12px;">Inactive</span>'}</td>
</tr>`).join('');

const discordRows = (discordMems || []).map(d => {
    const exp = d.expires_at ? new Date(d.expires_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : 'N/A';
    return `<tr style="border-bottom:1px solid #0f2040;">
      <td style="padding:12px 14px;color:#90b8e8;font-size:13px;">${d.full_name || '—'}</td>
      <td style="padding:12px 14px;color:#6b8db8;font-size:13px;">${d.email}</td>
      <td style="padding:12px 14px;">${badge(d.status)}</td>
      <td style="padding:12px 14px;color:#4a6a8a;font-size:12px;">${exp}</td>
      <td style="padding:12px 14px;color:#a78bfa;font-size:12px;">${d.discord_username || (d.discord_user_id ? '✓ Linked' : '—')}</td>
      <td style="padding:12px 14px;">${d.status === 'active' ? cancelBtn(d.email, 'discord', 'CANCEL') : '<span style="color:#2d4a6e;font-size:12px;">Inactive</span>'}</td>
    </tr>`;
}).join('');

const liveRows = liveHVT.map(m => `<tr style="border-bottom:1px solid #0f2040;">
  <td style="padding:12px 14px;color:#90b8e8;font-size:13px;">${m.nick || '—'}</td>
  <td style="padding:12px 14px;color:#a78bfa;font-size:13px;">@${m.user.username}</td>
  <td style="padding:12px 14px;color:#4a6a8a;font-size:11px;font-family:monospace;">${m.user.id}</td>
  <td style="padding:12px 14px;"><button onclick="removeRoleById('${m.user.id}','${m.user.username}')" style="background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-family:'Rajdhani',sans-serif;font-size:12px;font-weight:700;letter-spacing:1px;cursor:pointer;">REMOVE ROLE</button></td>
</tr>`).join('');

res.send(`<!DOCTYPE html><html lang="en"><head>
```

<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>HVT Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:radial-gradient(ellipse at 50% 0%,#0d2150 0%,#060e1f 55%,#020810 100%);min-height:100vh;padding:32px 24px;color:#fff;}
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid #1a3060;}
.brand{font-family:'Rajdhani',sans-serif;font-size:20px;font-weight:700;letter-spacing:3px;text-transform:uppercase;}
.restricted{background:rgba(229,62,62,0.1);border:1px solid rgba(229,62,62,0.3);border-radius:20px;padding:5px 14px;font-family:'Rajdhani',sans-serif;font-size:11px;color:#fc8181;letter-spacing:2px;font-weight:700;}
.sec{margin-bottom:36px;}
.sec-ttl{font-family:'Rajdhani',sans-serif;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#2d5a8e;margin-bottom:16px;}
.panel{background:linear-gradient(145deg,#0d1f42,#091526);border:1px solid #1a3060;border-radius:16px;overflow:hidden;}
.pt{height:3px;background:linear-gradient(90deg,#1a3a8e,#4a9eff,#1a3a8e);}
.pt-red{background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d);}
.pt-gold{background:linear-gradient(90deg,#92610a,#f6ad55,#92610a);}
.pt-purple{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95);}
.pt-green{background:linear-gradient(90deg,#14532d,#16a34a,#14532d);}
table{width:100%;border-collapse:collapse;}
th{padding:12px 14px;text-align:left;font-family:'Rajdhani',sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#1e3a6e;border-bottom:1px solid #1a3060;}
.fc{padding:28px;background:linear-gradient(145deg,#0d1f42,#091526);border:1px solid #1a3060;border-radius:16px;margin-bottom:20px;}
.gc{padding:28px;background:linear-gradient(145deg,#1a0d42,#0d091f);border:1px solid #3a1a80;border-radius:16px;margin-bottom:20px;}
.bar{height:3px;margin:-28px -28px 24px;border-radius:16px 16px 0 0;}
.bar-red{background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d);}
.bar-purple{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95);}
input[type=email],input[type=text],select{width:100%;padding:12px 16px;background:rgba(255,255,255,0.03);border:1px solid #1a3060;border-radius:10px;color:#fff;font-size:14px;outline:none;font-family:'Inter',sans-serif;margin-bottom:12px;}
input:focus,select:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,0.15);}
input::placeholder{color:#1e3a5e;}
.btn-red{padding:12px 32px;background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:10px;font-family:'Rajdhani',sans-serif;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 20px rgba(220,38,38,0.3);}
.btn-purple{padding:12px 32px;background:linear-gradient(135deg,#4c1d95,#7c3aed);color:#fff;border:none;border-radius:10px;font-family:'Rajdhani',sans-serif;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 20px rgba(124,58,237,0.35);}
.msg{margin-top:12px;padding:12px 16px;border-radius:10px;font-size:13px;display:none;line-height:1.5;}
.msg.show{display:block;}
.ok{background:rgba(56,161,105,0.08);color:#68d391;border:1px solid rgba(56,161,105,0.2);}
.er{background:rgba(229,62,62,0.08);color:#fc8181;border:1px solid rgba(229,62,62,0.2);}
.tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;}
.tab{padding:8px 18px;border-radius:20px;font-family:'Rajdhani',sans-serif;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;border:1px solid #1a3060;color:#4a6a8a;background:transparent;transition:all .2s;}
.tab.active{background:rgba(74,158,255,0.1);border-color:rgba(74,158,255,0.3);color:#4a9eff;}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:1000;align-items:center;justify-content:center;}
.overlay.show{display:flex;}
.modal{background:linear-gradient(145deg,#0d1f42,#091526);border:1px solid #1a3060;border-radius:16px;padding:32px;max-width:420px;width:90%;text-align:center;}
.mttl{font-family:'Rajdhani',sans-serif;font-size:20px;font-weight:700;color:#fff;margin-bottom:12px;}
.msub{color:#6b8db8;font-size:14px;line-height:1.6;margin-bottom:24px;}
.mbtns{display:flex;gap:12px;}
.mok{flex:1;padding:12px;background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:10px;font-family:'Rajdhani',sans-serif;font-size:14px;font-weight:700;cursor:pointer;}
.mno{flex:1;padding:12px;background:transparent;color:#6b8db8;border:1px solid #1a3060;border-radius:10px;font-family:'Rajdhani',sans-serif;font-size:14px;font-weight:700;cursor:pointer;}
label{display:block;font-family:'Rajdhani',sans-serif;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;}
.lred{color:#3a6a9a;}
.lpurp{color:#7c3aed;}
</style>
</head><body>
<div class="hdr">
<div>
<div class="brand">High Velocity Trading</div>
<div style="font-family:'Rajdhani',sans-serif;font-size:10px;color:#1e3a6e;letter-spacing:4px;text-transform:uppercase;margin-top:3px;">Admin Control Panel</div>
</div>
<div class="restricted">⚠ RESTRICTED</div>
</div>

<div class="sec">
<div class="sec-ttl">⚡ God Mode — Instant Discord Role</div>
<div class="gc">
<div class="bar bar-purple"></div>
<div style="font-family:'Rajdhani',sans-serif;font-size:16px;font-weight:700;color:#c4b5fd;margin-bottom:6px;">Add Any Discord User Instantly</div>
<div style="color:#4a6a8a;font-size:13px;margin-bottom:20px;">Bypasses everything. Type a Discord username, pick the role, done. They must already be in the server.</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
<div>
<label class="lpurp">Discord Username</label>
<input type="text" id="godUser" placeholder="theirDiscordUsername" style="margin-bottom:0;" />
</div>
<div>
<label class="lpurp">Role to Assign</label>
<select id="godRole" style="margin-bottom:0;">
<option value="monthly">Monthly Member</option>
<option value="lifetime">Lifetime Member</option>
<option value="discord">Discord Room ($37)</option>
</select>
</div>
</div>
<button class="btn-purple" onclick="godMode()">⚡ ASSIGN ROLE NOW</button>
<div class="msg" id="godMsg"></div>
</div>
</div>

<div class="sec">
<div class="sec-ttl">Manual Access Removal</div>
<div class="fc">
<div class="bar bar-red"></div>
<div style="font-family:'Rajdhani',sans-serif;font-size:16px;font-weight:700;color:#fff;margin-bottom:6px;">Cancel / Revoke by Email</div>
<div style="color:#4a6a8a;font-size:13px;margin-bottom:20px;">Cancels subscription, removes Discord role, marks account cancelled.</div>
<label class="lred">Member Email</label>
<input type="email" id="manualEmail" [placeholder="member@email.com](mailto:placeholder=%22member@email.com)" />
<label class="lred">Membership Type</label>
<select id="manualType">
<option value="monthly">Monthly Membership</option>
<option value="lifetime">Lifetime License</option>
<option value="discord">Discord Room ($37)</option>
</select>
<button class="btn-red" onclick="openModal()">🔥 CANCEL ACCESS</button>
<div class="msg" id="manualMsg"></div>
</div>
</div>

<div class="sec">
<div class="sec-ttl">Member Management</div>
<div class="tabs">
<button class="tab active" onclick="showTab('monthly',this)">Monthly (${(members||[]).length})</button>
<button class="tab" onclick="showTab('lifetime',this)">Lifetime (${(licenses||[]).length})</button>
<button class="tab" onclick="showTab('discord37',this)">Discord $37 (${(discordMems||[]).length})</button>
<button class="tab" onclick="showTab('live',this)">Live on Discord (${liveHVT.length})</button>
</div>

<div id="tab-monthly" class="panel">
<div class="pt"></div>
<div style="overflow-x:auto;"><table>
<thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Expires</th><th>Discord</th><th>Action</th></tr></thead>
<tbody>${memberRows || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#2d4a6e;">No records</td></tr>'}</tbody>
</table></div>
</div>

<div id="tab-lifetime" class="panel" style="display:none;">
<div class="pt pt-gold"></div>
<div style="overflow-x:auto;"><table>
<thead><tr><th>Name</th><th>Email</th><th>Status</th><th>License Key</th><th>Action</th></tr></thead>
<tbody>${licenseRows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#2d4a6e;">No records</td></tr>'}</tbody>
</table></div>
</div>

<div id="tab-discord37" class="panel" style="display:none;">
<div class="pt pt-purple"></div>
<div style="overflow-x:auto;"><table>
<thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Expires</th><th>Discord Username</th><th>Action</th></tr></thead>
<tbody>${discordRows || '<tr><td colspan="6" style="padding:20px;text-align:center;color:#2d4a6e;">No records</td></tr>'}</tbody>
</table></div>
</div>

<div id="tab-live" class="panel" style="display:none;">
<div class="pt pt-green"></div>
<div style="padding:14px 18px;border-bottom:1px solid #1a3060;"><p style="color:#4a6a8a;font-size:12px;">Members currently in your Discord server with an HVT role. REMOVE ROLE strips all HVT roles instantly.</p></div>
<div style="overflow-x:auto;"><table>
<thead><tr><th>Display Name</th><th>Username</th><th>Discord ID</th><th>Action</th></tr></thead>
<tbody>${liveRows || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#2d4a6e;">No members with HVT roles found</td></tr>'}</tbody>
</table></div>
</div>
</div>

<div class="overlay" id="overlay">
<div class="modal">
<div style="font-size:32px;margin-bottom:16px;">⚠️</div>
<div class="mttl">Confirm Action</div>
<div class="msub" id="modalSub"></div>
<div class="mbtns">
<button class="mno" onclick="closeModal()">BACK</button>
<button class="mok" onclick="confirm()">CONFIRM</button>
</div>
</div>
</div>

<script>
const KEY = '${key}';
let pending = null;

function showTab(name, el) {
['monthly','lifetime','discord37','live'].forEach(t => document.getElementById('tab-'+t).style.display='none');
document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
document.getElementById('tab-'+name).style.display='block';
el.classList.add('active');
}

function openModal() {
const email = document.getElementById('manualEmail').value.trim();
const type  = document.getElementById('manualType').value;
if (!email) { const m=document.getElementById('manualMsg'); m.className='msg er show'; m.textContent='Please enter an email.'; return; }
pending = { action:'cancel', email, type };
document.getElementById('modalSub').innerHTML = 'Cancel access for:<br><strong style="color:#fc8181;">'+email+'</strong><br><br>Discord role will be removed immediately.';
document.getElementById('overlay').classList.add('show');
}
function closeModal() { document.getElementById('overlay').classList.remove('show'); pending=null; }

async function confirm() {
closeModal();
if (!pending) return;
if (pending.action === 'cancel')     await doCancel(pending.email, pending.type);
if (pending.action === 'removeRole') await doRemoveRole(pending.uid, pending.username);
}

function fireUser(email, type) {
document.getElementById('manualEmail').value = email;
document.getElementById('manualType').value  = type;
openModal();
}

async function doCancel(email, type) {
const msg = document.getElementById('manualMsg');
msg.className='msg';
try {
const r = await fetch('/admin/cancel', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email, type, key:KEY }) });
const d = await r.json();
if (r.ok) { msg.className='msg ok show'; msg.textContent='✓ Cancelled: '+email; setTimeout(()=>location.reload(),1800); }
else       { msg.className='msg er show'; msg.textContent=d.error||'Error.'; }
} catch { msg.className='msg er show'; msg.textContent='Network error.'; }
}

function removeRoleById(uid, username) {
pending = { action:'removeRole', uid, username };
document.getElementById('modalSub').innerHTML = 'Strip ALL HVT roles from:<br><strong style="color:#a78bfa;">@'+username+'</strong><br><br>They will lose Discord access immediately.';
document.getElementById('overlay').classList.add('show');
}

async function doRemoveRole(uid, username) {
const msg = document.getElementById('manualMsg');
msg.className='msg';
try {
const r = await fetch('/admin/remove-role', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ discord_user_id:uid, key:KEY }) });
const d = await r.json();
if (r.ok) { msg.className='msg ok show'; msg.textContent='✓ Roles removed from @'+username; setTimeout(()=>location.reload(),1800); }
else       { msg.className='msg er show'; msg.textContent=d.error||'Error.'; }
} catch { msg.className='msg er show'; msg.textContent='Network error.'; }
}

async function godMode() {
const username = document.getElementById('godUser').value.trim();
const role     = document.getElementById('godRole').value;
const msg      = document.getElementById('godMsg');
msg.className='msg';
if (!username) { msg.className='msg er show'; msg.textContent='Please enter a Discord username.'; return; }
try {
const r = await fetch('/admin/god-add', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ discord_username:username, role, key:KEY }) });
const d = await r.json();
if (r.ok) { msg.className='msg ok show'; msg.textContent='⚡ Role assigned to @'+username+'!'; }
else       { msg.className='msg er show'; msg.textContent=d.error||'Error.'; }
} catch { msg.className='msg er show'; msg.textContent='Network error.'; }
}

document.getElementById('overlay').addEventListener('click', e => { if (e.target===e.currentTarget) closeModal(); });
</script>
</body></html>`);
});

// POST /admin/cancel
app.post('/admin/cancel', adm, express.json(), async (req, res) => {
if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
try {
const email = (req.body.email || '').toLowerCase().trim();
const type  = req.body.type || 'monthly';
if (!email) return res.status(400).json({ error: 'Email required' });

```
    if (type === 'lifetime') {
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
        const { data: m } = await supabase.from(MEMBERSHIP_TABLE).select('authnet_subscription_id,discord_user_id').eq('email', email).maybeSingle();
        if (!m) return res.status(404).json({ error: 'No membership found' });
        if (m.authnet_subscription_id) try { await cancelSub(m.authnet_subscription_id); } catch {}
        if (m.discord_user_id) try { await stripRole(m.discord_user_id, DISCORD_MONTHLY_ROLE_ID); } catch {}
        await supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email);
        console.log(`[Admin] Monthly cancelled: ${email}`);
    }
    res.json({ ok: true });
} catch (e) { console.error('[AdminCancel]', e.message); res.status(500).json({ error: e.message }); }
```

});

// POST /admin/remove-role — strip all HVT roles from a Discord user ID
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

// POST /admin/god-add — instantly assign a Discord role by username
app.post('/admin/god-add', adm, express.json(), async (req, res) => {
if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
try {
const username = (req.body.discord_username || '').trim();
const role     = req.body.role || 'monthly';
if (!username) return res.status(400).json({ error: 'discord_username required' });
const found = await findUser(username);
if (!found) return res.status(404).json({ error: `@${username} not found in the HVT server. They must join the server first.` });
const uid = [found.user.id](http://found.user.id/);
const rid = role === 'lifetime' ? DISCORD_LIFETIME_ROLE_ID : (role === 'discord' ? (DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID) : DISCORD_MONTHLY_ROLE_ID);
await addRole(uid, rid);
console.log(`[God Mode] @${username} (${uid}) → role: ${role} (${rid})`);
res.json({ ok: true, discord_user_id: uid, role });
} catch (e) { console.error('[GodMode]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

app.listen(PORT, () => console.log(`🚀 HVT Backend on port ${PORT}`));
