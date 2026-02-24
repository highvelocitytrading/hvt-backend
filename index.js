To ensure your deployment is "perfection" and avoids the common pitfalls of moving from a local terminal to a cloud environment like Railway, we need to address Port Binding, Production-grade Error Handling, and Health Monitoring.

Below is the optimized index.js.

The Production-Ready index.js
JavaScript
"use strict";

require('dotenv').config();
const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

/**
 * 1. DYNAMIC PORT BINDING
 * Railway injects the PORT variable. Using 0.0.0.0 ensures 
 * the server is accessible outside the container.
 */
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

// ===================== CONFIG & CLIENTS =====================

/**
 * 2. ENV VALIDATION
 * Prevents the server from starting if critical keys are missing.
 */
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("❌ CRITICAL: Missing Supabase Environment Variables.");
    process.exit(1); 
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const AUTHNET_SIGNATURE_KEY = process.env.AUTHNET_SIGNATURE_KEY || "";
const TABLE = "MEMBERSHIPS"; // Confirm this is exactly as named in Supabase

app.set("trust proxy", true);
app.use(express.raw({ type: "*/*", limit: "10mb" }));

// ===================== HELPERS =====================

function calculateExpiry(planName) {
  const now = new Date();
  if (planName?.toUpperCase().includes('YEAR')) {
    return new Date(now.setFullYear(now.getFullYear() + 1)).toISOString();
  }
  return new Date(now.setDate(now.getDate() + 30)).toISOString();
}

function verifySignature(rawBody, header) {
  if (!AUTHNET_SIGNATURE_KEY) return true;
  try {
    const expected = crypto
      .createHmac("sha512", AUTHNET_SIGNATURE_KEY)
      .update(rawBody, "utf8")
      .digest("hex");
    const provided = header?.replace("sha512=", "") || "";
    return crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch (err) {
    console.error("Signature verification error:", err);
    return false;
  }
}

// ===================== ROUTES =====================

/**
 * 3. LIVENESS PROBE
 * Used by Railway to check if the container is healthy.
 */
app.get("/health", (req, res) => {
    res.status(200).json({ status: "online", timestamp: new Date().toISOString() });
});

// ACCESS CHECK (For your Trading Indicators)
app.get("/check-access", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ active: false, error: "Missing email" });

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

// JOTFORM WEBHOOK
app.post("/webhooks/jotform", async (req, res) => {
  try {
    const rawBody = req.body.toString("utf8");
    const parsed = JSON.parse(rawBody);

    const email = parsed.email || parsed.q3_email;
    if (!email) throw new Error("No email provided in Jotform payload");

    const row = {
      email,
      first_name: parsed.first_name || parsed["q1_name[first]"] || "",
      last_name: parsed.last_name || parsed["q1_name[last]"] || "",
      plan_name: parsed.plan_name || "Monthly Membership",
      status: "active",
      source: "jotform",
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase.from(TABLE).upsert(row, { onConflict: "email" });
    if (error) throw error;

    res.status(200).send("OK");
  } catch (err) {
    console.error("Jotform Error:", err.message);
    res.status(500).send("Internal Server Error");
  }
});

// AUTHORIZE.NET WEBHOOK
app.post("/webhooks/authorize-net", async (req, res) => {
  try {
    const rawBody = req.body.toString("utf8");
    if (!verifySignature(rawBody, req.headers["x-anet-signature"])) {
      return res.status(401).send("Unauthorized");
    }

    const data = JSON.parse(rawBody);
    const { payload, eventType } = data;

    const isSuccess = eventType.includes("subscription.created") || eventType.includes("subscription.payment");
    
    const row = {
      authnet_subscription_id: String(payload.id),
      status: isSuccess ? "active" : "expired",
      plan_name: payload.name,
      amount: payload.amount,
      expires_at: isSuccess ? calculateExpiry(payload.name) : new Date().toISOString(),
      authnet_payload: data,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase.from(TABLE).upsert(row, { onConflict: "authnet_subscription_id" });
    if (error) throw error;

    res.status(200).send("OK");
  } catch (err) {
    console.error("Authorize.Net Error:", err.message);
    res.status(500).send("Internal Server Error");
  }
});

// 4. START THE SERVER
app.listen(PORT, HOST, () => {
    console.log(`✅ HVT Production Server running on ${HOST}:${PORT}`);
});
