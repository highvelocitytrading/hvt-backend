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

// -------------------- THE PROTECTED HUNTER --------------------
function huntMembershipData(rawString) {
    // 1. Email Hunter (DO NOT TOUCH - WORKING)
    const emailMatch = rawString.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    
    // 2. Name Hunter (DO NOT TOUCH - WORKING q3/q4)
    const firstMatch = rawString.match(/\[q3[^\]]*\]=([^\\n\r]+)/) || rawString.match(/"q3[^"]*":"([^"]+)"/);
    const lastMatch = rawString.match(/\[q4[^\]]*\]=([^\\n\r]+)/) || rawString.match(/"q4[^"]*":"([^"]+)"/);
    const first = firstMatch ? firstMatch[1].trim() : "";
    const last = lastMatch ? lastMatch[1].trim() : "";

    // 3. THE 3-7 SPLIT PHONE HUNTER (PROFESSIONAL FIX)
    // Specifically targets the separate area code and phone boxes
    const area = rawString.match(/\[q7[^\]]*\]\[area\]=([^\\n\r]+)/);
    const num = rawString.match(/\[q7[^\]]*\]\[phone\]=([^\\n\r]+)/);
    
    let phone = null;
    if (area && num) {
        // Welds the pieces into a clean (786) 1234567 format
        phone = `(${area[1].trim()}) ${num[1].trim()}`; 
    } else {
        // Fallback Vacuum: In case the mask is accidentally toggled back on
        const fullMatch = rawString.match(/\[q7[^\]]*\]\[full\]=([^\\n\r]+)/) || 
                          rawString.match(/\[q7[^\]]*\]=([^\\n\r]+)/) ||
                          rawString.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
        phone = fullMatch ? (Array.isArray(fullMatch) ? fullMatch[0] : fullMatch[1]).trim() : null;
    }
    
    return {
        email: emailMatch ? emailMatch[0].toLowerCase().trim() : null,
        full_name: [first, last].filter(Boolean).join(' ') || "New Member",
        phone: phone
    };
}

// -------------------- THE JOTFORM WEBHOOK --------------------
app.post('/webhooks/membership-jotform', (req, res) => {
    const bb = Busboy({ headers: req.headers });
    let rawConcat = '';

    bb.on('field', (name, val) => {
        rawConcat += `\n[${name}]=${val}`;
    });

    bb.on('finish', async () => {
        try {
            const extracted = huntMembershipData(rawConcat);

            if (!extracted.email) {
                console.error('❌ Missing Email');
                return res.status(400).send('No email found');
            }

            // --- THE DATABASE UPSERT ---
            const { error } = await supabase.from(TABLE).upsert({
                email: extracted.email,
                full_name: extracted.full_name,
                "Phone": extracted.phone,         // MATCHES YOUR CAPITAL 'P' COLUMN
                plan_name: 'membership',
                status: 'active',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'email' });

            if (error) throw error;
            console.log(`✅ SUCCESS: ${extracted.full_name} | ${extracted.phone}`);
            res.status(200).send('OK');
        } catch (err) {
            console.error('❌ Save Failure:', err.message);
            res.status(500).send('Server Error');
        }
    });

    req.pipe(bb);
});

// Access Check for PineScript remains untouched
app.get('/check-access', async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    const { data } = await supabase.from(TABLE).select('status, expires_at').eq('email', email).maybeSingle();
    const active = data?.status === 'active' && new Date(data.expires_at) > new Date();
    res.json({ active });
});

app.listen(PORT, () => console.log(`🚀 System Online: Name and Phone Precision Enabled`));
