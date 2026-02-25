'use strict';

require('dotenv').config();
const express = require('express');
const Busboy = require('busboy');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 8080;

// -------------------- CONFIG --------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = process.env.SUPABASE_TABLE || 'membershipstab';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[FATAL] Missing Supabase Credentials');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

console.log(`[INIT] Using Supabase table: ${TABLE}`);

// -------------------- HELPERS --------------------
function huntMembershipData(rawString) {
    // 1. Hunt Email
    const emailMatch = rawString.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    
    // 2. Hunt Names
    const firstMatch = rawString.match(/\[q3[^\]]*\]=([^\n]+)/) || rawString.match(/"q3[^"]*":"([^"]+)"/);
    const lastMatch = rawString.match(/\[q4[^\]]*\]=([^\n]+)/) || rawString.match(/"q4[^"]*":"([^"]+)"/);

    // 3. Hunt Phone (q7_phone5)
    const phoneMatch = rawString.match(/\[q7[^\]]*\]=([^\n]+)/);

    const first = firstMatch ? firstMatch[1].trim() : "";
    const last = lastMatch ? lastMatch[1].trim() : "";
    
    return {
        email: emailMatch ? emailMatch[0].toLowerCase().trim() : null,
        full_name: [first, last].filter(Boolean).join(' ') || null,
        phone: phoneMatch ? phoneMatch[1].trim() : null
    };
}

// -------------------- ROUTES --------------------

app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'hvt-membership-engine', table: TABLE });
});

/**
 * JOTFORM WEBHOOK: Handles Multipart/Form-Data
 */
app.post('/webhooks/membership-jotform', (req, res) => {
    const bb = Busboy({ headers: req.headers });
    let rawConcat = '';

    bb.on('field', (name, val) => {
        console.log(`FIELD: [${name}] = ${val}`);
        rawConcat += `\n[${name}]=${val}`;
    });

    bb.on('finish', async () => {
        try {
            console.log('RAW DUMP:', rawConcat);
            const extracted = huntMembershipData(rawConcat);
            console.log('[Extracted]', extracted);

            if (!extracted.email) {
                console.error('❌ No email found in Jotform bundle');
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

            console.log('[Upserting to Supabase]', payload);

            const { error } = await supabase.from(TABLE).upsert(payload, { onConflict: 'email' });

            if (error) {
                console.error('[Supabase Error]', error);
                throw error;
            }

            console.log(`✅ Success: ${extracted.full_name} (${extracted.email}) Phone: ${extracted.phone}`);
            res.status(200).send('OK');
        } catch (err) {
            console.error('[Jotform Error]', err.message);
            res.status(500).send('Server Error');
        }
    });

    req.pipe(bb);
});

/**
 * AUTHORIZE.NET WEBHOOK: Handles JSON Renewals
 */
app.post('/webhooks/membership-authnet', express.json(), async (req, res) => {
    try {
        const body = req.body;
        const email = (body.payload?.customerDetails?.email || "").toLowerCase().trim();

        if (email && (body.eventType.includes('success') || body.eventType.includes('created'))) {
            const { error } = await supabase.from(TABLE).upsert({
                email,
                plan_name: 'membership',
                status: 'active',
                source: 'authnet',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'email' });

            if (error) {
                console.error('[Authnet Supabase Error]', error);
                throw error;
            }

            console.log(`✅ Authnet Success: ${email}`);
        }
        res.status(200).send('OK');
    } catch (err) {
        console.error('[Authnet Error]', err.message);
        res.status(500).send('Internal Error');
    }
});

/**
 * PINESCRIPT ACCESS CHECK
 */
app.get('/check-access', async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });

    const { data, error } = await supabase.from(TABLE)
        .select('status, expires_at')
        .eq('email', email)
        .maybeSingle();

    if (error) console.error('[Check-Access Error]', error);

    const active = data?.status === 'active' && new Date(data.expires_at) > new Date();
    res.json({ active });
});

app.listen(PORT, () => console.log(`🚀 Membership Engine live on ${PORT} | Table: ${TABLE}`));
