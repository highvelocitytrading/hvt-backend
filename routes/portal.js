// routes/portal.js
// Member portal, course, trading room, downloads, journal, login/logout, and shop routes.

'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const {
    MEMBERSHIP_TABLE, LICENSE_TABLE, DISCORD_TABLE, ECHO_TABLE,
    JOURNAL_TABLE, DISCORD_INVITE_URL, DISCORD_ROOM_CHECKOUT_URL,
    DISCORD_MONTHLY_ROLE_ID, DISCORD_LIFETIME_ROLE_ID, DISCORD_ROOM_ROLE_ID,
    DEMO_MODE
} = require('../config/constants');
const { nowISO }                                    = require('../helpers/utils');
const { supabase }                                  = require('../services/supabase');
const { findUser, addRole }                         = require('../services/discord');
const { ntCreateLicense }                           = require('../services/ninjatrader');
const { sendCourseEmail }                           = require('../services/email');
const {
    SESSION_COOKIE: AUTH_COOKIE, _sessions,
    createSession, getSessionFromCookie, getSessionAsync, requireSession
}                                                   = require('../middleware/auth');
const { shell, resultPage, memberPortalHtml, ninjaLogoSVG } = require('../helpers/html');
const { frm, rateLimit }                            = require('../middleware/rateLimiter');

// ─── CHECK ACCESS (external Jotform check) ────────────────────────────────────
router.get('/check-access', frm, async (req, res) => {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ active: false });
    try {
        const { data } = await supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).maybeSingle();
        res.json({ active: (data?.status === 'active' || data?.status === 'pending_cancel') && new Date(data.expires_at) > new Date() });
    } catch (e) { console.error('[CheckAccess]', e.message); res.status(500).json({ active: false }); }
});

// ─── DOWNLOADS ────────────────────────────────────────────────────────────────
router.get('/downloads/installer', frm, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
    try {
        const { data, error } = await supabase.storage.from('uploads').createSignedUrl('HVTMasterAccessNQ.zip', 300);
        if (error) {
            console.error('[DownloadInstaller] Signed URL error:', error.message, error.statusCode || '');
            const { data: pub } = supabase.storage.from('uploads').getPublicUrl('HVTMasterAccessNQ.zip');
            if (pub?.publicUrl) { console.log('[DownloadInstaller] Falling back to public URL'); return res.redirect(302, pub.publicUrl); }
            return res.status(500).json({ error: 'Download unavailable. Please contact support.', detail: error.message });
        }
        return res.redirect(302, data.signedUrl + (data.signedUrl.includes('?') ? '&' : '?') + 'download=HVTMasterAccessNQ.zip');
    } catch (e) { console.error('[DownloadInstaller] Exception:', e.message); return res.status(500).json({ error: 'Download unavailable. Please contact support.' }); }
});

router.get('/downloads/template', frm, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
    try {
        const { data, error } = await supabase.storage.from('uploads').createSignedUrl('HVT NQ TEMPLATE.xml', 300);
        if (error) {
            console.error('[DownloadTemplate] Signed URL error:', error.message, error.statusCode || '');
            const { data: pub } = supabase.storage.from('uploads').getPublicUrl('HVT NQ TEMPLATE.xml');
            if (pub?.publicUrl) { console.log('[DownloadTemplate] Falling back to public URL'); return res.redirect(302, pub.publicUrl + '?download=HVT_NQ_TEMPLATE.xml'); }
            return res.status(500).json({ error: 'Download unavailable. Please contact support.', detail: error.message });
        }
        return res.redirect(302, data.signedUrl + (data.signedUrl.includes('?') ? '&' : '?') + 'download=HVT_NQ_TEMPLATE.xml');
    } catch (e) { console.error('[DownloadTemplate] Exception:', e.message); return res.status(500).json({ error: 'Download unavailable. Please contact support.' }); }
});

router.get('/downloads/prop-installer', requireSession, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
    try {
        const { data, error } = await supabase.storage.from('uploads').createSignedUrl('HVTPROPNQ.zip', 300);
        if (error) {
            console.error('[DownloadPropInstaller] Signed URL error:', error.message);
            const { data: pub } = supabase.storage.from('uploads').getPublicUrl('HVTPROPNQ.zip');
            if (pub?.publicUrl) return res.redirect(302, pub.publicUrl);
            return res.status(500).json({ error: 'Download unavailable. Please contact support.', detail: error.message });
        }
        console.log('[DownloadPropInstaller] Downloaded by: ' + req._session?.email);
        return res.redirect(302, data.signedUrl + (data.signedUrl.includes('?') ? '&' : '?') + 'download=HVTPROPNQ.zip');
    } catch (e) { console.error('[DownloadPropInstaller] Exception:', e.message); return res.status(500).json({ error: 'Download unavailable. Please contact support.' }); }
});

router.get('/downloads/es-installer', frm, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
    try {
        const { data, error } = await supabase.storage.from('uploads').createSignedUrl('HVTMASTERACCESSES.zip', 300);
        if (error) {
            const { data: pub } = supabase.storage.from('uploads').getPublicUrl('HVTMASTERACCESSES.zip');
            if (pub?.publicUrl) return res.redirect(302, pub.publicUrl);
            return res.status(500).json({ error: 'Download unavailable. Please contact support.', detail: error.message });
        }
        console.log('[DownloadESInstaller] Downloaded by: ' + (req._session?.email || 'guest'));
        return res.redirect(302, data.signedUrl + (data.signedUrl.includes('?') ? '&' : '?') + 'download=HVTMASTERACCESSES.zip');
    } catch (e) { console.error('[DownloadESInstaller] Exception:', e.message); return res.status(500).json({ error: 'Download unavailable. Please contact support.' }); }
});

router.get('/downloads/es-prop-installer', requireSession, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
    try {
        const { data, error } = await supabase.storage.from('uploads').createSignedUrl('HVTPROPES.zip', 300);
        if (error) {
            const { data: pub } = supabase.storage.from('uploads').getPublicUrl('HVTPROPES.zip');
            if (pub?.publicUrl) return res.redirect(302, pub.publicUrl);
            return res.status(500).json({ error: 'Download unavailable. Please contact support.', detail: error.message });
        }
        console.log('[DownloadESPropInstaller] Downloaded by: ' + req._session?.email);
        return res.redirect(302, data.signedUrl + (data.signedUrl.includes('?') ? '&' : '?') + 'download=HVTPROPES.zip');
    } catch (e) { console.error('[DownloadESPropInstaller] Exception:', e.message); return res.status(500).json({ error: 'Download unavailable. Please contact support.' }); }
});

router.get('/downloads/echo', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
    const email   = req.query.email?.toLowerCase()?.trim();
    const license = req.query.license?.toUpperCase()?.trim();
    if (!email || !license) return res.status(400).json({ error: 'Email and license key required. Use: /downloads/echo?email=your@email.com&license=ECHO-XXXX-XXXX-XXXX' });
    try {
        const { data: echoLicense } = await supabase.from(ECHO_TABLE).select('status, license_key').eq('email', email).eq('license_key', license).maybeSingle();
        if (!echoLicense || echoLicense.status !== 'active') return res.status(403).json({ error: 'Invalid or inactive Echo license. Purchase at highvelocitytrading.com' });
        const { data, error } = await supabase.storage.from('uploads').createSignedUrl('HVTECHO.zip', 300);
        if (error) {
            const { data: pub } = supabase.storage.from('uploads').getPublicUrl('HVTECHO.zip');
            if (pub?.publicUrl) return res.redirect(302, pub.publicUrl + '?download=HVTECHO.zip');
            return res.status(500).json({ error: 'Download unavailable. Please contact support.', detail: error.message });
        }
        console.log(`[DownloadEcho] Downloaded by: ${email} | License: ${license}`);
        return res.redirect(302, data.signedUrl + (data.signedUrl.includes('?') ? '&' : '?') + 'download=HVTECHO.zip');
    } catch (e) { console.error('[DownloadEcho] Exception:', e.message); return res.status(500).json({ error: 'Download unavailable. Please contact support.' }); }
});

router.get('/downloads/es-template', frm, async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured.' });
    try {
        const { data, error } = await supabase.storage.from('uploads').createSignedUrl('HVT_ES_TEMPLATE.xml', 300);
        if (error) {
            const { data: pub } = supabase.storage.from('uploads').getPublicUrl('HVT_ES_TEMPLATE.xml');
            if (pub?.publicUrl) return res.redirect(302, pub.publicUrl + '?download=HVT_ES_TEMPLATE.xml');
            return res.status(500).json({ error: 'Download unavailable. Please contact support.', detail: error.message });
        }
        return res.redirect(302, data.signedUrl + (data.signedUrl.includes('?') ? '&' : '?') + 'download=HVT_ES_TEMPLATE.xml');
    } catch (e) { console.error('[DownloadESTemplate] Exception:', e.message); return res.status(500).json({ error: 'Download unavailable. Please contact support.' }); }
});

