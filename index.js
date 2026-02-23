/**
 * MEMBERSHIPS WEBHOOK SERVER
 * - Captures inbound payloads (Jotform + Authorize.Net) safely (body read ONCE)
 * - Writes to Supabase table: MEMBERSHIPS
 *
 * Fixes "InternalServerError: stream is not readable" by avoiding double-reading.
 */

"use strict";

const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const querystring = require("querystring");

const app = express();

// ========= ENV =========
const PORT = process.env.PORT || 8080;
const SERVICE_NAME = process.env.SERVICE_NAME || "hvt-backend-memberships";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // backend only
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "MEMBERSHIPS";

const BODY_LIMIT = process.env.BODY_LIMIT || "25mb";

// Optional Authorize.Net webhook signature verification
// x-anet-signature format: "sha512=<hex_hmac_sha512>"
const AUTHNET_SIGNATURE_KEY = process.env.AUTHNET_SIGNATURE_KEY || "";

// ========= Supabase =========
let supabase = null;
let supabaseReady = false;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  supabaseReady = true;
}

// ========= Trust proxy (Railway) =========
app.set("trust proxy", true);

// ========= Read body ONCE =========
// This makes req.body a Buffer for ALL POSTs, regardless of content-type.
// Then we create req.rawBody + req.parsedBody ourselves.
app.use(
  express.raw({
    type: "*/*",
    limit: BODY_LIMIT,
  })
);

// ========= Helpers =========
function sha256(input) {
  return crypto.createHash("sha256").update(input || "", "utf8").digest("hex");
}

function getClientIp(req) {
  // prefer x-forwarded-for chain if present (Railway / proxies)
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff);
  return req.ip || null;
}

function parseBodyByContentType(rawBody, contentType) {
  const ct = (contentType || "").toLowerCase();

  // default outputs
  let parsed = null;
  let parseMode = "none";

  if (!rawBody) return { parsed: null, parseMode: "empty" };

  // JSON
  if (ct.includes("application/json")) {
    try {
      parsed = JSON.parse(rawBody);
      parseMode = "json";
      return { parsed, parseMode };
    } catch {
      return { parsed: null, parseMode: "json_invalid" };
    }
  }

  // urlencoded
  if (ct.includes("application/x-www-form-urlencoded")) {
    try {
      parsed = querystring.parse(rawBody);
      parseMode = "urlencoded";
      return { parsed, parseMode };
    } catch {
      return { parsed: null, parseMode: "urlencoded_invalid" };
    }
  }

  // multipart/form-data (we keep raw; parsing multipart perfectly is not needed for capture)
  if (ct.includes("multipart/form-data")) {
    return { parsed: null, parseMode: "multipart_raw_only" };
  }

  // anything else → store raw only
  return { parsed: null, parseMode: "raw_only" };
}

function timingSafeEqualHex(a, b) {
  try {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function verifyAuthorizeNetSignature(rawBody, providedHeader) {
  if (!AUTHNET_SIGNATURE_KEY) return { ok: true, skipped: true };

  const sig = providedHeader;
  if (!sig || typeof sig !== "string") return { ok: false, reason: "missing_x_anet_signature" };
  if (!sig.startsWith("sha512=")) return { ok: false, reason: "bad_signature_format" };

  const provided = sig.slice("sha512=".length).trim();

  const expected = crypto
    .createHmac("sha512", AUTHNET_SIGNATURE_KEY)
    .update(rawBody || "", "utf8")
    .digest("hex");

  const ok = timingSafeEqualHex(provided, expected);
  return ok ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

async function insertMembershipEvent(row) {
  if (!supabaseReady || !supabase) {
    return { ok: false, error: "supabase_not_ready" };
  }

  const { error } = await supabase.from(SUPABASE_TABLE).insert(row);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ========= Health =========
app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    table: SUPABASE_TABLE,
    supabase_ready: supabaseReady,
    authnet_signature_check: AUTHNET_SIGNATURE_KEY ? "enabled" : "disabled",
  });
});

// ========= Core capture handler =========
function makeWebhookHandler(sourceLabel, { isAuthorizeNet } = { isAuthorizeNet: false }) {
  return async (req, res) => {
    const capture_id = crypto.randomUUID();

    const contentType = req.headers["content-type"] || "";
    const rawBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const raw_body = rawBuf.length ? rawBuf.toString("utf8") : "";

    const { parsed, parseMode } = parseBodyByContentType(raw_body, contentType);

    // Best-effort event_type extraction (matches your earlier pattern)
    let event_type = null;
    if (parsed && typeof parsed === "object") {
      // Authorize.Net often has eventType at top-level
      if (parsed.eventType) event_type = parsed.eventType;
      // Some payloads nest it
      if (!event_type && parsed.payload && parsed.payload.eventType) event_type = parsed.payload.eventType;
    }

    // Optional signature verification for Authorize.Net
    let sigCheck = { ok: true, skipped: true };
    if (isAuthorizeNet) {
      sigCheck = verifyAuthorizeNetSignature(raw_body, req.headers["x-anet-signature"]);
    }

    // Build row compatible with the structure you showed in the CSV export
    const row = {
      source: sourceLabel,
      event_type: event_type,
      received_at: new Date().toISOString(),
      headers: req.headers || null,
      body: parsed || {},              // jsonb
      raw_body: raw_body || null,      // text
      query: req.query || {},          // jsonb
      ip: getClientIp(req),            // text
      user_agent: req.headers["user-agent"] || null,
      status: isAuthorizeNet && !sigCheck.ok ? "rejected" : "received",
      notes: `capture_id=${capture_id} sha256=${sha256(raw_body)} parse=${parseMode}${
        isAuthorizeNet ? ` sig=${sigCheck.ok ? "ok" : "fail:" + sigCheck.reason}` : ""
      }`,
    };

    const db = await insertMembershipEvent(row);

    // Always respond 200 fast to avoid retries/timeouts from webhook providers
    // (Even if DB fails, we return useful debug info)
    return res.status(200).json({
      ok: true,
      capture_id,
      source: sourceLabel,
      received: true,
      bytes: rawBuf.length,
      parse_mode: parseMode,
      event_type: event_type,
      authnet_signature: isAuthorizeNet ? (sigCheck.ok ? "ok" : `fail:${sigCheck.reason}`) : "n/a",
      supabase: db.ok ? "insert_ok" : `insert_failed:${db.error}`,
      table: SUPABASE_TABLE,
    });
  };
}

// ========= Webhook routes (MEMBERSHIPS) =========
// Use THESE in Jotform + Authorize.Net

// Jotform submission webhook (membership)
app.post(
  ["/webhooks/memberships/jotform", "/webhooks/capture-debug/jotform-membership"],
  makeWebhookHandler("jotform_membership", { isAuthorizeNet: false })
);

// Authorize.Net webhook (membership notifications)
app.post(
  ["/webhooks/memberships/authorize-net", "/webhooks/capture-debug/authorize-net"],
  makeWebhookHandler("authorize_net_membership", { isAuthorizeNet: true })
);

// Optional: catch-all
app.all("*", (req, res) => {
  res.status(404).json({ ok: false, message: "Not found" });
});

// ========= Start =========
app.listen(PORT, () => {
  console.log(`✅ ${SERVICE_NAME} running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Jotform: POST /webhooks/memberships/jotform`);
  console.log(`AuthNet: POST /webhooks/memberships/authorize-net`);
});
