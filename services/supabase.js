// services/supabase.js
// Supabase client setup and all shared database helper functions.
// Individual routes may make their own supabase calls; this file exports
// the client and reusable helpers shared across multiple modules.

'use strict';

const { createClient } = require('@supabase/supabase-js');
const {
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
    MEMBERSHIP_TABLE, LICENSE_TABLE, DISCORD_TABLE, PROP_FIRM_TABLE
} = require('../config/constants');
const { genKey, nowISO } = require('../helpers/utils');
const { ntRevokeLicense } = require('./ninjatrader');

// ─── CLIENT SETUP ─────────────────────────────────────────────────────────────
let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    console.log(`[INIT] Supabase connected: ${MEMBERSHIP_TABLE} | ${LICENSE_TABLE} | ${DISCORD_TABLE}`);
} else {
    console.warn('[WARN] Supabase env missing — database features will fail until configured.');
}

// ─── LICENSE HELPERS ──────────────────────────────────────────────────────────
// Fetch a lifetime license record by Authorize.net transaction ID
async function getByTxn(txId) {
    const { data, error } = await supabase.from('license_keys').select('*').eq('transaction_id', txId).maybeSingle();
    if (error) throw error;
    return data || null;
}

// Upsert a lifetime license record, generating a key if one doesn't exist yet
async function upsertLicense(txId, patch) {
    const ex  = await getByTxn(txId);
    const row = { transaction_id: txId, license_key: ex?.license_key || genKey(), updated_at: nowISO(), ...patch };
    const { data, error } = await supabase.from('license_keys').upsert(row, { onConflict: 'transaction_id' }).select().single();
    if (error) throw error;
    return data;
}

// ─── PROP FIRM: REVOKE ALL ACTIVE ACTIVATIONS FOR A MONTHLY MEMBER ───────────
// Called whenever a monthly membership is cancelled/expired.
// Lifetime members KEEP their prop access — this only applies to monthly.
async function revokeMonthlyPropActivations(email) {
    if (!email) return;
    try {
        const { data: props } = await supabase
            .from(PROP_FIRM_TABLE)
            .select('id, nt_license_id')
            .eq('email', email.toLowerCase().trim())
            .eq('status', 'active');
        if (!props || !props.length) return;
        for (const p of props) {
            if (p.nt_license_id) {
                try { await ntRevokeLicense(p.nt_license_id); }
                catch (e) { console.error('[PropRevoke] NT revoke error:', e.message); }
            }
            await supabase.from(PROP_FIRM_TABLE)
                .update({ status: 'revoked', updated_at: nowISO() })
                .eq('id', p.id);
        }
        console.log(`[PropRevoke] ✅ Revoked ${props.length} prop activation(s) for monthly cancel: ${email}`);
    } catch (e) {
        console.error('[PropRevoke] Error revoking prop activations:', e.message);
    }
}

module.exports = { supabase, getByTxn, upsertLicense, revokeMonthlyPropActivations };