// ─── TRADING ROOM — GET STARTED PAGE ─────────────────────────────────────────
router.get('/trading-room', (req, res) => {
    res.send(shell('Get Started', `
<style>
.gs-wrap{width:100%;max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:16px;position:relative;z-index:1;}
.gs-markets-row{display:flex;flex-direction:row;gap:16px;align-items:stretch;width:100%;max-width:1100px;margin:0 auto;}
.gs-markets-row .gs-step{flex:1;min-width:0;margin:0;}
@media(max-width:860px){.gs-markets-row{flex-direction:column;max-width:560px;}}
.gs-step{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden;transition:border-color .2s;}
.gs-step.done{border-color:rgba(74,222,128,0.35);}
.gs-head{display:flex;align-items:center;gap:16px;padding:22px 24px;}
.gs-num{width:36px;height:36px;border-radius:50%;background:rgba(34,84,245,0.15);border:1px solid rgba(34,84,245,0.3);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#2254F5;flex-shrink:0;transition:all .3s;}
.gs-step.done .gs-num{background:rgba(74,222,128,0.15);border-color:rgba(74,222,128,0.4);color:#4ade80;}
.gs-head-text{flex:1;}
.gs-title{font-size:16px;font-weight:700;color:#fff;margin-bottom:3px;}
.gs-subtitle{font-size:13px;color:#64748b;line-height:1.5;}
.gs-check{width:22px;height:22px;border-radius:50%;background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.3);display:none;align-items:center;justify-content:center;color:#4ade80;font-size:13px;flex-shrink:0;}
.gs-step.done .gs-check{display:flex;}
.gs-body{padding:0 24px 24px;}
.gs-divider{height:1px;background:rgba(255,255,255,0.06);margin-bottom:20px;}
.gs-btn{width:100%;padding:13px;border:none;border-radius:12px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;transition:all .2s;letter-spacing:0.3px;}
.gs-btn-blue{background:#2254F5;color:#fff;box-shadow:0 4px 16px rgba(34,84,245,0.3);}
.gs-btn-blue:hover{background:#1d47d4;transform:translateY(-1px);}
.gs-btn-blue:disabled{opacity:.4;cursor:not-allowed;transform:none;}
.gs-btn-discord{background:#5865F2;color:#fff;box-shadow:0 4px 16px rgba(88,101,242,0.3);display:flex;align-items:center;justify-content:center;gap:12px;}
.gs-btn-discord:hover{background:#4752c4;transform:translateY(-1px);}
.gs-input{width:100%;padding:13px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:#fff;font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s;margin-bottom:12px;font-family:'DM Sans',sans-serif;}
.gs-input:focus{border-color:#2254F5;box-shadow:0 0 0 3px rgba(34,84,245,0.2);}
.gs-input::placeholder{color:#334155;}
.gs-label{display:block;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#475569;margin-bottom:8px;}
.gs-msg{margin-top:12px;padding:12px 16px;border-radius:10px;font-size:13px;text-align:center;display:none;line-height:1.5;}
.gs-msg.show{display:block;}
.gs-msg.ok{background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2);}
.gs-msg.er{background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2);}
.gs-dl-row{display:flex;flex-direction:column;gap:10px;}
.gs-dl-btn{display:flex;align-items:center;gap:12px;padding:14px 18px;background:rgba(34,84,245,0.06);border:1px solid rgba(34,84,245,0.18);border-radius:12px;color:#fff;text-decoration:none;font-size:14px;font-weight:600;transition:all .2s;}
.gs-dl-btn:hover{background:rgba(34,84,245,0.12);border-color:rgba(34,84,245,0.35);transform:translateX(3px);}
.gs-dl-icon{width:36px;height:36px;border-radius:9px;background:rgba(34,84,245,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.gs-dl-text{flex:1;}
.gs-dl-name{font-size:14px;font-weight:700;color:#fff;}
.gs-dl-desc{font-size:12px;color:#64748b;margin-top:1px;}
.gs-tip{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px 16px;margin-top:12px;}
.gs-tip p{color:#475569;font-size:12px;margin:0;line-height:1.7;}
.gs-nt-signup{display:inline-flex;align-items:center;justify-content:center;gap:8px;margin:12px auto 0 auto;padding:10px 18px;background:#D9452A;color:#fff;border-radius:9px;font-size:13px;font-weight:800;letter-spacing:1px;text-decoration:none;box-shadow:0 4px 14px rgba(217,69,42,0.35);transition:all .2s;}
.gs-nt-signup:hover{background:#c43d25;transform:translateY(-1px);}
.gs-discord-logo{width:28px;height:28px;object-fit:contain;display:block;flex-shrink:0;}
.gs-mkt-btn{flex:1;padding:14px 12px;border-radius:12px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:#fff;font-family:'DM Sans',sans-serif;cursor:pointer;transition:all .2s;text-align:center;}
.gs-mkt-btn:hover{background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.18);}
.gs-mkt-btn.active-nq{border-color:rgba(34,84,245,0.5);background:rgba(34,84,245,0.1);}
.gs-mkt-btn.active-nq span:first-child{color:#2254F5 !important;}
.gs-mkt-btn.active-es{border-color:rgba(255,255,255,0.55);background:rgba(255,255,255,0.07);box-shadow:0 0 18px rgba(255,255,255,0.1),inset 0 0 12px rgba(255,255,255,0.03);}
.gs-mkt-btn.active-es span:first-child{color:#ffffff !important;}
</style>

<div class="gs-wrap" style="max-width:1100px;">

  <!-- HEADER -->
  <div style="text-align:center;margin-bottom:8px;max-width:560px;margin-left:auto;margin-right:auto;">
    <div style="display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.2);border-radius:999px;padding:6px 20px;margin-bottom:14px;">
      <span style="color:#2254F5;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">Get Started</span>
    </div>
    <h1 style="font-size:28px;font-weight:800;color:#fff;margin:0 0 8px;letter-spacing:-0.5px;">3 Steps to Full Access</h1>
    <p style="color:#64748b;font-size:14px;margin:0;">Complete each step independently. Takes less than 5 minutes total.</p>
  </div>

  <!-- STEP 1 — NINJATRADER -->
  <div class="gs-step" id="step1" style="max-width:560px;margin-left:auto;margin-right:auto;width:100%;">
    <div class="gs-head">
      <div class="gs-num">1</div>
      <div class="gs-head-text">
        <div class="gs-title">Activate Your Software</div>
        <div class="gs-subtitle">Verify your purchase and enter your NinjaTrader email to activate</div>
      </div>
      <div class="gs-check">&#10003;</div>
    </div>
    <div class="gs-body">
      <div class="gs-divider"></div>
      <div style="background:rgba(34,84,245,0.05);border:1px solid rgba(34,84,245,0.12);border-radius:12px;padding:18px 20px;margin-bottom:18px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;">
        <div style="margin-bottom:4px;">${ninjaLogoSVG()}</div>
        <div style="width:100%;">
          <div style="font-size:12px;font-weight:700;color:#2254F5;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">NinjaTrader Required</div>
          <div style="font-size:13px;color:#94a3b8;line-height:1.6;">You need a free NinjaTrader account before activating. Don't have one?</div>
          <a href="https://lp.ninjatrader.com/platform?im_ref=XLAQAKxrwxyZWIqQPWQSz2P0Uku26HTRR1lDXQ0&sharedid=&irpid=7019303&irgwc=1&afsrc=1" target="_blank" rel="noopener noreferrer" class="gs-nt-signup">Create Free Account &rarr;</a>
        </div>
      </div>
      <label class="gs-label" for="nt-purchase-email">Purchase Email</label>
      <input class="gs-input" type="email" id="nt-purchase-email" placeholder="email you used to purchase HVT" />
      <label class="gs-label" for="ntemail">NinjaTrader Account Email</label>
      <input class="gs-input" type="email" id="ntemail" placeholder="email you use to log into NinjaTrader" />
      <button class="gs-btn gs-btn-blue" id="btn-nt" onclick="activateNT()">Activate Software</button>
      <div class="gs-msg" id="msg-nt"></div>
    </div>
  </div>

  <!-- STEP 2 — DOWNLOADS -->
  <div class="gs-step" id="step2" style="max-width:560px;margin-left:auto;margin-right:auto;width:100%;">
    <div class="gs-head">
      <div class="gs-num">2</div>
      <div class="gs-head-text">
        <div class="gs-title">Download Your Software</div>
        <div class="gs-subtitle">Select your market, then your account type</div>
      </div>
      <div class="gs-check">&#10003;</div>
    </div>
    <div class="gs-body">
      <div class="gs-divider"></div>
      <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#475569;margin-bottom:10px;">Select Market</div>
      <div style="display:flex;gap:10px;margin-bottom:24px;">
        <button id="mkt-btn-nq" onclick="selectMarket('nq')" class="gs-mkt-btn">
          <span style="font-size:15px;font-weight:900;color:#2254F5;display:block;margin-bottom:2px;letter-spacing:1px;">NQ</span>
          <span style="font-size:11px;color:#64748b;">Nasdaq-100</span>
        </button>
        <button id="mkt-btn-es" onclick="selectMarket('es')" class="gs-mkt-btn">
          <span style="font-size:15px;font-weight:900;color:#ffffff;display:block;margin-bottom:2px;letter-spacing:1px;">ES</span>
          <span style="font-size:11px;color:#64748b;">E-mini S&amp;P 500</span>
        </button>
      </div>
      <div id="dl-prompt" style="padding:20px;text-align:center;border:1px dashed rgba(255,255,255,0.07);border-radius:12px;">
        <div style="font-size:13px;color:#334155;">&#8593; Select a market above to see your downloads</div>
      </div>
      <div id="dl-nq" style="display:none;">
        <div style="height:1px;background:rgba(255,255,255,0.06);margin-bottom:20px;"></div>
        <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#2254F5;margin-bottom:10px;">Personal Account</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:12px;">Your own NinjaTrader account — licensed through NT ecosystem</div>
        <div class="gs-dl-row" style="margin-bottom:10px;">
          <a href="/downloads/installer" class="gs-dl-btn" onclick="markStep2()">
            <div class="gs-dl-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2254F5" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg></div>
            <div class="gs-dl-text"><div class="gs-dl-name">NQ Indicator Package</div><div class="gs-dl-desc">Standard — for personal NinjaTrader accounts</div></div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>
          <a href="/downloads/template" class="gs-dl-btn" onclick="markStep2()">
            <div class="gs-dl-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2254F5" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg></div>
            <div class="gs-dl-text"><div class="gs-dl-name">NQ Chart Template</div><div class="gs-dl-desc">Import after installing the indicator package</div></div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>
        </div>
        <div class="gs-tip" style="margin-bottom:24px;"><p>&#128161; <strong style="color:#94a3b8;">Install order:</strong> Indicator package first, then chart template.</p></div>
        <div style="height:1px;background:rgba(255,255,255,0.06);margin-bottom:20px;"></div>
        <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#2254F5;margin-bottom:10px;">Prop Firm Account</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:12px;">Apex, Topstep, Bulenox or any funded account</div>
        <div style="padding:12px 14px;background:rgba(34,84,245,0.05);border:1px solid rgba(34,84,245,0.18);border-radius:10px;margin-bottom:12px;">
          <p style="font-size:13px;color:#94a3b8;margin:0;line-height:1.7;">&#9888;&nbsp; You must <a href="/prop-activation" style="color:#2254F5;font-weight:700;text-decoration:none;">activate your Machine ID</a> first. Do not use the personal package on a prop firm account.</p>
        </div>
        <div class="gs-dl-row" style="margin-bottom:10px;">
          <a href="/downloads/prop-installer" class="gs-dl-btn" style="border-color:rgba(34,84,245,0.35);background:rgba(34,84,245,0.06);" onclick="markStep2()">
            <div class="gs-dl-icon" style="background:rgba(34,84,245,0.12);"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2254F5" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg></div>
            <div class="gs-dl-text"><div class="gs-dl-name" style="color:#2254F5;">NQ Prop Firm Package</div><div class="gs-dl-desc">Activate Machine ID first — then download</div></div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>
          <a href="/downloads/template" class="gs-dl-btn" onclick="markStep2()">
            <div class="gs-dl-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2254F5" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg></div>
            <div class="gs-dl-text"><div class="gs-dl-name">NQ Chart Template</div><div class="gs-dl-desc">Same template for both NQ packages</div></div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>
        </div>
        <div class="gs-tip" style="border-color:rgba(34,84,245,0.2);"><p>&#128161; <strong style="color:#94a3b8;">Setup order:</strong> 1) <a href="/prop-activation" style="color:#2254F5;text-decoration:none;font-weight:600;">Activate Machine ID</a> &rarr; 2) Download prop package &rarr; 3) Import into NinjaTrader &rarr; 4) Import chart template.</p></div>
      </div>
      <div id="dl-es" style="display:none;">
        <div style="height:1px;background:rgba(255,255,255,0.06);margin-bottom:20px;"></div>
        <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ffffff;margin-bottom:10px;">Personal Account</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:12px;">Your own NinjaTrader account — licensed through NT ecosystem</div>
        <div class="gs-dl-row" style="margin-bottom:10px;">
          <a href="/downloads/es-installer" class="gs-dl-btn" onclick="markStep2()">
            <div class="gs-dl-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg></div>
            <div class="gs-dl-text"><div class="gs-dl-name">ES Indicator Package</div><div class="gs-dl-desc">Full ES suite — NinjaTrader vendor licensed</div></div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>
          <a href="/downloads/es-template" class="gs-dl-btn" onclick="markStep2()">
            <div class="gs-dl-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg></div>
            <div class="gs-dl-text"><div class="gs-dl-name">ES Chart Template</div><div class="gs-dl-desc">Import after installing the indicator package</div></div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>
        </div>
        <div class="gs-tip" style="margin-bottom:24px;"><p>&#128161; <strong style="color:#94a3b8;">Install order:</strong> Indicator package first, then chart template.</p></div>
        <div style="height:1px;background:rgba(255,255,255,0.06);margin-bottom:20px;"></div>
        <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ffffff;margin-bottom:10px;">Prop Firm Account</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:12px;">Apex, Topstep, Bulenox or any funded account</div>
        <div style="padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.14);border-radius:10px;margin-bottom:12px;">
          <p style="font-size:13px;color:#94a3b8;margin:0;line-height:1.7;">&#9888;&nbsp; You must <a href="/prop-activation" style="color:#ffffff;font-weight:700;text-decoration:none;">activate your Machine ID</a> first. Do not use the personal package on a prop firm account.</p>
        </div>
        <div class="gs-dl-row" style="margin-bottom:10px;">
          <a href="/downloads/es-prop-installer" class="gs-dl-btn" style="border-color:rgba(255,255,255,0.2);background:rgba(255,255,255,0.04);" onclick="markStep2()">
            <div class="gs-dl-icon" style="background:rgba(255,255,255,0.07);"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg></div>
            <div class="gs-dl-text"><div class="gs-dl-name" style="color:#ffffff;">ES Prop Firm Package</div><div class="gs-dl-desc">Activate Machine ID first — then download</div></div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>
          <a href="/downloads/es-template" class="gs-dl-btn" onclick="markStep2()">
            <div class="gs-dl-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg></div>
            <div class="gs-dl-text"><div class="gs-dl-name">ES Chart Template</div><div class="gs-dl-desc">Same template for both ES packages</div></div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>
        </div>
        <div class="gs-tip" style="border-color:rgba(255,255,255,0.12);"><p>&#128161; <strong style="color:#94a3b8;">Setup order:</strong> 1) <a href="/prop-activation" style="color:#ffffff;text-decoration:none;font-weight:600;">Activate Machine ID</a> &rarr; 2) Download prop package &rarr; 3) Import into NinjaTrader &rarr; 4) Import ES template.</p></div>
      </div>
    </div>
  </div>

  <!-- STEP 3 — DISCORD -->
  <div class="gs-step" id="step3" style="max-width:560px;margin-left:auto;margin-right:auto;width:100%;">
    <div class="gs-head">
      <div class="gs-num">3</div>
      <div class="gs-head-text">
        <div class="gs-title">Join the Discord Trading Room</div>
        <div class="gs-subtitle">Get your member role and access the live trading room</div>
      </div>
      <div class="gs-check">&#10003;</div>
    </div>
    <div class="gs-body">
      <div class="gs-divider"></div>
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">Step A — Join the Server</div>
        <a href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener noreferrer" class="gs-btn gs-btn-discord" style="text-decoration:none;display:flex;" onclick="markDiscordJoined()">
          <img src="/discordlogo.png" alt="Discord" class="gs-discord-logo" />
          <span style="font-size:15px;font-weight:700;">Join HVT Discord Server</span>
        </a>
      </div>
      <div style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">Step B — Activate Your Role</div>
      <label class="gs-label" for="email">Your Purchase Email</label>
      <input class="gs-input" type="email" id="email" placeholder="email you used to purchase" />
      <label class="gs-label" for="discord">Your Discord Username</label>
      <input class="gs-input" type="text" id="discord" placeholder="e.g. johntrader22" />
      <div class="gs-tip" style="margin-bottom:14px;">
        <p>&#128161; <strong style="color:#94a3b8;">Finding your username:</strong> In Discord, click your avatar at the bottom-left. Your username is below your display name — lowercase, may include numbers. <strong style="color:#94a3b8;">Not your display name — the actual username.</strong></p>
      </div>
      <button class="gs-btn gs-btn-blue" id="btn-discord" onclick="activateDiscord()">Assign My Discord Role</button>
      <div class="gs-msg" id="msg-discord"></div>
    </div>
  </div>

</div>

<script>
async function activateNT() {
  const purchaseEmail = document.getElementById('nt-purchase-email').value.trim();
  const ntEmail = document.getElementById('ntemail').value.trim();
  const msg     = document.getElementById('msg-nt');
  const btn     = document.getElementById('btn-nt');
  msg.className = 'gs-msg';
  if (!purchaseEmail) { msg.className='gs-msg er show'; msg.textContent='Please enter your purchase email.'; return; }
  if (!ntEmail) { msg.className='gs-msg er show'; msg.textContent='Please enter your NinjaTrader account email.'; return; }
  btn.disabled = true; btn.textContent = 'Activating...';
  try {
    const r = await fetch('/trading-room/activate-nt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: purchaseEmail, ninjatrader_email: ntEmail })
    });
    const d = await r.json();
    if (r.ok) {
      msg.className = 'gs-msg ok show';
      msg.textContent = '\\u2713 Software activated! Open NinjaTrader \u2014 your HVT software is now live.';
      btn.textContent = 'Software Activated \\u2713';
      document.getElementById('step1').classList.add('done');
    } else {
      msg.className = 'gs-msg er show';
      msg.textContent = d.error || 'Something went wrong. Please try again.';
      btn.disabled = false; btn.textContent = 'Activate Software';
    }
  } catch { msg.className='gs-msg er show'; msg.textContent='Network error. Please try again.'; btn.disabled=false; btn.textContent='Activate Software'; }
}
function selectMarket(market) {
  var nqBtn = document.getElementById('mkt-btn-nq');
  var esBtn = document.getElementById('mkt-btn-es');
  var nqDl  = document.getElementById('dl-nq');
  var esDl  = document.getElementById('dl-es');
  var prompt = document.getElementById('dl-prompt');
  nqBtn.className = 'gs-mkt-btn'; esBtn.className = 'gs-mkt-btn';
  if (market === 'nq') {
    nqBtn.className = 'gs-mkt-btn active-nq';
    nqDl.style.display = 'block'; esDl.style.display = 'none';
  } else {
    esBtn.className = 'gs-mkt-btn active-es';
    esDl.style.display = 'block'; nqDl.style.display = 'none';
  }
  if (prompt) prompt.style.display = 'none';
}
function markStep2() {
  setTimeout(function(){ document.getElementById('step2').classList.add('done'); }, 1500);
}
function markDiscordJoined() {}
async function activateDiscord() {
  const email   = document.getElementById('email').value.trim();
  const disc    = document.getElementById('discord').value.trim();
  const msg     = document.getElementById('msg-discord');
  const btn     = document.getElementById('btn-discord');
  msg.className = 'gs-msg';
  if (!email) { msg.className='gs-msg er show'; msg.textContent='Please enter your purchase email.'; return; }
  if (!disc)  { msg.className='gs-msg er show'; msg.textContent='Please enter your Discord username.'; return; }
  btn.disabled = true; btn.textContent = 'Activating...';
  try {
    const r = await fetch('/trading-room/activate-discord', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, discord_username: disc })
    });
    const d = await r.json();
    if (r.ok) {
      msg.className = 'gs-msg ok show';
      msg.textContent = '\\u2713 Done! Your Discord role has been assigned. Check the HVT server — you now have full access.';
      btn.textContent = 'Role Assigned \\u2713';
      document.getElementById('step3').classList.add('done');
    } else {
      msg.className = 'gs-msg er show';
      msg.textContent = d.error || 'Something went wrong. Please try again.';
      btn.disabled = false; btn.textContent = 'Assign My Discord Role';
    }
  } catch { msg.className='gs-msg er show'; msg.textContent='Network error. Please try again.'; btn.disabled=false; btn.textContent='Assign My Discord Role'; }
}
document.getElementById('ntemail').addEventListener('keydown', e => { if(e.key==='Enter') activateNT(); });
document.getElementById('discord').addEventListener('keydown', e => { if(e.key==='Enter') activateDiscord(); });
</script>`, {}));
});

