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

async function sendMagicLinkEmail(email, token) {
    const cancelUrl = `${APP_URL}/cancel/confirm?token=${token}`;

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${RESEND_API_KEY}`
        },
        body: JSON.stringify({
            from: FROM_EMAIL,
            to: email,
            subject: 'Cancel Your HVT Membership',
            html: `
                <!DOCTYPE html>
                <html>
                <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
                <body style="margin:0;padding:0;background:#0a1628;font-family:Arial,sans-serif;">
                    <div style="max-width:560px;margin:40px auto;padding:20px;">
                        <div style="background:linear-gradient(135deg,#0d2150 0%,#0a1628 100%);border:1px solid #1e3a6e;border-radius:16px;padding:40px;text-align:center;">
                            <h1 style="color:#ffffff;font-size:24px;margin:0 0 8px;">High Velocity Trading</h1>
                            <p style="color:#4a9eff;font-size:13px;letter-spacing:2px;text-transform:uppercase;margin:0 0 32px;">Membership Cancellation</p>
                            <div style="background:rgba(255,255,255,0.05);border:1px solid #1e3a6e;border-radius:12px;padding:24px;margin-bottom:32px;">
                                <p style="color:#cbd5e0;font-size:15px;line-height:1.6;margin:0;">We received a request to cancel your membership. Click the button below to confirm. This link expires in <strong style="color:#fff;">1 hour</strong>.</p>
                            </div>
                            <a href="${cancelUrl}" style="display:inline-block;background:linear-gradient(135deg,#c53030,#e53e3e);color:#fff;padding:14px 36px;text-decoration:none;border-radius:8px;font-size:16px;font-weight:bold;letter-spacing:0.5px;">Confirm Cancellation</a>
                            <p style="color:#4a5568;font-size:13px;margin:24px 0 0;">If you did not request this, ignore this email. Your membership remains active.</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(`Resend failed: ${JSON.stringify(data)}`);
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
            if (phoneField && raw[phoneField]?.full) {
                phone = raw[phoneField].full.trim();
            }
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

// ==================== ROUTES ====================

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'hvt-unified-backend',
        membershipTable: MEMBERSHIP_TABLE,
        licenseTable: LICENSE_TABLE
    });
});

