// services/discord.js
// Discord Bot API integration.
// Handles role management, member lookup, and guild queries.

'use strict';

const { DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = require('../config/constants');
const { fetchFn } = require('../helpers/utils');

// ─── CORE API WRAPPER ─────────────────────────────────────────────────────────
// Wraps Discord REST API calls with timeout and automatic rate-limit retry
async function dc(method, path, body, _retry = 0) {
    const ctrl = new AbortController();
    const _t   = setTimeout(() => ctrl.abort(), 8000);
    const r    = await fetchFn(`https://discord.com/api/v10${path}`, {
        method,
        signal: ctrl.signal,
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    clearTimeout(_t);
    if (r.status === 429 && _retry < 3) {
        const retryAfter = parseFloat(r.headers.get('retry-after') || '1');
        console.warn(`[DC] Rate limited on ${method} ${path} — retrying in ${retryAfter}s (attempt ${_retry + 1})`);
        await new Promise(res => setTimeout(res, retryAfter * 1000));
        return dc(method, path, body, _retry + 1);
    }
    if (r.status === 204) return null;
    const d = await r.json();
    if (!r.ok) throw new Error(`Discord ${r.status}: ${JSON.stringify(d)}`);
    return d;
}

// ─── MEMBER LOOKUP ────────────────────────────────────────────────────────────
async function findUser(username) {
    try {
        const list = await dc('GET', `/guilds/${DISCORD_GUILD_ID}/members/search?query=${encodeURIComponent(username)}&limit=10`);
        if (!list?.length) return null;
        const exact = list.find(m => m.user.username.toLowerCase() === username.toLowerCase());
        if (!exact) { console.warn(`[DC findUser] No exact match for username "${username}" in ${list.length} results`); return null; }
        return exact;
    } catch (e) { console.error('[DC findUser]', e.message); return null; }
}

// ─── ROLE MANAGEMENT ──────────────────────────────────────────────────────────
async function addRole(uid, rid) {
    if (!rid) throw new Error('addRole: role ID is empty — check DISCORD_ROOM_ROLE_ID / DISCORD_MONTHLY_ROLE_ID env vars');
    await dc('PUT', `/guilds/${DISCORD_GUILD_ID}/members/${uid}/roles/${rid}`);
}

async function stripRole(uid, rid) {
    await dc('DELETE', `/guilds/${DISCORD_GUILD_ID}/members/${uid}/roles/${rid}`);
}

async function getGuildAll() {
    try { return await dc('GET', `/guilds/${DISCORD_GUILD_ID}/members?limit=1000`) || []; }
    catch (e) { console.error('[DC getGuild]', e.message); return []; }
}

module.exports = { dc, findUser, addRole, stripRole, getGuildAll };
