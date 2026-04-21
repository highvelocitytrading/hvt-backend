// middleware/errorHandler.js
// Global security headers, 404 handler, and unhandled error middleware.

'use strict';

// ─── SECURITY HEADERS ─────────────────────────────────────────────────────────
// Applied to every response before route handlers run
function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options',       'nosniff');
    res.setHeader('X-Frame-Options',               'DENY');
    res.setHeader('X-XSS-Protection',              '1; mode=block');
    res.setHeader('Referrer-Policy',               'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy',            'geolocation=(), microphone=(), camera=()');
    res.setHeader('Strict-Transport-Security',     'max-age=31536000; includeSubDomains');
    res.removeHeader('X-Powered-By');
    next();
}

// ─── 404 HANDLER ─────────────────────────────────────────────────────────────
function notFound(req, res) {
    res.status(404).json({ ok: false, error: 'not_found' });
}

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    console.error('[UnhandledError]', err.message, err.stack);
    res.status(500).json({ ok: false, error: 'Internal server error.' });
}

module.exports = { securityHeaders, notFound, errorHandler };
