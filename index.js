import express from "express";

const app = express();

/**
 * Trust proxy so req.ip / protocol behave correctly behind Railway/edge proxies.
 */
app.set("trust proxy", true);

/**
 * IMPORTANT:
 * - Authorize sends JSON. We also capture raw body for future signature verification.
 * - Jotform webhooks are often x-www-form-urlencoded, so we enable urlencoded too.
 */
app.use(
  express.json({
    verify: (req, res, buf) => {
      // Save raw body for debugging / future signature verification
      req.rawBody = buf?.toString("utf8");
    },
  })
);
app.use(express.urlencoded({ extended: true }));

/**
 * Basic routes
 */
app.get("/", (req, res) => {
  res.send("HVT backend is running. Try /health");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * =========================
 * AUTHORIZE.NET WEBHOOKS
 * =========================
 */
app.get("/webhooks/authorize", (req, res) => {
  res.json({ ok: true, msg: "Use POST here for real Authorize.Net webhooks" });
});

app.post("/webhooks/authorize", (req, res) => {
  try {
    const body = req.body || {};
    const eventType = body.eventType;
    const payload = body.payload || {};
    const txId = payload.id; // <-- this is the Authorize transaction ID in your logs
    const amount = payload.authAmount ?? payload.settleAmount ?? payload.amount;

    console.log("=== AUTHORIZE WEBHOOK HIT ===");
    console.log("Time:", new Date().toISOString());
    console.log("IP:", req.ip);
    console.log("User-Agent:", req.get("user-agent"));
    console.log("Event:", eventType);
    console.log("Transaction ID:", txId);
    console.log("Amount:", amount);
    console.log("webhookId:", body.webhookId);
    console.log("notificationId:", body.notificationId);

    // If you ever need deeper debugging:
    console.log("Headers:", req.headers);
    console.log("Body:", body);

    // Always 200 quickly so Authorize doesn't retry
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Authorize webhook handler error:", err);
    // Still return 200 to avoid endless retries while you debug
    return res.status(200).send("OK");
  }
});

/**
 * =========================
 * JOTFORM WEBHOOKS
 * =========================
 */
app.get("/webhooks/jotform", (req, res) => {
  res.json({ ok: true, msg: "Use POST here for real Jotform webhooks" });
});

app.post("/webhooks/jotform", (req, res) => {
  try {
    const body = req.body || {};

    console.log("=== JOTFORM WEBHOOK HIT ===");
    console.log("Time:", new Date().toISOString());
    console.log("IP:", req.ip);
    console.log("User-Agent:", req.get("user-agent"));

    // Helpful: try to auto-find an email field (varies by form)
    let detectedEmail = null;
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "string" && k.toLowerCase().includes("email")) {
        detectedEmail = v;
        break;
      }
    }

    console.log("Detected email:", detectedEmail);
    console.log("Headers:", req.headers);
    console.log("Body:", body);

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Jotform webhook handler error:", err);
    return res.status(200).send("OK");
  }
});

/**
 * Catch-all (optional)
 */
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

/**
 * Start server
 * Railway supplies PORT automatically. Local fallback = 3000
 */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
