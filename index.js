'use strict';

require('dotenv').config();
const express = require('express');
const Busboy = require('busboy');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 8080;

// -------------------- SUPABASE --------------------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TABLE = process.env.SUPABASE_TABLE || 'MEMBERSHIPS';

// -------------------- Helpers --------------------
function pickFirst(...vals) {
    for (const v of vals) {
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
    }
    return null;
}

// -------------------- Routes --------------------

app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'hvt-membership-busboy', table: TABLE });
});

// Jotform webhook (Busboy Logic)
app.post('/webhooks/membership-jotform', (req, res) => {
    const bb = Busboy({ headers: req.headers });
    const fields = {};

    bb.on('field', (name, val) => {
        fields[name] = val;
    });

    bb.on('finish', async () => {
        try {
            // 1. DATA EXTRACTION (Locked IDs from your Jotform)
            const first = pickFirst(fields.q3_q3_textbox1);
            const last = pickFirst(fields.q4_q4_textbox2);
            
            // Extracting Email (using the same logic that's been working)
            const email = pickFirst(fields.q11_email, fields.email); 

            // Extracting Phone (Direct q7 mapping)
            const phone = pickFirst(fields['q7_q7_phone5[full]'], fields.q7_q7_phone5);

            const full_name = [first, last].filter(Boolean).join(' ') || "Unknown Name";

            if (!email) {
                console.error('[ERROR] No email found in fields');
                return res.status(400).send("No email found");
            }

            // 2. SUPABASE UPSERT
            const { error } = await supabase.from(TABLE).upsert({
                email: email.toLowerCase().trim(),
                full_name: full_name,
                phone: phone,
                plan_name: 'membership', // Always hardcoded to membership
                status: 'active',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'email' });

            if (error) throw error;
            
            console.log(`✅ Membership Saved: ${full_name} | ${phone} | ${email}`);
            res.status(200).send('OK');

        } catch (err) {
            console.error('[Jotform Error]', err);
            res.status(500).send('Internal Server Error');
        }
    });

    req.pipe(bb);
});

// Authorize.Net Webhook (JSON)
app.post('/webhooks/membership-authnet', express.json(), async (req, res) => {
    try {
        const body = req.body;
        const email = pickFirst(body?.payload?.customerDetails?.email);

        if (email && (body.eventType.includes('success') || body.eventType.includes('created'))) {
            await supabase.from(TABLE).upsert({
                email: email.toLowerCase().trim(),
                plan_name: 'membership',
                status: 'active',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'email' });
        }
        res.status(200).send('OK');
    } catch (err) {
        res.status(500).send('Error');
    }
});

// PineScript Access Check
app.get('/check-access', async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });

    const { data } = await supabase.from(TABLE)
        .select('status, expires_at')
        .eq('email', email)
        .maybeSingle();

    const active = data?.status === 'active' && new Date(data.expires_at) > new Date();
    res.json({ active });
});

app.listen(PORT, () => console.log(`🚀 Membership Engine (Busboy) listening on port ${PORT}`));
