// index.js (capture-only server)
// CommonJS version. If your project uses "type": "module", tell me and I’ll convert to ESM imports.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// --------------------
// Hard lock: ALWAYS capture to webhook_events (invincible)
// --------------------
const CAPTURE_TABLE = "webhook_events";

// --------------------
// Validate required env vars on boot
// --------------------
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL) {
  console.error("Missing SUPABASE_URL");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// --------------------
// Body parsers with raw body capture
// --------------------
// JSON
app.use(
  express.json({
    limit: "10mb",
    type: ["application/json", "application/*+json"],
    verify: (req, res, buf) => {
      req.rawBody = buf ? buf.toString("utf8") : "";
    },
  })
);

// URL-encoded (some providers)
app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
    type: ["application/x-www-form-urlencoded"],
    verify: (req, res, buf) => {
      // If JSON didn't run, this ensures rawBody still exists
      req.rawBody = buf ? buf.toString("utf8") : req.rawBody || "";
    },
  })
);

// Fallback: if some webhook sends text/plain, capture it too
app.use(
  express.text({
    type: ["text/*"],
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf ? buf.toString("utf8") : req.rawBody || "";
    },
  })
);

// --------------------
// Health check
// --------------------
app.get("/health", (req, res) => res.status(200).send("ok"));

// --------------------
// Capture endpoint
// POST /webhook_events?source=authorize.net
// --------------------
app.post("/webhook_events", async (req, res) => {
  // Always respond 200 to prevent provider retry-storms
  // (We still log failures server-side.)
  try {
    // Optional auth gate so random people can't spam your DB
    const requiredToken = process.env.CAPTURE_TOKEN;
    if (requiredToken) {
      const provided =
        req.headers["x-capture-token"] ||
        req.headers["X-Capture-Token"] ||
        req.query.token;

      if (String(provided || "") !== String(requiredToken)) {
        return res.status(200).json({ ok: false, error: "unauthorized" });
      }
    }

    // Source can come from query param or a header
    const source =
      (req.query.source && String(req.query.source)) ||
      (req.headers["x-webhook-source"] && String(req.headers["x-webhook-source"])) ||
      null;

    // Event type (optional)
    const eventType =
      (req.query.event_type && String(req.query.event_type)) ||
      (req.headers["x-event-type"] && String(req.headers["x-event-type"])) ||
      null;

    // IP address (best-effort behind proxies)
    const forwarded = req.headers["x-forwarded-for"];
    const ip =
      (forwarded && String(forwarded).split(",")[0].trim()) ||
      (req.socket && req.socket.remoteAddress) ||
      null;

    const userAgent = req.headers["user-agent"] || null;

    // Determine body: JSON object, urlencoded object, or text
    let bodyJson = null;
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      bodyJson = req.body; // json or urlencoded becomes object
    }

    // Ensure raw_body is captured even if verify didn't run for some reason
    let rawBody = req.rawBody;
    if (!rawBody) {
      if (typeof req.body === "string") rawBody = req.body;
      else if (bodyJson) rawBody = JSON.stringify(bodyJson);
      else rawBody = "";
    }

    const record = {
      source,
      event_type: eventType,
      headers: req.headers || {},
      body: bodyJson,
      raw_body: rawBody,
      query: req.query || {},
      ip,
      user_agent: userAgent,
      status: "captured",
      notes: null,
    };

    // Safety: never allow capture to hit the wrong table
    if (CAPTURE_TABLE !== "webhook_events") {
      throw new Error("CAPTURE_TABLE must be webhook_events");
    }

    const { data, error } = await supabase
      .from(CAPTURE_TABLE)
      .insert(record)
      .select("id")
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(200).json({ ok: false, error: "db_insert_failed" });
    }

    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    console.error("Capture route error:", err);
    return res.status(200).json({ ok: false, error: "capture_failed" });
  }
});

// --------------------
// Start server (Railway provides PORT)
// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Capture server running on port ${PORT}`);
  console.log(`Capture table locked to: ${CAPTURE_TABLE}`);
});
