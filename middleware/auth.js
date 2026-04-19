// middleware/auth.js
// Session management and authentication middleware.
// Sessions are stored both in-memory (fast) and in Supabase (survives Railway restarts).

'use strict';

const crypto = require('crypto');
const { ADMIN_SECRET, MEMBERSHIP_TABLE, LICENSE_TABLE, DEMO_MODE } = require('../config/constants');
const { nowISO } = require('../helpers/utils');
const { supabase } = require('../services/supabase');
const { resultPage } = require('../helpers/html');

// ─── SESSION STORE ────────────────────────────────────────────────────────────
const SESSION_COOKIE = 'hvt_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const _sessions      = new Map(); // token -> { email, name, plan, expires }

// Prune expired sessions hourly
setInterval(() => {
    const n = Date.now();
    for (const [k, s] of _sessions) if (n > s.expires) _sessions.delete(k);
}, 3600000);

// ─── SESSION CREATION ─────────────────────────────────────────────────────────
// Creates a session in memory and persists it to Supabase so it survives restarts
function createSession(email, name, plan) {
    const token      = crypto.randomBytes(32).toString('hex');
    const expires    = Date.now() + SESSION_TTL_MS;
    _sessions.set(token, { email, name, plan, expires });
    const expiresISO = new Date(expires).toISOString();
    (async () => {
        try {
            const { data: mem } = await supabase.from(MEMBERSHIP_TABLE).select('email').eq('email', email).maybeSingle();
            if (mem) {
                await supabase.from(MEMBERSHIP_TABLE).update({ session_token: token, session_expires: expiresISO, updated_at: nowISO() }).eq('email', email);
            } else {
                await supabase.from(LICENSE_TABLE).update({ session_token: token, session_expires: expiresISO, updated_at: nowISO() }).eq('email', email);
            }
        } catch (e) { console.error('[Session persist]', e.message); }
    })();
    return token;
}

// ─── SESSION LOOKUP ───────────────────────────────────────────────────────────
function getSessionFromCookie(req) {
    const raw   = req.headers.cookie || '';
    const match = raw.match(new RegExp(`${SESSION_COOKIE}=([a-f0-9]{64})`));
    if (!match) return { token: null, cached: null };
    const token = match[1];
    const s     = _sessions.get(token);
    if (s && Date.now() <= s.expires) return { token, cached: s };
    return { token, cached: null };
}

function getSession(req) {
    const { token, cached } = getSessionFromCookie(req);
    if (!token) return null;
    if (cached) return cached;
    return null;
}

// Async version — re-hydrates from Supabase on Railway restart (memory wipe case)
async function getSessionAsync(req) {
    const { token, cached } = getSessionFromCookie(req);
    if (!token) return null;
    if (cached) return cached;
    try {
        const now = new Date().toISOString();
        const { data: mem } = await supabase.from(MEMBERSHIP_TABLE)
            .select('email,full_name,status,expires_at,session_token,session_expires')
            .eq('session_token', token)
            .maybeSingle();
        if (mem && mem.session_expires && mem.session_expires > now) {
            const s = {
                email:   mem.email,
                name:    (mem.full_name || 'Trader').split(' ')[0],
                plan:    'Monthly Membership',
                expires: new Date(mem.session_expires).getTime()
            };
            _sessions.set(token, s);
            console.log(`[Session] Re-hydrated from DB (monthly): ${mem.email}`);
            return s;
        }
        const { data: lic } = await supabase.from(LICENSE_TABLE)
            .select('email,full_name,status,session_token,session_expires')
            .eq('session_token', token)
            .maybeSingle();
        if (lic && lic.session_expires && lic.session_expires > now) {
            const s = {
                email:   lic.email,
                name:    (lic.full_name || 'Trader').split(' ')[0],
                plan:    'Lifetime Access',
                expires: new Date(lic.session_expires).getTime()
            };
            _sessions.set(token, s);
            console.log(`[Session] Re-hydrated from DB (lifetime): ${lic.email}`);
            return s;
        }
    } catch (e) { console.error('[Session re-hydrate]', e.message); }
    return null;
}

// ─── REQUIRE SESSION MIDDLEWARE ───────────────────────────────────────────────
// Redirects to /login if no valid session exists
async function requireSession(req, res, next) {
    if (DEMO_MODE) {
        req._session = {
            email:   'demo@hvt-mail.com',
            name:    'Demo Trader',
            plan:    'Demo Access',
            expires: Date.now() + 7 * 24 * 60 * 60 * 1000
        };
        return next();
    }
    const s = await getSessionAsync(req);
    if (s) { req._session = s; return next(); }
    res.redirect('/login');
}

// ─── ADMIN GUARD MIDDLEWARE ───────────────────────────────────────────────────
// Blocks access unless the correct admin key is provided as a query param or body field
function adminGuard(req, res, next) {
    const k = req.query.key || req.body?.key;
    if (!k || k !== ADMIN_SECRET) return res.status(403).send(resultPage('error', 'Access Denied', 'Invalid or missing admin key.'));
    next();
}

module.exports = {
    SESSION_COOKIE, _sessions,
    createSession, getSessionFromCookie, getSession, getSessionAsync,
    requireSession, adminGuard
};
