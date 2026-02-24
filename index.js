/**
 * HVT MEMBERSHIPS WEBHOOK SERVER (Railway)
 * - Webhooks:
 *    POST /webhooks/capture-debug/jotform-membership
 *    POST /webhooks/capture-debug/authorize-net
 * - Writes/Upserts into Supabase table: MEMBERSHIPS (aka memberships)
 *
 * Fixes stream errors by reading body ONCE via express.raw().
 */

"use strict";

const express = require("express");
const crypto = require("crypto");
const querystring = require("querystring");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===================== ENV =====================
const PORT = process.env.PORT || 8080;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// If you *insist* on "MEMBERSHIPS" keep it here.
// But Supabase best practice is lowercase "memberships".
const MEMBERSHIPS_TABLE = process.env.MEMBERSHIPS_TABLE || "MEMBERSHIPS";

const BODY_LIMIT = process.env.BODY_LIMIT || "10mb";

// Optional: Authorize.Net signature key (sha512 HMAC)
// If blank, signature checking is skipped.
const AUTHNET_SIGNATURE_KEY = process.env.AUTHNET_SIGNATURE_KEY || "";

// ===================== Supabase =====================
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

// Railway / proxies
app.set("trust proxy", true);

// ===================== Read body ONCE =====================
app.use(
  express.raw({
    type: "*/*",
    limit: BODY_LIMIT,
  })
);

// ===================== Helpers =====================
function nowIso() {
  return new Date().toISOString();
}

function sha256(str) {
  return crypto.createHash("sha256").update(str || "", "utf8").digest("hex");
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff);
  return req.ip || null;
}

function parseByContentType(rawBodyString, contentType) {
  const ct = String(contentType || "").toLowerCase();

  if (!rawBodyString) return { parsed: {}, mode: "empty" };

  if (ct.includes("application/json")) {
    try {
      return { parsed: JSON.parse(rawBodyString), mode: "json" };
    } catch {
      return { parsed: {}, mode: "json_invalid" };
    }
  }

  if (ct.includes("application/x-www-form-urlencoded")) {
    try {
      return { parsed: querystring.parse(rawBodyString), mode: "urlencoded" };
    } catch {
      return { parsed: {}, mode: "urlencoded_invalid" };
    }
  }

  // multipart/form-data or anything else: keep raw only (store parsed as {})
  return { parsed: {}, mode: "raw_only" };
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

function verifyAuthorizeNetSignature(rawBodyString, headerValue) {
  if (!AUTHNET_SIGNATURE_KEY) return { ok: true, skipped: true };

  if (!headerValue || typeof headerValue !== "string") {
    return { ok: false, reason: "missing_x_anet_signature" };
  }
  if (!headerValue.startsWith("sha512=")) {
    return { ok: false, reason: "bad_signature_format" };
  }

  const provided = headerValue.slice("sha512=".length).trim();
  const expected = crypto
    .createHmac("sha512", AUTHNET_SIGNATURE_KEY)
    .update(rawBodyString || "", "utf8")
    .digest("hex");

  const ok = timingSafeEqualHex(provided, expected);
  return ok ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

// ----- membership field extraction (best-effort) -----
function pickFirst(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s.length) return s;
  }
  return null;
}

