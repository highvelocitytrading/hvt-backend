// routes/licenses.js
// NinjaTrader license check and prop firm activation endpoints.

'use strict';

const express = require('express');
const router  = express.Router();

const {
    MEMBERSHIP_TABLE, LICENSE_TABLE, PROP_FIRM_TABLE
} = require('../config/constants');
const { nowISO }             = require('../helpers/utils');
const { supabase, revokeMonthlyPropActivations } = require('../services/supabase');
const { ntRevokeLicense }    = require('../services/ninjatrader');
const { requireSession }     = require('../middleware/auth');
const { shell, portalNavCss, portalNavHtml } = require('../helpers/html');

// ─── LICENSE CHECK (called by NT indicators) ──────────────────────────────────
// GET /api/license-check?machineId=MACHINEID
router.get('/license-check', async (req, res) => {
    try {
        const machineId = (req.query.machineId || req.query.machine_id || '').trim();
        if (!machineId) return res.json({ authorized: false });

        const { data: prop } = await supabase.from(PROP_FIRM_TABLE).select('id,status,email').eq('machine_id', machineId).eq('status', 'active').limit(1).maybeSingle();
        if (!prop) { console.log('[LicenseCheck] Machine not found: ' + machineId.substring(0,12)); return res.json({ authorized: false }); }

        const email = prop.email;
        const [{ data: mem }, { data: lic }] = await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).maybeSingle(),
            supabase.from(LICENSE_TABLE).select('status').eq('email', email).maybeSingle()
        ]);
        const isLifetime = lic?.status === 'active';
        const isMonthly  = (mem?.status === 'active' || mem?.status === 'pending_cancel') && mem.expires_at && new Date(mem.expires_at) > new Date();

        if (!isLifetime && !isMonthly) {
            revokeMonthlyPropActivations(email).catch(e => console.error('[LicenseCheck revoke]', e.message));
            console.log('[LicenseCheck] Denied ' + email + ' — membership no longer active');
            return res.json({ authorized: false });
        }

        console.log('[LicenseCheck] ✅ Authorized machine: ' + machineId.substring(0,12) + '...');
        res.json({ authorized: true });
    } catch(e) { console.error('[LicenseCheck]', e.message); res.json({ authorized: false }); }
});

// ─── PROP FIRM ACTIVATION: MY ACTIVATIONS ─────────────────────────────────────
router.get('/prop-activations/mine', requireSession, async (req, res) => {
    try {
        const s = req._session;
        const { data, error } = await supabase.from(PROP_FIRM_TABLE).select('email, firm_name, status, created_at, machine_id').eq('email', s.email.toLowerCase()).order('created_at', { ascending: false });
        if (error) return res.status(500).json({ ok: false, error: error.message });
        res.json({ ok: true, activations: data || [] });
    } catch(e) { console.error('[PropMine]', e.message); res.status(500).json({ ok: false, error: 'Server error.' }); }
});

