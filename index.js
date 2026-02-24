"use strict";

require('dotenv').config();
const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 8080;

// ===================== CONFIG =====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const AUTHNET_SIGNATURE_KEY = process.env.AUTHNET_SIGNATURE_KEY || "";
const TABLE = "MEMBERSHIPS"; // Ensure this matches your Supabase table name

app.set("trust proxy", true);
// Read body as raw to handle Jotform multipart and AuthNet signatures
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
  const expected = crypto
    .createHmac("sha512", AUTHNET_SIGNATURE_KEY)
    .update(rawBody, "utf8")
    .digest("hex");
  const provided = header?.replace("sha512=", "") || "";
  return crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}

// ===================== ROUTES =====================

// 1. ACCESS CHECK (For your Trading Indicators)
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

// 2. JOTFORM WEBHOOK
app.post("/webhooks/jotform", async (req, res) => {
  const rawBody = req.body.toString("utf8");
  // Best practice: Use JSON integration in Jotform settings
  let parsed = {};
  try { parsed = JSON.parse(rawBody); } catch (e) { /* handle non-json if needed */ }

  const email = parsed.email || parsed.q3_email;
  if (!email) return res.status(400).send("No email found");

  const row = {
    email,
    first_name: parsed.first_name || parsed["q1_name[first]"],
    last_name: parsed.last_name || parsed["q1_name[last]"],
    plan_name: parsed.plan_name || "Monthly Membership",
    status: "active",
    source: "jotform",
    updated_at: new Date().toISOString()
  };

  await supabase.from(TABLE).upsert(row, { onConflict: "email" });
  res.status(200).send("OK");
});

// 3. AUTHORIZE.NET WEBHOOK (ARB)
app.post("/webhooks/authorize-net", async (req, res) => {
  const rawBody = req.body.toString("utf8");
  if (!verifySignature(rawBody, req.headers["x-anet-signature"])) {
    return res.status(401).send("Invalid Signature");
  }

  const data = JSON.parse(rawBody);
  const payload = data.payload;
  const eventType = data.eventType;

  // Handle successful creation or recurring payment
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

  // Upsert by Subscription ID to link to the user
  await supabase.from(TABLE).upsert(row, { onConflict: "authnet_subscription_id" });
  res.status(200).send("OK");
});

app.listen(PORT, () => console.log(`High Velocity Server running on ${PORT}`));
