/**
 * MEMBERSHIPS WEBHOOK SERVER (Railway)
 * - Jotform (multipart/urlencoded) + Authorize.Net (json)
 * - Writes to Supabase table: memberships
 * - Reads request body ONCE (fixes "stream is not readable")
 */

"use strict";

const express = require("express");
const crypto = require("crypto");
const getRawBody = require("raw-body");
const querystring = require("querystring");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set("trust proxy", true);

// ========= ENV =========
const PORT = process.env.PORT || 8080;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "memberships";

const BODY_LIMIT = process.env.BODY_LIMIT || "25mb";

// Optional: Authorize.Net webhook signature verification (sha512=...)
const AUTHNET_SIGNATURE_KEY = process.env.AUTHNET_SIGNATURE_KEY || "";

// ========= Supabase =========
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ========= Helpers =========
function nowIso() {
  return new Date().toISOString();
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf || Buffer.from("")).digest("hex");
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  return xff ? String(xff) : req.ip || null;
}

function timingSafeEqualHex(a, b) {
  try {
    const A = Buffer.from(a, "hex");
    const B = Buffer.from(b, "hex");
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

function verifyAuthorizeNetSignature(rawText, providedHeader) {
  if (!AUTHNET_SIGNATURE_KEY) return { ok: true, skipped: true };

  if (!providedHeader || typeof providedHeader !== "string") {
    return { ok: false, reason: "missing_x_anet_signature" };
  }
  if (!providedHeader.startsWith("sha512=")) {
    return { ok: false, reason: "bad_signature_format" };
  }

  const provided = providedHeader.slice("sha512=".length).trim();
  const expected = crypto
    .createHmac("sha512", AUTHNET_SIGNATURE_KEY)
    .update(rawText || "", "utf8")
    .digest("hex");

  return timingSafeEqualHex(provided, expected)
    ? { ok: true }
    : { ok: false, reason: "signature_mismatch" };
}

/**
 * Minimal multipart parser (text fields only).
 * Works well for webhook-style multipart forms (like Jotform).
 */
function parseMultipartText(rawText, contentType) {
  const match = /boundary=([^;]+)/i.exec(contentType || "");
  if (!match) return { parsed: null, mode: "multipart_no_boundary" };

  const boundary = match[1];
  const delimiter = `--${boundary}`;
  const parts = rawText.split(delimiter);

  const out = {};
  for (const part of parts) {
    if (!part || part === "--\r\n" || part === "--") continue;

    // Separate headers from body
    const idx = part.indexOf("\r\n\r\n");
    if (idx === -1) continue;

    const headerBlock = part.slice(0, idx);
    let value = part.slice(idx + 4);

    // trim ending CRLF
    value = value.replace(/\r\n$/g, "");
    value = value.replace(/\r\n--$/g, "");

    // Content-Disposition: form-data; name="..."
    const nameMatch = /name="([^"]+)"/i.exec(headerBlock);
    if (!nameMatch) continue;

    const fieldName = nameMatch[1];
    out[fieldName] = value;
  }

  return { parsed: out, mode: "multipart_text" };
}

function parseBody(rawBuf, contentType) {
  const ct = (contentType || "").toLowerCase();
  const rawText = rawBuf.toString("utf8");

  // JSON
  if (ct.includes("application/json")) {
    try {
      return { parsed: JSON.parse(rawText), mode: "json", rawText };
    } catch {
      return { parsed: null, mode: "json_invalid", rawText };
    }
  }

  // urlencoded
  if (ct.includes("application/x-www-form-urlencoded")) {
    try {
      return { parsed: querystring.parse(rawText), mode: "urlencoded", rawText };
    } catch {
      return { parsed: null, mode: "urlencoded_invalid", rawText };
    }
  }

  // multipart
  if (ct.includes("multipart/form-data")) {
    const { parsed, mode } = parseMultipartText(rawText, contentType);
    return { parsed, mode, rawText };
  }

  // fallback
  return { parsed: null, mode: "raw_only", rawText };
}

