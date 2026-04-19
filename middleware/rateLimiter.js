// middleware/rateLimiter.js
// In-memory rate limiter for endpoint protection.
// Exports a factory function and pre-configured limiters for common use cases.

'use strict';

// ─── RATE LIMIT STORE ─────────────────────────────────────────────────────────
const _rl = new Map();

// Prune expired entries every 5 minutes to prevent memory growth
setInterval(() => {
    const n = Date.now();
    for (const [k, r] of _rl) if (n > r.resetAt) _rl.delete(k);
}, 300000);

// ─── FACTORY ──────────────────────────────────────────────────────────────────
// Returns an Express middleware that limits requests per IP per path
function rateLimit({ windowMs = 60000, max = 20 } = {}) {
    return (req, res, next) => {
        const key = `${req.ip}:${req.path}`;
        const now = Date.now();
        const r   = _rl.get(key);
        if (!r || now > r.resetAt) {
            _rl.set(key, { count: 1, resetAt: now + windowMs });
            return next();
        }
        if (++r.count > max) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        next();
    };
}

// ─── PRE-CONFIGURED LIMITERS ──────────────────────────────────────────────────
const wh  = rateLimit({ max: 50 });   // webhook endpoints
const frm = rateLimit({ max: 10 });   // form / public endpoints
const adm = rateLimit({ max: 30 });   // admin endpoints

module.exports = { rateLimit, wh, frm, adm };
