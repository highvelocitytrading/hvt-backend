'use strict';

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const Busboy = require('busboy');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 8080;

// -------------------- ENV --------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTHORIZE_SIGNATURE_KEY = process.env.AUTHORIZE_SIGNATURE_KEY || null;
const AUTHNET_API_LOGIN_ID = process.env.AUTHNET_API_LOGIN_ID;
const AUTHNET_TRANSACTION_KEY = process.env.AUTHNET_TRANSACTION_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'support@support.highvelocitytrading.com';
const APP_URL = process.env.APP_URL || 'https://hvt-backend-production-ec41.up.railway.app';

// Discord
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1460694720090083483';
const DISCORD_MONTHLY_ROLE_ID = process.env.DISCORD_MONTHLY_ROLE_ID || '1476634274424819897';
const DISCORD_LIFETIME_ROLE_ID = process.env.DISCORD_LIFETIME_ROLE_ID || '1476634362811384001';

const MEMBERSHIP_TABLE = process.env.SUPABASE_TABLE || 'membershipstab';
const LICENSE_TABLE = 'license_keys';

// -------------------- SUPABASE --------------------
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
});

console.log(`[INIT] Membership table: ${MEMBERSHIP_TABLE} | License table: ${LICENSE_TABLE}`);

// -------------------- SHARED HELPERS --------------------
function pickFirst(...vals) {
    for (const v of vals) {
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
    }
    return null;
}

function genLicenseKey() {
    const a = crypto.randomBytes(4).toString('hex').toUpperCase();
    const b = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `HVT-${a}-${b}`;
}

function verifyAuthorizeSignature(rawBody, signatureHeader) {
    if (!AUTHORIZE_SIGNATURE_KEY) return { ok: true, reason: 'signature_key_not_set_skip' };
    if (!signatureHeader || typeof signatureHeader !== 'string') {
        return { ok: false, reason: 'missing_signature_header' };
    }
    const provided = signatureHeader.startsWith('sha512=')
        ? signatureHeader.slice('sha512='.length)
        : signatureHeader;
    let computed;
    try {
        computed = crypto
            .createHmac('sha512', AUTHORIZE_SIGNATURE_KEY)
            .update(rawBody || '', 'utf8')
            .digest('hex');
    } catch {
        return { ok: false, reason: 'compute_failed' };
    }
    try {
        const a = Buffer.from(provided, 'hex');
        const b = Buffer.from(computed, 'hex');
        if (a.length !== b.length) return { ok: false, reason: 'signature_length_mismatch' };
        const match = crypto.timingSafeEqual(a, b);
        return match ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
    } catch {
        return { ok: false, reason: 'invalid_signature_format' };
    }
}

// -------------------- DISCORD HELPERS --------------------
async function discordRequest(method, path, body) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        method,
        headers: {
            'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(data)}`);
    return data;
}

async function findDiscordUserByUsername(username) {
    try {
        const members = await discordRequest('GET', `/guilds/${DISCORD_GUILD_ID}/members/search?query=${encodeURIComponent(username)}&limit=5`);
        if (!members || members.length === 0) return null;
        const exact = members.find(m =>
            m.user.username.toLowerCase() === username.toLowerCase() ||
            (m.nick && m.nick.toLowerCase() === username.toLowerCase())
        );
        return exact || members[0];
    } catch (err) {
        console.error('[Discord Search Error]', err.message);
        return null;
    }
}

async function assignDiscordRole(discordUserId, roleId) {
    await discordRequest('PUT', `/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`);
    console.log(`[Discord] Role ${roleId} assigned to user ${discordUserId}`);
}

async function removeDiscordRole(discordUserId, roleId) {
    await discordRequest('DELETE', `/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`);
    console.log(`[Discord] Role ${roleId} removed from user ${discordUserId}`);
}

// -------------------- EMAIL HELPERS --------------------
async function sendEmail(to, subject, html) {
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${RESEND_API_KEY}`
        },
        body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
    });
    const data = await response.json();
    console.log('[Resend Response]', JSON.stringify(data));
    if (!response.ok) throw new Error(`Resend failed: ${JSON.stringify(data)}`);
    return data;
}

function emailTemplate(content) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#060e1f;font-family:Arial,sans-serif;">
<div style="max-width:560px;margin:40px auto;padding:20px;">
    <div style="text-align:center;margin-bottom:32px;">
        <div style="display:inline-block;border-bottom:1px solid #1e3a6e;border-top:1px solid #1e3a6e;padding:12px 32px;">
            <span style="font-size:18px;font-weight:700;color:#fff;letter-spacing:3px;text-transform:uppercase;">HIGH VELOCITY TRADING</span><br>
            <span style="font-size:10px;color:#3a6ea8;letter-spacing:4px;text-transform:uppercase;">Member Services</span>
        </div>
    </div>
    <div style="background:linear-gradient(145deg,#0d1f42,#091526);border:1px solid #1a3060;border-radius:16px;overflow:hidden;">
        <div style="height:3px;background:linear-gradient(90deg,#1a3a8e,#4a9eff,#1a3a8e);"></div>
        <div style="padding:36px 32px;">
            ${content}
        </div>
    </div>
    <div style="text-align:center;margin-top:24px;color:#1e3a5e;font-size:11px;letter-spacing:0.3px;line-height:1.8;">
        © 2026 High Velocity Trading. All rights reserved.<br>
        <a href="https://highvelocitytrading.com" style="color:#2d4a6e;text-decoration:none;">highvelocitytrading.com</a>
    </div>
</div>
</body></html>`;
}

