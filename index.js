"use strict";

require('dotenv').config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("❌ DEPLOYMENT FAILED: Missing Variables.");
    process.exit(1); 
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TABLE = "MEMBERSHIPS"; 

app.set("trust proxy", true);
app.use(express.json());

// --- HELPER ---
const getExpiryDate = (days = 30) => {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
};

app.get("/health", (req, res) => {
    res.status(200).json({ status: "online", service: "HVT-Backend" });
});

app.get("/check-access", async (req, res) => {
    // 1. Lowercase the incoming email to match database
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

app.post("/webhooks/jotform", async (req, res) => {
    try {
        const body = req.body;
        // 2. Lowercase the email from Jotform
        const rawEmail = body.email || body.q3_email;
        if (!rawEmail) return res.status(400).send("No email");
        
        const email = rawEmail.toLowerCase();

        // 3. Automatically set an expiry date (Default 30 days)
        await supabase.from(TABLE).upsert({ 
            email, 
            status: "active", 
            expires_at: getExpiryDate(30), 
            updated_at: new Date().toISOString() 
        }, { onConflict: "email" });

        res.status(200).send("OK");
    } catch (err) { 
        console.error("Webhook Error:", err);
        res.status(500).send("Error"); 
    }
});

app.listen(PORT, HOST, () => {
    console.log(`🚀 HVT Backend live at http://${HOST}:${PORT}`);
});