// ─── TRADING ROOM: ACTIVATE (full flow) ──────────────────────────────────────
router.post('/trading-room/activate', frm, express.json(), async (req, res) => {
    try {
        const email   = (req.body.email || '').toLowerCase().trim();
        const discUser= (req.body.discord_username || '').trim();
        const ntEmail = (req.body.ninjatrader_email || '').toLowerCase().trim();
        if (!ntEmail)  return res.status(400).json({ error: 'NinjaTrader email is required' });
        if (!email)    return res.status(400).json({ error: 'Email is required' });
        if (!discUser) return res.status(400).json({ error: 'Discord username is required' });

        const [{ data: mem }, { data: licRows }, { data: dm }] = await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).select('status,expires_at,nt_license_id').eq('email', email).order('updated_at', { ascending: false }).limit(1),
            supabase.from(LICENSE_TABLE).select('status,nt_license_id').eq('email', email).order('updated_at', { ascending: false }).limit(1),
            supabase.from(DISCORD_TABLE).select('status,expires_at').eq('email', email).order('updated_at', { ascending: false }).limit(1)
        ]);
        const mem0 = mem?.[0] ?? null;
        const lic  = licRows?.[0] ?? null;
        const dm0  = dm?.[0] ?? null;
        const isMonthly  = (mem0?.status === 'active' || mem0?.status === 'pending_cancel') && new Date(mem0.expires_at) > new Date();
        const isLifetime = lic?.status === 'active';
        const isDiscord  = dm0?.status  === 'active' && new Date(dm0.expires_at)  > new Date();

        if (!isMonthly && !isLifetime && !isDiscord)
            return res.status(403).json({ error: 'No active membership found for this email. Please check your email or contact support at 786-461-4235.' });

        const found = await findUser(discUser);
        if (!found) return res.status(404).json({ error: `Discord user "${discUser}" not found in the HVT server. Please make sure you have joined first at highvelocitytrading.com.` });

        const uid  = found.user.id;
        const rid  = isLifetime ? DISCORD_LIFETIME_ROLE_ID : (isDiscord ? (DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID) : DISCORD_MONTHLY_ROLE_ID);
        await addRole(uid, rid);

        if (isMonthly) await supabase.from(MEMBERSHIP_TABLE).update({ discord_user_id: uid, discord_username: discUser, updated_at: nowISO() }).eq('email', email);
        if (isDiscord) await supabase.from(DISCORD_TABLE).update({ discord_user_id: uid, discord_username: discUser, updated_at: nowISO() }).eq('email', email);

        const ntType = isLifetime ? 'lifetime' : 'monthly';
        const existingNtId = isLifetime ? lic?.nt_license_id : mem0?.nt_license_id;
        if (!existingNtId) {
            try {
                const ntId = await ntCreateLicense(ntEmail, ntType);
                if (ntId) {
                    if (isLifetime) await supabase.from(LICENSE_TABLE).update({ nt_license_id: ntId, nt_email: ntEmail, updated_at: nowISO() }).eq('email', email);
                    else await supabase.from(MEMBERSHIP_TABLE).update({ nt_license_id: ntId, nt_email: ntEmail, updated_at: nowISO() }).eq('email', email);
                }
            } catch (e) { console.error('[NT activate]', e.message); }
        }

        console.log(`✅ Role assigned: @${discUser} (${uid}) → ${email} | NT: ${ntEmail}`);
        res.json({ ok: true });
    } catch (e) { console.error('[TRActivate]', e.message); res.status(500).json({ error: 'Server error. Please try again or call 786-461-4235.' }); }
});

// ─── TRADING ROOM: ACTIVATE NT ONLY ──────────────────────────────────────────
router.post('/trading-room/activate-nt', frm, express.json(), async (req, res) => {
    try {
        const ntEmail = (req.body.ninjatrader_email || '').toLowerCase().trim();
        const email   = (req.body.email || '').toLowerCase().trim();
        if (!ntEmail) return res.status(400).json({ error: 'NinjaTrader email is required.' });

        let mem = null, lic = null;
        if (email) {
            const [{ data: m }, { data: l }] = await Promise.all([
                supabase.from(MEMBERSHIP_TABLE).select('status,expires_at,nt_license_id,email').eq('email', email).maybeSingle(),
                supabase.from(LICENSE_TABLE).select('status,nt_license_id,email').eq('email', email).maybeSingle()
            ]);
            mem = m; lic = l;
        } else {
            const [{ data: m }, { data: l }] = await Promise.all([
                supabase.from(MEMBERSHIP_TABLE).select('status,expires_at,nt_license_id,email').eq('nt_email', ntEmail).maybeSingle(),
                supabase.from(LICENSE_TABLE).select('status,nt_license_id,email').eq('nt_email', ntEmail).maybeSingle()
            ]);
            mem = m; lic = l;
        }

        const isMonthly  = (mem?.status === 'active' || mem?.status === 'pending_cancel') && new Date(mem.expires_at) > new Date();
        const isLifetime = lic?.status === 'active';
        if (!isMonthly && !isLifetime) return res.status(403).json({ error: 'No active membership found. Please also enter your purchase email, or contact support at 786-461-4235.' });

        const ntType       = isLifetime ? 'lifetime' : 'monthly';
        const existingNtId = isLifetime ? lic?.nt_license_id : mem?.nt_license_id;
        const memberEmail  = isLifetime ? lic.email : mem.email;

        if (existingNtId) {
            console.log(`[NT-only] Already has NT license: ${memberEmail}`);
            return res.json({ ok: true });
        }

        const ntId = await ntCreateLicense(ntEmail, ntType);
        if (!ntId) return res.status(500).json({ error: 'Failed to create NinjaTrader license. Please try again or contact support.' });

        if (isLifetime) await supabase.from(LICENSE_TABLE).update({ nt_license_id: ntId, nt_email: ntEmail, updated_at: nowISO() }).eq('email', memberEmail);
        else            await supabase.from(MEMBERSHIP_TABLE).update({ nt_license_id: ntId, nt_email: ntEmail, updated_at: nowISO() }).eq('email', memberEmail);

        console.log(`✅ NT-only activated: ${memberEmail} | NT email: ${ntEmail} | id: ${ntId}`);
        res.json({ ok: true });
    } catch (e) { console.error('[NT-only activate]', e.message); res.status(500).json({ error: 'Server error. Please try again or call 786-461-4235.' }); }
});

