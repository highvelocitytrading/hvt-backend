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

// -------------------- THE SAFETY HUNTER --------------------
function huntMembershipData(rawString) {
    // 1. Email (Unbreakable)
    const emailMatch = rawString.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    
    // 2. Names (Safety added to prevent 500 errors)
    const firstMatch = rawString.match(/\[q3[^\]]*\]=([^\\n\r]+)/);
    const lastMatch = rawString.match(/\[q4[^\]]*\]=([^\\n\r]+)/);
    
    // 3. THE 3-7 PHONE SPLIT (Method 1)
    // Specifically looking for the Area Code and Phone boxes
    const areaMatch = rawString.match(/\[q7[^\]]*\]\[area\]=([^\\n\r]+)/);
    const numMatch = rawString.match(/\[q7[^\]]*\]\[phone\]=([^\\n\r]+)/);
    
    let phoneString = "No Phone Provided";
    if (areaMatch && numMatch) {
        phoneString = `(${areaMatch[1].trim()}) ${numMatch[1].trim()}`; 
    }

    return {
        email: emailMatch ? emailMatch[0].toLowerCase().trim() : null,
        full_name: [(firstMatch ? firstMatch[1].trim() : ""), (lastMatch ? lastMatch[1].trim() : "")].join(' ').trim() || "New Member",
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

            if (!extracted.email) {
                console.error('❌ 500 Prevention: Missing Email');
                return res.status(400).send('Email required');
            }

            // --- THE DATABASE UPSERT ---
            // If this fails, it's because 'Phone' or 'full_name' doesn't exist in Supabase
            const { error } = await supabase.from(TABLE).upsert({
                email: extracted.email,
                full_name: extracted.full_name,
                "Phone": extracted.phone,         // Matches your Capital 'P'
                plan_name: 'membership',
                status: 'active',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'email' });

            if (error) {
                console.error('❌ Database Conflict:', error.message);
                return res.status(500).send(error.message);
            }

            console.log(`✅ SUCCESS: ${extracted.full_name} | ${extracted.phone}`);
            res.status(200).send('OK');
        } catch (err) {
            console.error('❌ System Crash Prevented:', err.message);
            res.status(500).send('Internal Server Error');
        }
    });

    req.pipe(bb);
});

app.get('/check-access', async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    const { data } = await supabase.from(TABLE).select('status, expires_at').eq('email', email).maybeSingle();
    const active = data?.status === 'active' && new Date(data.expires_at) > new Date();
    res.json({ active });
});

app.listen(PORT, () => console.log(`🚀 System Online: 500 Error Protection Active`));