async function sendWelcomeEmail(email, fullName, type) {
    const isMonthly = type === 'monthly';
    const name = fullName ? fullName.split(' ')[0] : 'Trader';
    const subject = isMonthly ? 'Welcome to HVT Monthly Membership!' : 'Welcome to HVT Lifetime Access!';
    const activationLabel = isMonthly ? 'Monthly Membership Activation' : 'Lifetime Access Activation';
    const accentColor = isMonthly ? '#4a9eff' : '#f6ad55';
    const badgeBg = isMonthly ? 'rgba(74,158,255,0.08)' : 'rgba(246,173,85,0.08)';
    const badgeBorder = isMonthly ? 'rgba(74,158,255,0.2)' : 'rgba(246,173,85,0.2)';

    const monthlyNote = isMonthly ? `
        <div style="background:rgba(229,62,62,0.06);border:1px solid rgba(229,62,62,0.15);border-radius:10px;padding:14px 18px;margin-bottom:24px;">
            <p style="color:#fc8181;font-size:13px;line-height:1.6;margin:0;">
                ⚠️ <strong>Please note:</strong> Your Trading Room and indicator access are tied to your active monthly membership. If your payment stops, access will be removed at the end of your current billing period.
            </p>
        </div>
    ` : '';

    const content = `
        <div style="text-align:center;margin-bottom:8px;">
            <div style="display:inline-block;background:${badgeBg};border:1px solid ${badgeBorder};border-radius:20px;padding:6px 18px;margin-bottom:20px;">
                <span style="color:${accentColor};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">${activationLabel}</span>
            </div>
            <h2 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 8px;letter-spacing:1px;">Welcome, ${name}!</h2>
            <p style="color:#6b8db8;font-size:14px;margin:0;">We're grateful to have you with us.</p>
        </div>
        <div style="height:1px;background:linear-gradient(90deg,transparent,#1e3a6e,transparent);margin:28px 0;"></div>
        <p style="color:#8aafd4;font-size:14px;line-height:1.8;margin-bottom:24px;text-align:center;">
            Thank you for your purchase. You now have access to everything High Velocity Trading has to offer. We are here to support you every step of the way.
        </p>
        ${monthlyNote}
        <div style="text-align:center;margin-bottom:28px;">
            <a href="${APP_URL}/trading-room" style="display:inline-block;background:linear-gradient(135deg,#1a3a8e,#2a5aae);color:#fff;text-decoration:none;padding:16px 48px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;box-shadow:0 4px 24px rgba(42,90,174,0.4);">ACTIVATE TRADING ROOM</a>
        </div>
        <div style="height:1px;background:linear-gradient(90deg,transparent,#1e3a6e,transparent);margin-bottom:24px;"></div>
        <div style="background:rgba(74,158,255,0.04);border:1px solid rgba(74,158,255,0.12);border-radius:10px;padding:16px 20px;text-align:center;">
            <p style="color:#4a6a8a;font-size:13px;line-height:1.6;margin:0 0 8px;">Need help getting set up?</p>
            <p style="color:#90b8e8;font-size:15px;font-weight:700;margin:0;letter-spacing:0.5px;">📞 786-461-4235</p>
            <p style="color:#4a6a8a;font-size:12px;margin:4px 0 0;">We are happy to walk you through everything.</p>
        </div>
    `;

    await sendEmail(email, subject, emailTemplate(content));
    console.log(`[Welcome Email] Sent ${type} welcome to ${email}`);
}

async function sendMagicLinkEmail(email, token, type) {
    const url = `${APP_URL}/${type}/confirm?token=${token}`;
    const isBilling = type === 'billing';
    const subject = isBilling ? 'Access Your HVT Billing Portal' : 'Cancel Your HVT Membership';
    const title = isBilling ? 'Billing Portal Access' : 'Membership Cancellation';
    const btnText = isBilling ? 'VIEW MY BILLING' : 'CONFIRM CANCELLATION';
    const btnColor = isBilling ? 'linear-gradient(135deg,#1a3a8e,#2a5aae)' : 'linear-gradient(135deg,#b91c1c,#dc2626)';
    const btnShadow = isBilling ? 'rgba(42,90,174,0.4)' : 'rgba(220,38,38,0.35)';
    const desc = isBilling
        ? 'Click the button below to securely access your billing dashboard. This link expires in <strong style="color:#90b8e8;">1 hour</strong>.'
        : 'We received a request to cancel your <strong style="color:#90b8e8;">HVT Monthly Membership</strong>. Click below to confirm. This link expires in <strong style="color:#90b8e8;">1 hour</strong>.';

    const content = `
        <div style="text-align:center;margin-bottom:24px;">
            <span style="font-size:20px;font-weight:700;color:#fff;letter-spacing:1px;">${title}</span>
        </div>
        <p style="color:#6b8db8;font-size:14px;line-height:1.7;text-align:center;margin-bottom:32px;">${desc}</p>
        <div style="height:1px;background:linear-gradient(90deg,transparent,#1e3a6e,transparent);margin-bottom:32px;"></div>
        <div style="text-align:center;margin-bottom:24px;">
            <a href="${url}" style="display:inline-block;background:${btnColor};color:#fff;text-decoration:none;padding:16px 48px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:2px;box-shadow:0 4px 24px ${btnShadow};">${btnText}</a>
        </div>
        <p style="text-align:center;color:#2d4a6e;font-size:12px;margin-bottom:20px;">Secure link · Expires in 1 hour</p>
        <div style="background:rgba(74,158,255,0.04);border:1px solid rgba(74,158,255,0.12);border-radius:10px;padding:14px 18px;">
            <p style="color:#4a6a8a;font-size:13px;line-height:1.6;margin:0;">🔒 If you did not request this, ignore this email. No changes will be made to your account.</p>
        </div>
    `;

    await sendEmail(email, subject, emailTemplate(content));
}