// ─── TRADING ROOM: ACTIVATE DISCORD ONLY ─────────────────────────────────────
router.post('/trading-room/activate-discord', frm, express.json(), async (req, res) => {
    try {
        const email    = (req.body.email || '').toLowerCase().trim();
        const discUser = (req.body.discord_username || '').trim();
        if (!email)    return res.status(400).json({ error: 'Purchase email is required.' });
        if (!discUser) return res.status(400).json({ error: 'Discord username is required.' });

        const [{ data: memRows2 }, { data: licRows2 }, { data: dmRows2 }] = await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).order('updated_at', { ascending: false }).limit(1),
            supabase.from(LICENSE_TABLE).select('status').eq('email', email).order('updated_at', { ascending: false }).limit(1),
            supabase.from(DISCORD_TABLE).select('status,expires_at').eq('email', email).order('updated_at', { ascending: false }).limit(1)
        ]);
        const mem2 = memRows2?.[0] ?? null;
        const lic2 = licRows2?.[0] ?? null;
        const dm2  = dmRows2?.[0] ?? null;
        const isMonthly  = (mem2?.status === 'active' || mem2?.status === 'pending_cancel') && new Date(mem2.expires_at) > new Date();
        const isLifetime = lic2?.status === 'active';
        const isDiscord  = dm2?.status  === 'active' && new Date(dm2.expires_at) > new Date();

        if (!isMonthly && !isLifetime && !isDiscord)
            return res.status(403).json({ error: 'No active membership found for this email. Please check your email or contact support at 786-461-4235.' });

        const found = await findUser(discUser);
        if (!found) return res.status(404).json({ error: `Discord user "${discUser}" not found in the HVT server. Make sure you have joined first, then try again.` });

        const uid = found.user.id;
        const rid = isLifetime ? DISCORD_LIFETIME_ROLE_ID : (isDiscord ? (DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID) : DISCORD_MONTHLY_ROLE_ID);
        await addRole(uid, rid);

        if (isMonthly)  await supabase.from(MEMBERSHIP_TABLE).update({ discord_user_id: uid, discord_username: discUser, updated_at: nowISO() }).eq('email', email);
        if (isDiscord)  await supabase.from(DISCORD_TABLE).update({ discord_user_id: uid, discord_username: discUser, updated_at: nowISO() }).eq('email', email);
        if (isLifetime) await supabase.from(LICENSE_TABLE).update({ discord_user_id: uid, discord_username: discUser, updated_at: nowISO() }).eq('email', email).catch(e => console.error('[Discord] LIC update:', e.message));

        console.log(`✅ Discord-only: @${discUser} (${uid}) → ${email}`);
        res.json({ ok: true });
    } catch (e) { console.error('[Discord-only activate]', e.message); res.status(500).json({ error: 'Server error. Please try again or call 786-461-4235.' }); }
});

// ─── LOGIN PAGE ───────────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
    try {
        if (DEMO_MODE) return res.redirect('/member');
        const _sess = await getSessionAsync(req);
        if (_sess) return res.redirect('/member');
    } catch(e) { /* session check failed, show login */ }
    res.send(shell('Member Login', `
    <div style="width:100%;max-width:520px;">
      <div class="card" style="max-width:520px;">
        <div class="ct"></div>
        <div class="cb">
          <label for="email">Membership Email</label>
          <input type="email" id="email" placeholder="your@email.com" autocomplete="email" />
          <button class="btn" id="btn" onclick="go()">Send My Access Link</button>
          <div class="msg" id="msg"></div>
          <p style="text-align:center;color:#334155;font-size:11px;margin-top:20px;margin-bottom:0;">Not a member? <a href="https://highvelocitytrading.com/#packages" style="color:#2254F5;text-decoration:none;font-weight:600;">View Packages &rarr;</a></p>
        </div>
      </div>
    </div>
    <script>
      async function go(){const email=document.getElementById('email').value.trim();const msg=document.getElementById('msg');const btn=document.getElementById('btn');msg.className='msg';if(!email){msg.className='msg er show';msg.textContent='Please enter your email.';return}btn.disabled=true;btn.textContent='Sending...';try{const r=await fetch('/course/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});const d=await r.json();if(r.ok){msg.className='msg ok show';msg.textContent='\u2713 Check your email \u2014 your secure link is on the way!';btn.textContent='Link Sent \u2713'}else{msg.className='msg er show';msg.textContent=d.error||'Something went wrong.';btn.disabled=false;btn.textContent='Send My Access Link'}}catch{msg.className='msg er show';msg.textContent='Network error.';btn.disabled=false;btn.textContent='Send My Access Link'}}
      document.getElementById('email').addEventListener('keydown',e=>{if(e.key==='Enter')go();});
    </script>`, {hideNav:true, pill:'MEMBER LOGIN', title:'Member Access', sub:'Enter your email to receive a secure login link.'}));
});