// ─── PROP FIRM ACTIVATION: SUBMIT ─────────────────────────────────────────────
router.post('/prop-activation', requireSession, express.json(), async (req, res) => {
    try {
        const s = req._session;
        const { email: bodyEmail, machineId, firmName } = req.body || {};
        if (!bodyEmail || !machineId || !firmName) return res.status(400).json({ ok: false, error: 'Email, Machine ID and prop firm are all required.' });
        if (machineId.trim().length > 200) return res.status(400).json({ ok: false, error: 'Machine ID too long.' });
        if (firmName.trim().length > 100)  return res.status(400).json({ ok: false, error: 'Firm name too long.' });

        const cleanEmail    = s.email.trim().toLowerCase();
        const submittedEmail = bodyEmail.trim().toLowerCase();
        if (submittedEmail !== cleanEmail) return res.status(403).json({ ok: false, error: 'The email you entered does not match your HVT account. Please use the email you signed up with.' });

        const cleanMachine = machineId.trim();
        const cleanFirm    = firmName.trim();

        const [{ data: m1 }, { data: m2 }] = await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).select('email,status,expires_at').eq('email', cleanEmail).maybeSingle(),
            supabase.from(LICENSE_TABLE).select('email,status').eq('email', cleanEmail).maybeSingle()
        ]);
        const isMonthly  = (m1?.status === 'active' || m1?.status === 'pending_cancel') && new Date(m1.expires_at) > new Date();
        const isLifetime = m2?.status === 'active';
        if (!isMonthly && !isLifetime) return res.status(403).json({ ok: false, error: 'No active HVT membership found for this email. Please check your email or contact support.' });

        const { data: existingMachine } = await supabase.from(PROP_FIRM_TABLE).select('id,machine_id,firm_name,status').eq('machine_id', cleanMachine).eq('status', 'active').limit(1).maybeSingle();
        if (existingMachine) {
            if (!isMonthly && !isLifetime) { await revokeMonthlyPropActivations(cleanEmail); return res.status(403).json({ ok: false, error: 'Your HVT membership has expired. Please renew to access prop firm features.' }); }
            console.log('[PropActivation] Returning existing machine activation: ' + cleanMachine);
            return res.json({ ok: true, alreadyActive: true, machineId: cleanMachine, firmName: existingMachine.firm_name });
        }

        const { error: dbErr } = await supabase.from(PROP_FIRM_TABLE).insert({
            email: cleanEmail, member_name: s.full_name || s.name || '', firm_name: cleanFirm,
            machine_id: cleanMachine, status: 'active', created_at: nowISO(), updated_at: nowISO()
        });
        if (dbErr) { console.error('[PropActivation] DB insert error:', dbErr.message); return res.status(500).json({ ok: false, error: 'Could not save activation: ' + dbErr.message }); }

        console.log('[PropActivation] ✅ ' + cleanEmail + ' | ' + cleanFirm + ' | machine=' + cleanMachine);
        res.json({ ok: true, machineId: cleanMachine, firmName: cleanFirm });
    } catch(e) { console.error('[PropActivation] Fatal:', e.message); res.status(500).json({ ok: false, error: 'Server error. Please try again.' }); }
});

