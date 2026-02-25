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
const TABLE = process.env.SUPABASE_TABLE || 'MEMBERSHIPS';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// -------------------- HELPERS --------------------
function huntMembershipData(rawString) {
    // 1. Email Hunter (Working)
    const emailMatch = rawString.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    
    // 2. Name Hunter (Working - q3 and q4)
    const firstMatch = rawString.match(/\[q3[^\]]*\]=([^\\n\r]+)/) || rawString.match(/"q3[^"]*":"([^"]+)"/);
    const lastMatch = rawString.match(/\[q4[^\]]*\]=([^\\n\r]+)/) || rawString.match(/"q4[^"]*":"([^"]+)"/);
    const first = firstMatch ? firstMatch[1].trim() : "";
    const last = lastMatch ? lastMatch[1].trim() : "";

    // 3. PHONE HUNTER (The Fix)
    // We search specifically for q7 (the phone field) and grab the value
    const phoneMatch = rawString.match(/\[q7[^\]]*\]\[full\]=([^\\n\r]+)/) || 
                       rawString.match(/\[q7[^\]]*\]=([^\\n\r]+)/) ||
                       rawString.match(/"q7[^"]*":"([^"]+)"/);

    const phone = phoneMatch ? phoneMatch[1].trim() : null;
    
    return {
        email: emailMatch ? emailMatch[0].toLowerCase().trim() : null,
        full_name: [first, last].filter(Boolean).join(' ') || null,
        phone: phone
    };
}

// -------------------- ROUTES --------------------

app.post('/webhooks/membership-jotform', (req, res) => {
    const bb = Busboy({ headers: req.headers });
    let rawConcat = '';

    bb.on('field', (name, val) => {
        rawConcat += `\n[${name}]=${val}`;
    });

    bb.on('finish', async () => {
        try {
            const extracted = huntMembershipData(rawConcat);

            if (!extracted.email) return res.status(400).send('No email found');

            // Save to your MEMBERSHIPS table
            const { error } = await supabase.from(TABLE).upsert({
                email: extracted.email,
                full_name: extracted.full_name,
                phone: extracted.phone,         // This goes to your 'phone' column
                plan_name: 'membership',
                status: 'active',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'email' });

            if (error) throw error;
            console.log(`✅ Success: ${extracted.full_name} | ${extracted.phone}`);
            res.status(200).send('OK');
        } catch (err) {
            res.status(500).send('Server Error');
        }
    });

    req.pipe(bb);
});

// Access Check for PineScript
app.get('/check-access', async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    const { data } = await supabase.from(TABLE).select('status, expires_at').eq('email', email).maybeSingle();
    const active = data?.status === 'active' && new Date(data.expires_at) > new Date();
    res.json({ active });
});

app.listen(PORT, () => console.log(`🚀 Membership Engine Live`));
