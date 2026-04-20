// helpers/utils.js
// Shared utility functions and helpers used across routes and services.

'use strict';

const crypto = require('crypto');
const { AUTHORIZE_SIGNATURE_KEY } = require('../config/constants');

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

module.exports = {
    fetchFn, pickFirst, genKey, genEchoKey, esc, now30days, nowISO,
    verifyAuthnetSig
};
