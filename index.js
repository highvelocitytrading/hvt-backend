"use strict";

require('dotenv').config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// CLOUD SETTINGS: Railway uses these to stay alive
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

// SECURITY GUARD: Ensures your database keys are present
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("❌ DEPLOYMENT FAILED: Missing Supabase Variables in Railway.");
    process.exit(1); 
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TABLE = process.env.SUPABASE_TABLE || "MEMBERSHIPS"; 

app.use(express.json()); // Essential for parsing Jotform JSON

// --- HEALTH CHECK ---
app.get("/health", (req, res) => {
    res.status(200).json({ status: "online", service: "Membership-Backend" });
});

// --- MEMBERSHIP WEBHOOK ---
// URL for Jotform: https://hvt-backend-production-ec41.up.railway.app/webhooks/membership
app.post("/webhooks/membership", async (req, res) => {
    try {
        const body = req.body;
        // Normalizes email to lowercase for database consistency
        const email = (body.email || body.q3_email || "").toLowerCase();
        
        if (!email) {
            console.error("⚠️ Webhook received with no email field.");
            return res.status(400).send("No email found");
        }

        // UPSERT: Updates existing user or creates a new one
        const { error } = await supabase.from(TABLE).upsert({ 
            email, 
            status: "active",
            // Sets a standard 31-day expiry
            expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString() 
        }, { onConflict: "email" });

        if (error) throw error;

        console.log(`✅ Membership Activated: ${email}`);
        res.status(200).send("Membership Processed");
    } catch (err) { 
        console.error("❌ Webhook Error:", err.message);
        res.status(500).send("Internal Server Error"); 
    }
});

// --- ACCESS CHECK FOR INDICATORS ---
app.get("/check-access", async (req, res) => {
    const email = req.query.email?.toLowerCase();
    if (!email) return res.status(400).json({ active: false });

    const { data, error } = await supabase
        .from(TABLE)
        .select("status, expires_at")
        .eq("email", email)
        .maybeSingle();

    if (error || !data) return res.json({ active: false });

    const isActive = data.status === "active";
    const isNotExpired = new Date(data.expires_at) > new Date();

    res.json({ active: isActive && isNotExpired, expires_at: data.expires_at });
});

app.listen(PORT, HOST, () => {
    console.log(`🚀 Membership Engine live on port ${PORT}`);
});
