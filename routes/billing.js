// routes/billing.js
// Billing portal, session-based billing, cancellation flow, and subscription management.

'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const cancel  = express.Router();

const { MEMBERSHIP_TABLE, LICENSE_TABLE } = require('../config/constants');
const { nowISO }           = require('../helpers/utils');
const { supabase }         = require('../services/supabase');
const { cancelSub }        = require('../services/payment');
const { sendMagicLink, sendCancelConfirmEmail } = require('../services/email');
const { shell, resultPage }                     = require('../helpers/html');

// ─── BILLING PORTAL PAGE ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
    res.send(shell('Billing Portal', `
    <div class="card"><div class="ct"></div><div class="cb">
      <div class="ttl">Billing Portal</div>
      <div class="sub">Enter your email and we'll send a secure link to your billing dashboard.</div>
      <div class="div"></div>
      <label for="email">Email Address</label>
      <input type="email" id="email" placeholder="your@email.com" />
      <button class="btn" id="btn" onclick="go()">Send Access Link</button>
      <div class="msg" id="msg"></div>
    </div></div>
    <script>
      async function go(){const email=document.getElementById('email').value.trim();const msg=document.getElementById('msg');const btn=document.getElementById('btn');msg.className='msg';if(!email){msg.className='msg er show';msg.textContent='Please enter your email.';return}btn.disabled=true;btn.textContent='Sending...';try{const r=await fetch('/billing/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\u2713 Check your email! A secure link has been sent.';btn.textContent='Email Sent'}else{msg.className='msg er show';msg.textContent=d.error||'Something went wrong.';btn.disabled=false;btn.textContent='Send Access Link'}}catch{msg.className='msg er show';msg.textContent='Network error.';btn.disabled=false;btn.textContent='Send Access Link'}}
    </script>`));
});

// ─── BILLING: SEND MAGIC LINK ─────────────────────────────────────────────────
router.post('/request', express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,status').eq('email', email).maybeSingle();
        if (!data) return res.status(404).json({ error: 'No membership found for this email' });
        const token   = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000).toISOString();
        await supabase.from(MEMBERSHIP_TABLE).update({ billing_token: token, billing_token_expires: expires, updated_at: nowISO() }).eq('email', email);
        await sendMagicLink(email, token, 'billing');
        res.json({ ok: true });
    } catch (e) { console.error('[BillingReq]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

// ─── BILLING: CONFIRM MAGIC LINK ──────────────────────────────────────────────
router.get('/confirm', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid.'));
    try {
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,expires_at,billing_token_expires').eq('billing_token', token).maybeSingle();
        if (!data) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid or has expired.'));
        if (!data.billing_token_expires || new Date(data.billing_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/billing" style="color:#2254F5;">Request a new one</a>.'));
        const { status, email, full_name: name = 'Member', expires_at } = data;
        const exAt    = expires_at ? new Date(expires_at) : null;
        const sc      = (status === 'active' || status === 'pending_cancel') ? '#4ade80' : '#f87171';
        const sb      = (status === 'active' || status === 'pending_cancel') ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)';
        const sbd     = status === 'active' ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)';
        const next    = exAt ? exAt.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }) : 'N/A';
        const days    = exAt ? Math.max(0, Math.ceil((exAt - new Date()) / 86400000)) : 0;
        const cancel  = status === 'active' ? `<div style="margin-top:24px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);"><p style="color:#334155;font-size:12px;text-align:center;margin-bottom:16px;">Want to cancel?</p><a href="/cancel" style="display:block;width:100%;padding:12px;background:transparent;border:1px solid rgba(248,113,113,0.3);color:#f87171;border-radius:999px;font-size:14px;font-weight:700;text-align:center;text-decoration:none;">Cancel Membership</a></div>` : `<div style="margin-top:24px;text-align:center;"><p style="color:#64748b;font-size:13px;">Membership is no longer active.</p></div>`;
        res.send(shell('My Billing', `
        <div class="card" style="max-width:480px;width:100%;"><div class="ct"></div><div class="cb">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
            <div>
              <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:4px;">Welcome back</div>
              <div style="font-size:22px;font-weight:700;color:#fff;">${name}</div>
            </div>
            <div style="background:${sb};border:1px solid ${sbd};border-radius:20px;padding:6px 14px;font-size:12px;color:${sc};font-weight:600;">${status === 'active' ? '&#9679; Active' : status}</div>
          </div>
          <div class="div"></div>
          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Plan</span><span style="color:#94a3b8;font-size:13px;">HVT Monthly Membership</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Email</span><span style="color:#94a3b8;font-size:13px;">${email}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Next Billing</span><span style="color:#94a3b8;font-size:13px;">${next}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;"><span style="color:#64748b;font-size:13px;">Days Remaining</span><span style="color:${days > 7 ? '#4ade80' : '#f6ad55'};font-size:13px;font-weight:600;">${days} days</span></div>
          </div>${cancel}
        </div></div>`));
    } catch (e) { console.error('[BillingConfirm]', e.message); res.send(resultPage('error', 'Error', 'Something went wrong.')); }
});

