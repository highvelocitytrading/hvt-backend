"use strict";

require('dotenv').config();
const express = require("express");
const multer = require("multer"); 
const { createClient } = require("@supabase/supabase-js");

const app = express();
const upload = multer();

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TABLE = process.env.SUPABASE_TABLE || "MEMBERSHIPS";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. THE REINFORCED EMAIL HUNTER ---
// This ensures the email column NEVER gets the "Wall of Text" again
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

// Helper to clean up names
const cleanName = (name) => {
    if (!name) return "";
    const trimmed = name.toString().trim();
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
};

// --- 2. JOTFORM WEBHOOK ---
app.post("/webhooks/membership-jotform", upload.any(), async (req, res) => {
    try {
        const data = { ...req.body, ...req.files };
        
        // Step A: Find the clean email pattern
        const rawEmail = findEmailAnywhere(data);
        const email = (rawEmail || "").toLowerCase().trim();

        if (!email) {
            console.error("❌ 400: No valid email address pattern found.");
            return res.status(400).send("No email found");
        }

        // Step B: Map names specifically from the IDs in your logs
        // q3_q3_textbox1 = Andrew | q4_q4_textbox2 = Sachs
        const first_name = cleanName(data.q3_q3_textbox1);
        const last_name = cleanName(data.q4_q4_textbox2);
        const plan_name = "membership"; 

        // Step C: Save to database
        const { error } = await supabase.from(TABLE).upsert({
            email,        
            first_name,   
            last_name,    
            plan_name,    
            status: "active",
            expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString()
        }, { onConflict: "email" });

        if (error) throw error;
        console.log(`✅ Success: Saved ${first_name} ${last_name} (${email}) correctly.`);
        res.status(200).send("OK");
    } catch (err) { res.status(500).send(err.message); }
});

// --- 3. AUTHORIZE.NET WEBHOOK ---
app.post("/webhooks/membership-authnet", async (req, res) => {
    try {
        const body = req.body;
        const email = (body.payload?.customerDetails?.email || "").toLowerCase().trim();
        if (email && (body.eventType.includes("success") || body.eventType.includes("created"))) {
            await supabase.from(TABLE).upsert({
                email, 
                plan_name: "membership",
                status: "active",
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: "email" });
            console.log(`✅ Success: Renewal for ${email}`);
        }
        res.status(200).send("OK");
    } catch (err) { res.status(500).send("Internal Error"); }
});

// --- 4. ACCESS CHECK ---
app.get("/check-access", async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    const { data } = await supabase.from(TABLE).select("status, expires_at").eq("email", email).maybeSingle();
    const active = data?.status === "active" && new Date(data.expires_at) > new Date();
    res.json({ active });
});

app.listen(PORT, HOST, () => console.log(`🚀 Membership Engine Live on Port ${PORT}`));