// ─── COURSE: REQUEST LOGIN LINK ───────────────────────────────────────────────
router.post('/course/request', frm, express.json(), async (req, res) => {
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ error: 'Email is required' });
        const { data: mem } = await supabase.from(MEMBERSHIP_TABLE).select('status,expires_at').eq('email', email).maybeSingle();
        const { data: lic } = await supabase.from(LICENSE_TABLE).select('status').eq('email', email).maybeSingle();
        const isMonthly  = (mem?.status === 'active' || mem?.status === 'pending_cancel') && new Date(mem.expires_at) > new Date();
        const isLifetime = lic?.status === 'active';
        if (!isMonthly && !isLifetime) return res.status(403).json({ error: 'No active membership found. Visit highvelocitytrading.com or call 786-461-4235.' });
        const token   = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 86400000).toISOString();
        if (isMonthly) await supabase.from(MEMBERSHIP_TABLE).update({ course_token: token, course_token_expires: expires, updated_at: nowISO() }).eq('email', email);
        else           await supabase.from(LICENSE_TABLE).update({ course_token: token, course_token_expires: expires, updated_at: nowISO() }).eq('email', email);
        await sendCourseEmail(email, token);
        res.json({ ok: true });
    } catch (e) { console.error('[CourseReq]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

// ─── COURSE: CONFIRM MAGIC LINK ───────────────────────────────────────────────
router.get('/course/confirm', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.send(resultPage('error', 'Invalid Link', 'This access link is invalid.'));
    try {
        const { data: mData } = await supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,expires_at,course_token_expires').eq('course_token', token).maybeSingle();
        const { data: lData } = await supabase.from(LICENSE_TABLE).select('email,full_name,status,course_token_expires').eq('course_token', token).maybeSingle();
        const rec = mData || lData;
        if (!rec) return res.send(resultPage('error', 'Invalid Link', 'This link is invalid or has expired.'));
        if (!rec.course_token_expires || new Date(rec.course_token_expires) < new Date()) return res.send(resultPage('error', 'Link Expired', 'This link has expired. <a href="/login" style="color:#2254F5;">Request a new one</a>.'));
        const isMonthly  = (mData?.status === 'active' || mData?.status === 'pending_cancel') && new Date(mData.expires_at) > new Date();
        const isLifetime = lData?.status === 'active';
        if (!isMonthly && !isLifetime) return res.send(resultPage('error', 'Access Revoked', 'Your membership is no longer active.'));
        const name    = (rec.full_name || 'Trader').split(' ')[0];
        const plan    = isLifetime ? 'Lifetime Access' : 'Monthly Membership';
        const sessToken = createSession(rec.email, name, plan);
        res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${sessToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7*24*3600}`);
        const clearTable = lData ? LICENSE_TABLE : MEMBERSHIP_TABLE;
        supabase.from(clearTable).update({ course_token: null, course_token_expires: null, updated_at: nowISO() }).eq('course_token', token).then(() => {}).catch(e => console.error('[CourseConfirm clear token]', e.message));
        return res.redirect('/member');
    } catch (e) { console.error('[CourseConfirm]', e.message); res.send(resultPage('error', 'Error', 'Something went wrong.')); }
});

// ─── MEMBER PORTAL ────────────────────────────────────────────────────────────
router.get('/member', requireSession, (req, res) => {
    const s = req._session;
    res.send(memberPortalHtml(s));
});

// ─── MEMBER SHOP ──────────────────────────────────────────────────────────────
router.get('/shop', requireSession, (req, res) => {
    const s = req._session;
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Member Shop — HVT</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"DM Sans",sans-serif;background:#000;min-height:100vh;color:#fff;overflow-x:hidden}
.bg{position:fixed;inset:0;z-index:0;pointer-events:none;background:#000}
.bg::before{content:"";position:absolute;top:0;left:0;width:70%;height:60%;background:radial-gradient(ellipse at 20% 20%,#00001C 0%,transparent 60%);pointer-events:none}
.topnav-wrap{position:fixed;top:0;left:0;right:0;z-index:10}
.topnav{display:flex;align-items:center;justify-content:space-between;padding:0 28px;height:64px;width:100%;background:rgba(10,10,12,0.85);backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.08)}
.topnav-logo img{height:29px;width:auto;object-fit:contain;display:block}
.topnav-right{display:flex;align-items:center;gap:12px}
.topnav-out{color:rgba(255,255,255,0.82);font-size:13px;font-weight:600;text-decoration:none;padding:8px 0;transition:color .2s}
.topnav-out:hover{color:#fff}
.back-btn{display:inline-flex;align-items:center;gap:6px;color:rgba(255,255,255,0.5);font-size:13px;font-weight:500;text-decoration:none;padding:8px 0;transition:color .2s}
.back-btn:hover{color:#fff}
.wrap{position:relative;z-index:1;max-width:960px;margin:0 auto;padding:100px 24px 80px}
.hero{text-align:center;margin-bottom:56px}
.pill{display:inline-block;background:rgba(212,168,83,0.12);border:1px solid rgba(232,200,120,0.35);border-radius:999px;color:#e8c878;font-size:10px;letter-spacing:3px;text-transform:uppercase;padding:5px 16px;margin-bottom:16px}
.hero h1{font-size:36px;font-weight:800;letter-spacing:-0.5px;color:#fff;margin-bottom:10px}
.hero p{color:#64748b;font-size:15px;line-height:1.6;max-width:480px;margin:0 auto}
.hero-div{height:1px;background:linear-gradient(90deg,transparent,rgba(212,168,83,0.45),transparent);margin:20px auto 0;max-width:160px}
.section-lbl{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#475569;margin-bottom:24px;font-weight:700}
.products{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px;margin-bottom:48px}
.product-card{background:#0a0a0e;border:1px solid rgba(255,255,255,0.07);border-radius:20px;overflow:hidden;transition:border-color .25s,transform .25s,box-shadow .25s;display:flex;flex-direction:column}
.product-card:hover{border-color:rgba(212,168,83,0.4);transform:translateY(-4px);box-shadow:0 16px 48px rgba(212,168,83,0.2)}
.product-card .top-bar{height:3px;background:linear-gradient(90deg,#e8c878,#d4a853,#c9a227)}
.product-card .body{padding:28px;display:flex;flex-direction:column;flex:1}
.product-badge{display:inline-block;width:fit-content;max-width:100%;align-self:flex-start;text-align:center;background:rgba(212,168,83,0.12);border:1px solid rgba(232,200,120,0.35);border-radius:999px;color:#e8c878;font-size:9px;letter-spacing:2px;text-transform:uppercase;padding:5px 14px;margin-bottom:18px;font-weight:700}
.product-name{font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.3px;margin-bottom:6px}
.product-tag{font-size:12px;color:#475569;margin-bottom:20px;letter-spacing:0.3px}
.product-features{list-style:none;margin-bottom:24px;flex:1}
.product-features li{display:flex;align-items:center;gap:10px;font-size:13px;color:#94a3b8;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04)}
.product-features li:last-child{border-bottom:none}
.feat-check{width:18px;height:18px;border-radius:50%;background:rgba(212,168,83,0.14);border:1px solid rgba(232,200,120,0.35);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.feat-check svg{width:9px;height:9px}
.price-row{display:flex;align-items:baseline;gap:8px;margin-bottom:20px}
.price{font-size:36px;font-weight:800;color:#fff;letter-spacing:-1px;line-height:1}
.price-note{font-size:12px;color:#475569}
.buy-btn{display:block;width:100%;padding:14px;background:linear-gradient(135deg,#c9a227,#d4a853,#e5c76b);color:#0f0f0f;border:1px solid rgba(255,236,180,0.45);border-radius:999px;font-family:"DM Sans",sans-serif;font-size:14px;font-weight:800;letter-spacing:0.5px;text-align:center;text-decoration:none;cursor:pointer;transition:opacity .2s,transform .1s,box-shadow .2s;box-shadow:0 4px 28px rgba(212,168,83,0.45)}
.buy-btn:hover{opacity:0.98;transform:translateY(-1px);box-shadow:0 8px 36px rgba(212,168,83,0.55)}
.buy-btn:active{transform:translateY(0)}
.product-card.card-room:hover{border-color:rgba(96,165,250,0.45);transform:translateY(-4px);box-shadow:0 16px 48px rgba(34,84,245,0.22)}
.product-card.card-room .top-bar{background:linear-gradient(90deg,#60a5fa,#2254F5,#3b82f6)}
.product-card.card-room .product-badge{background:rgba(34,84,245,0.12);border-color:rgba(96,165,250,0.35);color:#93c5fd}
.product-card.card-room .feat-check{background:rgba(34,84,245,0.12);border-color:rgba(96,165,250,0.28)}
.room-price{color:#60a5fa !important}
.price-was{font-size:15px;font-weight:600;color:#64748b;text-decoration:line-through;letter-spacing:-0.3px;margin-left:4px}
.buy-btn-blue{display:block;width:100%;padding:14px;background:linear-gradient(135deg,#2254F5,#3b82f6);color:#fff;border:1px solid rgba(147,197,253,0.25);border-radius:999px;font-family:"DM Sans",sans-serif;font-size:14px;font-weight:800;letter-spacing:0.5px;text-align:center;text-decoration:none;cursor:pointer;transition:opacity .2s,transform .1s,box-shadow .2s;box-shadow:0 4px 24px rgba(34,84,245,0.4)}
.buy-btn-blue:hover{opacity:0.96;transform:translateY(-1px);box-shadow:0 8px 32px rgba(34,84,245,0.5)}
.buy-btn-blue:active{transform:translateY(0)}
.coming-soon{display:block;width:100%;padding:14px;background:rgba(255,255,255,0.04);color:#334155;border:1px solid rgba(255,255,255,0.07);border-radius:999px;font-size:13px;font-weight:600;text-align:center;cursor:default;letter-spacing:0.5px}
.footer-note{text-align:center;color:#334155;font-size:12px;padding-top:32px;border-top:1px solid rgba(255,255,255,0.05)}
.footer-note a{color:#475569;text-decoration:none}
@media(max-width:600px){.topnav{padding:0 12px}.hero h1{font-size:26px}}
</style></head><body>
<div class="bg" aria-hidden="true"></div>
<div class="topnav-wrap"><nav class="topnav">
  <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer"><img src="/hvt-logo.cropped.png" alt="HVT" style="height:29px;width:auto;object-fit:contain;display:block;" onerror="this.onerror=null;this.style.display=none" /></a>
  <div class="topnav-right">
    <a href="/member" class="topnav-out">Portal</a>
    <a href="/billing/confirm-session" class="topnav-out">Billing</a>
    <a href="/logout" class="topnav-out">Log out</a>
  </div>
</nav></div>
<div class="wrap">
  <a href="/member" class="back-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> Back to Portal</a>
  <div class="hero" style="margin-top:24px;">
    <div class="pill">Members Only</div>
    <h1>Member Shop</h1>
    <p>Exclusive tools built for serious traders. Available only to active HVT members.</p>
    <div class="hero-div"></div>
  </div>
  <div class="section-lbl">Available Now</div>
  <div class="products">
    <div class="product-card card-room">
      <div class="top-bar"></div>
      <div class="body">
        <div class="product-badge">Trading Room</div>
        <div class="product-name">HVT Discord Monthly Access</div>
        <div class="product-tag">Discord &bull; Monthly subscription</div>
        <ul class="product-features">
          <li><span class="feat-check"><svg viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Trading Room Discord access each month</li>
          <li><span class="feat-check"><svg viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Direct access to our private community</li>
          <li><span class="feat-check"><svg viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Trade in real time with our professional team</li>
        </ul>
        <div class="price-row" style="flex-wrap:wrap;align-items:baseline;gap:4px 8px;">
          <div class="price room-price">$37</div>
          <span class="price-was">$77</span>
          <div class="price-note">per month &bull; cancel anytime</div>
        </div>
        <a href="${DISCORD_ROOM_CHECKOUT_URL}" class="buy-btn-blue" target="_blank" rel="noopener noreferrer">Join the Room &rarr;</a>
      </div>
    </div>
    <div class="product-card">
      <div class="top-bar"></div>
      <div class="body">
        <div class="product-badge">Copy Trader</div>
        <div class="product-name">HVT Echo</div>
        <div class="product-tag">NinjaTrader 8 &bull; One-time license</div>
        <ul class="product-features">
          <li><span class="feat-check"><svg viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#a67c2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Copy to up to 5 prop firm accounts</li>
          <li><span class="feat-check"><svg viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#a67c2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Sub-100ms execution</li>
          <li><span class="feat-check"><svg viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#a67c2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Machine ID locked license</li>
          <li><span class="feat-check"><svg viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#a67c2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Works with all major prop firms</li>
          <li><span class="feat-check"><svg viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#a67c2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>License key delivered instantly</li>
        </ul>
        <div class="price-row" style="flex-wrap:wrap;align-items:baseline;gap:4px 8px;"><div class="price">$97</div><span class="price-was">$130</span><div class="price-note">one-time &bull; no subscription</div></div>
        <a href="https://app.highvelocitytrading.com/checkout-echo" class="buy-btn">Get HVT Echo &rarr;</a>
      </div>
    </div>
    <div class="product-card" style="opacity:0.5;pointer-events:none;">
      <div class="top-bar" style="background:rgba(255,255,255,0.1);"></div>
      <div class="body">
        <div class="product-badge" style="background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.1);color:#334155;">Coming Soon</div>
        <div class="product-name" style="color:#475569;">More Tools</div>
        <div class="product-tag">Future releases</div>
        <ul class="product-features" style="flex:1;"><li><span class="feat-check" style="background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.08);"><svg viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#334155" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>New tools added regularly</li></ul>
        <div class="price-row"><div class="price" style="color:#334155;">—</div></div>
        <span class="coming-soon">Coming Soon</span>
      </div>
    </div>
  </div>
  <div class="footer-note">Questions? Call <a href="tel:7864614235">786-461-4235</a> or email <a href="mailto:alerts@hvt-mail.com">alerts@hvt-mail.com</a></div>
</div>
</body></html>`);
});

// ─── TRADING JOURNAL ──────────────────────────────────────────────────────────
router.get('/trading-journal', requireSession, (req, res) => {
    const s = req._session;
    const hero = { pill: 'TRADING JOURNAL', title: 'Trading Journal', sub: 'Your complete record of trades, performance metrics, and daily progress all in one place.' };
    res.send(shell('Trading Journal', `
    <div class="journal-wrap" style="width:100%;max-width:1400px;margin:0 auto;padding:0 20px;box-sizing:border-box;position:relative;z-index:1;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <span style="font-size:12px;color:#64748b;font-weight:600;">Period:</span>
        <button type="button" class="journal-tab active" data-period="day">Today</button>
        <button type="button" class="journal-tab" data-period="week">This Week</button>
        <button type="button" class="journal-tab" data-period="month">This Month</button>
        <button type="button" class="journal-tab" data-period="all">All</button>
      </div>
      <div class="journal-metrics" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
        <div class="card j-card" style="padding:20px 22px;">
          <div class="j-card-label">Net P&L</div>
          <div class="j-card-value" id="stat-pnl" style="color:#94a3b8;">+$0.00</div>
          <div id="pnl-bar-wrap" class="j-bar-wrap" style="margin-top:12px;">
            <div id="pnl-bar" class="j-bar j-bar-win" style="width:0%;transition:width 0.4s ease;"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:5px;color:#64748b;">
            <span id="pnl-trades-label">0 trades</span>
            <span id="pnl-today-label"></span>
          </div>
        </div>
        <div class="card j-card" style="padding:20px 22px;">
          <div class="j-card-label">Avg Win / Avg Loss</div>
          <div class="j-card-value" id="stat-avgwl" style="color:#94a3b8;">— / —</div>
          <div class="j-bar-wrap" id="avgwl-bar-wrap" style="margin-top:12px;">
            <div id="avgwl-bar-win" class="j-bar j-bar-win" style="width:50%;transition:width 0.4s ease;"></div>
            <div id="avgwl-bar-loss" class="j-bar j-bar-loss" style="width:50%;transition:width 0.4s ease;"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:5px;color:#64748b;">
            <span id="avgwl-wins-label" style="color:#22c55e;">0 wins</span>
            <span id="avgwl-losses-label" style="color:#ef4444;">0 losses</span>
          </div>
        </div>
        <div class="card j-card" style="padding:20px 22px;">
          <div class="j-card-label">Current Trade Streak</div>
          <div class="j-card-value" id="stat-tradestreak" style="color:#94a3b8;">0 trades</div>
          <div style="margin-top:12px;display:flex;align-items:center;gap:8px;">
            <div id="streak-dots" style="display:flex;gap:4px;flex-wrap:wrap;max-width:200px;"></div>
          </div>
          <div style="display:flex;gap:16px;font-size:11px;margin-top:6px;color:#64748b;">
            <span id="streak-w-label">0W</span>
            <span id="streak-l-label">0L</span>
          </div>
        </div>
      </div>
      <div class="journal-bottom-grid" style="display:grid;grid-template-columns:minmax(200px,280px) minmax(560px,1fr);gap:24px;align-items:start;min-width:0;">
        <div class="card" style="overflow:hidden;max-width:100%;">
          <div class="ct"></div>
          <div style="padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:12px;font-weight:700;letter-spacing:1px;color:#e2e8f0;">Trades</span>
            <button type="button" class="j-info-btn" aria-label="Info">i</button>
          </div>
          <div style="display:flex;gap:0;border-bottom:1px solid rgba(255,255,255,0.06);">
            <button type="button" class="j-panel-tab active" data-tab="recent">Recent</button>
            <button type="button" class="j-panel-tab" data-tab="open">Open Positions</button>
          </div>
          <div id="trades-recent" class="j-trades-content" style="max-height:320px;overflow-y:auto;">
            <table class="j-trades-table"><thead><tr><th>Symbol</th><th>Close Date</th><th>Net P&L</th></tr></thead><tbody>
              <tr><td colspan="3" style="text-align:center;color:#64748b;padding:28px 16px;">No trades recorded yet</td></tr>
            </tbody></table>
          </div>
          <div id="trades-open" class="j-trades-content" style="display:none;max-height:320px;overflow-y:auto;">
            <table class="j-trades-table"><thead><tr><th>Symbol</th><th>Side</th><th>Unrealized P&L</th></tr></thead><tbody><tr><td colspan="3" style="text-align:center;color:#64748b;padding:24px;">No open positions</td></tr></tbody></table>
          </div>
        </div>
        <div class="card journal-calendar-card" style="overflow:visible;width:100%;min-width:560px;">
          <div class="ct"></div>
          <div style="padding:0;">
            <div style="padding:10px 20px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
              <div style="display:flex;align-items:center;gap:6px;">
                <button type="button" id="cal-prev" aria-label="Previous month" class="cal-nav-btn">&#9664;</button>
                <button type="button" id="cal-prev-yr" aria-label="Previous year" class="cal-nav-btn" style="font-size:11px;">&#171;</button>
                <button type="button" id="cal-today" class="cal-today-btn">TODAY</button>
                <button type="button" id="cal-next-yr" aria-label="Next year" class="cal-nav-btn" style="font-size:11px;">&#187;</button>
                <button type="button" id="cal-next" aria-label="Next month" class="cal-nav-btn">&#9654;</button>
              </div>
              <span id="cal-month-year" style="flex:1;text-align:center;font-size:14px;font-weight:700;color:#fff;letter-spacing:0.5px;">March 2026</span>
              <button type="button" id="cal-info" aria-label="Info" class="j-info-btn">i</button>
            </div>
            <div style="padding:12px 20px 20px;">
              <div style="display:grid;grid-template-columns:repeat(7,minmax(72px,1fr));gap:6px;margin-bottom:6px;">
                <div class="cal-weekday">Sun</div>
                <div class="cal-weekday">Mon</div>
                <div class="cal-weekday">Tue</div>
                <div class="cal-weekday">Wed</div>
                <div class="cal-weekday">Thu</div>
                <div class="cal-weekday">Fri</div>
                <div class="cal-weekday">Sat</div>
              </div>
              <div id="cal-grid" style="display:grid;grid-template-columns:repeat(7,minmax(72px,1fr));gap:6px;min-width:0;"></div>
            </div>
          </div>
        </div>
      </div>
      <div id="cal-tooltip" style="display:none;position:fixed;z-index:100;background:#0f172a;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:12px 16px;box-shadow:0 20px 40px rgba(0,0,0,0.5);pointer-events:none;font-size:13px;">
        <div id="cal-tooltip-date" style="font-weight:700;color:#fff;margin-bottom:4px;"></div>
        <div id="cal-tooltip-pnl" style="font-weight:700;"></div>
        <div id="cal-tooltip-trades" style="color:#64748b;font-size:11px;margin-top:2px;"></div>
      </div>
    </div>
    <style>
      body{justify-content:flex-start !important;padding-top:90px !important;}

      /* Flatten the bubbly shell card — slim border, no heavy accent bar */
      .journal-wrap .card{max-width:none;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;}
      .journal-wrap .card .ct{display:none;}

      /* Period switcher — ghost underline, not chunky pills */
      .journal-tab{padding:8px 4px;margin-right:18px;border-radius:0;border:none;border-bottom:1px solid transparent;background:transparent;color:#64748b;font-size:12px;font-weight:500;letter-spacing:0.02em;cursor:pointer;transition:color .18s,border-color .18s;font-family:inherit;}
      .journal-tab:hover{background:transparent;color:#cbd5e1;}
      .journal-tab.active{background:transparent;border-bottom-color:#0055fe;color:#fff;}

      /* Metric cards — quieter label, bigger number, thinner bar */
      .j-card{padding:18px 20px !important;}
      .j-card-label{font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#64748b;font-weight:500;margin-bottom:10px;}
      .j-card-value{font-size:28px;font-weight:600;letter-spacing:-0.02em;line-height:1;}
      .j-bar-wrap{display:flex;height:3px;border-radius:2px;overflow:hidden;margin-top:14px;background:rgba(255,255,255,0.05);}
      .j-bar{height:100%;}.j-bar-win{background:#22c55e;}.j-bar-loss{background:#ef4444;}

      /* Info icon — softer ghost */
      .j-info-btn{width:22px;height:22px;border-radius:50%;border:1px solid rgba(255,255,255,0.08);background:transparent;color:#475569;cursor:pointer;font-size:10px;font-weight:500;display:flex;align-items:center;justify-content:center;transition:color .18s,border-color .18s;}
      .j-info-btn:hover{color:#94a3b8;border-color:rgba(255,255,255,0.16);}

      /* Panel tabs — underline, thinner */
      .j-panel-tab{padding:12px 16px;border:none;background:transparent;color:#64748b;font-size:12px;font-weight:500;letter-spacing:0.02em;cursor:pointer;border-bottom:1px solid transparent;transition:color .18s,border-color .18s;}
      .j-panel-tab:hover{color:#cbd5e1;}
      .j-panel-tab.active{color:#fff;border-bottom-color:#0055fe;}

      /* Trades table — tighter, smaller, less shouty */
      .j-trades-table{width:100%;border-collapse:collapse;font-size:13px;}
      .j-trades-table th{text-align:left;padding:10px 18px;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#475569;font-weight:500;border-bottom:1px solid rgba(255,255,255,0.05);position:sticky;top:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(10px);z-index:2;}
      .j-trades-table td{padding:12px 18px;border-bottom:1px solid rgba(255,255,255,0.04);color:#cbd5e1;}
      .j-trades-content::-webkit-scrollbar{width:3px;}
      .j-trades-content::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.14);border-radius:2px;}

      /* Calendar nav — flat, square-ish, ghost */
      .cal-nav-btn,.cal-today-btn{width:30px;height:30px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:#64748b;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;transition:color .18s,border-color .18s,background .18s;}
      .cal-today-btn{width:auto;padding:0 10px;font-size:10px;letter-spacing:0.14em;font-weight:500;}
      #cal-prev:hover,#cal-next:hover,#cal-prev-yr:hover,#cal-next-yr:hover,#cal-today:hover{background:rgba(255,255,255,0.04);color:#e2e8f0;border-color:rgba(255,255,255,0.12);}

      /* Calendar cells — quiet, flat, 1px border */
      .cal-weekday{text-align:center;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#475569;font-weight:500;padding:6px 0;}
      .cal-day{aspect-ratio:1;min-width:0;border-radius:6px;display:flex;flex-direction:column;align-items:stretch;cursor:pointer;transition:background .15s,border-color .15s;border:1px solid rgba(255,255,255,0.04);position:relative;padding:8px 6px;box-sizing:border-box;background:transparent;gap:4px;}
      .cal-day:hover{background:rgba(255,255,255,0.03);border-color:rgba(255,255,255,0.10);}
      .cal-day.other-month{opacity:0.35;}
      .cal-day.other-month .cal-num{color:#334155;}
      .cal-day.has-pnl.profit{background:rgba(34,197,94,0.08);border-color:rgba(34,197,94,0.28);}
      .cal-day.has-pnl.profit:hover{background:rgba(34,197,94,0.14);border-color:rgba(34,197,94,0.42);}
      .cal-day.has-pnl.loss{background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.28);}
      .cal-day.has-pnl.loss:hover{background:rgba(239,68,68,0.14);border-color:rgba(239,68,68,0.42);}
      .cal-day.is-today{border-color:rgba(0,85,254,0.45);}
      .cal-day.is-today .cal-num{color:#4d8bff;font-weight:700;}
      .cal-num{font-size:12px;font-weight:500;color:#94a3b8;flex-shrink:0;line-height:1;}
      .cal-day-content{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:0;overflow:hidden;padding:0 2px;}
      .cal-pnl{font-size:11px;font-weight:600;line-height:1.3;word-break:break-all;letter-spacing:-0.01em;}
      .cal-trades{font-size:9px;color:inherit;opacity:0.75;margin-top:2px;line-height:1.2;letter-spacing:0.04em;}
      .cal-day.has-pnl.profit .cal-pnl,.cal-day.has-pnl.profit .cal-trades{color:#22c55e;}
      .cal-day.has-pnl.loss .cal-pnl,.cal-day.has-pnl.loss .cal-trades{color:#ef4444;}

      /* Section headers inside cards — quiet, uppercase, small */
      .journal-wrap .card > div > span[style*="font-weight:700"]{font-size:11px !important;letter-spacing:0.16em !important;font-weight:500 !important;color:#94a3b8 !important;text-transform:uppercase;}
      #cal-month-year{font-size:13px !important;font-weight:600 !important;letter-spacing:0.02em !important;color:#e2e8f0 !important;}

      @media(max-width:900px){.journal-metrics{grid-template-columns:1fr !important;} .journal-bottom-grid{grid-template-columns:1fr !important;}}
    </style>
    <script>
      (function(){
        var period = 'day';
        document.querySelectorAll('.journal-tab').forEach(function(btn){
          btn.addEventListener('click', function(){
            document.querySelectorAll('.journal-tab').forEach(function(b){ b.classList.remove('active'); });
            btn.classList.add('active');
            period = btn.getAttribute('data-period');
          });
        });
        var cur = new Date();
        var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        var samplePnL = {};
        var sampleTrades = {};
        function dateKey(d){ return d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate(); }
        function formatPnl(n){ var a = Math.abs(n); if (a >= 1000) return (n >= 0 ? '' : '-') + '$' + (a/1000).toFixed(1) + 'k'; return (n >= 0 ? '+' : '') + '$' + n.toFixed(1); }
        var todayKey = dateKey(new Date());
        document.querySelectorAll('.j-panel-tab').forEach(function(btn){
          btn.addEventListener('click', function(){
            document.querySelectorAll('.j-panel-tab').forEach(function(b){ b.classList.remove('active'); });
            btn.classList.add('active');
            var t = btn.getAttribute('data-tab');
            document.getElementById('trades-recent').style.display = t === 'recent' ? 'block' : 'none';
            document.getElementById('trades-open').style.display = t === 'open' ? 'block' : 'none';
          });
        });
        function render(){
          var y = cur.getFullYear(), m = cur.getMonth();
          document.getElementById('cal-month-year').textContent = monthNames[m] + ' ' + y;
          var first = new Date(y, m, 1);
          var last = new Date(y, m + 1, 0);
          var startPad = first.getDay();
          var days = last.getDate();
          var prevLast = new Date(y, m, 0).getDate();
          var grid = document.getElementById('cal-grid');
          grid.innerHTML = '';
          for (var i = 0; i < startPad; i++) {
            var cell = document.createElement('div');
            cell.className = 'cal-day other-month';
            cell.innerHTML = '<span class="cal-num">' + (prevLast - startPad + i + 1) + '</span>';
            grid.appendChild(cell);
          }
          for (var d = 1; d <= days; d++) {
            var dt = new Date(y, m, d);
            var key = dateKey(dt);
            var pnl = samplePnL[key];
            var trades = sampleTrades[key] || 0;
            var cell = document.createElement('div');
            cell.className = 'cal-day' + (pnl != null ? ' has-pnl ' + (pnl >= 0 ? 'profit' : 'loss') : '') + (key === todayKey ? ' is-today' : '');
            cell.setAttribute('data-date', key);
            cell.setAttribute('data-pnl', pnl != null ? pnl : '');
            cell.setAttribute('data-trades', trades);
            var pnlStr = pnl != null ? formatPnl(pnl) : '';
            var tradesStr = (pnl != null ? trades : 0) + ' trade' + (trades !== 1 ? 's' : '');
            cell.innerHTML = '<span class="cal-num">' + d + '</span>' + (pnlStr ? '<div class="cal-day-content"><span class="cal-pnl">' + pnlStr + '</span><span class="cal-trades">' + tradesStr + '</span></div>' : '');
            cell.addEventListener('mouseenter', showTooltip);
            cell.addEventListener('mouseleave', hideTooltip);
            cell.addEventListener('mousemove', moveTooltip);
            grid.appendChild(cell);
          }
          var rest = (startPad + days <= 35 ? 35 : 42) - (startPad + days);
          for (var j = 0; j < rest; j++) {
            var cell = document.createElement('div');
            cell.className = 'cal-day other-month';
            cell.innerHTML = '<span class="cal-num">' + (j + 1) + '</span>';
            grid.appendChild(cell);
          }
        }
        function showTooltip(e){
          var el = e.target.closest('.cal-day');
          if (!el || el.classList.contains('other-month')) return;
          var dateStr = el.getAttribute('data-date');
          var pnl = el.getAttribute('data-pnl');
          var trades = el.getAttribute('data-trades') || '0';
          if (!dateStr) return;
          var parts = dateStr.split('-');
          var d = new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10));
          document.getElementById('cal-tooltip-date').textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
          if (pnl !== '' && pnl != null) {
            var n = parseFloat(pnl);
            document.getElementById('cal-tooltip-pnl').textContent = (n >= 0 ? '+' : '') + '$' + n.toFixed(2);
            document.getElementById('cal-tooltip-pnl').style.color = n >= 0 ? '#4ade80' : '#f87171';
          } else {
            document.getElementById('cal-tooltip-pnl').textContent = 'No trades';
            document.getElementById('cal-tooltip-pnl').style.color = '#64748b';
          }
          document.getElementById('cal-tooltip-trades').textContent = trades + ' trade(s) closed';
          document.getElementById('cal-tooltip').style.display = 'block';
        }
        function hideTooltip(){ document.getElementById('cal-tooltip').style.display = 'none'; }
        function moveTooltip(e){
          var tt = document.getElementById('cal-tooltip');
          tt.style.left = (e.clientX + 14) + 'px';
          tt.style.top = (e.clientY + 14) + 'px';
        }
        document.getElementById('cal-prev').onclick = function(){ cur.setMonth(cur.getMonth()-1); render(); };
        document.getElementById('cal-next').onclick = function(){ cur.setMonth(cur.getMonth()+1); render(); };
        document.getElementById('cal-prev-yr').onclick = function(){ cur.setFullYear(cur.getFullYear()-1); render(); };
        document.getElementById('cal-next-yr').onclick = function(){ cur.setFullYear(cur.getFullYear()+1); render(); };
        document.getElementById('cal-today').onclick = function(){ cur = new Date(); render(); };
        document.getElementById('cal-info').onclick = function(){ alert('Daily PnL: green = profit day, red = loss day. Live from NinjaTrader via HVTJournalSync.'); };
        render();
        var liveData={pnl:{},trades:{},recent:[],open:[]};
        function g(id){return document.getElementById(id);}
        function setText(id,txt,col){var e=g(id);if(e){e.textContent=txt;if(col)e.style.color=col;}}
        function applyPeriodFilter(p){
          var now=new Date();
          var f=liveData.recent.filter(function(t){
            var d=new Date(t.exit_time);
            if(p==='day') return d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate();
            if(p==='week'){var w=new Date(now);w.setDate(now.getDate()-now.getDay());w.setHours(0,0,0,0);return d>=w;}
            if(p==='month') return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();
            return true;
          });
          f=f.map(function(t){var n=parseFloat(t.net_pnl);return Object.assign({},t,{net_pnl:isNaN(n)?0:n});});
          var fAsc=f.slice().sort(function(a,b){return new Date(a.exit_time)-new Date(b.exit_time);});
          var fDesc=f.slice().sort(function(a,b){return new Date(b.exit_time)-new Date(a.exit_time);});
          var wins=f.filter(function(t){return t.net_pnl>0;});
          var losses=f.filter(function(t){return t.net_pnl<0;});
          var net=Math.round(f.reduce(function(s,t){return s+t.net_pnl;},0)*100)/100;
          var aw=wins.length?Math.round(wins.reduce(function(s,t){return s+t.net_pnl;},0)/wins.length*100)/100:null;
          var al=losses.length?Math.round(Math.abs(losses.reduce(function(s,t){return s+t.net_pnl;},0)/losses.length)*100)/100:null;
          var gw=Math.round(wins.reduce(function(s,t){return s+t.net_pnl;},0)*100)/100;
          var gl=Math.round(Math.abs(losses.reduce(function(s,t){return s+t.net_pnl;},0))*100)/100;
          var ts=0,sd=null;
          for(var j=fAsc.length-1;j>=0;j--){var ww=fAsc[j].net_pnl>0;if(sd===null)sd=ww;if(ww===sd)ts++;else break;}
          var pnlColor=net>0?'#4ade80':net<0?'#ef4444':'#94a3b8';
          setText('stat-pnl',(net>=0?'+':'')+'\$'+Math.abs(net).toFixed(2),pnlColor);
          var pnlBar=g('pnl-bar');
          if(pnlBar){pnlBar.style.width=(f.length?Math.min(100,70+Math.min(30,f.length*3))+'%':'0%');pnlBar.className='j-bar '+(net>=0?'j-bar-win':'j-bar-loss');}
          setText('pnl-trades-label',f.length+' trade'+(f.length!==1?'s':''),'#64748b');
          setText('pnl-today-label',wins.length+'W / '+losses.length+'L','#64748b');
          var awStr=aw!==null?'+\$'+aw.toFixed(0):'—';
          var alStr=al!==null?'-\$'+al.toFixed(0):'—';
          setText('stat-avgwl',awStr+' / '+alStr,aw!==null?'#e2e8f0':'#94a3b8');
          var totalBar=gw+gl;
          var winPct=totalBar>0?Math.round(gw/totalBar*100):50;
          var lossPct=100-winPct;
          var bw=g('avgwl-bar-win'),bl=g('avgwl-bar-loss');
          if(bw&&bl){if(f.length===0){bw.style.width='50%';bl.style.width='50%';}else{bw.style.width=winPct+'%';bl.style.width=lossPct+'%';}}
          setText('avgwl-wins-label',wins.length+' win'+(wins.length!==1?'s':''),'#22c55e');
          setText('avgwl-losses-label',losses.length+' loss'+(losses.length!==1?'es':''),'#ef4444');
          var streakColor=ts>0&&sd===true?'#4ade80':ts>0&&sd===false?'#ef4444':'#94a3b8';
          var streakLabel=ts>0?(sd===true?'\u25b2 '+ts+' win'+(ts!==1?'s':''):'\u25bc '+ts+' loss'+(ts!==1?'es':'')):'0 trades';
          setText('stat-tradestreak',streakLabel,streakColor);
          var dotsEl=g('streak-dots');
          if(dotsEl){dotsEl.innerHTML='';var show=Math.min(ts,8);for(var d2=0;d2<show;d2++){var dot=document.createElement('div');dot.style.cssText='width:10px;height:10px;border-radius:50%;background:'+(sd===true?'#22c55e':'#ef4444')+';opacity:'+(1-(d2*0.08))+';';dotsEl.appendChild(dot);}if(ts===0){var dot0=document.createElement('div');dot0.style.cssText='width:10px;height:10px;border-radius:50%;background:#334155;';dotsEl.appendChild(dot0);}}
          var wCount=f.filter(function(t){return t.net_pnl>0;}).length;
          var lCount=f.filter(function(t){return t.net_pnl<0;}).length;
          setText('streak-w-label',wCount+'W','#22c55e');
          setText('streak-l-label',lCount+'L','#ef4444');
          var tb=document.querySelector('#trades-recent table tbody');
          if(tb){if(!f.length){tb.innerHTML='<tr><td colspan="3" style="text-align:center;color:#64748b;padding:28px;">No trades recorded yet</td></tr>';}else{tb.innerHTML=fDesc.map(function(t){var c=t.net_pnl>0?'#4ade80':t.net_pnl<0?'#f87171':'#94a3b8';var d=new Date(t.exit_time);return '<tr><td>'+(t.instrument||'\u2014')+'</td><td>'+(d.getMonth()+1)+'/'+d.getDate()+'/'+d.getFullYear()+'</td><td style="color:'+c+';font-weight:600;">'+(t.net_pnl>=0?'+':'')+' $'+Math.abs(t.net_pnl||0).toFixed(2)+'</td></tr>';}).join('');}}
          var ob=document.querySelector('#trades-open table tbody');
          if(ob){if(!liveData.open||!liveData.open.length){ob.innerHTML='<tr><td colspan="3" style="text-align:center;color:#64748b;padding:24px;">No open positions</td></tr>';}else{ob.innerHTML=liveData.open.map(function(p){var c=p.unrealized_pnl>=0?'#4ade80':'#f87171';return '<tr><td>'+(p.instrument||'\u2014')+'</td><td style="color:'+(p.direction==='Long'?'#60a5fa':'#f6ad55')+';">'+(p.direction||'\u2014')+'</td><td style="color:'+c+';font-weight:600;">'+(p.unrealized_pnl>=0?'+':'')+' $'+Math.abs(p.unrealized_pnl||0).toFixed(2)+'</td></tr>';}).join('');}}
          samplePnL=liveData.pnl;sampleTrades=liveData.trades;render();
        }
        function loadJournalData(){fetch('/api/journal/data',{credentials:'include'}).then(function(r){return r.ok?r.json():Promise.reject(r.status);}).then(function(d){liveData=d;applyPeriodFilter(period);}).catch(function(e){console.warn('[HVTJournal]',e);});}
        document.querySelectorAll('.journal-tab').forEach(function(btn){btn.addEventListener('click',function(){document.querySelectorAll('.journal-tab').forEach(function(b){b.classList.remove('active');});btn.classList.add('active');period=btn.getAttribute('data-period');applyPeriodFilter(period);});});
        loadJournalData();
        setInterval(loadJournalData,10000);
      })();
    </script>`, hero));
});

// ─── JOURNAL RATE LIMITER & EMAIL VERIFIER ────────────────────────────────────
const JOURNAL_RATE = rateLimit({ max: 120 });

async function verifyJournalEmail(email) {
    if (!email) return null;
    const e = email.toLowerCase().trim();
    const safe = p => p.then(r => r).catch(() => ({ data: null }));
    const [{ data: m }, { data: l }, { data: d }, { data: mNT }, { data: lNT }] = await Promise.all([
        safe(supabase.from(MEMBERSHIP_TABLE).select('email,status,expires_at').eq('email', e).maybeSingle()),
        safe(supabase.from(LICENSE_TABLE).select('email,status').eq('email', e).maybeSingle()),
        safe(supabase.from(DISCORD_TABLE).select('email,status,expires_at').eq('email', e).maybeSingle()),
        safe(supabase.from(MEMBERSHIP_TABLE).select('email,status,expires_at').eq('nt_email', e).maybeSingle()),
        safe(supabase.from(LICENSE_TABLE).select('email,status').eq('nt_email', e).maybeSingle())
    ]);
    const isMonthly  = ((m?.status==='active'||m?.status==='pending_cancel')&&new Date(m.expires_at)>new Date())||((mNT?.status==='active'||mNT?.status==='pending_cancel')&&new Date(mNT.expires_at)>new Date());
    const isLifetime = l?.status==='active'||lNT?.status==='active';
    const isDiscord  = d?.status==='active'&&new Date(d.expires_at)>new Date();
    if (!isMonthly&&!isLifetime&&!isDiscord) return null;
    return (m||mNT||l||lNT||d)?.email||e;
}

// ─── JOURNAL API ──────────────────────────────────────────────────────────────
router.post('/api/journal/trade', JOURNAL_RATE, express.json(), async (req, res) => {
    try {
        const { email, trade } = req.body || {};
        const canonical = await verifyJournalEmail(email);
        if (!canonical) return res.status(401).json({ error: 'No active membership found for this email.' });
        if (!trade||!trade.trade_id) return res.status(400).json({ error: 'Missing trade data.' });
        if (typeof trade.trade_id !== 'string' || trade.trade_id.length > 200) return res.status(400).json({ error: 'Invalid trade_id.' });
        const safeNum = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
        const { error } = await supabase.from(JOURNAL_TABLE).upsert({
            email: canonical, account_name: trade.account_name||null, instrument: trade.instrument||null,
            direction: trade.direction||null, quantity: parseInt(trade.quantity)||0,
            entry_price: safeNum(trade.entry_price), exit_price: safeNum(trade.exit_price),
            entry_time: trade.entry_time||null, exit_time: trade.exit_time||null,
            pnl: safeNum(trade.pnl), commission: safeNum(trade.commission), net_pnl: safeNum(trade.net_pnl),
            trade_id: trade.trade_id, is_open: false, unrealized_pnl: 0, updated_at: nowISO()
        }, { onConflict: 'trade_id' });
        if (error) { console.error('[Journal/trade]', error.message); return res.status(500).json({ error: 'DB error.' }); }
        res.json({ ok: true });
    } catch (e) { console.error('[Journal/trade]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

router.post('/api/journal/positions', JOURNAL_RATE, express.json(), async (req, res) => {
    try {
        const { email, open_positions } = req.body || {};
        const canonical = await verifyJournalEmail(email);
        if (!canonical) return res.status(401).json({ error: 'No active membership found for this email.' });
        await supabase.from(JOURNAL_TABLE).update({ is_open: false, updated_at: nowISO() }).eq('email', canonical).eq('is_open', true);
        if (open_positions&&open_positions.length>0) {
            const { error: posErr } = await supabase.from(JOURNAL_TABLE).upsert(open_positions.map(p => ({
                email: canonical, account_name: p.account_name||null, instrument: p.instrument||null,
                direction: p.direction||null, quantity: p.quantity||0, entry_price: p.avg_price||0,
                exit_price: 0, entry_time: p.updated_at||nowISO(), exit_time: null,
                pnl: 0, commission: 0, net_pnl: 0,
                trade_id: `open_${canonical}_${(p.instrument||'').replace(/[^a-z0-9]/gi,'_')}`,
                is_open: true, unrealized_pnl: p.unrealized_pnl||0, updated_at: nowISO()
            })), { onConflict: 'trade_id' });
            if (posErr) console.error('[Journal/positions] upsert error:', posErr.message);
        }
        res.json({ ok: true });
    } catch (e) { console.error('[Journal/positions]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

router.get('/api/journal/data', requireSession, async (req, res) => {
    try {
        const email = req._session.email.toLowerCase().trim();
        const { data: rows, error } = await supabase.from(JOURNAL_TABLE)
            .select('instrument,direction,quantity,entry_price,exit_price,entry_time,exit_time,pnl,commission,net_pnl,is_open,unrealized_pnl')
            .eq('email', email).order('exit_time', { ascending: false }).limit(2000);
        if (error) return res.status(500).json({ error: 'DB error.' });
        const closed=(rows||[]).filter(t=>!t.is_open), open=(rows||[]).filter(t=>t.is_open);
        const pnlMap={}, tradesMap={};
        closed.forEach(t => {
            if (!t.exit_time) return;
            const d=new Date(t.exit_time), k=d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();
            pnlMap[k]=Math.round(((pnlMap[k]||0)+(t.net_pnl||0))*100)/100;
            tradesMap[k]=(tradesMap[k]||0)+1;
        });
        res.json({ pnl:pnlMap, trades:tradesMap, recent:closed,
            open:open.map(p=>({instrument:p.instrument,direction:p.direction,quantity:p.quantity,unrealized_pnl:p.unrealized_pnl})) });
    } catch (e) { console.error('[Journal/data]', e.message); res.status(500).json({ error: 'Server error.' }); }
});

// ─── COURSE PLAYER ────────────────────────────────────────────────────────────
router.get('/course', requireSession, (req, res) => {
    const s = req._session;
    const LOGO_URL = '/hvt-logo.cropped.png';
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>Course Library — HVT</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{background:#060810;color:#fff;font-family:'DM Sans',-apple-system,sans-serif;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:0 28px;height:64px;border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(10,10,12,0.85);backdrop-filter:blur(16px);flex-shrink:0;z-index:200;position:relative}
.topbar-left{display:flex;align-items:center;gap:12px;min-width:0;flex-shrink:0}
.topbar-logo{display:flex;align-items:center;text-decoration:none;flex-shrink:0}
.topbar-logo img{height:29px;width:auto;object-fit:contain;display:block}
.topbar-right{display:flex;align-items:center;gap:12px;flex-shrink:0}
.topnav-link,.topnav-out{color:rgba(255,255,255,0.82);font-size:13px;font-weight:600;text-decoration:none;padding:8px 0;transition:color .2s}
.topnav-link:hover,.topnav-out:hover{color:#fff}
.prop-firm-btn{display:inline-block;background:#2254F5;color:#fff;font-size:12px;font-weight:500;text-decoration:none;padding:8px 14px;border-radius:6px;white-space:nowrap}
.prop-firm-btn:hover{background:#2d5cf7}
.mob-menu{display:none;align-items:center;justify-content:center;width:36px;height:36px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:6px;cursor:pointer;color:rgba(255,255,255,0.7);font-size:18px;flex-shrink:0}
.layout{display:flex;flex:1;overflow:hidden}
.sidebar{width:288px;flex-shrink:0;border-right:1px solid rgba(255,255,255,0.07);background:#060810;display:flex;flex-direction:column;overflow:hidden;transition:transform .25s ease}
.sidebar-header{padding:16px 20px 14px;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0}
.sidebar-header h2{font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#334155}
.sidebar-scroll{flex:1;overflow-y:auto;padding:6px 0 16px}
.sidebar-scroll::-webkit-scrollbar{width:3px}
.sidebar-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.07);border-radius:2px}
.section{margin-bottom:1px}
.section-header{display:flex;align-items:center;gap:8px;padding:10px 18px;cursor:pointer;user-select:none;transition:background .15s}
.section-header:hover{background:rgba(255,255,255,0.025)}
.section-dot{width:6px;height:6px;border-radius:50%;background:#1e2d3d;flex-shrink:0;transition:background .2s}
.section.open .section-dot{background:#2254F5}
.section-title{font-size:11px;font-weight:700;color:#64748b;letter-spacing:0.8px;text-transform:uppercase;flex:1;transition:color .2s}
.section.open .section-title{color:#94a3b8}
.section-count{font-size:10px;color:#1e2d3d;font-weight:600;margin-right:4px}
.section-chevron{color:#1e2d3d;font-size:9px;transition:transform .2s}
.section.open .section-chevron{transform:rotate(90deg);color:#334155}
.section-videos{display:none;padding:2px 0 4px}
.section.open .section-videos{display:block}
.video-item{display:flex;align-items:center;gap:11px;padding:8px 18px 8px 26px;cursor:pointer;transition:background .12s;position:relative}
.video-item:hover{background:rgba(255,255,255,0.025)}
.video-item.active{background:rgba(34,84,245,0.06)}
.video-item.active::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:#2254F5;border-radius:0 2px 2px 0}
.video-item.no-video{opacity:0.4;cursor:default}
.video-thumb{width:52px;height:32px;border-radius:5px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.play-icon{width:13px;height:13px;color:#2d3f52}
.video-item.active .play-icon{color:#2254F5}
.video-info{flex:1;min-width:0}
.video-title{font-size:12px;font-weight:500;color:#475569;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .15s}
.video-item:hover:not(.no-video) .video-title{color:#64748b}
.video-item.active .video-title{color:#e2e8f0;font-weight:600}
.video-dur{font-size:10px;color:#1e2d3d;margin-top:1px;font-weight:500}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#060810;min-width:0}
.player-wrap{flex:1;display:flex;align-items:center;justify-content:center;background:#000;position:relative;min-height:0}
.player-wrap iframe{width:100%;height:100%;border:none;display:block}
.player-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#64748b;text-align:center;padding:40px;width:100%;height:100%}
.video-meta{padding:16px 24px;border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;background:#060810;display:none;align-items:center;gap:14px;flex-wrap:wrap}
.video-meta h2{font-size:16px;font-weight:700;color:#fff;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.video-meta-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.section-badge{background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.2);border-radius:20px;padding:3px 11px;font-size:10px;font-weight:700;color:#2254F5;letter-spacing:1.5px;text-transform:uppercase}
.video-dur-meta{font-size:12px;color:#334155;font-weight:500}
.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:149;backdrop-filter:blur(2px)}
.sidebar-overlay.show{display:block}
@media(max-width:768px){
  .topbar{padding:0 12px;height:56px}
  .topbar-logo img{height:21px}
  .topbar-right a.topnav-link,.topbar-right a.topnav-out{display:none}
  .mob-menu{display:flex}
  .sidebar{position:fixed;left:0;top:56px;bottom:0;width:280px;z-index:150;transform:translateX(-100%);box-shadow:4px 0 32px rgba(0,0,0,0.6)}
  .sidebar.open{transform:translateX(0)}
  .video-meta{padding:12px 16px}
  .video-meta h2{font-size:14px}
}
@media(max-width:400px){.topbar-logo img{height:18px}}
</style>
</head><body>
<div class="topbar">
  <div class="topbar-left">
    <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="topbar-logo">
      <img src="${LOGO_URL}" alt="High Velocity Trading" onerror="this.style.display='none'" />
    </a>
  </div>
  <div class="topbar-right">
    <a href="/member" class="topnav-link">Portal</a>
    <a href="/billing/confirm-session" class="topnav-out">Billing</a>
    <a href="/logout" class="topnav-out">Log out</a>
    <a href="/prop-activation" class="prop-firm-btn">Prop Firms</a>
    <button class="mob-menu" id="mobMenu">&#9776;</button>
  </div>
</div>
<div class="sidebar-overlay" id="sidebarOverlay"></div>
<div class="layout">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header"><h2>Course Content</h2></div>
    <div class="sidebar-scroll" id="sidebarScroll"></div>
  </div>
  <div class="main">
    <div class="player-wrap" id="playerWrap">
      <div class="player-placeholder" id="placeholder">
        <div style="width:72px;height:72px;border-radius:50%;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.18);display:flex;align-items:center;justify-content:center;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#2254F5" stroke-width="1.5" style="opacity:0.8"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"/></svg>
        </div>
        <h3 style="font-size:18px;font-weight:700;color:#94a3b8;margin-top:4px;">HVT Masterclass</h3>
        <p style="font-size:13px;color:#334155;max-width:300px;line-height:1.6;">Select a lesson from the menu to begin.</p>
      </div>
      <div id="player" style="display:none;width:100%;height:100%;"></div>
    </div>
    <div class="video-meta" id="videoMeta">
      <h2 id="videoTitle"></h2>
      <div class="video-meta-right">
        <span class="section-badge" id="videoSection"></span>
        <span class="video-dur-meta" id="videoDur"></span>
      </div>
    </div>
  </div>
</div>
<script>
(function(){
'use strict';
var COURSE = [
  { title: 'Introduction', videos: [
    { title: 'Welcome to the HVT Portal',     dur: '2m',  ytId: 'vn0L41oxvl4' },
    { title: 'How This Course Is Structured', dur: '3m',  ytId: 'g38umuTvf_M' },
    { title: 'Getting the Most Out of HVT',   dur: '3m',  ytId: 'DYZ8njASd74' }
  ]},
  { title: 'Indicators', videos: [
    { title: 'Overview of HVT Indicators',    dur: '4m',  ytId: 'MRteZN0Xgmw' },
    { title: 'Reading Momentum & Trend',      dur: '5m',  ytId: 'pVP01QzVidM' },
    { title: 'Combining Signals for Entries', dur: '6m',  ytId: '' }
  ]},
  { title: 'Risk Management', videos: [
    { title: 'Position Sizing & Daily Loss Limits', dur: '5m', ytId: '' },
    { title: 'Stop Placement & Trade Invalidation', dur: '4m', ytId: '' },
    { title: 'Building a Risk Plan You Keep',       dur: '4m', ytId: '' }
  ]},
  { title: 'Psychology', videos: [
    { title: 'Welcome to HVT Psychology',        dur: '3m', ytId: '' },
    { title: 'Why Traders Fail in the Long Run', dur: '4m', ytId: '' },
    { title: 'Discipline, FOMO, and Tilt',       dur: '5m', ytId: '' },
    { title: 'Creating a Professional Routine',  dur: '4m', ytId: '' }
  ]}
];
var activeSec = 0, activeVid = 0;
var sidebarEl     = document.getElementById('sidebar');
var overlayEl     = document.getElementById('sidebarOverlay');
var scrollEl      = document.getElementById('sidebarScroll');
var playerEl      = document.getElementById('player');
var placeholderEl = document.getElementById('placeholder');
var metaEl        = document.getElementById('videoMeta');
var titleEl       = document.getElementById('videoTitle');
var sectionEl     = document.getElementById('videoSection');
var durEl         = document.getElementById('videoDur');
document.getElementById('mobMenu').addEventListener('click', function(){
  var open = sidebarEl.classList.toggle('open');
  overlayEl.classList.toggle('show', open);
});
overlayEl.addEventListener('click', function(){
  sidebarEl.classList.remove('open');
  overlayEl.classList.remove('show');
});
function buildSidebar(){
  scrollEl.innerHTML = '';
  COURSE.forEach(function(sec, si){
    var secEl = document.createElement('div');
    secEl.className = 'section' + (si === activeSec ? ' open' : '');
    var hdr = document.createElement('div');
    hdr.className = 'section-header';
    hdr.innerHTML = '<div class="section-dot"></div><div class="section-title">'+esc(sec.title)+'</div><div class="section-count">'+sec.videos.length+'</div><div class="section-chevron">&#9654;</div>';
    hdr.addEventListener('click', function(){ toggleSection(si); });
    var vids = document.createElement('div');
    vids.className = 'section-videos';
    sec.videos.forEach(function(v, vi){
      var item = document.createElement('div');
      item.className = 'video-item' + (si===activeSec&&vi===activeVid?' active':'') + (!v.ytId?' no-video':'');
      item.innerHTML = '<div class="video-thumb"><svg class="play-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"/></svg></div><div class="video-info"><div class="video-title">'+esc(v.title)+'</div><div class="video-dur">'+esc(v.dur)+(v.ytId?'':' \xb7 Soon')+'</div></div>';
      if(v.ytId) item.addEventListener('click', function(){ playVideo(si, vi); });
      vids.appendChild(item);
    });
    secEl.appendChild(hdr);
    secEl.appendChild(vids);
    scrollEl.appendChild(secEl);
  });
}
function toggleSection(si){
  var els = scrollEl.querySelectorAll('.section');
  if(els[si]) els[si].classList.toggle('open');
}
function playVideo(si, vi){
  activeSec = si; activeVid = vi;
  buildSidebar();
  var v = COURSE[si].videos[vi];
  if(v.ytId){
    playerEl.innerHTML = '<iframe src="https://www.youtube.com/embed/'+v.ytId+'?autoplay=1&rel=0&iv_load_policy=3" style="width:100%;height:100%;border:none" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>';
    playerEl.style.display = 'block';
    placeholderEl.style.display = 'none';
  } else {
    playerEl.style.display = 'none';
    playerEl.innerHTML = '';
    placeholderEl.style.display = 'flex';
    placeholderEl.innerHTML = '<div style="width:64px;height:64px;border-radius:50%;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.2);display:flex;align-items:center;justify-content:center;"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2254F5" stroke-width="1.5" style="opacity:0.7"><path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"/></svg></div><h3 style="color:#94a3b8;font-size:17px;font-weight:700;">'+esc(v.title)+'</h3><p style="color:#334155;font-size:13px;max-width:280px;line-height:1.6;text-align:center;">This lesson will be available soon.</p>';
  }
  titleEl.textContent   = v.title;
  sectionEl.textContent = COURSE[si].title;
  durEl.textContent     = v.dur;
  metaEl.style.display  = 'flex';
  if(window.innerWidth < 769){
    sidebarEl.classList.remove('open');
    overlayEl.classList.remove('show');
  }
}
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
buildSidebar();
})();
</script>
</body></html>`);
});

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
router.get('/logout', async (req, res) => {
    const { token } = getSessionFromCookie(req);
    if (token) _sessions.delete(token);
    if (token) {
        try {
            await Promise.all([
                supabase.from(MEMBERSHIP_TABLE).update({ session_token: null, session_expires: null, updated_at: nowISO() }).eq('session_token', token),
                supabase.from(LICENSE_TABLE).update({ session_token: null, session_expires: null, updated_at: nowISO() }).eq('session_token', token)
            ]);
        } catch (e) { console.error('[Logout DB clear]', e.message); }
    }
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect(302, 'https://highvelocitytrading.com');
});

module.exports = router;