// ─── BILLING: CONFIRM VIA SESSION (skips magic link for logged-in members) ────
router.get('/confirm-session', async (req, res, next) => {
    const { getSessionAsync } = require('../middleware/auth');
    const _s = await getSessionAsync(req);
    if (_s) { req._session = _s; return next(); }
    res.redirect('/login');
}, async (req, res) => {
    const s = req._session;
    let status = 'active', exAt = null, nextLabel = 'N/A', days = 0, isLifetime = false;
    let cancelHtml = `<div style="margin-top:24px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);"><p style="color:#334155;font-size:12px;text-align:center;margin-bottom:16px;">Want to cancel?</p><a href="/cancel" style="display:block;width:100%;padding:12px;background:transparent;border:1px solid rgba(248,113,113,0.3);color:#f87171;border-radius:999px;font-size:14px;font-weight:700;text-align:center;text-decoration:none;">Cancel Membership</a></div>`;
    try {
        const [{ data: mem }, { data: lic }] = await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', s.email).maybeSingle(),
            supabase.from(LICENSE_TABLE).select('status').eq('email', s.email).maybeSingle()
        ]);
        isLifetime = lic?.status === 'active';
        if (isLifetime) {
            status = 'active'; nextLabel = 'Lifetime'; days = 99999;
        } else if (mem) {
            status = mem.status || 'inactive';
            exAt = mem.expires_at ? new Date(mem.expires_at) : null;
            nextLabel = exAt ? exAt.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : 'N/A';
            days = exAt ? Math.max(0, Math.ceil((exAt - new Date()) / 86400000)) : 0;
            if (status === 'active' && exAt && exAt < new Date()) { status = 'expired'; days = 0; }
        } else {
            status = 'ended';
        }
        if (status !== 'active') {
            cancelHtml = `<div style="margin-top:24px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;"><p style="color:#64748b;font-size:13px;line-height:1.6;">Your membership has ended. To reactivate, visit <a href="https://highvelocitytrading.com/#packages" style="color:#2254F5;text-decoration:none;font-weight:600;">highvelocitytrading.com</a> or call <strong style="color:#94a3b8;">786-461-4235</strong>.</p></div>`;
        }
    } catch (e) { console.error('[BillingSession]', e.message); status = 'error'; }
    const statusLabels = { active: '&#9679; Active', cancelled: 'Membership Ended', expired: 'Membership Ended', ended: 'Membership Ended', inactive: 'Membership Ended', error: 'Unable to Load' };
    const statusLabel = statusLabels[status] || 'Membership Ended';
    const isActive = (status === 'active' || status === 'pending_cancel');
    const sc = isActive ? '#4ade80' : '#f87171';
    const sb = isActive ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)';
    const sbd = isActive ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)';
    const daysDisplay = isLifetime ? '<span style="color:#f6ad55;font-size:13px;font-weight:600;">Lifetime</span>' : `<span style="color:${days > 7 ? '#4ade80' : (days > 0 ? '#f6ad55' : '#f87171')};font-size:13px;font-weight:600;">${days > 0 ? days + ' days' : 'Expired'}</span>`;
    res.send(shell('Billing', `
        <div class="card" style="max-width:480px;width:100%;"><div class="ct"></div><div class="cb">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <a href="/member" style="color:#2254F5;font-size:13px;text-decoration:none;">&larr; Back to Portal</a>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;margin-top:16px;">
            <div>
              <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:4px;">Welcome back</div>
              <div style="font-size:22px;font-weight:700;color:#fff;">${s.name}</div>
            </div>
            <div style="background:${sb};border:1px solid ${sbd};border-radius:20px;padding:6px 14px;font-size:12px;color:${sc};font-weight:600;">${statusLabel}</div>
          </div>
          <div class="div"></div>
          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Plan</span><span style="color:#94a3b8;font-size:13px;">${s.plan}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Email</span><span style="color:#94a3b8;font-size:13px;">${s.email}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#64748b;font-size:13px;">Next Billing</span><span style="color:#94a3b8;font-size:13px;">${nextLabel}</span></div>
            <div style="display:flex;justify-content:space-between;padding:14px 18px;"><span style="color:#64748b;font-size:13px;">Days Remaining</span>${daysDisplay}</div>
          </div>${cancelHtml}
        </div></div>`, {pill:'BILLING', title:'Your Membership', sub:'Manage your plan and billing details below.'}));
});

