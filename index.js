"use strict";

require('dotenv').config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TABLE = process.env.SUPABASE_TABLE || "MEMBERSHIPS"; 

app.use(express.json());

// --- JOTFORM WEBHOOK ---
app.post("/webhooks/membership-jotform", async (req, res) => {
    try {
        const body = req.body;
        
        // UNIVERSAL SEARCH: Looks for 'email', 'q3_email', and your specific 'q5_email3'
        const email = (
            body.email || 
            body.q3_email || 
            body.q5_email3 || 
            Object.values(body).find(v => typeof v === 'string' && v.includes('@')) || 
            ""
        ).toLowerCase().trim();
        
        if (!email) {
            console.log("⚠️ 400 Error: No email found in payload. Body keys:", Object.keys(body));
            return res.status(400).send("No email found");
        }

        const { error } = await supabase.from(TABLE).upsert({ 
            email, 
            status: "active",
            expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString() 
        }, { onConflict: "email" });

        if (error) throw error;
        console.log(`✅ Jotform Success: ${email} added to ${TABLE}`);
        res.status(200).send("OK");
    } catch (err) { res.status(500).send(err.message); }
});

// --- AUTHORIZE.NET WEBHOOK ---
app.post("/webhooks/membership-authnet", async (req, res) => {
    try {
        const body = req.body;
        const email = (body.payload?.customerDetails?.email || "").toLowerCase().trim();

        if (email && (body.eventType.includes("success") || body.eventType.includes("created"))) {
            await supabase.from(TABLE).upsert({ 
                email, 
                status: "active",
                expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
                updated_at: new Date().toISOString() 
            }, { onConflict: "email" });
            console.log(`✅ AuthNet Success: ${email} renewed`);
        }
        res.status(200).send("OK");
    } catch (err) { res.status(500).send(err.message); }
});

// --- ACCESS CHECK ---
app.get("/check-access", async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    const { data } = await supabase.from(TABLE).select("status, expires_at").eq("email", email).maybeSingle();
    const active = data?.status === "active" && new Date(data.expires_at) > new Date();
    res.json({ active });
});

app.listen(PORT, HOST, () => console.log(`🚀 Engine live on ${PORT}`));
