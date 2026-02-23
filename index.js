/**
 * CAPTURE + DEBUG SERVER (Membership)
 * Purpose: Capture EXACT inbound payloads from:
 *  - Jotform webhook (membership form submission)
 *  - Authorize.Net webhook notifications (subscription/payment events)
 *
 * Capture-first: always logs raw + parsed payload.
 * Optional: write to Supabase table `webhook_events`
 *
 * NOTE:
 * - Supabase capture is ON BY DEFAULT.
 * - To turn it OFF, set CAPTURE_TO_SUPABASE=false (or 0/no/off) in Railway.
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ========= Config =========
const PORT = process.env.PORT || 3000;
const SERVICE_NAME = process.env.SERVICE_NAME || "hvt-backend-capture-membership";

// If set, we will append NDJSON capture logs to this folder (optional)
const CAPTURE_DIR = process.env.CAPTURE_DIR || "";

// Increase limits because Jotform payloads can be large
const JSON_LIMIT = process.env.JSON_LIMIT || "25mb";
const FORM_LIMIT = process.env.FORM_LIMIT || "25mb";

// ✅ Supabase capture: ON by default. Turn OFF only if explicitly false/0/no/off
const CAPTURE_TO_SUPABASE = !["false", "0", "no", "off"].includes(
  (process.env.CAPTURE_TO_SUPABASE || "").toLowerCase()
);

// ========= Optional Supabase capture =========
let supabase = null;
let SUPABASE_READY = false;

if (CAPTURE_TO_SUPABASE) {
  const { createClient } = require("@supabase/supabase-js");
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // backend only

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "❌ Supabase capture ON, but SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing."
    );
    console.error("   -> Set both in Railway Variables and redeploy/restart.");
  } else {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    SUPABASE_READY = true;
    console.log("✅ Supabase client initialized (service role).");
  }
}

const app = express();

// ========= Helpers =========
function ensureDir(dir) {
  if (!dir) return;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sha256(str) {
  return crypto.createHash("sha256").update(str || "").digest("hex");
}

function writeCaptureToFile(eventObj) {
  // One-line summary
  console.log(
    `[CAPTURE] ${eventObj.capture_id} source=${eventObj.source} ${eventObj.method} ${eventObj.path} bytes=${eventObj.raw_body_bytes}`
  );

  if (!CAPTURE_DIR) return;
  ensureDir(CAPTURE_DIR);

  const file = path.join(
    CAPTURE_DIR,
    `${new Date().toISOString().slice(0, 10)}-captures.ndjson`
  );

  fs.appendFileSync(file, JSON.stringify(eventObj) + "\n", "utf8");
}

async function writeCaptureToSupabase(eventObj) {
  if (!supabase || !SUPABASE_READY) return;

  // Matches your table columns:
  // source, event_type, received_at, headers, body, raw_body, query, ip, user_agent, status, notes
  const row = {
    source: eventObj.source,
    event_type: eventObj.event_type || null,
    received_at: eventObj.captured_at, // timestamptz
    headers: eventObj.headers || null, // jsonb
    body: eventObj.body ?? null,       // jsonb
    raw_body: eventObj.raw_body || null, // text
    query: eventObj.query || null,     // jsonb
    ip: eventObj.ip || null,           // text
    user_agent: eventObj.user_agent || null, // text
    status: "received",                // text
    notes: `capture_id=${eventObj.capture_id} sha256=${eventObj.raw_body_sha256}`, // text
  };

  const { error } = await supabase.from("webhook_events").insert(row);

  if (error) {
    console.error("❌ Supabase insert failed:", error.message);
    // Helpful hint for common causes
    console.error(
      "   -> Check: table name webhook_events, RLS, service role key, and column types."
    );
  } else {
    console.log(`✅ Supabase insert ok (source=${row.source})`);
  }
}

// ========= Raw Body Capture Middleware =========
function rawBodySaver(req, res, buf) {
  if (buf && buf.length) {
    req.rawBody = buf.toString("utf8");
  }
}

app.use(
  express.json({
    limit: JSON_LIMIT,
    verify: rawBodySaver,
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: FORM_LIMIT,
    verify: rawBodySaver,
  })
);

// If provider sends text/plain or xml
app.use(
  express.text({
    type: ["text/*", "application/xml", "application/*+xml"],
    limit: FORM_LIMIT,
    verify: rawBodySaver,
  })
);

// ========= Routes =========
app.get("/health", async (req, res) => {
  // If Supabase is configured, do a tiny readiness check (non-fatal)
  let supabase_ok = false;
  let supabase_error = null;

  if (SUPABASE_READY) {
    try {
      const { error } = await supabase.from("webhook_events").select("id").limit(1);
      if (error) supabase_error = error.message;
      else supabase_ok = true;
    } catch (e) {
      supabase_error = e?.message || String(e);
    }
  }

  res.json({
    ok: true,
    service: SERVICE_NAME,
    mode: "capture_debug",
    capture_to_supabase: CAPTURE_TO_SUPABASE,
    supabase_ready: SUPABASE_READY,
    supabase_ok,
    supabase_error,
  });
});

function captureHandler(sourceLabel, eventType = null) {
  return async (req, res) => {
    const captureId = crypto.randomUUID();

    const eventObj = {
      capture_id: captureId,
      captured_at: new Date().toISOString(),
      source: sourceLabel,
      event_type: eventType,

      method: req.method,
      path: req.originalUrl,

      ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown",
      user_agent: req.headers["user-agent"] || null,
      content_type: req.headers["content-type"] || "unknown",

      headers: req.headers,
      query: req.query || null,

      raw_body: req.rawBody || "",
      raw_body_bytes: req.rawBody ? Buffer.byteLength(req.rawBody, "utf8") : 0,
      raw_body_sha256: sha256(req.rawBody || ""),

      body: req.body ?? null,
    };

    // Always: file/console capture
    writeCaptureToFile(eventObj);

    // Supabase capture (ON by default)
    if (CAPTURE_TO_SUPABASE) {
      await writeCaptureToSupabase(eventObj);
    }

    // Reply fast for webhook provider
    return res.status(200).json({
      ok: true,
      capture_id: captureId,
      source: sourceLabel,
      received: true,
      raw_bytes: eventObj.raw_body_bytes,
      capture_to_supabase: CAPTURE_TO_SUPABASE,
      supabase_ready: SUPABASE_READY,
    });
  };
}

/**
 * PRIMARY endpoints (clean)
 */
