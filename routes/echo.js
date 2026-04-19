// routes/echo.js
// HVT Echo copy-trader public endpoints: license validation.

'use strict';

const express = require('express');
const router  = express.Router();

const { ECHO_TABLE } = require('../config/constants');
const { rateLimit }  = require('../middleware/rateLimiter');
const { nowISO }     = require('../helpers/utils');
const { supabase }   = require('../services/supabase');

// ─── ECHO LICENSE VALIDATION (called by NinjaScript add-on) ─────────────────
// POST /validate
// Body: { license_key, machine_id, version }
router.post('/validate', rateLimit({ windowMs: 60000, max: 30 }), express.json(), async (req, res) => {
    try {
        const { license_key, machine_id, version = '1.0.0' } = req.body || {};
        if (!license_key || !machine_id) return res.status(400).json({ valid: false, message: 'License key and machine ID are required.' });

        const { data: license, error } = await supabase.from(ECHO_TABLE).select('id, email, status, machine_id, license_key').eq('license_key', license_key.trim().toUpperCase()).maybeSingle();
        if (error) { console.error('[EchoValidate] DB error:', error.message); return res.status(500).json({ valid: false, message: 'Server error. Please try again.' }); }

        if (!license) { console.log(`[EchoValidate] Key not found: ${license_key}`); return res.json({ valid: false, message: 'License key not found. Please check your key or contact support at 786-461-4235.' }); }
        if (license.status === 'cancelled') { console.log(`[EchoValidate] Cancelled key: ${license_key}`); return res.json({ valid: false, message: 'This license has been cancelled. Visit highvelocitytrading.com to reactivate.' }); }

        if (!license.machine_id) {
            const { error: updateErr } = await supabase.from(ECHO_TABLE).update({ machine_id: machine_id.trim(), updated_at: nowISO() }).eq('id', license.id);
            if (updateErr) { console.error('[EchoValidate] Machine ID save error:', updateErr.message); return res.status(500).json({ valid: false, message: 'Server error. Please try again.' }); }
            console.log(`[EchoValidate] ✅ First activation — machine registered: ${license.email} | ${machine_id.substring(0, 12)}...`);
            return res.json({ valid: true, message: 'License activated successfully. Welcome to HVT Echo.', plan: 'one_time' });
        }

        if (license.machine_id.trim() !== machine_id.trim()) {
            console.log(`[EchoValidate] Machine ID mismatch for ${license.email}`);
            return res.json({ valid: false, message: 'This license is registered to a different machine. Contact support at 786-461-4235 to transfer your license.' });
        }

        console.log(`[EchoValidate] ✅ Valid: ${license.email} | machine match`);
        return res.json({ valid: true, message: 'License active.', plan: 'one_time' });
    } catch (e) { console.error('[EchoValidate] Fatal:', e.message); res.status(500).json({ valid: false, message: 'Server error. Please try again.' }); }
});

module.exports = router;
