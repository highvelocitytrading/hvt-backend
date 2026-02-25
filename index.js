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

// --- THE DATA PRECISION ENGINE ---
function huntMembershipData(fields, rawString) {
    // 1. Unbreakable Email Hunt
    const emailMatch = rawString.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    
    // 2. Name Mapping (q3 + q4)
    const first = (fields.q3_q3_textbox1 || "").trim();
    const last = (fields.q4_q4_textbox2 || "").trim();

    // 3. PERFECT PHONE MAPPING
    // Specifically looking for the 'full' composite key from Jotform
    let phone = fields['q7_q7_phone5[full]'] || fields.q7_q7_phone5 || "";
    
    // Fallback: If Jotform sends area and phone separately
    if (!phone && fields['q7_q7_phone5[area]'] && fields['q7_q7_phone5[phone]']) {
        phone = `(${fields['q7_q7_phone5[area]']}) ${fields['q7_q7_phone5[phone]']}`;
    }

    return {
        email: emailMatch ? emailMatch[0].toLowerCase().trim() : null,
        full_name: [first, last].filter(Boolean).join(' ') || null,
        phone: phone.trim() || null
    };
}

app.post('/webhooks/membership-jotform', (req, res) => {
    const bb = Busboy({ headers: req.headers });
    const fields = {};
    let rawConcat = '';

    bb.on('field', (name, val) => {
        fields[name] = val;
        rawConcat += `\n[${name}]=${val}`;
    });

    bb.on('finish', async () => {
        try {
            const result = huntMembershipData(fields, rawConcat);
            if (!result.email) return res.status(400).send("No email found");

            // Save to Supabase
            const { error } = await supabase.from(TABLE).upsert({
                email: result.email,
                full_name: result.full_name,
                phone: result.phone,       // <--- This lands in your new Supabase column
                plan_name: 'membership',   // Always 'membership'
                status: 'active',
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'email' });

            if (error) throw error;
            console.log(`✅ Success: ${result.full_name} | ${result.phone}`);
            res.status(200).send('OK');
        } catch (err) {
            res.status(500).send(err.message);
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

app.listen(PORT, () => console.log(`🚀 System Online on port ${PORT}`));
