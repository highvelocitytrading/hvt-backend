import express from "express";

const app = express();

/**
 * IMPORTANT:
 * - Authorize.Net sends JSON -> express.json() is required
 * - Jotform Webhooks often send application/x-www-form-urlencoded -> express.urlencoded() is required
 */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Health check (easy test)
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ✅ Root route
app.get("/", (req, res) => {
  res.send("HVT backend is running. Try /health");
});

/**
 * =========================
 * AUTHORIZE.NET WEBHOOKS
 * =========================
 */

// ✅ Quick browser test (GET) so you don't see an error in the browser
app.get("/webhooks/authorize", (req, res) => {
  res.json({ ok: true, msg: "Use POST here for real Authorize.Net webhooks" });
});

// ✅ Webhook endpoint (Authorize.Net will POST to this)
app.post("/webhooks/authorize", (req, res) => {
  try {
    console.log("=== AUTHORIZE WEBHOOK HIT ===");
    console.log("Time:", new Date().toISOString());
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);

    // Always respond 200 fast so Authorize doesn't retry
    return res.sendStatus(200);
  } catch (err) {
    console.error("Authorize webhook handler error:", err);
    // Still return 200 so Authorize doesn't keep retrying forever
    return res.sendStatus(200);
  }
});

/**
 * =========================
 * JOTFORM WEBHOOKS
 * =========================
 */

// ✅ Quick browser test (GET)
app.get("/webhooks/jotform", (req, res) => {
  res.json({ ok: true, msg: "Use POST here for real Jotform webhooks" });
});

// ✅ Jotform webhook endpoint
app.post("/webhooks/jotform", (req, res) => {
  try {
    console.log("=== JOTFORM WEBHOOK HIT ===");
    console.log("Time:", new Date().toISOString());
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);

    /**
     * NOTE:
     * Jotform payload field names vary depending on webhook settings.
     * Common places email can appear:
     * - req.body.email
     * - req.body["q3_email"] or similar (question id based)
     * - req.body.rawRequest / submission data object (depends on integration)
     *
     * For now we just log everything.
     * Once you paste a sample Jotform Body here, we’ll extract the exact email key.
     */

    return res.sendStatus(200);
  } catch (err) {
    console.error("Jotform webhook handler error:", err);
    return res.sendStatus(200);
  }
});

// ✅ Railway provides PORT automatically. Local fallback = 3000
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Server running on port", port);
});
