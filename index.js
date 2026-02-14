import express from "express";

const app = express();

// Health check (easy test)
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Webhook endpoint (Authorize will hit this later)
app.post("/webhooks/authorize", (req, res) => {
  console.log("Authorize webhook hit!");
  res.sendStatus(200);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});