function pickFirst(obj, predicate) {
  if (!obj || typeof obj !== "object") return null;
  for (const [k, v] of Object.entries(obj)) {
    if (predicate(k, v)) return v;
  }
  return null;
}

function normalizeMoney(val) {
  if (val == null) return null;
  const s = String(val).replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function extractEmail(payload) {
  // direct
  const direct = pickFirst(payload, (k, v) => /email/i.test(k) && typeof v === "string" && v.includes("@"));
  if (direct) return String(direct).trim();

  // any value that looks like email
  const any = pickFirst(payload, (_k, v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()));
  return any ? String(any).trim() : null;
}

function extractName(payload) {
  let first = pickFirst(payload, (k, v) => /first/i.test(k) && typeof v === "string" && v.trim().length > 0);
  let last = pickFirst(payload, (k, v) => /last/i.test(k) && typeof v === "string" && v.trim().length > 0);

  // sometimes single "name" field
  if ((!first || !last)) {
    const full = pickFirst(payload, (k, v) => /name/i.test(k) && typeof v === "string" && v.trim().length > 0);
    if (full && (!first || !last)) {
      const parts = String(full).trim().split(/\s+/);
      if (!first) first = parts[0] || null;
      if (!last) last = parts.length > 1 ? parts.slice(1).join(" ") : null;
    }
  }

  return {
    first_name: first ? String(first).trim() : null,
    last_name: last ? String(last).trim() : null,
  };
}

function extractPlan(payload) {
  // plan, membership, product, package, etc.
  const plan = pickFirst(payload, (k, v) =>
    /(plan|membership|product|package|tier)/i.test(k) && typeof v === "string" && v.trim().length > 0
  );
  return plan ? String(plan).trim() : null;
}

function extractAmount(payload) {
  const amt = pickFirst(payload, (k, v) =>
    /(amount|price|total|payment)/i.test(k) && (typeof v === "string" || typeof v === "number")
  );
  return normalizeMoney(amt);
}

function extractCurrency(payload) {
  const cur = pickFirst(payload, (k, v) =>
    /(currency)/i.test(k) && typeof v === "string" && v.trim().length > 0
  );
  return cur ? String(cur).trim().toUpperCase() : "USD";
}

async function upsertMembership(row) {
  // IMPORTANT: this assumes you have a UNIQUE constraint on email OR authnet_subscription_id.
  // Best practice: unique(email) and unique(authnet_subscription_id).
  const { data, error } = await supabase
    .from(SUPABASE_TABLE)
    .upsert(row, { onConflict: row.authnet_subscription_id ? "authnet_subscription_id" : "email" })
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data?.id ?? null };
}

// ========= One middleware to read body ONCE =========
app.use(async (req, res, next) => {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();

  try {
    const rawBuf = await getRawBody(req, { limit: BODY_LIMIT });
    req.rawBuf = rawBuf;
    next();
  } catch (e) {
    console.error("❌ raw-body read failed:", e?.message || e);
    res.status(400).json({ ok: false, error: "raw_body_read_failed" });
  }
});

// ========= Health =========
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    table: SUPABASE_TABLE,
  });
});

// ========= Webhooks =========

// Jotform membership webhook
app.post(["/webhooks/capture-debug/jotform-membership", "/webhooks/memberships/jotform"], async (req, res) => {
  const capture_id = crypto.randomUUID();
  const contentType = req.headers["content-type"] || "";
  const rawBuf = req.rawBuf || Buffer.from("");
  const { parsed, mode, rawText } = parseBody(rawBuf, contentType);

  const email = extractEmail(parsed || {});
  const { first_name, last_name } = extractName(parsed || {});
  const plan_name = extractPlan(parsed || {});
  const amount = extractAmount(parsed || {});
  const currency = extractCurrency(parsed || {});

  // Jotform submission means "active" in your world (user entered flow)
  const row = {
    email,
    first_name,
    last_name,
    status: "active",
    plan_name,
    amount,
    currency,
    source: "jotform",

    last_event_type: "jotform_submission",
    last_event_at: nowIso(),

    // Store payloads for debugging/auditing
    jotform_payload: parsed || {},
    notes: `capture_id=${capture_id} parse=${mode} sha256=${sha256(rawBuf)}`,
  };

  const db = await upsertMembership(row);

  // Log hard if we didn't get core fields
  if (!email) console.warn("⚠️ Jotform parsed but email missing. parse_mode=", mode);
  if (!db.ok) console.error("❌ Supabase upsert failed:", db.error);

  res.status(200).json({
    ok: true,
    capture_id,
    parse_mode: mode,
    extracted: { email, first_name, last_name, plan_name, amount, currency },
    supabase: db.ok ? "upsert_ok" : `upsert_failed:${db.error}`,
  });
});