// ─── CANCEL ROUTER ────────────────────────────────────────────────────────────
// Mounted at /cancel in index.js

cancel.get('/', (req, res) => {
    res.send(shell('Cancel Membership', `
    <div class="card">
      <div class="ct" style="background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d);"></div>
      <div class="cb">
        <div class="ttl">Cancel Membership</div>
        <div class="sub">Enter your email and we'll send a secure one-time cancellation link.</div>
        <div class="div"></div>
        <label for="email">Email Address</label>
        <input type="email" id="email" placeholder="your@email.com" />
        <button class="btn btn-red" id="btn" onclick="go()">Send Cancellation Link</button>
        <div class="msg" id="msg"></div>
      </div>
    </div>
    <script>
      async function go(){const email=document.getElementById('email').value.trim();const msg=document.getElementById('msg');const btn=document.getElementById('btn');msg.className='msg';if(!email){msg.className='msg er show';msg.textContent='Please enter your email.';return}btn.disabled=true;btn.textContent='Sending...';try{const r=await fetch('/cancel/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\u2713 Check your email! A secure cancellation link has been sent.';btn.textContent='Email Sent'}else{msg.className='msg er show';msg.textContent=d.error||'Something went wrong.';btn.disabled=false;btn.textContent='Send Cancellation Link'}}catch{msg.className='msg er show';msg.textContent='Network error.';btn.disabled=false;btn.textContent='Send Cancellation Link'}}
    </script>`));
});

cancel.post('/request', express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,status').eq('email', email).maybeSingle();
        if (!data) return res.status(404).json({ error: 'No membership found for this email' });
        if (data.status === 'cancelled') return res.status(400).json({ error: 'This membership is already cancelled' });
        const token   = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000).toISOString();
        await supabase.from(MEMBERSHIP_TABLE).update({ cancel_token: token, cancel_token_expires: expires, updated_at: nowISO() }).eq('email', email);
        await sendMagicLink(email, token, 'cancel');
        res.json({ ok: true });
    } catch (e) { console.error('[CancelReq]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

cancel.get('/confirm', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid.'));
    try {
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('email,status,authnet_subscription_id,cancel_token_expires,discord_user_id,nt_license_id,expires_at').eq('cancel_token', token).maybeSingle();
        if (!data) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid or has expired.'));
        if (new Date(data.cancel_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/cancel" style="color:#f87171;">Request a new one</a>.'));
        if (data.status === 'cancelled') return res.send(resultPage('info', 'Already Cancelled', 'Your membership is already cancelled.'));
        if (data.authnet_subscription_id) try { await cancelSub(data.authnet_subscription_id); } catch (e) { console.error('[CancelSub]', e.message); }
        const cancelsAt = data.expires_at || nowISO();
        await supabase.from(MEMBERSHIP_TABLE).update({
            status: 'pending_cancel', cancels_at: cancelsAt,
            cancel_token: null, cancel_token_expires: null, updated_at: nowISO()
        }).eq('cancel_token', token);
        try { await sendCancelConfirmEmail(data.email, cancelsAt); } catch (e) { console.error('[CancelConfirm email]', e.message); }
        console.log('[CancelConfirm] Pending cancel: ' + data.email + ' — access until ' + cancelsAt);
        const expDateStr = new Date(cancelsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        res.send(resultPage('success', 'Cancellation Confirmed', 'Your subscription has been cancelled. No future charges will occur.<br><br>You have full access to everything until <strong style="color:#fff;">' + expDateStr + '</strong>. After that your account will be automatically closed.'));
    } catch (e) { console.error('[CancelConfirm]', e.message); res.send(resultPage('error', 'Error', 'Something went wrong. Please contact support.')); }
});

module.exports = { billingRouter: router, cancelRouter: cancel };
