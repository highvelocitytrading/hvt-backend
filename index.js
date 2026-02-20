/**
 * CAPTURE-ONLY SERVER (Membership)
 * Purpose: Capture EXACT inbound payloads from:
 *  - Jotform webhook (membership form submission)
 *  - Authorize.Net webhook notifications (subscription/payment events)
 *
 * No business logic. No Supabase writes. Just capture + log.
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

// ========= Config =========
const PORT = process.env.PORT || 3000;

// If set, we will append NDJSON capture logs to this folder
// Example: CAPTURE_DIR=./captures
const CAPTURE_DIR = process.env.CAPTURE_DIR || "";

// Increase limits because Jotform payloads can be large
const JSON_LIMIT = process.env.JSON_LIMIT || "25mb";
const FORM_LIMIT = process.env.FORM_LIMIT || "25mb";

// ========= Helpers =========
function ensureDir(dir) {
  if (!dir) return;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeString(v, max = 20000) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + `... [truncated ${s.length - max} chars]` : s;
}

function sha256(str) {
  return crypto.createHash("sha256").update(str || "").digest("hex");
}

function writeCapture(eventObj) {
  // Always log to console
  console.log(
    `[CAPTURE] ${eventObj.capture_id} ${eventObj.method} ${eventObj.path} ${eventObj.content_type} bytes=${eventObj.raw_body_bytes}`
  );

  // Optionally write to file (NDJSON)
  if (!CAPTURE_DIR) return;
  ensureDir(CAPTURE_DIR);

  const file = path.join(
    CAPTURE_DIR,
    `${new Date().toISOString().slice(0, 10)}-captures.ndjson`
  );

  fs.appendFileSync(file, JSON.stringify(eventObj) + "\n", "utf8");
}

// ========= Raw Body Capture Middleware =========
// We capture raw bytes for BOTH json + urlencoded bodies.
// This is critical for webhook debugging (and future signature verification).
function rawBodySaver(req, res, buf) {
  if (buf && buf.length) {
    req.rawBody = buf.toString("utf8");
  }
}

// Parse JSON + URL-encoded (covers most Jotform/Authorize webhook styles)
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

// If a provider sends text/plain
app.use(
  express.text({
    type: ["text/*", "application/xml", "application/*+xml"],
    limit: FORM_LIMIT,
    verify: rawBodySaver,
  })
);

// ========= Routes =========
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "hvt-backend-capture-membership",
    mode: "capture_only",
  });
});

function captureHandler(sourceLabel) {
  return (req, res) => {
    const captureId = crypto.randomUUID();

    const eventObj = {
      capture_id: captureId,
      captured_at: new Date().toISOString(),
      source: sourceLabel,

      method: req.method,
      path: req.originalUrl,

      ip:
        req.headers["x-forwarded-for"] ||
        req.socket?.remoteAddress ||
        "unknown",

      content_type: req.headers["content-type"] || "unknown",

      headers: req.headers,

      // raw body (exact inbound)
      raw_body: req.rawBody || "",
      raw_body_bytes: req.rawBody ? Buffer.byteLength(req.rawBody, "utf8") : 0,
      raw_body_sha256: sha256(req.rawBody || ""),

      // parsed body (what express interpreted)
      body: req.body ?? null,
    };

    // Write capture
    writeCapture(eventObj);

    // Respond 200 quickly so the webhook provider is happy
    res.status(200).json({
      ok: true,
      capture_id: captureId,
      source: sourceLabel,
      received: true,
      raw_bytes: eventObj.raw_body_bytes,
    });
  };
}

/**
 * IMPORTANT:
 * Use THESE for capture only (membership):
 *
 * Jotform Webhook URL:
 *   https://YOUR_DOMAIN/debug/capture/membership/jotform
 *
 * Authorize.Net Webhook URL:
 *   https://YOUR_DOMAIN/debug/capture/membership/authorize-net
 */

app.post(
  "/debug/capture/membership/jotform",
  captureHandler("jotform_membership_capture")
);

app.post(
  "/debug/capture/membership/authorize-net",
  captureHandler("authorize_net_membership_capture")
);

// Optional: catch-all to help you spot wrong endpoints quickly
app.all("*", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "not_found",
    hint: "Use /health or the /debug/capture/membership/* endpoints",
    path: req.originalUrl,
  });
});

// ========= Start =========
app.listen(PORT, () => {
  console.log(`✅ Capture-only server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Capture Jotform: /debug/capture/membership/jotform`);
  console.log(`Capture Authorize.Net: /debug/capture/membership/authorize-net`);
  if (CAPTURE_DIR) console.log(`Captures writing to: ${CAPTURE_DIR}`);
});
