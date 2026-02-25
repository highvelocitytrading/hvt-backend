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

// --- HELPER: THE ULTIMATE EMAIL HUNTER ---
// This function crawls through the entire JSON to find any email
const findEmailAnywhere = (obj) => {
    if (typeof obj === 'string' && obj.includes('@')) return obj;
    if (typeof obj !== 'object' || obj === null) return null;
    
    for (const value of Object.values(obj)) {
        const found = findEmailAnywhere(value);
        if (found) return found;
    }
    return null;
};

app.post("/webhooks/membership-jotform", async (req, res) => {
    try {
        const body = req.body;
        console.log("📥 Received Jotform Payload Keys:", Object.keys(body));

        // Use the hunter function to find the email anywhere in the payload
        const rawEmail = findEmailAnywhere(body);
        const email = (rawEmail || "").toLowerCase().trim();

        if (!email) {
            console.error("❌ 400 Error: No email found anywhere in the Jotform body.");
            return res.status(400).send("No email found");
        }

        const { error } = await supabase.from(TABLE).upsert({
            email,
            status: "active",
            expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString()
        }, { onConflict: "email" });

        if (error) throw error;
        console.log(`✅ Jotform Success: ${email} added.`);
        res.status(200).send("OK");
    } catch (err) {
        console.error("❌ Jotform Database Error:", err.message);
        res.status(500).send("Internal Error");
    }
});

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
            console.log(`✅ AuthNet Success: ${email} processed.`);
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

app.listen(PORT, HOST, () => console.log(`🚀 Engine live on ${PORT}`));
