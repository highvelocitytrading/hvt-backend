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

/**
 * JOTFORM WEBHOOK: Membership
 */
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

/**
 * AUTHORIZE.NET WEBHOOK: Membership Renewals
 */
app.post('/webhooks/membership-authnet', express.json(), async (req, res) => {
    try {
        const body = req.body;
        const email = (body.payload?.customerDetails?.email || "").toLowerCase().trim();

        if (email && (body.eventType.includes('success') || body.eventType.includes('created'))) {
            const { error } = await supabase.from(MEMBERSHIP_TABLE).upsert({
                email,
                plan_name: 'membership',
                status: 'active',
                source: 'authnet',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'email' });

            if (error) {
                console.error('[Membership Authnet Supabase Error]', error);
                throw error;
            }

            console.log(`✅ Membership Authnet Success: ${email}`);
        }
        res.status(200).send('OK');
    } catch (err) {
        console.error('[Membership Authnet Error]', err.message);
        res.status(500).send('Internal Error');
    }
});

/**
 * PINESCRIPT ACCESS CHECK
 */
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

// ==================== LIFETIME LICENSE ROUTES ====================

/**
 * AUTHORIZE.NET WEBHOOK: Lifetime License
 */
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

/**
 * JOTFORM WEBHOOK: Lifetime License
 */
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

            // Extract phone from q12_phone10
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
