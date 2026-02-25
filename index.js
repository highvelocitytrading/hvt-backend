'use strict';

require('dotenv').config();
const express = require('express');
const Busboy = require('busboy');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 8080;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TABLE = process.env.SUPABASE_TABLE || 'MEMBERSHIPS';

// --- THE DATA PRECISION HUNTER ---
function huntMembershipData(rawString) {
    // 1. EMAIL (Already confirmed working)
    const emailMatch = rawString.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    
    // 2. NAME (Confirmed working q3/q4)
    const firstMatch = rawString.match(/\[q3[^\]]*\]=([^\\n\r]+)/);
    const lastMatch = rawString.match(/\[q4[^\]]*\]=([^\\n\r]+)/);
    const first = firstMatch ? firstMatch[1].trim() : "";
    const last = lastMatch ? lastMatch[1].trim() : "";

    // 3. THE 3-7 PHONE SPLIT (Method 1: Separating Parts)
    // Specifically targets the individual boxes for Area and Phone
    const area = rawString.match(/\[q7[^\]]*\]\[area\]=([^\\n\r]+)/);
    const num = rawString.match(/\[q7[^\]]*\]\[phone\]=([^\\n\r]+)/);
    
    let phoneString = null;
    if (area && num) {
        // Welds them together: (786) 6121678
        phoneString = `(${area[1].trim()}) ${num[1].trim()}`; 
    }
    
    return {
        email: emailMatch ? emailMatch[0].toLowerCase().trim() : null,
        full_name: [first, last].filter(Boolean).join(' ') || "New Member",
        phone: phoneString
    };
}

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

            // Save to Supabase
            // IMPORTANT: If this still fails with 500, check if your column 
            // is "Phone" (Capital) or "phone" (Lowercase) in Supabase.
            const { error } = await supabase.from(TABLE).upsert({
                email: extracted.email,
                full_name: extracted.full_name,
                "Phone": extracted.phone,         // Using Capital P based on your screenshot
                plan_name: 'membership',
                status: 'active',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'email' });

            if (error) {
                console.error('Database Error:', error.message);
                return res.status(500).send(error.message);
            }

            console.log(`✅ SUCCESS: ${extracted.full_name} | ${extracted.phone}`);
            res.status(200).send('OK');
        } catch (err) {
            console.error('System Error:', err.message);
            res.status(500).send('Server Error');
        }
    });

    req.pipe(bb);
});

// PineScript Check
app.get('/check-access', async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    const { data } = await supabase.from(TABLE).select('status, expires_at').eq('email', email).maybeSingle();
    const active = data?.status === 'active' && new Date(data.expires_at) > new Date();
    res.json({ active });
});

app.listen(PORT, () => console.log(`🚀 Membership Engine Live`));
