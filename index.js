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

// --- 1. THE REGEX SHIELD (UNBREAKABLE EMAIL) ---
// This hunts through the data and only extracts a valid email pattern
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

// --- 2. JOTFORM WEBHOOK ---
app.post("/webhooks/membership-jotform", upload.any(), async (req, res) => {
    try {
        // req.body contains the fields parsed by multer
        const data = req.body;
        
        // Find clean email
        const rawEmail = findEmailAnywhere(data);
        const email = (rawEmail || "").toLowerCase().trim();

        if (!email) {
            console.error("❌ 400: No valid email address detected.");
            return res.status(400).send("No email found");
        }

        // DIRECT MAPPING: We use the exact IDs found in your CSV logs
        // q3_q3_textbox1 = First Name | q4_q4_textbox2 = Last Name
        const first_name = data.q3_q3_textbox1 || "";
        const last_name = data.q4_q4_textbox2 || "";
        const plan_name = "membership"; // Hardcoded as requested

        const { error } = await supabase.from(TABLE).upsert({
            email,
            first_name,   // Now correctly mapped
            last_name,    // Now correctly mapped
            plan_name,    // Always "membership"
            status: "active",
            expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString()
        }, { onConflict: "email" });

        if (error) throw error;
        console.log(`✅ Success: ${first_name} ${last_name} (${email}) added.`);
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
                email, plan_name: "membership", status: "active",
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: "email" });
        }
        res.status(200).send("OK");
    } catch (err) { res.status(500).send("Internal Error"); }
});

// --- 4. ACCESS CHECK (For PineScript) ---
app.get("/check-access", async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    const { data } = await supabase.from(TABLE).select("status, expires_at").eq("email", email).maybeSingle();
    const active = data?.status === "active" && new Date(data.expires_at) > new Date();
    res.json({ active });
});

app.listen(PORT, HOST, () => console.log(`🚀 Membership Engine Live on Port ${PORT}`));
