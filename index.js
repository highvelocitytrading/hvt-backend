"use strict";

require('dotenv').config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// 1. DYNAMIC PORT: Railway injects this. 0.0.0.0 is required for external access.
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

// 2. STARTUP GUARD: If these fail, check your Railway "Variables" tab.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("❌ DEPLOYMENT FAILED: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Railway Variables.");
    process.exit(1); 
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TABLE = "MEMBERSHIPS"; 

app.set("trust proxy", true);
app.use(express.json()); // Essential for Authorize.net JSON payloads.

// 3. HEALTH CHECK: Railway uses this to see if your app is alive.
app.get("/health", (req, res) => {
    res.status(200).json({ status: "online", service: "HVT-Backend" });
});

// 4. ACCESS CHECK
app.get("/check-access", async (req, res) => {
    const { email } = req.query;
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

// 5. WEBHOOKS
app.post("/webhooks/jotform", async (req, res) => {
    try {
        const body = req.body;
        const email = body.email || body.q3_email; 
        if (!email) return res.status(400).send("No email");

        await supabase.from(TABLE).upsert({ 
            email, 
            status: "active", 
            updated_at: new Date().toISOString() 
        }, { onConflict: "email" });

        res.status(200).send("OK");
    } catch (err) { res.status(500).send("Error"); }
});

app.listen(PORT, HOST, () => {
    console.log(`✅ HVT Backend live at http://${HOST}:${PORT}`);
});