// ==================== MEMBERSHIP ROUTES ====================

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

            console.log('[Membership Upserting]', payload);

            const { error } = await supabase
                .from(MEMBERSHIP_TABLE)
                .upsert(payload, { onConflict: 'email' });

            if (error) {
                console.error('[Membership Supabase Error]', error);
                throw error;
            }

            console.log(`✅ Membership Success: ${extracted.full_name} (${extracted.email}) Phone: ${extracted.phone}`);
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

            if (!email) {
                console.error('[Membership Authnet] No email found');
                return res.status(400).send('No email');
            }

            const upsertPayload = {
                email,
                plan_name: 'membership',
                status: 'active',
                source: 'authnet',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            };

            if (subscriptionId) upsertPayload.authnet_subscription_id = subscriptionId;

            const { error } = await supabase
                .from(MEMBERSHIP_TABLE)
                .upsert(upsertPayload, { onConflict: 'email' });

            if (error) {
                console.error('[Membership Authnet Supabase Error]', error);
                throw error;
            }

            console.log(`✅ Membership Activated: ${email} | SubID: ${subscriptionId}`);
        }

        else if (
            eventType === 'net.authorize.customer.subscription.cancelled' ||
            eventType === 'net.authorize.customer.subscription.expired' ||
            eventType === 'net.authorize.customer.subscription.suspended' ||
            eventType === 'net.authorize.customer.subscription.terminated' ||
            eventType === 'net.authorize.customer.subscription.failed'
        ) {
            let updateQuery;
            if (subscriptionId) {
                updateQuery = supabase
                    .from(MEMBERSHIP_TABLE)
                    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
                    .eq('authnet_subscription_id', subscriptionId);
            } else if (email) {
                updateQuery = supabase
                    .from(MEMBERSHIP_TABLE)
                    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
                    .eq('email', email);
            }

            if (updateQuery) {
                const { error } = await updateQuery;
                if (error) {
                    console.error('[Membership Authnet Cancel Error]', error);
                    throw error;
                }
                console.log(`🚫 Membership Cancelled: ${email || subscriptionId} | Event: ${eventType}`);
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

// ==================== CANCEL SYSTEM ====================

app.get('/cancel', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Cancel Membership – High Velocity Trading</title>
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body {
                    font-family: 'Arial', sans-serif;
                    background: radial-gradient(ellipse at top, #0d2150 0%, #060e1f 60%, #020810 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .container {
                    width: 100%;
                    max-width: 460px;
                }
                .logo {
                    text-align: center;
                    margin-bottom: 32px;
                }
                .logo h1 {
                    color: #ffffff;
                    font-size: 26px;
                    font-weight: 700;
                    letter-spacing: 1px;
                }
                .logo span {
                    color: #4a9eff;
                    font-size: 12px;
                    letter-spacing: 3px;
                    text-transform: uppercase;
                    display: block;
                    margin-top: 4px;
                }
                .card {
                    background: linear-gradient(145deg, #0d1f42 0%, #0a1628 100%);
                    border: 1px solid #1e3a6e;
                    border-radius: 20px;
                    padding: 40px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05);
                }
                .card-title {
                    color: #ffffff;
                    font-size: 20px;
                    font-weight: 600;
                    margin-bottom: 8px;
                }
                .card-subtitle {
                    color: #6b8db8;
                    font-size: 14px;
                    line-height: 1.6;
                    margin-bottom: 32px;
                }
                .divider {
                    height: 1px;
                    background: linear-gradient(90deg, transparent, #1e3a6e, transparent);
                    margin-bottom: 32px;
                }
                label {
                    display: block;
                    color: #8aafd4;
                    font-size: 13px;
                    font-weight: 600;
                    letter-spacing: 1px;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                }
                input[type="email"] {
                    width: 100%;
                    padding: 14px 16px;
                    background: rgba(255,255,255,0.04);
                    border: 1px solid #1e3a6e;
                    border-radius: 10px;
                    color: #ffffff;
                    font-size: 15px;
                    outline: none;
                    transition: border-color 0.2s, box-shadow 0.2s;
                    margin-bottom: 20px;
                }
                input[type="email"]:focus {
                    border-color: #4a9eff;
                    box-shadow: 0 0 0 3px rgba(74,158,255,0.1);
                }
                input[type="email"]::placeholder { color: #2d4a6e; }
                button {
                    width: 100%;
                    padding: 14px;
                    background: linear-gradient(135deg, #c53030 0%, #e53e3e 100%);
                    color: #ffffff;
                    border: none;
                    border-radius: 10px;
                    font-size: 15px;
                    font-weight: 600;
                    cursor: pointer;
                    letter-spacing: 0.5px;
                    transition: opacity 0.2s, transform 0.1s;
                    box-shadow: 0 4px 20px rgba(229,62,62,0.3);
                }
                button:hover { opacity: 0.9; transform: translateY(-1px); }
                button:active { transform: translateY(0); }
                button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
                .msg {
                    margin-top: 20px;
                    padding: 14px 16px;
                    border-radius: 10px;
                    font-size: 14px;
                    text-align: center;
                    display: none;
                    line-height: 1.5;
                }
                .msg.show { display: block; }
                .msg.success { background: rgba(56,161,105,0.1); color: #68d391; border: 1px solid rgba(56,161,105,0.2); }
                .msg.error { background: rgba(229,62,62,0.1); color: #fc8181; border: 1px solid rgba(229,62,62,0.2); }
                .footer {
                    text-align: center;
                    margin-top: 24px;
                    color: #2d4a6e;
                    font-size: 13px;
                }
                .footer a { color: #4a9eff; text-decoration: none; }
                .footer a:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="logo">
                    <h1>HIGH VELOCITY TRADING</h1>
                    <span>Member Portal</span>
                </div>
                <div class="card">
                    <p class="card-title">Cancel Membership</p>
                    <p class="card-subtitle">Enter your email address below and we'll send you a secure one-time link to cancel your membership.</p>
                    <div class="divider"></div>
                    <label for="email">Email Address</label>
                    <input type="email" id="email" placeholder="your@email.com" />
                    <button id="btn" onclick="requestCancel()">Send Cancellation Link</button>
                    <div class="msg" id="msg"></div>
                </div>
                <div class="footer">
                    Changed your mind? <a href="https://highvelocitytrading.com">Return to High Velocity Trading</a>
                </div>
            </div>
            <script>
                async function requestCancel() {
                    const email = document.getElementById('email').value.trim();
                    const msg = document.getElementById('msg');
                    const btn = document.getElementById('btn');

                    msg.className = 'msg';
                    msg.textContent = '';

                    if (!email) {
                        msg.className = 'msg error show';
                        msg.textContent = 'Please enter your email address.';
                        return;
                    }

                    btn.disabled = true;
                    btn.textContent = 'Sending...';

                    try {
                        const res = await fetch('/cancel/request', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email })
                        });
                        const data = await res.json();

                        if (res.ok) {
                            msg.className = 'msg success show';
                            msg.textContent = '✓ Check your email! A secure cancellation link has been sent.';
                            btn.textContent = 'Email Sent';
                        } else {
                            msg.className = 'msg error show';
                            msg.textContent = data.error || 'Something went wrong. Please try again.';
                            btn.disabled = false;
                            btn.textContent = 'Send Cancellation Link';
                        }
                    } catch (e) {
                        msg.className = 'msg error show';
                        msg.textContent = 'Network error. Please try again.';
                        btn.disabled = false;
                        btn.textContent = 'Send Cancellation Link';
                    }
                }

                document.getElementById('email').addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') requestCancel();
                });
            </script>
        </body>
        </html>
    `);
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
            .update({
                cancel_token: token,
                cancel_token_expires: expires,
                updated_at: new Date().toISOString()
            })
            .eq('email', email);

        if (updateError) throw updateError;

        await sendMagicLinkEmail(email, token);

        console.log(`[Cancel Request] Magic link sent to ${email}`);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Cancel Request Error]', err.message);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

app.get('/cancel/confirm', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.send(cancelResultPage('error', 'Invalid cancellation link.'));

    try {
        const { data, error } = await supabase
            .from(MEMBERSHIP_TABLE)
            .select('email, full_name, status, authnet_subscription_id, cancel_token_expires')
            .eq('cancel_token', token)
            .maybeSingle();

        if (error) throw error;
        if (!data) return res.send(cancelResultPage('error', 'Invalid or expired cancellation link.'));
        if (new Date(data.cancel_token_expires) < new Date()) {
            return res.send(cancelResultPage('error', 'This link has expired. Please request a new one at <a href="/cancel">/cancel</a>.'));
        }
        if (data.status === 'cancelled') {
            return res.send(cancelResultPage('info', 'Your membership is already cancelled.'));
        }

        if (data.authnet_subscription_id) {
            try {
                await cancelAuthorizeSubscription(data.authnet_subscription_id);
                console.log(`[Cancel] Authnet subscription ${data.authnet_subscription_id} cancelled`);
            } catch (authErr) {
                console.error('[Cancel] Authnet error:', authErr.message);
            }
        } else {
            console.warn(`[Cancel] No subscription ID for ${data.email}`);
        }

        const { error: updateError } = await supabase
            .from(MEMBERSHIP_TABLE)
            .update({
                status: 'cancelled',
                cancel_token: null,
                cancel_token_expires: null,
                updated_at: new Date().toISOString()
            })
            .eq('cancel_token', token);

        if (updateError) throw updateError;

        console.log(`🚫 Membership cancelled: ${data.email}`);
        return res.send(cancelResultPage('success', 'Your membership has been successfully cancelled.<br><br>You will retain access until the end of your current billing period.'));

    } catch (err) {
        console.error('[Cancel Confirm Error]', err.message);
        return res.send(cancelResultPage('error', 'Something went wrong. Please contact support.'));
    }
});

function cancelResultPage(type, message) {
    const types = {
        success: { icon: '✓', title: 'Membership Cancelled', color: '#68d391', bg: 'rgba(56,161,105,0.1)', border
