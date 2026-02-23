/**
 * HVT Membership Capture + Mapping Server
 *
 * Captures EXACT inbound payloads from:
 *  - Jotform webhook (often multipart/form-data)
 *  - Authorize.Net webhook notifications (application/json + x-anet-signature)
 *
 * Always captures:
 *  - raw_body (string)
 *  - parsed body when possible
 * Writes into Supabase table: webhook_events
 *
 * Optionally maps membership status into a Supabase table (MEMBERS_TABLE) via upsert.
 */

const express = require("express");
const crypto = require("crypto");
const getRawBody = require("raw-body");

// ===== Config =====
const PORT = Number(process.env.PORT || 8080);
const SERVICE_NAME = process.env.SERVICE_NAME || "hvt-backend-membership";

const JSON_LIMIT = process.env.JSON_LIMIT || "25mb";
const RAW_LIMIT = process.env.RAW_LIMIT || "25mb";

// Capture events to Supabase webhook_events table
const CAPTURE_TO_SUPABASE =
  (process.env.CAPTURE_TO_SUPABASE || "true").toLowerCase() === "true";

// Optional membership mapping (upsert)
const ENABLE_MEMBERSHIP_MAPPING =
  (process.env.ENABLE_MEMBERSHIP_MAPPING || "true").toLowerCase() === "true";

const MEMBERS_TABLE = process.env.MEMBERS_TABLE || "memberships"; // you create this table (SQL below)
const WEBHOOK_EVENTS_TABLE = process.env.WEBHOOK_EVENTS_TABLE || "webhook_events";

// Authorize.Net signature verification (recommended)
const AUTHNET_SIGNATURE_KEY = process.env.AUTHNET_SIGNATURE_KEY || "";

// ===== Supabase =====
let supabase = null;
let supabaseReady = false;

function initSupabase() {
  if (!CAPTURE_TO_SUPABASE && !ENABLE_MEMBERSHIP_MAPPING) return;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Supabase features disabled."
    );
    return;
  }

  const { createClient } = require("@supabase/supabase-js");
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  supabaseReady = true;
}

initSupabase();

// ===== App =====
const app = express();

/**
 * We want RAW body for ALL webhook posts so:
 * - Jotform multipart can be stored exactly (your CSV showed {} body for Jotform)
 * - Auth.net signature verification needs raw body exactly
 *
 * We'll read raw body for ONLY our webhook routes to avoid interfering with other routes.
 */
async function rawBodyMiddleware(req, res, next) {
  const isWebhook =
    req.path.startsWith("/webhooks/") || req.path.startsWith("/debug/");

  if (!isWebhook) return next();

  try {
    const buf = await getRawBody(req, {
      length: req.headers["content-length"],
      limit: RAW_LIMIT,
      encoding: true, // string
    });
    req.rawBody = buf || "";
  } catch (e) {
    req.rawBody = "";
    req.rawBodyError = e?.message || "raw_body_read_failed";
  }

  return next();
}

app.use(rawBodyMiddleware);

// We still enable parsers for non-multipart cases (json/urlencoded/text)
app.use(
  express.json({
    limit: JSON_LIMIT,
    type: ["application/json", "application/*+json"],
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: JSON_LIMIT,
  })
);

app.use(
  express.text({
    type: ["text/*", "application/xml", "application/*+xml"],
    limit: JSON_LIMIT,
  })
);

// ===== Helpers =====
function sha256(str) {
  return crypto.createHash("sha256").update(str || "", "utf8").digest("hex");
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function parseUrlEncoded(str) {
  try {
    const params = new URLSearchParams(str);
    const obj = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return obj;
  } catch {
    return null;
  }
}

// Best-effort parser for Jotform: many times it’s multipart => raw only.
// If it’s urlencoded/json/text, we’ll parse it.
function bestEffortParse(req) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();

  // If Express already parsed JSON/urlencoded into req.body
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const raw = req.rawBody || "";

  if (!raw) return null;

  if (ct.includes("application/json")) return safeJsonParse(raw);
  if (ct.includes("application/x-www-form-urlencoded")) return parseUrlEncoded(raw);

  // If content-type is missing or text
  const asJson = safeJsonParse(raw);
  if (asJson) return asJson;

  const asUrl = parseUrlEncoded(raw);
  if (asUrl && Object.keys(asUrl).length) return asUrl;

  return { _raw_text: raw };
}