// ─── PROP FIRM ACTIVATION: PAGE ───────────────────────────────────────────────
router.get('/prop-activation', requireSession, (req, res) => {
    const s = req._session;
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon.png?v=1">
<title>Activate Prop Account – High Velocity Trading</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#000;min-height:100vh;color:#fff;padding:130px 20px 60px;overflow-x:hidden}
.bg{position:fixed;inset:0;z-index:0;pointer-events:none;background:#000}
.bg::before{content:'';position:absolute;top:0;left:0;width:65%;height:65%;background:radial-gradient(ellipse at 15% 30%,#00001C 0%,transparent 65%)}
${portalNavCss()}
.content{position:relative;z-index:1;max-width:620px;margin:0 auto}
.hero{text-align:center;margin-bottom:28px}
.hero-pill{display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.25);border-radius:999px;color:#2254F5;font-size:11px;letter-spacing:3px;text-transform:uppercase;padding:6px 18px;margin-bottom:14px}
.hero h1{font-size:26px;font-weight:800;color:#fff;margin-bottom:8px;letter-spacing:-.3px}
.hero p{color:#64748b;font-size:14px;line-height:1.6}
.hero-div{height:1px;background:linear-gradient(90deg,transparent,rgba(34,84,245,0.3),transparent);margin:16px auto 0;max-width:160px}
.card{background:rgba(255,255,255,0.03);border:1px solid rgba(34,84,245,0.2);border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.6)}
.ct{height:3px;background:linear-gradient(90deg,#2254F5,#2254F5)}
.cb{padding:32px}
.field-label{display:block;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:8px}
.field-input{width:100%;padding:13px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:#fff;font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s;margin-bottom:20px;font-family:'DM Sans',sans-serif}
.field-input:focus{border-color:#2254F5;box-shadow:0 0 0 3px rgba(34,84,245,0.2)}
.field-input::placeholder{color:#334155}
.submit-btn{width:100%;padding:14px;background:#2254F5;color:#fff;border:none;border-radius:999px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 20px rgba(34,84,245,0.3);transition:opacity .2s,transform .1s}
.submit-btn:hover{opacity:.9;transform:translateY(-1px)}
.submit-btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
.msg{margin-top:16px;padding:12px 16px;border-radius:12px;font-size:13px;text-align:center;display:none;line-height:1.5}
.msg.show{display:block}
.msg.ok{background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2)}
.msg.er{background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2)}
.info-box{background:rgba(34,84,245,0.04);border:1px solid rgba(34,84,245,0.12);border-radius:12px;padding:16px 20px;margin-bottom:24px}
.info-box p{color:#64748b;font-size:13px;line-height:1.7;margin:0}
.info-box strong{color:#94a3b8}
.divider{height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.08),transparent);margin:24px 0}
.section-lbl{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#475569;margin-bottom:16px}
.acts-list{display:flex;flex-direction:column;gap:8px}
.act-row{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;gap:12px}
.act-firm{font-size:14px;font-weight:600;color:#fff}
.act-mid{font-size:11px;color:#475569;font-family:monospace}
.act-status{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:3px 10px;border-radius:4px}
.act-status.active{background:rgba(74,222,128,0.1);color:#4ade80;border:1px solid rgba(74,222,128,0.2)}
.act-status.revoked{background:rgba(248,113,113,0.1);color:#f87171;border:1px solid rgba(248,113,113,0.2)}
.empty-state{text-align:center;padding:24px;color:#334155;font-size:13px}
</style></head><body>
<div class="bg" aria-hidden="true"></div>
${portalNavHtml()}
<div class="content">
  <div class="hero">
    <span class="hero-pill">PROP FIRM ACTIVATION</span>
    <h1>Activate Your Prop Account</h1>
    <p>Register your Machine ID to enable HVT indicator access on your prop firm account.</p>
    <div class="hero-div"></div>
  </div>

  <div class="card">
    <div class="ct"></div>
    <div class="cb">
      <div class="info-box">
        <p>&#9888;&nbsp; <strong>Important:</strong> Use the prop firm version of the HVT package — not the personal version. Your Machine ID is found in the NinjaTrader indicator settings after import.</p>
      </div>
      <div class="section-lbl">Activate New Account</div>
      <label class="field-label" for="email">Your HVT Account Email</label>
      <input class="field-input" type="email" id="email" placeholder="${s.email}" value="${s.email}" />
      <label class="field-label" for="machineId">Machine ID</label>
      <input class="field-input" type="text" id="machineId" placeholder="Paste your Machine ID here" />
      <label class="field-label" for="firmName">Prop Firm Name</label>
      <input class="field-input" type="text" id="firmName" placeholder="e.g. Apex, Topstep, Bulenox" />
      <button class="submit-btn" id="submitBtn" onclick="activate()">Activate Machine ID</button>
      <div class="msg" id="msg"></div>

      <div class="divider"></div>

      <div class="section-lbl">Your Activations</div>
      <div id="actsList"><div class="empty-state">Loading...</div></div>
    </div>
  </div>
</div>
<script>
async function activate(){
  const email=document.getElementById('email').value.trim();
  const machineId=document.getElementById('machineId').value.trim();
  const firmName=document.getElementById('firmName').value.trim();
  const msg=document.getElementById('msg');
  const btn=document.getElementById('submitBtn');
  msg.className='msg';
  if(!email){msg.className='msg er show';msg.textContent='Please enter your HVT account email.';return;}
  if(!machineId){msg.className='msg er show';msg.textContent='Please paste your Machine ID.';return;}
  if(!firmName){msg.className='msg er show';msg.textContent='Please enter your prop firm name.';return;}
  btn.disabled=true;btn.textContent='Activating...';
  try{
    const r=await fetch('/prop-activation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,machineId,firmName})});
    const d=await r.json();
    if(r.ok&&d.ok){
      msg.className='msg ok show';
      msg.textContent=d.alreadyActive?'\u2713 Already activated for '+d.firmName+'.':'\u2713 Activated! Your '+d.firmName+' account is ready. Install the prop firm package and open NinjaTrader.';
      document.getElementById('machineId').value='';
      document.getElementById('firmName').value='';
      loadActivations();
    } else {
      msg.className='msg er show';msg.textContent=d.error||'Something went wrong.';
    }
  }catch{msg.className='msg er show';msg.textContent='Network error. Please try again.';}
  finally{btn.disabled=false;btn.textContent='Activate Machine ID';}
}
async function loadActivations(){
  const list=document.getElementById('actsList');
  try{
    const r=await fetch('/prop-activations/mine');
    const d=await r.json();
    if(!d.ok||!d.activations||!d.activations.length){list.innerHTML='<div class="empty-state">No activations yet.</div>';return;}
    list.innerHTML=d.activations.map(a=>'<div class="act-row"><div><div class="act-firm">'+esc(a.firm_name)+'</div><div class="act-mid">'+(a.machine_id?a.machine_id.substring(0,14)+'...':'No machine ID')+'</div></div><span class="act-status '+(a.status||'')+'">'+esc(a.status)+'</span></div>').join('');
  }catch{list.innerHTML='<div class="empty-state">Could not load activations.</div>';}
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
document.getElementById('machineId').addEventListener('keydown',e=>{if(e.key==='Enter')activate();});
loadActivations();
</script>
</body></html>`);
});

module.exports = router;