function toNumberMaybe(v) {
  if (v === undefined || v === null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Jotform payloads vary a lot. This is robust “best effort”.
function extractFromJotform(payload) {
  // common possibilities:
  // - direct keys: email, first_name, last_name, plan_name, amount, currency
  // - or nested: { submission: { answers: ... } }
  // We’ll just try a bunch of common shapes.

  const email = pickFirst(
    payload.email,
    payload.Email,
    payload.user_email,
    payload["q3_email"] // common Jotform style
  );

  const first_name = pickFirst(
    payload.first_name,
    payload.firstname,
    payload["firstName"],
    payload["q1_name[first]"],
    payload.first,
    payload["first"]
  );

  const last_name = pickFirst(
    payload.last_name,
    payload.lastname,
    payload["lastName"],
    payload["q1_name[last]"],
    payload.last,
    payload["last"]
  );

  const plan_name = pickFirst(
    payload.plan_name,
    payload.plan,
    payload.membership,
    payload.product,
    payload["planName"]
  );

  const amount = toNumberMaybe(
    pickFirst(payload.amount, payload.price, payload.total, payload["plan_amount"])
  );

  const currency = pickFirst(payload.currency, payload["currency_code"], "USD");

  return { email, first_name, last_name, plan_name, amount, currency };
}

// Authorize.Net: your capture CSV shows payload at parsed.payload
function extractFromAuthNet(parsed) {
  const p = parsed && typeof parsed === "object" ? parsed : {};

  const eventType = pickFirst(p.eventType, p.payload?.eventType);

  // We’ll accept IDs from a few likely keys:
  const authnet_subscription_id = pickFirst(
    p.payload?.subscription?.id,
    p.payload?.subscriptionId,
    p.payload?.id // your TEST payload had payload.id
  );

  const authnet_transaction_id = pickFirst(
    p.payload?.transaction?.id,
    p.payload?.transactionId,
    p.payload?.transId
  );

  const authnet_customer_profile_id = pickFirst(
    p.payload?.profile?.customerProfileId,
    p.payload?.customerProfileId
  );

  const authnet_customer_payment_profile_id = pickFirst(
    p.payload?.profile?.customerPaymentProfileId,
    p.payload?.customerPaymentProfileId
  );

  // Sometimes name/amount are present (your TEST payload did)
  const plan_name = pickFirst(p.payload?.name, p.payload?.subscription?.name);
  const amount = toNumberMaybe(p.payload?.amount);

  return {
    eventType,
    authnet_subscription_id,
    authnet_transaction_id,
    authnet_customer_profile_id,
    authnet_customer_payment_profile_id,
    plan_name,
    amount,
  };
}

function statusFromEventType(eventType) {
  if (!eventType) return null;
  const t = String(eventType).toLowerCase();
  if (t.includes("cancel") || t.includes("terminated") || t.includes("suspended")) return "canceled";
  if (t.includes("created") || t.includes("active") || t.includes("payment")) return "active";
  return "active";
}

// ===================== Supabase write (with table fallback) =====================
async function upsertMembership({ tableName, row, onConflict }) {
  if (!supabase) return { ok: false, error: "supabase_not_configured" };

  const attempt = async (t) => {
    // upsert requires a unique constraint on the onConflict column(s)
    const { data, error } = await supabase
      .from(t)
      .upsert(row, { onConflict, ignoreDuplicates: false })
      .select("id")
      .limit(1);

    if (error) return { ok: false, error: error.message };
    return { ok: true, data };
  };

  // 1) try exact tableName from env
  let r = await attempt(tableName);
  if (r.ok) return { ...r, table_used: tableName };

  // 2) fallback to lowercase memberships
  const lower = "memberships";
  if (tableName !== lower) {
    const r2 = await attempt(lower);
    if (r2.ok) return { ...r2, table_used: lower };
    return { ok: false, error: `${r.error} | fallback(${lower})=${r2.error}` };
  }

  return r;
}

// ===================== Routes =====================
app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    port: PORT,
    supabase_configured: Boolean(supabase),
    memberships_table_env: MEMBERSHIPS_TABLE,
    authnet_signature_check: AUTHNET_SIGNATURE_KEY ? "enabled" : "disabled",
  });
});

// ---- Jotform Membership ----
app.post("/webhooks/capture-debug/jotform-membership", async (req, res) => {
  const capture_id = crypto.randomUUID();
  const contentType = req.headers["content-type"] || "";

  const rawBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const raw_body = rawBuf.length ? rawBuf.toString("utf8") : "";

  const { parsed, mode } = parseByContentType(raw_body, contentType);
  const extracted = extractFromJotform(parsed);

  // We upsert primarily by email for Jotform
  const email = extracted.email;
  const onConflict = "email"; // requires unique(email)

  const row = {
    updated_at: nowIso(),
    email: email,
    first_name: extracted.first_name,
    last_name: extracted.last_name,
    status: "active",
    plan_name: extracted.plan_name,
    amount: extracted.amount,
    currency: extracted.currency || "USD",
    source: "jotform",
    last_event_type: "jotform_submission",
    last_event_at: nowIso(),
    last_webhook_event_id: null,
    jotform_payload: parsed || {},
    // do not overwrite authnet_payload here
    notes: `capture_id=${capture_id} parse=${mode} sha256=${sha256(raw_body)} ip=${getClientIp(req)}`,
  };

  // If email missing, we still store the payload but we can’t upsert reliably.
  // In that case, we insert a “new row” by generating a synthetic email-like key.
  let finalOnConflict = onConflict;
  if (!email) {
    row.email = `missing-email+${capture_id}@local.invalid`;
    finalOnConflict = "email";
  }

  const db = await upsertMembership({
    tableName: MEMBERSHIPS_TABLE,
    row,
    onConflict: finalOnConflict,
  });

  return res.status(200).json({
    ok: true,
    capture_id,
    route: "jotform_membership",
    bytes: rawBuf.length,
    parse_mode: mode,
    extracted,
    supabase: db.ok ? "upsert_ok" : `upsert_failed:${db.error}`,
    table_used: db.table_used || null,
  });
});

