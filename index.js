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
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <h2 style="color: #333;">Cancel Your HVT Membership</h2>
                    <p>We received a request to cancel your High Velocity Trading membership.</p>
                    <p>Click the button below to confirm your cancellation. This link expires in <strong>1 hour</strong>.</p>
                    <a href="${cancelUrl}" style="display: inline-block; background-color: #e53e3e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0;">
                        Confirm Cancellation
                    </a>
                    <p style="color: #666; font-size: 14px;">If you did not request this, please ignore this email. Your membership will remain active.</p>
                    <p style="color: #666; font-size: 14px;">Or copy this link: ${cancelUrl}</p>
                </div>
            `
        })
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(`Resend failed: ${JSON.stringify(data)}`);
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

// -------------------- HEALTH --------------------
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

            if (subscriptionId) {
                upsertPayload.authnet_subscription_id = subscriptionId;
            }

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

/**
 * STEP 1: Customer submits email to request cancellation
 * GET /cancel — shows the cancel request form
 */
app.get('/cancel', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Cancel Membership - High Velocity Trading</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body { font-family: Arial, sans-serif; background: #0f0f0f; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
                .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 40px; max-width: 440px; width: 90%; }
                h1 { font-size: 22px; margin-bottom: 8px; }
                p { color: #aaa; font-size: 14px; margin-bottom: 24px; }
                input { width: 100%; padding: 12px; border-radius: 6px; border: 1px solid #444; background: #222; color: #fff; font-size: 16px; margin-bottom: 16px; }
                button { width: 100%; padding: 12px; background: #e53e3e; color: #fff; border: none; border-radius: 6px; font-size: 16px; cursor: pointer; }
                button:hover { background: #c53030; }
                .msg { margin-top: 16px; padding: 12px; border-radius: 6px; font-size: 14px; text-align: center; }
                .success { background: #1a3a1a; color: #68d391; border: 1px solid #2f6b2f; }
                .error { background: #3a1a1a; color: #fc8181; border: 1px solid #6b2f2f; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>Cancel Membership</h1>
                <p>Enter your email address and we'll send you a secure link to cancel your membership.</p>
                <input type="email" id="email" placeholder="your@email.com" />
                <button onclick="requestCancel()">Send Cancellation Link</button>
                <div id="msg"></div>
            </div>
            <script>
                async function requestCancel() {
                    const email = document.getElementById('email').value.trim();
                    const msg = document.getElementById('msg');
                    if (!email) { msg.className = 'msg error'; msg.textContent = 'Please enter your email.'; return; }
                    msg.className = 'msg'; msg.textContent = 'Sending...';
                    const res = await fetch('/cancel/request', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        msg.className = 'msg success';
                        msg.textContent = 'Check your email for a cancellation link!';
                    } else {
                        msg.className = 'msg error';
                        msg.textContent = data.error || 'Something went wrong. Please try again.';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

/**
 * STEP 2: Server receives email, generates token, sends magic link
 * POST /cancel/request
 */
app.post('/cancel/request', express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });

        // Look up membership
        const { data, error } = await supabase
            .from(MEMBERSHIP_TABLE)
            .select('email, full_name, status, authnet_subscription_id')
            .eq('email', email)
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'No membership found for this email' });
        }

        if (data.status === 'cancelled') {
            return res.status(400).json({ error: 'This membership is already cancelled' });
        }

        // Generate secure token
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

        // Store token in Supabase
        const { error: updateError } = await supabase
            .from(MEMBERSHIP_TABLE)
            .update({
                cancel_token: token,
                cancel_token_expires: expires,
                updated_at: new Date().toISOString()
            })
            .eq('email', email);

        if (updateError) throw updateError;

        // Send magic link email
        await sendMagicLinkEmail(email, token);

        console.log(`[Cancel Request] Magic link sent to ${email}`);
        res.json({ ok: true, message: 'Cancellation link sent' });
    } catch (err) {
        console.error('[Cancel Request Error]', err.message);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

/**
 * STEP 3: Customer clicks magic link, server confirms and cancels
 * GET /cancel/confirm?token=xxx
 */
app.get('/cancel/confirm', async (req, res) => {
    const token = req.query.token;

    if (!token) {
        return res.send(cancelPage('error', 'Invalid cancellation link.'));
    }

    try {
        // Look up token
        const { data, error } = await supabase
            .from(MEMBERSHIP_TABLE)
            .select('email, full_name, status, authnet_subscription_id, cancel_token_expires')
            .eq('cancel_token', token)
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            return res.send(cancelPage('error', 'Invalid or expired cancellation link.'));
        }

        // Check expiry
        if (new Date(data.cancel_token_expires) < new Date()) {
            return res.send(cancelPage('error', 'This cancellation link has expired. Please request a new one.'));
        }

        if (data.status === 'cancelled') {
            return res.send(cancelPage('already', 'Your membership is already cancelled.'));
        }

        // Cancel in Authorize.net if we have subscription ID
        if (data.authnet_subscription_id) {
            try {
                await cancelAuthorizeSubscription(data.authnet_subscription_id);
                console.log(`[Cancel] Authnet subscription ${data.authnet_subscription_id} cancelled`);
            } catch (authErr) {
                console.error('[Cancel] Authnet error:', authErr.message);
                // Continue anyway — still update Supabase
            }
        } else {
            console.warn(`[Cancel] No subscription ID for ${data.email} — skipping Authnet call`);
        }

        // Update Supabase
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
        return res.send(cancelPage('success', `Your membership has been cancelled successfully. You will retain access until your current billing period ends.`));

    } catch (err) {
        console.error('[Cancel Confirm Error]', err.message);
        return res.send(cancelPage('error', 'Something went wrong. Please contact support.'));
    }
});

function cancelPage(type, message) {
    const colors = {
        success: { bg: '#1a3a1a', text: '#68d391', border: '#2f6b2f', title: '✅ Cancelled' },
        error: { bg: '#3a1a1a', text: '#fc8181', border: '#6b2f2f', title: '❌ Error' },
        already: { bg: '#1a1a3a', text: '#90cdf4', border: '#2f4f6b', title: 'ℹ️ Already Cancelled' }
    };
    const c = colors[type] || colors.error;
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Membership Cancellation - High Velocity Trading</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body { font-family: Arial, sans-serif; background: #0f0f0f; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
                .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 40px; max-width: 440px; width: 90%; text-align: center; }
                h1 { font-size: 22px; margin-bottom: 16px; }
                .msg { padding: 16px; border-radius: 8px; background: ${c.bg}; color: ${c.text}; border: 1px solid ${c.border}; font-size: 15px; line-height: 1.5; }
                a { display: inline-block; margin-top: 24px; color: #aaa; font-size: 14px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>${c.title}</h1>
                <div class="msg">${message}</div>
                <a href="https://highvelocitytrading.com">← Return to High Velocity Trading</a>
            </div>
        </body>
        </html>
    `;
}