// -------------------- CANCEL HELPERS --------------------
async function cancelAuthorizeSubscription(subscriptionId) {
    const payload = {
        ARBCancelSubscriptionRequest: {
            merchantAuthentication: {
                name: AUTHNET_API_LOGIN_ID,
                transactionKey: AUTHNET_TRANSACTION_KEY
            },
            subscriptionId: String(subscriptionId)
        }
    };
    const response = await fetch('https://api.authorize.net/xml/v1/request.api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await response.json();
    console.log('[Authnet Cancel Response]', JSON.stringify(data));
    const resultCode = data?.messages?.resultCode;
    if (resultCode !== 'Ok') {
        const msg = data?.messages?.message?.[0]?.text || 'Unknown error';
        throw new Error(`Authnet cancel failed: ${msg}`);
    }
    return data;
}

// -------------------- MEMBERSHIP HELPERS --------------------
function huntMembershipData(rawString) {
    const emailMatch = rawString.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const firstMatch = rawString.match(/\[q3[^\]]*\]=([^\n]+)/) || rawString.match(/"q3[^"]*":"([^"]+)"/);
    const lastMatch = rawString.match(/\[q4[^\]]*\]=([^\n]+)/) || rawString.match(/"q4[^"]*":"([^"]+)"/);

    let phone = null;
    const rawRequestMatch = rawString.match(/\[rawRequest\]=(\{.*\})/s);
    if (rawRequestMatch) {
        try {
            const raw = JSON.parse(rawRequestMatch[1]);
            const phoneField = Object.keys(raw).find(k => k.startsWith('q7'));
            if (phoneField && raw[phoneField]?.full) phone = raw[phoneField].full.trim();
        } catch (e) {
            console.error('[Membership Phone Parse Error]', e.message);
        }
    }

    const first = firstMatch ? firstMatch[1].trim() : "";
    const last = lastMatch ? lastMatch[1].trim() : "";

    return {
        email: emailMatch ? emailMatch[0].toLowerCase().trim() : null,
        full_name: [first, last].filter(Boolean).join(' ') || null,
        phone
    };
}

// -------------------- LICENSE HELPERS --------------------
async function getRowByTxn(transaction_id) {
    const { data, error } = await supabase
        .from(LICENSE_TABLE)
        .select('*')
        .eq('transaction_id', transaction_id)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
}

async function upsertSaleRow(transaction_id, patch) {
    if (!transaction_id) throw new Error('missing_transaction_id');
    const existing = await getRowByTxn(transaction_id);
    const license_key = existing?.license_key || genLicenseKey();
    const payload = {
        transaction_id,
        license_key,
        updated_at: new Date().toISOString(),
        ...patch
    };
    const { data, error } = await supabase
        .from(LICENSE_TABLE)
        .upsert(payload, { onConflict: 'transaction_id' })
        .select()
        .single();
    if (error) throw new Error(error.message);
    return data;
}

// -------------------- PAGE HELPERS --------------------
function pageShell(title, bodyContent) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} – High Velocity Trading</title>
    <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
    <style>
        *{box-sizing:border-box;margin:0;padding:0;}
        body{
            font-family:'Inter',sans-serif;
            background:radial-gradient(ellipse at 50% 0%,#0d2150 0%,#060e1f 55%,#020810 100%);
            min-height:100vh;
            display:flex;
            flex-direction:column;
            align-items:center;
            justify-content:center;
            padding:24px 20px;
            color:#fff;
        }
        .brand{text-align:center;margin-bottom:36px;}
        .brand h1{font-family:'Rajdhani',sans-serif;font-size:24px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:#fff;}
        .brand p{font-family:'Rajdhani',sans-serif;font-size:10px;color:#2d5a8e;letter-spacing:5px;text-transform:uppercase;margin-top:4px;}
        .card{
            width:100%;max-width:460px;
            background:linear-gradient(145deg,#0d1f42 0%,#091526 100%);
            border:1px solid #1a3060;
            border-radius:20px;
            overflow:hidden;
            box-shadow:0 24px 64px rgba(0,0,0,0.6),inset 0 1px 0 rgba(255,255,255,0.04);
        }
        .card-top{height:3px;background:linear-gradient(90deg,#1a3a8e,#4a9eff,#1a3a8e);}
        .card-body{padding:36px 32px;}
        .card-title{font-family:'Rajdhani',sans-serif;font-size:22px;font-weight:700;letter-spacing:1px;color:#fff;margin-bottom:8px;}
        .card-sub{color:#4a6a8a;font-size:13px;line-height:1.6;margin-bottom:28px;}
        .divider{height:1px;background:linear-gradient(90deg,transparent,#1a3060,transparent);margin-bottom:28px;}
        label{display:block;font-family:'Rajdhani',sans-serif;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#3a6a9a;margin-bottom:8px;}
        input[type=email],input[type=text]{
            width:100%;padding:13px 16px;
            background:rgba(255,255,255,0.03);
            border:1px solid #1a3060;
            border-radius:10px;
            color:#fff;font-size:15px;
            outline:none;
            transition:border-color 0.2s,box-shadow 0.2s;
            margin-bottom:20px;
            font-family:'Inter',sans-serif;
        }
        input[type=email]:focus,input[type=text]:focus{border-color:#2a5aae;box-shadow:0 0 0 3px rgba(42,90,174,0.15);}
        input[type=email]::placeholder,input[type=text]::placeholder{color:#1e3a5e;}
        .btn{
            width:100%;padding:13px;
            background:linear-gradient(135deg,#1a3a8e,#2a5aae);
            color:#fff;border:none;border-radius:10px;
            font-family:'Rajdhani',sans-serif;font-size:15px;font-weight:700;letter-spacing:2px;text-transform:uppercase;
            cursor:pointer;
            box-shadow:0 4px 20px rgba(42,90,174,0.3);
            transition:opacity 0.2s,transform 0.1s;
        }
        .btn:hover{opacity:0.9;transform:translateY(-1px);}
        .btn:active{transform:translateY(0);}
        .btn:disabled{opacity:0.4;cursor:not-allowed;transform:none;}
        .msg{margin-top:16px;padding:12px 16px;border-radius:10px;font-size:13px;text-align:center;display:none;line-height:1.5;}
        .msg.show{display:block;}
        .msg.success{background:rgba(56,161,105,0.08);color:#68d391;border:1px solid rgba(56,161,105,0.2);}
        .msg.error{background:rgba(229,62,62,0.08);color:#fc8181;border:1px solid rgba(229,62,62,0.2);}
        .footer-link{text-align:center;margin-top:20px;font-size:12px;color:#1e3a5e;}
        .footer-link a{color:#2d5a8e;text-decoration:none;}
        .footer-link a:hover{color:#4a9eff;}
    </style>
</head>
<body>
    <div class="brand">
        <h1>High Velocity Trading</h1>
        <p>Member Portal</p>
    </div>
    ${bodyContent}
    <div class="footer-link" style="margin-top:20px;">
        <a href="https://highvelocitytrading.com">← highvelocitytrading.com</a>
    </div>
</body>
</html>`;
}

function resultPage(type, title, message) {
    const t = {
        success: { icon: '✓', color: '#68d391', bg: 'rgba(56,161,105,0.08)', border: 'rgba(56,161,105,0.2)' },
        error:   { icon: '✕', color: '#fc8181', bg: 'rgba(229,62,62,0.08)',   border: 'rgba(229,62,62,0.2)' },
        info:    { icon: 'ℹ', color: '#90cdf4', bg: 'rgba(74,158,255,0.08)',  border: 'rgba(74,158,255,0.2)' }
    }[type] || { icon: '✕', color: '#fc8181', bg: 'rgba(229,62,62,0.08)', border: 'rgba(229,62,62,0.2)' };

    return pageShell(title, `
        <div class="card" style="max-width:460px;width:100%;">
            <div class="card-top"></div>
            <div class="card-body" style="text-align:center;">
                <div style="width:56px;height:56px;border-radius:50%;background:${t.bg};border:1px solid ${t.border};display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:22px;color:${t.color};">${t.icon}</div>
                <div class="card-title" style="margin-bottom:16px;">${title}</div>
                <div style="background:${t.bg};border:1px solid ${t.border};border-radius:10px;padding:16px;color:${t.color};font-size:14px;line-height:1.6;">${message}</div>
            </div>
        </div>
    `);
}

// ==================== ROUTES ====================

app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'hvt-unified-backend', membershipTable: MEMBERSHIP_TABLE, licenseTable: LICENSE_TABLE });
});

// ==================== MEMBERSHIP WEBHOOKS ====================

app.post('/webhooks/membership-jotform', (req, res) => {
    const bb = Busboy({ headers: req.headers });
    let rawConcat = '';

    bb.on('field', (name, val) => {
        console.log(`[Membership FIELD]: [${name}] = ${val}`);
        rawConcat += `\n[${name}]=${val}`;
    });

    bb.on('finish', async () => {
        try {
            console.log('[Membership RAW DUMP]:', rawConcat);
            const extracted = huntMembershipData(rawConcat);
            console.log('[Membership Extracted]', extracted);

            if (!extracted.email) {
                console.error('❌ No email found in Membership Jotform bundle');
                return res.status(400).send('No email found');
            }

            const payload = {
                email: extracted.email,
                full_name: extracted.full_name,
                phone: extracted.phone,
                plan_name: 'membership',
                status: 'active',
                source: 'jotform',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            };

            const { error } = await supabase.from(MEMBERSHIP_TABLE).upsert(payload, { onConflict: 'email' });
            if (error) { console.error('[Membership Supabase Error]', error); throw error; }

            // Send monthly welcome email
            try {
                await sendWelcomeEmail(extracted.email, extracted.full_name, 'monthly');
            } catch (emailErr) {
                console.error('[Monthly Welcome Email Error]', emailErr.message);
            }

            console.log(`✅ Membership Success: ${extracted.full_name} (${extracted.email})`);
            res.status(200).send('OK');
        } catch (err) {
            console.error('[Membership Jotform Error]', err.message);
            res.status(500).send('Server Error');
        }
    });

    req.pipe(bb);
});

app.post('/webhooks/membership-authnet', express.json(), async (req, res) => {
    try {
        const body = req.body;
        const eventType = body.eventType || '';
        const email = (body.payload?.customerDetails?.email || "").toLowerCase().trim();
        const subscriptionId = pickFirst(body.payload?.id);

        console.log(`[Membership Authnet] Event: ${eventType} | Email: ${email} | SubID: ${subscriptionId}`);

        if (eventType === 'net.authorize.customer.subscription.created' ||
            eventType === 'net.authorize.payment.capture.created') {

            if (!email) return res.status(400).send('No email');

            const upsertPayload = {
                email,
                plan_name: 'membership',
                status: 'active',
                source: 'authnet',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            };

            if (subscriptionId) upsertPayload.authnet_subscription_id = subscriptionId;

            const { error } = await supabase.from(MEMBERSHIP_TABLE).upsert(upsertPayload, { onConflict: 'email' });
            if (error) throw error;

            console.log(`✅ Membership Activated: ${email} | SubID: ${subscriptionId}`);
        } else if (
            eventType === 'net.authorize.customer.subscription.cancelled' ||
            eventType === 'net.authorize.customer.subscription.expired' ||
            eventType === 'net.authorize.customer.subscription.suspended' ||
            eventType === 'net.authorize.customer.subscription.terminated' ||
            eventType === 'net.authorize.customer.subscription.failed'
        ) {
            const updateData = { status: 'cancelled', updated_at: new Date().toISOString() };
            const query = subscriptionId
                ? supabase.from(MEMBERSHIP_TABLE).update(updateData).eq('authnet_subscription_id', subscriptionId)
                : email ? supabase.from(MEMBERSHIP_TABLE).update(updateData).eq('email', email) : null;

            if (query) {
                const { error } = await query;
                if (error) throw error;

                // Remove Discord role on cancellation
                try {
                    const { data: member } = await supabase
                        .from(MEMBERSHIP_TABLE)
                        .select('discord_user_id')
                        .eq(subscriptionId ? 'authnet_subscription_id' : 'email', subscriptionId || email)
                        .maybeSingle();

                    if (member?.discord_user_id) {
                        await removeDiscordRole(member.discord_user_id, DISCORD_MONTHLY_ROLE_ID);
                        console.log(`[Discord] Monthly role removed on cancellation`);
                    }
                } catch (discordErr) {
                    console.error('[Discord Remove Role Error]', discordErr.message);
                }

                console.log(`🚫 Membership Cancelled: ${email || subscriptionId}`);
            }
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('[Membership Authnet Error]', err.message);
        res.status(500).send('Internal Error');
    }
});

app.get('/check-access', async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });

    const { data, error } = await supabase
        .from(MEMBERSHIP_TABLE)
        .select('status, expires_at')
        .eq('email', email)
        .maybeSingle();

    if (error) console.error('[Check-Access Error]', error);
    const active = data?.status === 'active' && new Date(data.expires_at) > new Date();
    res.json({ active });
});

// ==================== TRADING ROOM ====================

app.get('/trading-room', (req, res) => {
    res.send(pageShell('Join Trading Room', `
        <div class="card">
            <div class="card-top" style="background:linear-gradient(90deg,#1a3a8e,#4a9eff,#1a3a8e);"></div>
            <div class="card-body">
                <div style="text-align:center;margin-bottom:24px;">
                    <div style="display:inline-block;background:rgba(74,158,255,0.08);border:1px solid rgba(74,158,255,0.2);border-radius:20px;padding:6px 18px;margin-bottom:16px;">
                        <span style="color:#4a9eff;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Discord Access Activation</span>
                    </div>
                    <div class="card-title" style="margin-bottom:8px;">Join the Trading Room</div>
                    <div class="card-sub" style="margin-bottom:0;">Enter your purchase email and Discord username to activate your Trading Room access instantly.</div>
                </div>
                <div class="divider"></div>
                <label for="email">Purchase Email</label>
                <input type="email" id="email" placeholder="your@email.com" />
                <label for="discord">Discord Username</label>
                <input type="text" id="discord" placeholder="yourUsername" />
                <div style="background:rgba(74,158,255,0.07);border:1px solid rgba(74,158,255,0.25);border-radius:10px;padding:16px 18px;margin-bottom:20px;">
                    <p style="color:#4a6a8a;font-size:12px;margin:0 0 10px;">You must already be a member of the <strong style="color:#90b8e8;">High Velocity Trading</strong> Discord server before activating.</p>
                    <div style="height:1px;background:rgba(74,158,255,0.15);margin-bottom:10px;"></div>
                    <p style="color:#c8dcf5;font-size:14px;font-weight:600;margin:0;line-height:1.6;">
                        📌 <strong style="color:#fff;">Not in the server yet?</strong> Visit <strong style="color:#4a9eff;">highvelocitytrading.com</strong> and click the <strong style="color:#fff;">Join Discord</strong> button in the top right corner of the website. Join first, then come back here to activate.
                    </p>
                </div>
                <button class="btn" id="btn" onclick="activate()">Activate Trading Room Access</button>
                <div class="msg" id="msg"></div>
            </div>
        </div>
        <script>
            async function activate() {
                const email = document.getElementById('email').value.trim();
                const discord = document.getElementById('discord').value.trim();
                const msg = document.getElementById('msg');
                const btn = document.getElementById('btn');
                msg.className = 'msg'; msg.textContent = '';
                if (!email) { msg.className='msg error show'; msg.textContent='Please enter your email.'; return; }
                if (!discord) { msg.className='msg error show'; msg.textContent='Please enter your Discord username.'; return; }
                btn.disabled = true; btn.textContent = 'Activating...';
                try {
                    const res = await fetch('/trading-room/activate', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify({ email, discord_username: discord })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        msg.className = 'msg success show';
                        msg.textContent = '✓ Access granted! Check Discord — your Trading Room role has been assigned.';
                        btn.textContent = 'Access Granted ✓';
                    } else {
                        msg.className = 'msg error show';
                        msg.textContent = data.error || 'Something went wrong.';
                        btn.disabled = false; btn.textContent = 'Activate Trading Room Access';
                    }
                } catch(e) {
                    msg.className = 'msg error show';
                    msg.textContent = 'Network error. Please try again.';
                    btn.disabled = false; btn.textContent = 'Activate Trading Room Access';
                }
            }
            document.addEventListener('DOMContentLoaded', () => {
                document.getElementById('discord').addEventListener('keypress', e => { if (e.key==='Enter') activate(); });
            });
        </script>
    `));
});

app.post('/trading-room/activate', express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        const discordUsername = (req.body.discord_username || '').trim();

        if (!email) return res.status(400).json({ error: 'Email is required' });
        if (!discordUsername) return res.status(400).json({ error: 'Discord username is required' });

        // Check membership table
        const { data: member, error: memberError } = await supabase
            .from(MEMBERSHIP_TABLE)
            .select('email, status, expires_at')
            .eq('email', email)
            .maybeSingle();

        // Check lifetime license table
        const { data: license } = await supabase
            .from(LICENSE_TABLE)
            .select('email, status')
            .eq('email', email)
            .maybeSingle();

        if (memberError) throw memberError;

        const isMemberActive = member?.status === 'active' && new Date(member.expires_at) > new Date();
        const isLifetimeActive = license?.status === 'active';

        if (!isMemberActive && !isLifetimeActive) {
            return res.status(403).json({ error: 'No active membership found for this email. Please check your email or contact support at 786-461-4235.' });
        }

        // Find Discord user in server
        const discordMember = await findDiscordUserByUsername(discordUsername);
        if (!discordMember) {
            return res.status(404).json({ error: `Discord user "${discordUsername}" not found in the High Velocity Trading server. Make sure you have joined the server first.` });
        }

        const discordUserId = discordMember.user.id;
        const roleId = isLifetimeActive ? DISCORD_LIFETIME_ROLE_ID : DISCORD_MONTHLY_ROLE_ID;

        // Assign the role
        await assignDiscordRole(discordUserId, roleId);

        // Save discord_user_id for future role removal
        if (isMemberActive) {
            await supabase.from(MEMBERSHIP_TABLE)
                .update({ discord_user_id: discordUserId, updated_at: new Date().toISOString() })
                .eq('email', email);
        }

        const roleType = isLifetimeActive ? 'Lifetime' : 'Monthly';
        console.log(`✅ Discord ${roleType} role assigned to ${discordUsername} (${discordUserId}) for ${email}`);

        res.json({ ok: true, role: roleType });
    } catch (err) {
        console.error('[Trading Room Activate Error]', err.message);
        res.status(500).json({ error: 'Server error. Please try again or call us at 786-461-4235.' });
    }
});

// ==================== BILLING PORTAL ====================

app.get('/billing', (req, res) => {
    res.send(pageShell('Billing Portal', `
        <div class="card">
            <div class="card-top"></div>
            <div class="card-body">
                <div class="card-title">Billing Portal</div>
                <div class="card-sub">Enter your email address and we'll send you a secure link to access your billing dashboard.</div>
                <div class="divider"></div>
                <label for="email">Email Address</label>
                <input type="email" id="email" placeholder="your@email.com" />
                <button class="btn" id="btn" onclick="submit()">Send Access Link</button>
                <div class="msg" id="msg"></div>
            </div>
        </div>
        <script>
            async function submit() {
                const email = document.getElementById('email').value.trim();
                const msg = document.getElementById('msg');
                const btn = document.getElementById('btn');
                msg.className = 'msg'; msg.textContent = '';
                if (!email) { msg.className='msg error show'; msg.textContent='Please enter your email.'; return; }
                btn.disabled = true; btn.textContent = 'Sending...';
                try {
                    const res = await fetch('/billing/request', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify({ email })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        msg.className = 'msg success show';
                        msg.textContent = '✓ Check your email! A secure access link has been sent.';
                        btn.textContent = 'Email Sent';
                    } else {
                        msg.className = 'msg error show';
                        msg.textContent = data.error || 'Something went wrong.';
                        btn.disabled = false; btn.textContent = 'Send Access Link';
                    }
                } catch(e) {
                    msg.className = 'msg error show';
                    msg.textContent = 'Network error. Please try again.';
                    btn.disabled = false; btn.textContent = 'Send Access Link';
                }
            }
            document.addEventListener('DOMContentLoaded', () => {
                document.getElementById('email').addEventListener('keypress', e => { if (e.key==='Enter') submit(); });
            });
        </script>
    `));
});

app.post('/billing/request', express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const { data, error } = await supabase
            .from(MEMBERSHIP_TABLE)
            .select('email, status')
            .eq('email', email)
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'No membership found for this email' });

        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        const { error: updateError } = await supabase
            .from(MEMBERSHIP_TABLE)
            .update({ billing_token: token, billing_token_expires: expires, updated_at: new Date().toISOString() })
            .eq('email', email);

        if (updateError) throw updateError;

        await sendMagicLinkEmail(email, token, 'billing');

        console.log(`[Billing] Magic link sent to ${email}`);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Billing Request Error]', err.message);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

app.get('/billing/confirm', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.send(resultPage('error', 'Invalid Link', 'This billing link is invalid.'));

    try {
        const { data, error } = await supabase
            .from(MEMBERSHIP_TABLE)
            .select('email, full_name, status, plan_name, expires_at, billing_token_expires')
            .eq('billing_token', token)
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid or has already been used.'));
        if (new Date(data.billing_token_expires) < new Date()) {
            return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/billing" style="color:#fc8181;">Request a new one</a>.'));
        }

        const name = data.full_name || 'Member';
        const status = data.status || 'unknown';
        const expiresAt = data.expires_at ? new Date(data.expires_at) : null;
        const email = data.email;
        const statusColor = status === 'active' ? '#68d391' : '#fc8181';
        const statusBg = status === 'active' ? 'rgba(56,161,105,0.08)' : 'rgba(229,62,62,0.08)';
        const statusBorder = status === 'active' ? 'rgba(56,161,105,0.2)' : 'rgba(229,62,62,0.2)';
        const statusLabel = status === 'active' ? '● Active' : status.charAt(0).toUpperCase() + status.slice(1);
        const nextBilling = expiresAt ? expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A';
        const daysLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24))) : 0;

        const cancelSection = status === 'active' ? `
            <div style="margin-top:24px;padding-top:24px;border-top:1px solid #1a3060;">
                <p style="color:#2d4a6e;font-size:12px;text-align:center;margin-bottom:16px;">Want to cancel your membership?</p>
                <a href="/cancel" style="display:block;width:100%;padding:12px;background:transparent;border:1px solid rgba(229,62,62,0.3);color:#fc8181;border-radius:10px;font-family:'Rajdhani',sans-serif;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;text-align:center;text-decoration:none;"
                   onmouseover="this.style.background='rgba(229,62,62,0.08)'" onmouseout="this.style.background='transparent'">
                    Cancel Membership
                </a>
            </div>
        ` : `
            <div style="margin-top:24px;padding-top:24px;border-top:1px solid #1a3060;text-align:center;">
                <p style="color:#4a6a8a;font-size:13px;">Your membership is no longer active.</p>
            </div>
        `;

        res.send(pageShell('My Billing', `
            <div class="card" style="max-width:480px;width:100%;">
                <div class="card-top"></div>
                <div class="card-body">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
                        <div>
                            <div style="font-family:'Rajdhani',sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#2d5a8e;margin-bottom:4px;">Welcome back</div>
                            <div style="font-family:'Rajdhani',sans-serif;font-size:22px;font-weight:700;color:#fff;letter-spacing:1px;">${name}</div>
                        </div>
                        <div style="background:${statusBg};border:1px solid ${statusBorder};border-radius:20px;padding:6px 14px;font-size:12px;color:${statusColor};font-family:'Rajdhani',sans-serif;letter-spacing:1px;font-weight:600;">${statusLabel}</div>
                    </div>
                    <div class="divider"></div>
                    <div style="font-family:'Rajdhani',sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#2d5a8e;margin-bottom:16px;">Membership Details</div>
                    <div style="background:rgba(255,255,255,0.02);border:1px solid #1a3060;border-radius:12px;overflow:hidden;margin-bottom:16px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #1a3060;">
                            <span style="color:#4a6a8a;font-size:13px;">Plan</span>
                            <span style="color:#90b8e8;font-size:13px;font-weight:500;">HVT Monthly Membership</span>
                        </div>
                        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #1a3060;">
                            <span style="color:#4a6a8a;font-size:13px;">Email</span>
                            <span style="color:#90b8e8;font-size:13px;font-weight:500;">${email}</span>
                        </div>
                        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #1a3060;">
                            <span style="color:#4a6a8a;font-size:13px;">${status === 'active' ? 'Next Billing Date' : 'Expired'}</span>
                            <span style="color:#90b8e8;font-size:13px;font-weight:500;">${nextBilling}</span>
                        </div>
                        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;">
                            <span style="color:#4a6a8a;font-size:13px;">Days Remaining</span>
                            <span style="color:${daysLeft > 7 ? '#68d391' : '#f6ad55'};font-size:13px;font-weight:600;">${daysLeft} days</span>
                        </div>
                    </div>
                    ${cancelSection}
                </div>
            </div>
        `));

    } catch (err) {
        console.error('[Billing Confirm Error]', err.message);
        return res.send(resultPage('error', 'Error', 'Something went wrong. Please try again.'));
    }
});

// ==================== CANCEL SYSTEM ====================

app.get('/cancel', (req, res) => {
    res.send(pageShell('Cancel Membership', `
        <div class="card">
            <div class="card-top" style="background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d);"></div>
            <div class="card-body">
                <div class="card-title">Cancel Membership</div>
                <div class="card-sub">Enter your email address and we'll send you a secure one-time link to cancel your membership.</div>
                <div class="divider"></div>
                <label for="email">Email Address</label>
                <input type="email" id="email" placeholder="your@email.com" />
                <button class="btn" id="btn" style="background:linear-gradient(135deg,#991b1b,#dc2626);box-shadow:0 4px 20px rgba(220,38,38,0.3);" onclick="submit()">Send Cancellation Link</button>
                <div class="msg" id="msg"></div>
            </div>
        </div>
        <script>
            async function submit() {
                const email = document.getElementById('email').value.trim();
                const msg = document.getElementById('msg');
                const btn = document.getElementById('btn');
                msg.className = 'msg'; msg.textContent = '';
                if (!email) { msg.className='msg error show'; msg.textContent='Please enter your email.'; return; }
                btn.disabled = true; btn.textContent = 'Sending...';
                try {
                    const res = await fetch('/cancel/request', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify({ email })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        msg.className = 'msg success show';
                        msg.textContent = '✓ Check your email! A secure cancellation link has been sent.';
                        btn.textContent = 'Email Sent';
                    } else {
                        msg.className = 'msg error show';
                        msg.textContent = data.error || 'Something went wrong.';
                        btn.disabled = false; btn.textContent = 'Send Cancellation Link';
                    }
                } catch(e) {
                    msg.className = 'msg error show';
                    msg.textContent = 'Network error. Please try again.';
                    btn.disabled = false; btn.textContent = 'Send Cancellation Link';
                }
            }
            document.addEventListener('DOMContentLoaded', () => {
                document.getElementById('email').addEventListener('keypress', e => { if (e.key==='Enter') submit(); });
            });
        </script>
    `));
});

app.post('/cancel/request', express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const { data, error } = await supabase
            .from(MEMBERSHIP_TABLE)
            .select('email, full_name, status, authnet_subscription_id')
            .eq('email', email)
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'No membership found for this email' });
        if (data.status === 'cancelled') return res.status(400).json({ error: 'This membership is already cancelled' });

        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        const { error: updateError } = await supabase
            .from(MEMBERSHIP_TABLE)
            .update({ cancel_token: token, cancel_token_expires: expires, updated_at: new Date().toISOString() })
            .eq('email', email);

        if (updateError) throw updateError;

        await sendMagicLinkEmail(email, token, 'cancel');

        console.log(`[Cancel Request] Magic link sent to ${email}`);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Cancel Request Error]', err.message);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

app.get('/cancel/confirm', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.send(resultPage('error', 'Invalid Link', 'This cancellation link is invalid.'));

    try {
        const { data, error } = await supabase
            .from(MEMBERSHIP_TABLE)
            .select('email, full_name, status, authnet_subscription_id, cancel_token_expires, discord_user_id')
            .eq('cancel_token', token)
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid or has already been used.'));
        if (new Date(data.cancel_token_expires) < new Date()) {
            return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/cancel" style="color:#fc8181;">Request a new one</a>.'));
        }
        if (data.status === 'cancelled') {
            return res.send(resultPage('info', 'Already Cancelled', 'Your membership is already cancelled.'));
        }

        if (data.authnet_subscription_id) {
            try {
                await cancelAuthorizeSubscription(data.authnet_subscription_id);
                console.log(`[Cancel] Authnet subscription ${data.authnet_subscription_id} cancelled`);
            } catch (authErr) {
                console.error('[Cancel] Authnet error:', authErr.message);
            }
        }

        // Remove Discord role on cancel
        if (data.discord_user_id) {
            try {
                await removeDiscordRole(data.discord_user_id, DISCORD_MONTHLY_ROLE_ID);
                console.log(`[Discord] Role removed on cancel for ${data.email}`);
            } catch (discordErr) {
                console.error('[Discord Remove Error]', discordErr.message);
            }
        }

        const { error: updateError } = await supabase
            .from(MEMBERSHIP_TABLE)
            .update({ status: 'cancelled', cancel_token: null, cancel_token_expires: null, updated_at: new Date().toISOString() })
            .eq('cancel_token', token);

        if (updateError) throw updateError;

        console.log(`🚫 Membership cancelled: ${data.email}`);
        return res.send(resultPage('success', 'Membership Cancelled', 'Your membership has been successfully cancelled.<br><br>You will retain access until the end of your current billing period.'));

    } catch (err) {
        console.error('[Cancel Confirm Error]', err.message);
        return res.send(resultPage('error', 'Error', 'Something went wrong. Please contact support.'));
    }
});

// ==================== LIFETIME LICENSE ROUTES ====================

app.post('/webhooks/authorize-net', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    try {
        const rawBody = req.body ? req.body.toString('utf8') : '';
        const sigHeader = req.headers['x-anet-signature'];

        const sigCheck = verifyAuthorizeSignature(rawBody, sigHeader);
        if (!sigCheck.ok) return res.status(401).json({ ok: false, error: 'invalid_signature', reason: sigCheck.reason });

        let body = {};
        try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; }

        const transaction_id = pickFirst(body?.payload?.id);
        const eventType = pickFirst(body?.eventType) || 'authorize_net';

        if (!transaction_id) return res.status(400).json({ ok: false, error: 'missing_transaction_id_from_authorize' });

        const row = await upsertSaleRow(transaction_id, {
            authorize_received: true,
            last_source: 'authorize',
            authorize_event_type: eventType,
            raw_authorize: rawBody,
            authorize_body_json: body,
            status: 'pending_jotform'
        });

        if (row.email && row.full_name) {
            const activated = await upsertSaleRow(transaction_id, {
                authorize_received: true,
                last_source: 'authorize',
                authorize_event_type: eventType,
                raw_authorize: rawBody,
                authorize_body_json: body,
                status: 'active'
            });
            console.log(`✅ License Authorize activated: ${activated.email} (${transaction_id})`);
            return res.status(200).json({ ok: true, transaction_id, status: activated.status });
        }

        return res.status(200).json({ ok: true, transaction_id, status: row.status, eventType });
    } catch (err) {
        console.error('[License authorize webhook error]', err);
        return res.status(500).json({ ok: false, error: 'server_error', details: err.message });
    }
});

app.post('/webhooks/jotform', (req, res) => {
    const bb = Busboy({ headers: req.headers, limits: { fieldSize: 5 * 1024 * 1024 } });
    const fields = {};
    let rawConcat = '';

    bb.on('field', (name, val) => {
        console.log(`[License FIELD]: [${name}] = ${val}`);
        fields[name] = val;
        rawConcat += `\n[${name}]=${val}`;
    });

    bb.on('error', (err) => {
        console.error('[License busboy error]', err);
        return res.status(400).json({ ok: false, error: 'invalid_multipart' });
    });

    bb.on('finish', async () => {
        try {
            let rawRequest = null;
            try { rawRequest = fields.rawRequest ? JSON.parse(fields.rawRequest) : null; } catch { rawRequest = null; }

            const rr = rawRequest || {};
            const first = pickFirst(rr?.q8_q8_fullname6?.first);
            const last = pickFirst(rr?.q8_q8_fullname6?.last);
            const email = pickFirst(rr?.q11_email);
            const transaction_id = pickFirst(rr?.transactionId);
            const full_name = [first, last].filter(Boolean).join(' ') || null;

            let phone = null;
            const phoneField = Object.keys(rr).find(k => k.startsWith('q12'));
            if (phoneField && rr[phoneField]?.full) phone = rr[phoneField].full.trim();

            if (!transaction_id) return res.status(400).json({ ok: false, error: 'missing_transaction_id_from_jotform' });

            const row = await upsertSaleRow(transaction_id, {
                jotform_received: true,
                last_source: 'jotform',
                email: email || null,
                full_name: full_name || null,
                phone: phone || null,
                raw_jotform: rawConcat,
                jotform_body_json: rr,
                status: 'pending_authorize'
            });

            if (row.authorize_received) {
                const activated = await upsertSaleRow(transaction_id, {
                    jotform_received: true,
                    last_source: 'jotform',
                    email: email || row.email || null,
                    full_name: full_name || row.full_name || null,
                    phone: phone || row.phone || null,
                    raw_jotform: rawConcat,
                    jotform_body_json: rr,
                    status: 'active'
                });

                // Send lifetime welcome email
                try {
                    await sendWelcomeEmail(activated.email, activated.full_name, 'lifetime');
                } catch (emailErr) {
                    console.error('[Lifetime Welcome Email Error]', emailErr.message);
                }

                console.log(`✅ License activated: ${activated.email} | Key: ${activated.license_key}`);
                return res.status(200).json({ ok: true, transaction_id, license_key: activated.license_key, status: activated.status });
            }

            return res.status(200).json({ ok: true, transaction_id, license_key: row.license_key, status: row.status });
        } catch (err) {
            console.error('[License jotform webhook error]', err);
            return res.status(500).json({ ok: false, error: 'server_error', details: err.message });
        }
    });

    req.pipe(bb);
});

// -------------------- 404 --------------------
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

app.listen(PORT, () => console.log(`🚀 HVT Unified Backend live on ${PORT} | Membership: ${MEMBERSHIP_TABLE} | License: ${LICENSE_TABLE}`));