// ---- Authorize.Net Membership ----
app.post("/webhooks/capture-debug/authorize-net", async (req, res) => {
  const capture_id = crypto.randomUUID();
  const contentType = req.headers["content-type"] || "";

  const rawBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const raw_body = rawBuf.length ? rawBuf.toString("utf8") : "";

  const { parsed, mode } = parseByContentType(raw_body, contentType);

  const sig = verifyAuthorizeNetSignature(raw_body, req.headers["x-anet-signature"]);
  const extracted = extractFromAuthNet(parsed);

  // Decide upsert key:
  // - prefer authnet_subscription_id if present
  // - else fall back to email if present (sometimes included depending on your flow)
  let onConflict = null;

  const authnet_subscription_id = extracted.authnet_subscription_id;
  const email = pickFirst(parsed.email, parsed.payload?.email); // best effort

  if (authnet_subscription_id) onConflict = "authnet_subscription_id";
  else if (email) onConflict = "email";
  else onConflict = "authnet_transaction_id"; // last resort

  const status = sig.ok ? (statusFromEventType(extracted.eventType) || "active") : "rejected";

  const row = {
    updated_at: nowIso(),

    // only set email if we have it
    email: email || null,

    // only set plan/amount if included
    plan_name: extracted.plan_name || null,
    amount: extracted.amount || null,
    currency: "USD",

    status,
    source: "authorize_net",

    authnet_subscription_id: authnet_subscription_id || null,
    authnet_transaction_id: extracted.authnet_transaction_id || (parsed.payload?.transactionId ?? null),
    authnet_customer_profile_id: extracted.authnet_customer_profile_id || null,
    authnet_customer_payment_profile_id: extracted.authnet_customer_payment_profile_id || null,

    last_event_type: extracted.eventType || null,
    last_event_at: nowIso(),
    last_webhook_event_id: null,

    authnet_payload: parsed || {},
    notes: `capture_id=${capture_id} parse=${mode} sig=${sig.skipped ? "skipped" : sig.ok ? "ok" : "fail"} sha256=${sha256(raw_body)} ip=${getClientIp(req)}`,
  };

  // If our conflict key column is null, force a stable synthetic value so PostgREST upsert doesn’t break.
  if (onConflict === "authnet_subscription_id" && !row.authnet_subscription_id) {
    row.authnet_subscription_id = `missing-sub+${capture_id}`;
  }
  if (onConflict === "authnet_transaction_id" && !row.authnet_transaction_id) {
    row.authnet_transaction_id = `missing-tx+${capture_id}`;
  }
  if (onConflict === "email" && !row.email) {
    row.email = `missing-email+${capture_id}@local.invalid`;
  }

  const db = await upsertMembership({
    tableName: MEMBERSHIPS_TABLE,
    row,
    onConflict,
  });

  return res.status(200).json({
    ok: true,
    capture_id,
    route: "authorize_net_membership",
    bytes: rawBuf.length,
    parse_mode: mode,
    signature: sig.skipped ? "skipped" : sig.ok ? "ok" : `fail:${sig.reason}`,
    extracted,
    supabase: db.ok ? "upsert_ok" : `upsert_failed:${db.error}`,
    table_used: db.table_used || null,
  });
});

// 404
app.all("*", (req, res) => {
  res.status(404).json({ ok: false, message: "Not found" });
});

app.listen(PORT, () => {
  console.log(`✅ memberships server running on :${PORT}`);
  console.log(`✅ health: GET /health`);
  console.log(`✅ jotform: POST /webhooks/capture-debug/jotform-membership`);
  console.log(`✅ authnet: POST /webhooks/capture-debug/authorize-net`);
});