function findFirstEmailDeep(val) {
  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

  function walk(x) {
    if (!x) return null;

    if (typeof x === "string") {
      const m = x.match(emailRegex);
      return m ? m[0] : null;
    }

    if (Array.isArray(x)) {
      for (const item of x) {
        const hit = walk(item);
        if (hit) return hit;
      }
      return null;
    }

    if (typeof x === "object") {
      // prefer keys containing "email"
      const keys = Object.keys(x);
      for (const k of keys) {
        if (k.toLowerCase().includes("email")) {
          const hit = walk(x[k]);
          if (hit) return hit;
        }
      }
      // then search everything
      for (const k of keys) {
        const hit = walk(x[k]);
        if (hit) return hit;
      }
    }

    return null;
  }

  return walk(val);
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

/**
 * Authorize.Net: signature header: x-anet-signature: "sha512=<hex>"
 * expected: HMAC_SHA512(signatureKey, rawBody)
 */
function verifyAuthorizeSignature(req) {
  if (!AUTHNET_SIGNATURE_KEY) return { ok: true, skipped: true };

  const sig = req.headers["x-anet-signature"];
  if (!sig || typeof sig !== "string") return { ok: false, reason: "missing_x_anet_signature" };
  if (!sig.startsWith("sha512=")) return { ok: false, reason: "bad_signature_format" };

  const provided = sig.replace("sha512=", "").trim();

  const computed = crypto
    .createHmac("sha512", AUTHNET_SIGNATURE_KEY)
    .update(req.rawBody || "", "utf8")
    .digest("hex");

  const ok = timingSafeEqualHex(provided, computed);
  return ok ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

async function insertWebhookEvent(row) {
  if (!supabaseReady || !supabase) return { ok: false, skipped: true };
  const { error } = await supabase.from(WEBHOOK_EVENTS_TABLE).insert(row);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

async function upsertMembershipByEmail(email, patch) {
  if (!ENABLE_MEMBERSHIP_MAPPING) return { ok: false, skipped: true };
  if (!supabaseReady || !supabase) return { ok: false, skipped: true };
  if (!email) return { ok: false, skipped: true, reason: "missing_email" };

  const row = {
    email: String(email).toLowerCase(),
    status: patch.status || null,
    plan: patch.plan || null,
    external_id: patch.external_id || null,
    last_event_source: patch.last_event_source || null,
    last_event_type: patch.last_event_type || null,
    last_event_at: patch.last_event_at || new Date().toISOString(),
    last_event: patch.last_event || null, // jsonb
    updated_at: new Date().toISOString(),
  };

  // requires memberships.email UNIQUE or PRIMARY KEY
  const { error } = await supabase.from(MEMBERS_TABLE).upsert(row, {
    onConflict: "email",
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ===== Health =====
app.get("/health", async (req, res) => {
  // lightweight Supabase probe (optional)
  let supabaseOk = false;
  let supabaseError = null;

  if (supabaseReady && supabase) {
    try {
      const { error } = await supabase.from(WEBHOOK_EVENTS_TABLE).select("id").limit(1);
      if (error) throw new Error(error.message);
      supabaseOk = true;
    } catch (e) {
      supabaseOk = false;
      supabaseError = e?.message || "supabase_probe_failed";
    }
  }

  res.json({
    ok: true,
    service: SERVICE_NAME,
    mode: "membership_capture_and_mapping",
    capture_to_supabase: CAPTURE_TO_SUPABASE,
    enable_membership_mapping: ENABLE_MEMBERSHIP_MAPPING,
    supabase_ready: supabaseReady,
    supabase_ok: supabaseOk,
    supabase_error: supabaseError,
  });
});

// ===== Main handlers =====
function captureRoute(sourceLabel) {
  return async (req, res) => {
    const capture_id = crypto.randomUUID();
    const captured_at = new Date().toISOString();

    const parsed = bestEffortParse(req);
    const raw = req.rawBody || "";

    // eventType (especially for Authorize.Net payloads)
    let event_type = null;
    if (parsed && typeof parsed === "object") {
      event_type =
        parsed.eventType ||
        parsed.event_type ||
        parsed?.payload?.eventType ||
        null;
    }

    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;
    const user_agent = req.headers["user-agent"] || null;

    const eventObj = {
      capture_id,
      source: sourceLabel,
      event_type,
      captured_at,
      headers: req.headers || null,
      body: parsed ?? null,
      raw_body: raw || null,
      raw_body_bytes: Buffer.byteLength(raw || "", "utf8"),
      raw_body_sha256: sha256(raw || ""),
      query: req.query || null,
      ip,
      user_agent,
      raw_body_error: req.rawBodyError || null,
    };

    // Insert into webhook_events (your CSV format)
    if (CAPTURE_TO_SUPABASE) {
      const row = {
        source: eventObj.source,
        event_type: eventObj.event_type,
        received_at: eventObj.captured_at,
        headers: eventObj.headers,
        body: eventObj.body,
        raw_body: eventObj.raw_body,
        query: eventObj.query,
        ip: String(eventObj.ip || ""),
        user_agent: String(eventObj.user_agent || ""),
        status: "received",
        notes: `capture_id=${eventObj.capture_id} sha256=${eventObj.raw_body_sha256}${
          eventObj.raw_body_error ? ` raw_error=${eventObj.raw_body_error}` : ""
        }`,
      };

      const ins = await insertWebhookEvent(row);
      if (!ins.ok && !ins.skipped) {
        console.error("❌ Supabase webhook_events insert failed:", ins.error);
      }
    }

    // Membership mapping
    // - Jotform: usually provides email in fields (NOT card)
    // - Authorize: may provide email or customer info depending on notification type
    const email = findFirstEmailDeep(parsed) || findFirstEmailDeep(raw);

    // Authorize signature validation only for authorize routes
    let sig = { ok: true, skipped: true };
    if (sourceLabel.includes("authorize_net")) {
      sig = verifyAuthorizeSignature(req);
      if (!sig.ok) {
        // still captured to Supabase — but respond 401 so you can see auth failures fast
        return res.status(401).json({
          ok: false,
          error: "authorize_signature_failed",
          reason: sig.reason,
          capture_id,
        });
      }
    }

    // Determine a good membership status for mapping
    // For Jotform => mark "pending" (intent created)
    // For Authorize => mark "active" (payment/subscription event arrived)
    let status = null;
    if (sourceLabel.includes("jotform")) status = "pending";
    if (sourceLabel.includes("authorize_net")) status = "active";

    // Extract an "external_id" if present (Authorize payload.id matches your sheet)
    let external_id = null;
    if (parsed?.payload?.id) external_id = String(parsed.payload.id);
    if (!external_id && parsed?.id) external_id = String(parsed.id);

    // Plan name if present (your CSV showed payload.name "TEST")
    let plan = null;
    if (parsed?.payload?.name) plan = String(parsed.payload.name);

    const up = await upsertMembershipByEmail(email, {
      status,
      plan,
      external_id,
      last_event_source: sourceLabel,
      last_event_type: event_type,
      last_event_at: captured_at,
      last_event: parsed ?? { raw: raw || null },
    });

    if (!up.ok && !up.skipped) {
      console.error("❌ Membership upsert failed:", up.error);
    }

    return res.json({
      ok: true,
      received: true,
      source: sourceLabel,
      capture_id,
      raw_bytes: eventObj.raw_body_bytes,
      capture_to_supabase: CAPTURE_TO_SUPABASE,
      membership_mapping: {
        enabled: ENABLE_MEMBERSHIP_MAPPING,
        email: email || null,
        status: status || null,
        upserted: up.ok || false,
        skipped: !!up.skipped,
        error: up.error || null,
      },
      authorize_signature: sig,
      supabase_ready: supabaseReady,
    });
  };
}

// Real endpoints
app.post("/webhooks/membership/jotform", captureRoute("jotform_membership"));
app.post("/webhooks/membership/authorize-net", captureRoute("authorize_net_membership"));

// Debug aliases (what you were using)
app.post("/webhooks/capture-debug/jotform-membership", captureRoute("jotform_membership"));
app.post("/webhooks/capture-debug/authorize-net", captureRoute("authorize_net_membership"));

// Old aliases you had in logs (optional)
app.post("/debug/capture/membership/jotform", captureRoute("jotform_membership"));
app.post("/debug/capture/membership/authorize-net", captureRoute("authorize_net_membership"));

// ===== Start =====
app.listen(PORT, () => {
  console.log(`✅ ${SERVICE_NAME} running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Jotform: POST /webhooks/membership/jotform`);
  console.log(`Authorize: POST /webhooks/membership/authorize-net`);
});