// Authorize.Net membership webhook
app.post(["/webhooks/capture-debug/authorize-net", "/webhooks/memberships/authorize-net"], async (req, res) => {
  const capture_id = crypto.randomUUID();
  const contentType = req.headers["content-type"] || "";
  const rawBuf = req.rawBuf || Buffer.from("");
  const { parsed, mode, rawText } = parseBody(rawBuf, contentType);

  const sigCheck = verifyAuthorizeNetSignature(rawText, req.headers["x-anet-signature"]);
  const rejected = !sigCheck.ok;

  // Expected structure based on your capture CSV example:
  // parsed.eventType, parsed.eventDate, parsed.payload.id, parsed.payload.amount, parsed.payload.status, parsed.payload.profile.customerProfileId, customerPaymentProfileId
  const eventType = parsed?.eventType || null;
  const eventDate = parsed?.eventDate || null;

  const subscriptionId = parsed?.payload?.id ? String(parsed.payload.id) : null;
  const amount = parsed?.payload?.amount != null ? normalizeMoney(parsed.payload.amount) : null;
  const status = parsed?.payload?.status ? String(parsed.payload.status) : "active";

  const custProfileId =
    parsed?.payload?.profile?.customerProfileId != null ? String(parsed.payload.profile.customerProfileId) : null;

  const custPayProfileId =
    parsed?.payload?.profile?.customerPaymentProfileId != null
      ? String(parsed.payload.profile.customerPaymentProfileId)
      : null;

  // You may not have email on AuthNet webhook; that's OK—match on subscription id (best key).
  const row = {
    authnet_subscription_id: subscriptionId,
    authnet_customer_profile_id: custProfileId,
    authnet_customer_payment_profile_id: custPayProfileId,
    amount: amount,
    currency: "USD",
    status: rejected ? "rejected" : status,
    source: "authnet",

    last_event_type: eventType,
    last_event_at: eventDate ? new Date(eventDate).toISOString() : nowIso(),

    authnet_payload: parsed || {},
    notes: `capture_id=${capture_id} parse=${mode} sha256=${sha256(rawBuf)} sig=${
      sigCheck.skipped ? "skipped" : sigCheck.ok ? "ok" : `fail:${sigCheck.reason}`
    }`,
  };

  const db = rejected ? { ok: true, id: null } : await upsertMembership(row);
  if (!db.ok) console.error("❌ Supabase upsert failed:", db.error);

  res.status(200).json({
    ok: true,
    capture_id,
    parse_mode: mode,
    authnet_signature: sigCheck.skipped ? "skipped" : sigCheck.ok ? "ok" : `fail:${sigCheck.reason}`,
    extracted: { subscriptionId, amount, status, custProfileId, custPayProfileId, eventType },
    supabase: rejected ? "skipped_insert_rejected" : db.ok ? "upsert_ok" : `upsert_failed:${db.error}`,
  });
});

// 404
app.all("*", (req, res) => res.status(404).json({ ok: false, message: "Not found" }));

app.listen(PORT, () => {
  console.log(`✅ memberships webhook server running on :${PORT}`);
  console.log(`Health: GET /health`);
  console.log(`Jotform: POST /webhooks/capture-debug/jotform-membership`);
  console.log(`AuthNet: POST /webhooks/capture-debug/authorize-net`);
});
