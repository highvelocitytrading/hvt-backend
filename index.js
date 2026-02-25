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

// --- 1. PRECISION EMAIL HUNTER ---
// Extracts ONLY the email and ignores JSON formatting or extra text
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
        const data = { ...req.body, ...req.files };
        
        // Extract clean email
        const rawEmail = findEmailAnywhere(data);
        const email = (rawEmail || "").toLowerCase().trim();

        if (!email) {
            console.error("⚠️ Failed: No email found in payload.");
            return res.status(400).send("No email found");
        }

        // Map names and plan from your specific requirements
        const first_name = data.q3_q3_textbox1 || "";
        const last_name = data.q4_q4_textbox2 || "";
        const plan_name = "membership"; // Hardcoded as requested

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
        console.log(`✅ Jotform Success: ${first_name} ${last_name} subscribed to '${plan_name}'`);
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
                plan_name: "membership", // Ensure consistency on renewal
                status: "active",
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: "email" });
            console.log(`✅ AuthNet Success: ${email} renewed membership.`);
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

app.listen(PORT, HOST, () => console.log(`🚀 Membership Engine live on ${PORT}`));
