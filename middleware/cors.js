// middleware/cors.js
// CORS middleware for form submission endpoints.
// Allows the HVT website to POST forms directly to the backend.

'use strict';

const { ALLOWED_ORIGINS } = require('../config/constants');

// ─── CORS PREFLIGHT + HEADERS ─────────────────────────────────────────────────
// Applied only to /api/submit/* routes. Allows only trusted origins.
function corsForForms(req, res, next) {
    const origin = req.headers.origin || '';
    const allowed = ALLOWED_ORIGINS.some(o => o === origin || (o.startsWith('*.') && origin.endsWith(o.slice(1))));

    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin',  origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age',       '86400');
    }

    if (req.method === 'OPTIONS') {
        return res.sendStatus(allowed ? 204 : 403);
    }

    // Allow GET requests without an Origin header (same-origin / server-to-server)
    if (!origin && req.method === 'GET') {
        return next();
    }

    if (!allowed) {
        return res.status(403).json({ ok: false, error: 'origin_not_allowed' });
    }

    next();
}

module.exports = { corsForForms };
