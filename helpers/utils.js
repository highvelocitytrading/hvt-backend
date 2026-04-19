// helpers/utils.js
// Shared utility functions and helpers used across routes and services.

'use strict';

const crypto = require('crypto');
const { JOTFORM_SECRET, AUTHORIZE_SIGNATURE_KEY } = require('../config/constants');

// ─── FETCH POLYFILL ───────────────────────────────────────────────────────────
// Uses native fetch if available (Node 18+), otherwise falls back to node-fetch
const fetchFn = global.fetch
    ? global.fetch.bind(global)
    : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─── GENERAL HELPERS ──────────────────────────────────────────────────────────
function pickFirst(...v) {
    for (const x of v) {
        if (typeof x === 'string' && x.trim()) return x.trim();
        if (typeof x === 'number') return String(x);
    }
    return null;
}

function genKey() {
    return `HVT-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function genEchoKey() {
    return `ECHO-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function now30days() {
    return new Date(Date.now() + 30 * 86400000).toISOString();
}

function nowISO() {
    return new Date().toISOString();
}

// ─── JOTFORM FIELD PARSER ─────────────────────────────────────────────────────
// Extracts email, name, and phone from raw Jotform multipart body
function huntData(raw) {
    const email = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0]?.toLowerCase() || null;
    const fn    = (raw.match(/\[q3[^\]]*\]=([^\n]+)/) || raw.match(/"q3[^"]*":"([^"]+)"/))?.[1]?.trim() || '';
    const ln    = (raw.match(/\[q4[^\]]*\]=([^\n]+)/) || raw.match(/"q4[^"]*":"([^"]+)"/))?.[1]?.trim() || '';
    let phone   = null;
    const rr    = raw.match(/\[rawRequest\]=(\{.*\})/s);
    if (rr) {
        try {
            const o  = JSON.parse(rr[1]);
            const pf = Object.keys(o).find(k => k.startsWith('q7'));
            if (pf && o[pf]?.full) phone = o[pf].full.trim();
        } catch {}
    }
    return { email, full_name: [fn, ln].filter(Boolean).join(' ') || null, phone };
}

// ─── SIGNATURE VERIFICATION ───────────────────────────────────────────────────
// Verifies Authorize.net webhook HMAC-SHA512 signature header
function verifyAuthnetSig(rawBody, hdr) {
    if (!AUTHORIZE_SIGNATURE_KEY) return { ok: true };
    if (!hdr) return { ok: false, reason: 'missing_header' };
    const provided = hdr.startsWith('sha512=') ? hdr.slice(7) : hdr;
    try {
        const computed = crypto.createHmac('sha512', AUTHORIZE_SIGNATURE_KEY).update(rawBody || '', 'utf8').digest('hex');
        const a = Buffer.from(provided, 'hex'), b = Buffer.from(computed, 'hex');
        if (a.length !== b.length) return { ok: false, reason: 'len_mismatch' };
        return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
    } catch { return { ok: false, reason: 'format_error' }; }
}

// Verifies Jotform webhook secret query param or header
function verifyJF(req) {
    if (!JOTFORM_SECRET) return true;
    return (req.query.secret || req.headers['x-jotform-secret']) === JOTFORM_SECRET;
}

module.exports = {
    fetchFn, pickFirst, genKey, genEchoKey, esc, now30days, nowISO,
    huntData, verifyAuthnetSig, verifyJF
};
