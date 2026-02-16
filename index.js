import express from "express";

const app = express();

// ✅ Let Express read JSON bodies (Authorize sends JSON)
app.use(express.json());

// ✅ Health check (easy test)
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ✅ Optional: root route so visiting the base domain doesn't show "Cannot GET /"
app.get("/", (req, res) => {
  res.send("HVT backend is running. Try /health");
});

// ✅ Quick browser test (GET) so you don't see an error in the browser
app.get("/webhooks/authorize", (req, res) => {
  res.json({ ok: true, msg: "Use POST here for real Authorize.net webhooks" });
});

// ✅ Webhook endpoint (Authorize.net will POST to this)
app.post("/webhooks/authorize", (req, res) => {
  console.log("Authorize webhook hit!");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);

  // Always respond 200 fast so Authorize doesn't retry
  res.sendStatus(200);
});

// ✅ Railway provides PORT automatically. Local fallback = 3000
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Server running on port", port);
});