app.post("/debug/capture/membership/jotform", captureHandler("jotform_membership"));
app.post(
  "/debug/capture/membership/authorize-net",
  captureHandler("authorize_net_membership")
);

/**
 * ALIASES (match what you already set in Railway webhooks)
 */
app.post(
  "/webhooks/capture-debug/jotform-membership",
  captureHandler("jotform_membership")
);
app.post(
  "/webhooks/capture-debug/authorize-net",
  captureHandler("authorize_net_membership")
);

/**
 * Catch-all to instantly show wrong endpoints
 */
app.all("*", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "not_found",
    hint:
      "Use /health OR POST to /debug/capture/membership/(jotform|authorize-net) OR /webhooks/capture-debug/(jotform-membership|authorize-net)",
    path: req.originalUrl,
  });
});

app.listen(PORT, () => {
  console.log(`✅ ${SERVICE_NAME} running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Capture Jotform (primary): /debug/capture/membership/jotform`);
  console.log(`Capture Authorize (primary): /debug/capture/membership/authorize-net`);
  console.log(`Capture Jotform (alias): /webhooks/capture-debug/jotform-membership`);
  console.log(`Capture Authorize (alias): /webhooks/capture-debug/authorize-net`);
  if (CAPTURE_DIR) console.log(`Captures writing to: ${CAPTURE_DIR}`);
  console.log(
    `Supabase capture: ${CAPTURE_TO_SUPABASE ? "ON" : "OFF"} (ready=${SUPABASE_READY})`
  );
});
