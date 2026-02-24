"use strict";

require('dotenv').config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// --- CLOUD CONFIGURATION ---
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

// --- DATABASE CONNECTION ---
// Uses the variables you just perfected in Railway
const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_ROLE_KEY
);
const TABLE = process.env.SUPABASE_TABLE || "MEMBERSHIPS"; 

app.use(express.json());

// --- 1. HEALTH CHECK ---
// Visit /health to see if the server is awake
app.get("/health", (req, res) => {
    res.status(200).json({ status: "online", service: "HVT-Membership-Engine" });
});

// --- 2. JOTFORM WEBHOOK (New Signups) ---
// URL: https://hvt-backend-production-ec41.up.railway.app/webhooks/membership-jotform
app.post("/webhooks/membership-jotform", async (req, res) => {
    try {
        const body = req.body;
        const email = (body.email || body.q3_email || "").toLowerCase();
        
        if (!email) {
            console.log("⚠️ Webhook ignored: No email found in payload.");
            return res.status(400).send("No email found");
        }

        const { error } = await supabase.from(TABLE).upsert({ 
            email, 
            status: "active",
            expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString() 
        }, { onConflict: "email" });

        if (error) throw error;
        console.log(`✅ Success: Jotform Membership Created for ${email}`);
        res.status(200).send("OK");
    } catch (err) { 
        console.error("❌ Jotform Error:", err.message);
        res.status(500).send("Internal Error"); 
    }
});

// --- 3. AUTHORIZE.NET WEBHOOK (Payments/Renewals) ---
// URL: https://hvt-backend-production-ec41.up.railway.app/webhooks/membership-authnet
app.post("/webhooks/membership-authnet", async (req, res) => {
    try {
        const body = req.body;
        const email = (body.payload?.customerDetails?.email || "").toLowerCase();

        if (!email) return res.status(200).send("No email in AuthNet payload; ignoring.");

        const eventType = body.eventType || "";
        // Only renew if payment is captured or subscription is created
        if (eventType.includes("success") || eventType.includes("created")) {
            await supabase.from(TABLE).upsert({ 
                email, 
                status: "active",
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString() 
            }, { onConflict: "email" });
            console.log(`✅ Success: AuthNet Membership Renewed for ${email}`);
        }

        res.status(200).send("OK");
    } catch (err) { 
        console.error("❌ AuthNet Error:", err.message);
        res.status(500).send("Internal Error"); 
    }
});

// --- 4. ACCESS CHECK (For TradingView Indicators) ---
app.get("/check-access", async (req, res) => {
    const email = req.query.email?.toLowerCase();
    if (!email) return res.status(400).json({ active: false });

    const { data } = await supabase.from(TABLE).select("status, expires_at").eq("email", email).maybeSingle();
    
    if (data?.status === "active" && new Date(data.expires_at) > new Date()) {
        return res.json({ active: true, expires_at: data.expires_at });
    }
    res.json({ active: false });
});

app.listen(PORT, HOST, () => {
    console.log(`🚀 HVT Membership Engine live at http://${HOST}:${PORT}`);
});
