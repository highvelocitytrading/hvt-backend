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

// --- 1. THE DATA DETECTORS ---
const extractDataByOrder = (body) => {
    const textFields = [];
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    let foundEmail = null;

    // We scan every value in the Jotform payload
    for (const key in body) {
        const value = body[key];
        if (typeof value !== 'string') continue;

        // Check for email first so we don't treat it as a name
        const emailMatch = value.match(emailRegex);
        if (emailMatch && !foundEmail) {
            foundEmail = emailMatch[0];
            continue; 
        }

        // If it's short text and not an email, it's likely a name
        if (value.length > 1 && value.length < 50 && !value.includes('{')) {
            textFields.push(value.trim());
        }
    }

    return {
        email: foundEmail ? foundEmail.toLowerCase() : null,
        // First text field found = First Name | Second text field found = Last Name
        first: textFields[0] || "",
        last: textFields[1] || ""
    };
};

// --- 2. JOTFORM WEBHOOK ---
app.post("/webhooks/membership-jotform", upload.any(), async (req, res) => {
    try {
        const extracted = extractDataByOrder(req.body);

        if (!extracted.email) {
            console.error("❌ Failed: No email address detected in submission.");
            return res.status(400).send("No email found");
        }

        const { error } = await supabase.from(TABLE).upsert({
            email: extracted.email,
            first_name: extracted.first,
            last_name: extracted.last,
            plan_name: "membership",
            status: "active",
            expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString()
        }, { onConflict: "email" });

        if (error) throw error;
        console.log(`✅ Success: ${extracted.first} ${extracted.last} (${extracted.email}) saved.`);
        res.status(200).send("OK");
    } catch (err) { res.status(500).send(err.message); }
});

// --- 3. AUTHORIZE.NET WEBHOOK (Kept Simple) ---
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

// --- 4. ACCESS CHECK ---
app.get("/check-access", async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    const { data } = await supabase.from(TABLE).select("status, expires_at").eq("email", email).maybeSingle();
    const active = data?.status === "active" && new Date(data.expires_at) > new Date();
    res.json({ active });
});

app.listen(PORT, HOST, () => console.log(`🚀 System Online on Port ${PORT}`));