// ==================== LIFETIME LICENSE ROUTES ====================

app.post(
    '/webhooks/authorize-net',
    express.raw({ type: '*/*', limit: '2mb' }),
    async (req, res) => {
        try {
            const rawBody = req.body ? req.body.toString('utf8') : '';
            const sigHeader = req.headers['x-anet-signature'];

            const sigCheck = verifyAuthorizeSignature(rawBody, sigHeader);
            if (!sigCheck.ok) {
                return res.status(401).json({ ok: false, error: 'invalid_signature', reason: sigCheck.reason });
            }

            let body = {};
            try {
                body = rawBody ? JSON.parse(rawBody) : {};
            } catch {
                body = {};
            }

            const transaction_id = pickFirst(body?.payload?.id);
            const eventType = pickFirst(body?.eventType) || 'authorize_net';

            if (!transaction_id) {
                return res.status(400).json({ ok: false, error: 'missing_transaction_id_from_authorize' });
            }

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

            console.log(`[License Authorize] Row created: ${transaction_id} | status: ${row.status}`);
            return res.status(200).json({ ok: true, transaction_id, status: row.status, eventType });
        } catch (err) {
            console.error('[License authorize webhook error]', err);
            return res.status(500).json({ ok: false, error: 'server_error', details: err.message });
        }
    }
);

app.post('/webhooks/jotform', (req, res) => {
    const bb = Busboy({
        headers: req.headers,
        limits: { fieldSize: 5 * 1024 * 1024 }
    });

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
            try {
                rawRequest = fields.rawRequest ? JSON.parse(fields.rawRequest) : null;
            } catch {
                rawRequest = null;
            }

            const rr = rawRequest || {};
            console.log('[License RAW REQUEST KEYS]', Object.keys(rr));

            const first = pickFirst(rr?.q8_q8_fullname6?.first);
            const last = pickFirst(rr?.q8_q8_fullname6?.last);
            const email = pickFirst(rr?.q11_email);
            const transaction_id = pickFirst(rr?.transactionId);
            const full_name = [first, last].filter(Boolean).join(' ') || null;

            let phone = null;
            const phoneField = Object.keys(rr).find(k => k.startsWith('q12'));
            if (phoneField && rr[phoneField]?.full) {
                phone = rr[phoneField].full.trim();
            }

            console.log('[License Extracted]', { email, full_name, phone, transaction_id });

            if (!transaction_id) {
                return res.status(400).json({ ok: false, error: 'missing_transaction_id_from_jotform' });
            }

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

                console.log(`✅ License Jotform activated: ${activated.email} | Phone: ${activated.phone} | Key: ${activated.license_key}`);
                return res.status(200).json({
                    ok: true,
                    transaction_id,
                    license_key: activated.license_key,
                    status: activated.status
                });
            }

            console.log(`[License Jotform] Row saved: ${transaction_id} | status: ${row.status} | Phone: ${row.phone}`);
            return res.status(200).json({
                ok: true,
                transaction_id,
                license_key: row.license_key,
                status: row.status
            });
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
