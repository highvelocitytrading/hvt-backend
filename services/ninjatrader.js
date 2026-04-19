// services/ninjatrader.js
// NinjaTrader Ecosystem API integration.
// Handles authentication, token renewal, and license creation/revocation.

'use strict';

const crypto = require('crypto');
const { NT_PRODUCT_ID, NT_USERNAME, NT_PASSWORD } = require('../config/constants');
const { fetchFn } = require('../helpers/utils');

// ─── TOKEN STATE ──────────────────────────────────────────────────────────────
let ntToken     = null;
let ntAuthFails = 0;

function getNtToken()     { return ntToken; }
function getNtAuthFails() { return ntAuthFails; }

// ─── PASSWORD SCRAMBLE ───────────────────────────────────────────────────────
// Exact password scramble from NT Ecosystem source (wr function)
function ntScramblePassword(name, password) {
    const n       = name.length % password.toString().length;
    const rotated = password.toString().slice(n) + password.toString().slice(0, n);
    const reversed = rotated.split('').reverse().join('');
    return Buffer.from(reversed).toString('base64');
}

// ─── CHALLENGE-RESPONSE PAYLOAD ───────────────────────────────────────────────
// Exact challenge-response from NT Ecosystem source (Kt function)
// HMAC secret key extracted from minified JS bundle
function ntBuildPayload(name, password) {
    const scrambled = ntScramblePassword(name, password);
    const chl       = `${Date.now() - 1581e9}`;
    const deviceId  = 'hvt-backend-railway';
    const appId     = 'arena';
    const hmac      = crypto.createHmac('sha256', '035a1259-11e7-485a-aeae-9b6016579351');
    const data      = [chl, deviceId, name, password, appId].join(''); // HMAC uses raw password, not scrambled
    hmac.update(data);
    const sec = hmac.digest('hex');
    return { name, password: scrambled, enc: true, environment: 'live', appId, appVersion: '0.1.0', cid: '1', chl, deviceId, sec };
}

// ─── AUTHENTICATION ───────────────────────────────────────────────────────────
async function ntLogin() {
    if (!NT_USERNAME || !NT_PASSWORD) {
        console.warn('[NT] NT_USERNAME / NT_PASSWORD not set');
        return false;
    }
    try {
        console.log('[NT] Logging in...');
        const payload = ntBuildPayload(NT_USERNAME, NT_PASSWORD);
        const r = await fetchFn('https://live.tradovateapi.com/v1/auth/accesstokenrequest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const d = await r.json();
        if (d?.accessToken) {
            ntToken     = d.accessToken;
            ntAuthFails = 0;
            console.log(`[NT] ✅ Logged in successfully — expires ${d.expirationTime}`);
            return true;
        }
        console.error('[NT] Login failed:', JSON.stringify(d));
        ntAuthFails++;
        return false;
    } catch (e) {
        console.error('[NT] Login error:', e.message);
        ntAuthFails++;
        return false;
    }
}

async function ntRenewToken() {
    if (ntToken) {
        try {
            const r = await fetchFn('https://live.tradovateapi.com/v1/auth/renewaccesstoken', {
                method: 'POST',
                headers: { Authorization: `Bearer ${ntToken}`, 'Content-Type': 'application/json' }
            });
            const d = await r.json();
            if (d?.accessToken) {
                ntToken     = d.accessToken;
                ntAuthFails = 0;
                console.log(`[NT] ✅ Token renewed — expires ${d.expirationTime}`);
                return true;
            }
            console.warn('[NT] Renewal failed — re-logging in');
        } catch (e) {
            console.warn('[NT] Renewal error — re-logging in:', e.message);
        }
    }
    return ntLogin();
}

// ─── LICENSE MANAGEMENT ───────────────────────────────────────────────────────
async function ntCreateLicense(email, type) {
    if (!ntToken) { console.warn('[NT] No token — skipping license creation'); return null; }
    try {
        const expiry = new Date();
        if (type === 'lifetime') {
            expiry.setFullYear(expiry.getFullYear() + 99);
        } else {
            expiry.setDate(expiry.getDate() + 31);
        }
        const r = await fetchFn(`https://ecosystemapi.ninjatrader.com/v1/products/${NT_PRODUCT_ID}/licenses`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${ntToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                license: {
                    email,
                    licenseType: type === 'lifetime' ? 'Lifetime' : 'OneMonth',
                    expirationDateUTC: expiry.toISOString()
                }
            })
        });
        const d = await r.json();
        console.log(`[NT] License API response for ${email}:`, JSON.stringify(d));
        if (d?.errorText && d.errorText !== '') {
            console.error(`[NT] License creation failed for ${email}:`, JSON.stringify(d));
            return null;
        }
        if (!d?.result) {
            console.error(`[NT] License creation no result for ${email}:`, JSON.stringify(d));
            return null;
        }
        // The "license key" users enter in NinjaTrader is their EMAIL ADDRESS
        // d.result is the internal NT license ID used for revocation
        console.log(`[NT] ✅ License created for ${email} | type=${type} | nt_id=${d.result}`);
        return d.result; // NT license ID (store in nt_license_id column)
    } catch (e) {
        console.error(`[NT] License creation error for ${email}:`, e.message);
        return null;
    }
}

async function ntRevokeLicense(ntLicenseId) {
    if (!ntLicenseId) return;
    if (!ntToken) { await ntLogin(); }
    if (!ntToken) { console.error('[NT] Cannot revoke — no token'); return; }
    try {
        const r = await fetchFn(`https://ecosystemapi.ninjatrader.com/v1/products/${NT_PRODUCT_ID}/licenses/${ntLicenseId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${ntToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ license: { expirationDateUTC: new Date().toISOString() } })
        });
        const d = await r.json();
        console.log(`[NT] License ${ntLicenseId} revoked:`, JSON.stringify(d));
    } catch (e) { console.error('[NT] Revoke error:', e.message); }
}

// ─── STARTUP: Login on startup, renew every 45 min ───────────────────────────
setTimeout(ntLogin, 3000);
setInterval(ntRenewToken, 45 * 60 * 1000);

module.exports = {
    ntLogin, ntRenewToken, ntCreateLicense, ntRevokeLicense,
    getNtToken, getNtAuthFails
};
