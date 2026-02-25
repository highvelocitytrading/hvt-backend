"use strict";

require('dotenv').config();
const express = require("express");
const multer = require("multer"); 
const { createClient } = require("@supabase/supabase-js");

const app = express();
const upload = multer(); // Opens the multipart packages from Jotform

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TABLE = process.env.SUPABASE_TABLE || "MEMBERSHIPS";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. THE REGEX SHIELD (KEEPING EMAIL WORKING) ---
// This part is untouched because you confirmed it works
const findEmailAnywhere = (obj) => {
    if (typeof obj === 'string') {
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        const match = obj.match(emailRegex);
        return match ? match[0] : null; 
    }
    if (typeof obj !== 'object' || obj === null) return null;
    for (const value of Object.values(obj)) {
        const found = findEmailAnywhere(value);
        if (found) return found;
    }
    return null;
};

// --- 2. THE NAME RESCUE ENGINE ---
const getNames = (data) => {
    // Priority 1: Use the exact keys we saw in your CSV log
    // Andrew was in q3_q3_textbox1 | Sachs was in q4_q4_textbox2
    if (data.q3_q3_textbox1 || data.q4_q4_textbox2) {
        return {
            first: (data.q3_q3_textbox1 || "").trim(),
            last: (data.q4_q4_textbox2 || "").trim()
        };
    }

    // Priority 2: Filter out technical junk and pick by position
    const junk = ['slug', 'tracker', 'source', 'date', 'url', 'observer', 'id', 'path', 'email', 'form', 'ip', 'agent'];
    const candidates = [];
    
    for (const key in data) {
        const val = data[key];
        const isJunkKey = junk.some(j => key.toLowerCase().includes(j));
        
        if (typeof val === 'string' && val.length > 0 && !isJunkKey && !val.includes('@') && !val.includes('{')) {
            candidates.push(val.trim());
        }
    }
    
    return {
        first: candidates[0] || "", // First human text found
        last: candidates[1] || ""   // Second human text found
    };
};

// --- 3. JOTFORM WEBHOOK ---
app.post("/webhooks/membership-jotform", upload.any(), async (req, res) => {
    try {
        const data = { ...req.body };
        
        // Use working email logic
        const rawEmail = findEmailAnywhere(data);
        const email = (rawEmail || "").toLowerCase().trim();

        if (!email) return res.status(400).send("No email found");

        // Use name rescue engine
        const names = getNames(data);
        const plan_name = "membership"; // Hardcoded as requested

        const { error } = await supabase.from(TABLE).upsert({
            email,
            first_name: names.first, // Now correctly capturing 'Andrew'
            last_name: names.last,   // Now correctly capturing 'Sachs'
            plan_name,               // Set to 'membership'
            status: "active",
            expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString()
        }, { onConflict: "email" });

        if (error) throw error;
        console.log(`✅ Everything Placed: ${names.first} ${names.last} | ${email} | ${plan_name}`);
        res.status(200).send("OK");
    } catch (err) { res.status(500).send(err.message); }
});

// --- 4. AUTHORIZE.NET WEBHOOK & ACCESS CHECK (Standard) ---
app.post("/webhooks/membership-authnet", async (req, res) => {
    try {
        const email = (req.body.payload?.customerDetails?.email || "").toLowerCase().trim();
        if (email && (req.body.eventType.includes("success") || req.body.eventType.includes("created"))) {
            await supabase.from(TABLE).upsert({
                email, plan_name: "membership", status: "active",
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: "email" });
        }
        res.status(200).send("OK");
    } catch (err) { res.status(500).send("Internal Error"); }
});

app.get("/check-access", async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    const { data } = await supabase.from(TABLE).select("status, expires_at").eq("email", email).maybeSingle();
    const active = data?.status === "active" && new Date(data.expires_at) > new Date();
    res.json({ active });
});

app.listen(PORT, HOST, () => console.log(`🚀 System Online on port ${PORT}`));
