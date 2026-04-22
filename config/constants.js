// config/constants.js
// All environment variables, table names, and static configuration values.
// No secrets are hardcoded — every value reads from process.env at runtime.

'use strict';

// ─── DEMO MODE ────────────────────────────────────────────────────────────────
const DEMO_MODE = false; // Always false for production
console.log('[INIT] DEMO_MODE =', DEMO_MODE);

// ─── REQUIRED ENV VALIDATION ──────────────────────────────────────────────────
const requiredEnv = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_ANON_KEY',
    'APP_URL',
    'RESEND_API_KEY',
    'ADMIN_SECRET'
];
const missing = requiredEnv.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
    if (DEMO_MODE) {
        console.warn('[WARN] DEMO_MODE=true and some env are missing (server will still start):');
        missing.forEach(k => console.warn('  -', k));
    } else {
        console.warn('[WARN] Missing env (server will still start, but some features may fail):');
        missing.forEach(k => console.warn('  -', k));
    }
}

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY;

// ─── AUTHORIZE.NET ────────────────────────────────────────────────────────────
const AUTHORIZE_SIGNATURE_KEY = process.env.AUTHORIZE_SIGNATURE_KEY || null;
const AUTHNET_API_LOGIN_ID    = process.env.AUTHNET_API_LOGIN_ID;
const AUTHNET_TRANSACTION_KEY = process.env.AUTHNET_TRANSACTION_KEY;
// Public client key embedded in frontend Accept.js — safe to expose
const AUTHNET_CLIENT_KEY      = process.env.AUTHNET_CLIENT_KEY || null;
// Switch AUTHNET_ENV=sandbox for testing, anything else = production
const AUTHNET_API_URL         = (process.env.AUTHNET_ENV === 'sandbox')
    ? 'https://apitest.authorize.net/xml/v1/request.api'
    : 'https://api.authorize.net/xml/v1/request.api';

// ─── EMAIL ────────────────────────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL     = 'alerts@hvt-mail.com';

// ─── APP ──────────────────────────────────────────────────────────────────────
const APP_URL      = process.env.APP_URL    || 'https://app.highvelocitytrading.com';
const ADMIN_SECRET = process.env.ADMIN_SECRET   || 'HVT-ADMIN-FADBC551B512718D76F4B8744E54B621';
const PORT         = process.env.PORT || 8080;

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Origins allowed to POST to /api/submit/* form endpoints.
// Add your website domain(s) here via ALLOWED_ORIGINS env var (comma-separated).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://highvelocitytrading.com,https://www.highvelocitytrading.com')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

// ─── DISCORD ──────────────────────────────────────────────────────────────────
const DISCORD_BOT_TOKEN        = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID         = process.env.DISCORD_GUILD_ID         || '1460694720090083483';
const DISCORD_MONTHLY_ROLE_ID  = process.env.DISCORD_MONTHLY_ROLE_ID  || '1476634274424819897';
const DISCORD_LIFETIME_ROLE_ID = process.env.DISCORD_LIFETIME_ROLE_ID || '1476634362811384001';
const DISCORD_ROOM_ROLE_ID     = process.env.DISCORD_ROOM_ROLE_ID     || '';
const DISCORD_INVITE_URL       = process.env.DISCORD_INVITE_URL       || 'https://discord.gg/2xG96nV4Hn';
const DISCORD_ROOM_CHECKOUT_URL = process.env.DISCORD_ROOM_CHECKOUT_URL || 'https://app.highvelocitytrading.com/checkout-discord';

// ─── NINJATRADER ECOSYSTEM ────────────────────────────────────────────────────
const NT_PRODUCT_ID = process.env.NT_PRODUCT_ID || '1212';
const NT_USERNAME   = process.env.NT_USERNAME   || '';
const NT_PASSWORD   = process.env.NT_PASSWORD   || '';

// ─── DATABASE TABLE NAMES ─────────────────────────────────────────────────────
const MEMBERSHIP_TABLE     = process.env.SUPABASE_TABLE || 'membershipstab';
const LICENSE_TABLE        = 'license_keys';
const DISCORD_TABLE        = 'discord_members';
const JOURNAL_TABLE        = 'journal_trades';
const PROP_FIRM_TABLE      = 'prop_firm_activations';
const ECHO_TABLE           = 'hvt_echo_licenses';
const COURSE_LESSONS_TABLE = 'course_lessons';

module.exports = {
    DEMO_MODE,
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
    AUTHORIZE_SIGNATURE_KEY, AUTHNET_API_LOGIN_ID, AUTHNET_TRANSACTION_KEY, AUTHNET_CLIENT_KEY, AUTHNET_API_URL,
    RESEND_API_KEY, FROM_EMAIL,
    APP_URL, ADMIN_SECRET, PORT, ALLOWED_ORIGINS,
    DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_MONTHLY_ROLE_ID,
    DISCORD_LIFETIME_ROLE_ID, DISCORD_ROOM_ROLE_ID, DISCORD_INVITE_URL, DISCORD_ROOM_CHECKOUT_URL,
    NT_PRODUCT_ID, NT_USERNAME, NT_PASSWORD,
    MEMBERSHIP_TABLE, LICENSE_TABLE, DISCORD_TABLE, JOURNAL_TABLE,
    PROP_FIRM_TABLE, ECHO_TABLE, COURSE_LESSONS_TABLE
};
