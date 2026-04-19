// routes/admin.js
// Admin panel endpoints: member management, god-mode grants, echo licenses, video uploads, and system tools.

'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const {
    MEMBERSHIP_TABLE, LICENSE_TABLE, DISCORD_TABLE, ECHO_TABLE,
    PROP_FIRM_TABLE, COURSE_LESSONS_TABLE,
    ADMIN_SECRET,
    DISCORD_MONTHLY_ROLE_ID, DISCORD_LIFETIME_ROLE_ID, DISCORD_ROOM_ROLE_ID,
    SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
} = require('../config/constants');
const { esc, now30days, nowISO, genEchoKey } = require('../helpers/utils');
const { supabase, revokeMonthlyPropActivations } = require('../services/supabase');
const { findUser, addRole, stripRole, getGuildAll } = require('../services/discord');
const { ntLogin, ntCreateLicense, ntRevokeLicense, getNtToken, getNtAuthFails } = require('../services/ninjatrader');
const { cancelSub } = require('../services/payment');
const { sendWelcome, sendDiscordWelcome, sendEchoWelcome, wrap, sendEmail } = require('../services/email');
const { adm } = require('../middleware/rateLimiter');
const { adminGuard } = require('../middleware/auth');

// ─── ADMIN: REFRESH NT TOKEN ──────────────────────────────────────────────────
router.post('/admin/refresh-nt-token', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const ok = await ntLogin();
        if (ok) return res.json({ ok: true, message: '✅ NT re-authenticated successfully' });
        res.status(500).json({ ok: false, message: '❌ NT login failed — check NT_USERNAME / NT_PASSWORD in Railway env vars' });
    } catch (e) { console.error('[RefreshNT]', e.message); res.status(500).json({ ok: false, message: e.message }); }
});

// ─── ADMIN: CANCEL / REVOKE MEMBERSHIP ───────────────────────────────────────
router.post('/admin/cancel', adm, express.json(), async (req, res) => {
    console.log('[AdminCancel] body:', JSON.stringify(req.body));
    if (req.body?.key !== ADMIN_SECRET) { console.log('[AdminCancel] UNAUTHORIZED — key mismatch'); return res.status(403).json({ error: 'Unauthorized' }); }
    try {
        const email = (req.body.email || '').toLowerCase().trim();
        const type  = req.body.type || 'monthly';
        console.log('[AdminCancel] email:', email, 'type:', type);
        if (!email) return res.status(400).json({ error: 'Email required' });

        const result = { ok: true, type, email, db_updated: false, nt_revoked: false, discord_stripped: false, sub_cancelled: false };

        if (type === 'lifetime') {
            const { data: lRows, error: fetchErr } = await supabase.from(LICENSE_TABLE).select('id,nt_license_id,status,email').eq('email', email).order('updated_at', { ascending: false }).limit(1);
            console.log('[AdminCancel] lifetime fetch:', lRows, fetchErr?.message);
            const l = (lRows && lRows.length > 0) ? lRows[0] : null;
            if (!l) return res.status(404).json({ error: 'No lifetime license found for: ' + email });
            if (l.nt_license_id) {
                try { await ntRevokeLicense(l.nt_license_id); result.nt_revoked = true; }
                catch (e) { console.error('[AdminCancel] NT revoke failed:', e.message); }
            }
            if (l.id) {
                const { error: updErr } = await supabase.from(LICENSE_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('id', l.id);
                if (updErr) { console.error('[AdminCancel] lifetime DB update failed:', updErr.message); result.db_note = 'NT revoked. DB update skipped: ' + updErr.message; }
                else { result.db_updated = true; }
            } else {
                const { error: updErr } = await supabase.from(LICENSE_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email).eq('status', 'active');
                if (updErr) { result.db_note = 'NT revoked. DB update skipped: ' + updErr.message; }
                else { result.db_updated = true; }
            }
        } else if (type === 'discord') {
            const { data: dmRows, error: fetchErr } = await supabase.from(DISCORD_TABLE).select('discord_user_id,authnet_subscription_id,status').eq('email', email).order('updated_at', { ascending: false }).limit(1);
            console.log('[AdminCancel] discord fetch:', dmRows, fetchErr?.message);
            const dm = (dmRows && dmRows.length > 0) ? dmRows[0] : null;
            if (!dm) return res.status(404).json({ error: 'No Discord membership found for: ' + email });
            if (dm.authnet_subscription_id) {
                try { await cancelSub(dm.authnet_subscription_id); result.sub_cancelled = true; }
                catch (e) { console.error('[AdminCancel] Sub cancel failed:', e.message); }
            }
            const rid = DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID;
            if (dm.discord_user_id) {
                try { await stripRole(dm.discord_user_id, rid); result.discord_stripped = true; }
                catch (e) { console.error('[AdminCancel] Discord strip failed:', e.message); }
            }
            const { data: upd, error: updErr } = await supabase.from(DISCORD_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email).select();
            console.log('[AdminCancel] discord update result:', upd, updErr?.message);
            if (updErr) return res.status(500).json({ error: 'DB update failed: ' + updErr.message });
            result.db_updated = true;
        } else {
            const { data: mRows, error: fetchErr } = await supabase.from(MEMBERSHIP_TABLE).select('authnet_subscription_id,discord_user_id,nt_license_id,status,email').eq('email', email).order('updated_at', { ascending: false }).limit(1);
            console.log('[AdminCancel] monthly fetch:', mRows, fetchErr?.message);
            const m = (mRows && mRows.length > 0) ? mRows[0] : null;
            if (!m) return res.status(404).json({ error: 'No monthly membership found for: ' + email });
            if (m.authnet_subscription_id) {
                try { await cancelSub(m.authnet_subscription_id); result.sub_cancelled = true; }
                catch (e) { console.error('[AdminCancel] Sub cancel failed:', e.message); }
            }
            if (m.discord_user_id) {
                try { await stripRole(m.discord_user_id, DISCORD_MONTHLY_ROLE_ID); result.discord_stripped = true; }
                catch (e) { console.error('[AdminCancel] Discord strip failed:', e.message); }
            }
            if (m.nt_license_id) {
                try { await ntRevokeLicense(m.nt_license_id); result.nt_revoked = true; }
                catch (e) { console.error('[AdminCancel] NT revoke failed:', e.message); }
            }
            const { data: upd, error: updErr } = await supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('email', email).select();
            console.log('[AdminCancel] monthly update result:', upd, updErr?.message);
            if (updErr) return res.status(500).json({ error: 'DB update failed: ' + updErr.message });
            result.db_updated = true;
            await revokeMonthlyPropActivations(email).catch(e => console.error('[AdminCancel PropRevoke]', e.message));
        }

        console.log('[AdminCancel] SUCCESS:', result);
        res.json(result);
    } catch (e) { console.error('[AdminCancel] FATAL:', e.message, e.stack); res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: REMOVE DISCORD ROLE ───────────────────────────────────────────────
router.post('/admin/remove-role', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const uid = req.body.discord_user_id;
        if (!uid) return res.status(400).json({ error: 'discord_user_id required' });
        const allRoles = [DISCORD_MONTHLY_ROLE_ID, DISCORD_LIFETIME_ROLE_ID, ...(DISCORD_ROOM_ROLE_ID ? [DISCORD_ROOM_ROLE_ID] : [])];
        for (const rid of allRoles) try { await stripRole(uid, rid); } catch {}
        const [{ data: stripped }] = await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).select('email').eq('discord_user_id', uid).maybeSingle(),
            supabase.from(MEMBERSHIP_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('discord_user_id', uid),
            supabase.from(DISCORD_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('discord_user_id', uid)
        ]);
        if (stripped?.email) revokeMonthlyPropActivations(stripped.email).catch(e => console.error('[AdminRemoveRole PropRevoke]', e.message));
        console.log('[Admin] All roles stripped:', uid);
        res.json({ ok: true });
    } catch (e) { console.error('[AdminRemoveRole]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: GOD MODE GRANT ────────────────────────────────────────────────────
router.post('/admin/god-add', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const email         = (req.body.email || '').trim().toLowerCase();
        const role          = req.body.role || 'monthly';
        const fullName      = (req.body.full_name || '').trim();
        const discordUser   = (req.body.discord_username || '').trim();
        const doEmail       = req.body.send_email !== false;
        const doNT          = req.body.create_nt !== false;
        const doDiscord     = req.body.assign_discord === true;

        if (!email) return res.status(400).json({ error: 'Email is required' });

        const result = { ok: true, supabase: false, nt_license: false, discord: false, email_sent: false };
        const isLifetime    = role === 'lifetime';
        const isDiscordOnly = role === 'discord';
        const expires       = isLifetime ? null : now30days();
        const table         = isLifetime ? LICENSE_TABLE : (isDiscordOnly ? DISCORD_TABLE : MEMBERSHIP_TABLE);
        const ntToken       = getNtToken();

        const row = { email, full_name: fullName || null, status: 'active', plan_name: role, source: 'admin_grant', expires_at: expires, updated_at: nowISO() };
        if (isLifetime) {
            row.transaction_id = `admin_grant_${Date.now()}_${email}`;
            row.license_key    = `HVT-ADMIN-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
        }

        let dbErr = null;
        if (isLifetime) {
            const { data: existingRows } = await supabase.from(table).select('id').eq('email', email).order('updated_at', { ascending: false }).limit(1);
            const existing = existingRows && existingRows.length > 0 ? existingRows[0] : null;
            if (existing) {
                const { error: updErr } = await supabase.from(table).update({ full_name: row.full_name, status: row.status, plan_name: row.plan_name, source: row.source, updated_at: row.updated_at }).eq('id', existing.id);
                dbErr = updErr;
            } else {
                const { error: insErr } = await supabase.from(table).insert(row);
                dbErr = insErr;
            }
        } else {
            const { error: upsErr } = await supabase.from(table).upsert(row, { onConflict: 'email' });
            dbErr = upsErr;
        }
        if (!dbErr) result.supabase = true;
        else console.error('[GodMode] DB error:', dbErr.message);

        if (doNT && !isDiscordOnly && ntToken) {
            try {
                const ntId = await ntCreateLicense(email, isLifetime ? 'lifetime' : 'monthly');
                if (ntId) {
                    result.nt_license = ntId;
                    await supabase.from(table).update({ nt_license_id: ntId, nt_email: email, updated_at: nowISO() }).eq('email', email);
                }
            } catch (e) { console.error('[GodMode] NT error:', e.message); }
        }

        if (doDiscord && discordUser) {
            try {
                const found = await findUser(discordUser);
                if (found) {
                    const uid = found.user.id;
                    const rid = isLifetime ? DISCORD_LIFETIME_ROLE_ID : (isDiscordOnly ? (DISCORD_ROOM_ROLE_ID || DISCORD_MONTHLY_ROLE_ID) : DISCORD_MONTHLY_ROLE_ID);
                    await addRole(uid, rid);
                    await supabase.from(table).update({ discord_user_id: uid, updated_at: nowISO() }).eq('email', email);
                    result.discord = true;
                }
            } catch (e) { console.error('[GodMode] Discord error:', e.message); }
        }

        if (doEmail) {
            try {
                const token    = crypto.randomBytes(32).toString('hex');
                const tokenExp = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                await supabase.from(table).update({ course_token: token, course_token_expires: tokenExp, updated_at: nowISO() }).eq('email', email);
                if (isDiscordOnly) {
                    await sendDiscordWelcome(email, fullName);
                } else {
                    await sendWelcome(email, fullName, isLifetime ? 'lifetime' : 'monthly');
                }
                result.email_sent = true;
            } catch (e) { console.error('[GodMode] Email error:', e.message); }
        }

        console.log(`[GodMode] ${email} | role=${role} | NT=${result.nt_license} | Discord=${result.discord} | Email=${result.email_sent}`);
        res.json(result);
    } catch (e) { console.error('[GodMode]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: PANEL HTML ────────────────────────────────────────────────────────
router.get('/admin', adm, adminGuard, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const key = req.query.key || '';
    const BUILD_TS = 'v' + new Date().toISOString().slice(0,16).replace('T',' ');
    try {
        const [{ data: members }, { data: licenses }, { data: discordMems }, { data: echoLicenses }] = await Promise.all([
            supabase.from(MEMBERSHIP_TABLE).select('email,full_name,status,plan_name,expires_at,discord_user_id,nt_license_id').order('updated_at', { ascending: false }).limit(100),
            supabase.from(LICENSE_TABLE).select('email,full_name,status,license_key,nt_license_id').order('updated_at', { ascending: false }).limit(100),
            supabase.from(DISCORD_TABLE).select('email,full_name,status,expires_at,discord_user_id,discord_username').order('updated_at', { ascending: false }).limit(100),
            supabase.from(ECHO_TABLE).select('id,email,full_name,status,license_key,machine_id,created_at').order('created_at', { ascending: false }).limit(200)
        ]);

        let guildMembers = [];
        try { guildMembers = await getGuildAll(); } catch {}
        const allRoles = [DISCORD_MONTHLY_ROLE_ID, DISCORD_LIFETIME_ROLE_ID, ...(DISCORD_ROOM_ROLE_ID ? [DISCORD_ROOM_ROLE_ID] : [])];
        const liveHVT  = guildMembers.filter(m => m.roles && m.roles.some(r => allRoles.includes(r)));
        const ntToken   = getNtToken();
        const ntAuthFails = getNtAuthFails();
        const ntStatus = ntToken ? '\u2713 Authenticated' : '\u2717 Not Authenticated';
        const ntColor  = ntToken ? '#4ade80' : '#f87171';

        function badge(st, gold) {
            const a  = st === 'active';
            const c  = a ? (gold ? '#f6ad55' : '#4ade80') : '#f87171';
            const bg = a ? (gold ? 'rgba(246,173,85,0.08)' : 'rgba(74,222,128,0.08)') : 'rgba(248,113,113,0.08)';
            const bd = a ? (gold ? 'rgba(246,173,85,0.2)' : 'rgba(74,222,128,0.2)') : 'rgba(248,113,113,0.2)';
            return '<span style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:20px;padding:3px 10px;font-size:11px;color:' + c + ';letter-spacing:1px;font-weight:600;">' + st + '</span>';
        }

        const echoRows = (echoLicenses || []).map(r => {
            const machineDisplay = r.machine_id ? r.machine_id.substring(0,14)+'...' : '<span style="color:#334155;">Not activated</span>';
            const statusColor = r.status === 'active' ? '#e8c878' : '#f87171';
            const statusBg    = r.status === 'active' ? 'rgba(212,168,83,0.14)' : 'rgba(239,68,68,0.1)';
            const statusBd    = r.status === 'active' ? 'rgba(212,168,83,0.3)' : 'rgba(239,68,68,0.25)';
            const cancelBtn   = r.status === 'active'
                ? '<button class="abtn echo-cancel-btn" data-echoid="'+r.id+'" style="font-size:11px;padding:4px 8px;">CANCEL</button>'
                : '<button class="abtn echo-reactivate-btn" data-echoid="'+r.id+'" style="background:linear-gradient(135deg,#14532d,#16a34a);font-size:11px;padding:4px 8px;">REACTIVATE</button>';
            const resetBtn    = r.machine_id ? '<button class="abtn echo-reset-btn" data-echoid="'+r.id+'" style="background:linear-gradient(135deg,#1e3a8a,#2254F5);font-size:11px;padding:4px 8px;margin-left:4px;">RESET</button>' : '';
            const emailBtn    = '<button class="abtn echo-email-btn" data-echoid="'+r.id+'" style="background:linear-gradient(135deg,#4c1d95,#7c3aed);font-size:11px;padding:4px 8px;margin-left:4px;">EMAIL</button>';
            const dateStr     = r.created_at ? new Date(r.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '\u2014';
            return '<tr><td>'+esc(r.full_name||'\u2014')+'</td><td class="em">'+esc(r.email)+'</td><td style="font-family:monospace;font-size:11px;color:#e8c878;">'+esc(r.license_key)+'</td><td><span style="background:'+statusBg+';border:1px solid '+statusBd+';border-radius:4px;padding:3px 8px;font-size:11px;font-weight:700;color:'+statusColor+';">'+r.status+'</span></td><td style="font-family:monospace;font-size:11px;color:#60a5fa;">'+machineDisplay+'</td><td class="dt">'+dateStr+'</td><td style="white-space:nowrap;">'+cancelBtn+resetBtn+emailBtn+'</td></tr>';
        }).join('') || '<tr><td colspan="7" class="empty">No Echo licenses</td></tr>';

        function actionBtn(email, type, label) {
            const safeEmail = email.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
            return '<button class="abtn" data-email="' + safeEmail + '" data-type="' + type + '" data-label="' + label + '">' + label + '</button>';
        }

        const memberRows = (members || []).map(m => {
            const exp = m.expires_at ? new Date(m.expires_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'N/A';
            const ntB = m.nt_license_id ? '<span style="color:#60a5fa;font-size:11px;">NT#' + m.nt_license_id + '</span>' : '<span style="color:#334155;">\u2014</span>';
            const act = m.status === 'active' ? actionBtn(m.email,'monthly','CANCEL') : '<span style="color:#334155;font-size:12px;">Inactive</span>';
            return '<tr><td>' + esc(m.full_name||'\u2014') + '</td><td class="em">' + esc(m.email) + '</td><td>' + badge(m.status) + '</td><td class="dt">' + esc(exp) + '</td><td>' + ntB + '</td><td>' + act + '</td></tr>';
        }).join('') || '<tr><td colspan="6" class="empty">No records</td></tr>';

        const licenseRows = (licenses || []).map(l => {
            const ntB = l.nt_license_id ? '<span style="color:#60a5fa;font-size:11px;">NT#' + l.nt_license_id + '</span>' : '<span style="color:#334155;">\u2014</span>';
            const act = l.status === 'active' ? actionBtn(l.email,'lifetime','REVOKE') : '<span style="color:#334155;font-size:12px;">Inactive</span>';
            return '<tr><td>' + esc(l.full_name||'\u2014') + '</td><td class="em">' + esc(l.email) + '</td><td>' + badge(l.status,true) + '</td><td class="dt" style="font-family:monospace;font-size:11px;">' + esc(l.license_key||'') + '</td><td>' + ntB + '</td><td>' + act + '</td></tr>';
        }).join('') || '<tr><td colspan="6" class="empty">No records</td></tr>';

        const discordRows = (discordMems || []).map(d => {
            const exp = d.expires_at ? new Date(d.expires_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'N/A';
            const act = d.status === 'active' ? actionBtn(d.email,'discord','CANCEL') : '<span style="color:#334155;font-size:12px;">Inactive</span>';
            return '<tr><td>' + esc(d.full_name||'\u2014') + '</td><td class="em">' + esc(d.email) + '</td><td>' + badge(d.status) + '</td><td class="dt">' + esc(exp) + '</td><td style="color:#a78bfa;font-size:12px;">' + esc(d.discord_username||(d.discord_user_id?'Linked':'\u2014')) + '</td><td>' + act + '</td></tr>';
        }).join('') || '<tr><td colspan="5" class="empty">No records</td></tr>';

        const liveRows = liveHVT.map(m => {
            const safeId   = (m.user.id||'').replace(/"/g,'&quot;');
            const safeUser = (m.user.username||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
            return '<tr><td>' + (m.nick||'\u2014') + '</td><td style="color:#a78bfa;">@' + m.user.username + '</td><td style="font-family:monospace;font-size:11px;color:#475569;">' + m.user.id + '</td><td><button class="abtn abtn-rm" data-uid="' + safeId + '" data-uname="' + safeUser + '">REMOVE</button></td></tr>';
        }).join('') || '<tr><td colspan="4" class="empty">No live members</td></tr>';

        const activeMonthly  = (members  || []).filter(m => m.status === 'active').length;
        const activeLifetime = (licenses || []).filter(l => l.status === 'active').length;
        const activeDiscord  = (discordMems || []).filter(d => d.status === 'active').length;
        const totalActive    = activeMonthly + activeLifetime + activeDiscord;
        const mCount  = (members  || []).length;
        const lCount  = (licenses || []).length;
        const dCount  = (discordMems || []).length;
        const lvCount = liveHVT.length;
        const echoCount = (echoLicenses || []).filter(r => r.status === 'active').length;
        const echoTotal = (echoLicenses || []).length;

        const adminJS = [
            'var K=' + JSON.stringify(key) + ';',
            '',
            'function el(id){return document.getElementById(id);}',
            'function on(id,ev,fn){var e=el(id);if(e)e.addEventListener(ev,fn);}',
            '',
            'function showMsg(id,ok,text){',
            '  var e=el(id);if(!e)return;',
            '  e.className="msg "+(ok?"ok":"er")+" show";',
            '  e.textContent=text;',
            '}',
            '',
            'function post(url,body,okCb,errCb){',
            '  fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({key:K},body))})',
            '    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})',
            '    .then(function(x){x.ok?okCb(x.d):errCb(x.d.error||JSON.stringify(x.d));})',
            '    .catch(function(e){errCb("Network error: "+e.message);});',
            '}',
            '',
            '// TABS',
            'document.querySelectorAll(".tab").forEach(function(btn){',
            '  btn.addEventListener("click",function(){',
            '    document.querySelectorAll(".tab").forEach(function(b){b.classList.remove("on");});',
            '    document.querySelectorAll(".tp").forEach(function(p){p.style.display="none";});',
            '    btn.classList.add("on");',
            '    var p=el("tp-"+btn.dataset.tab);',
            '    if(p)p.style.display="block";',
            '  });',
            '});',
            '',
            'on("btnRefreshNT","click",function(){',
            '  var btn=el("btnRefreshNT");',
            '  if(btn)btn.disabled=true;',
            '  showMsg("ntMsg",true,"Reconnecting...");',
            '  fetch("/admin/refresh-nt-token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:K})})',
            '    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})',
            '    .then(function(x){showMsg("ntMsg",x.ok,x.d.message||(x.ok?"Done":"Error"));})',
            '    .catch(function(e){showMsg("ntMsg",false,"Network error: "+e.message);})',
            '    .finally(function(){var b=el("btnRefreshNT");if(b)b.disabled=false;});',
            '});',
            '',
            'on("btnTestStorage","click",function(){',
            '  var btn=el("btnTestStorage");',
            '  if(btn)btn.disabled=true;',
            '  showMsg("storageMsg",true,"Testing...");',
            '  fetch("/admin/test-storage?key="+encodeURIComponent(K))',
            '    .then(function(r){return r.json();})',
            '    .then(function(d){',
            '      var t=["Buckets: "+JSON.stringify(d.buckets),"Uploads: "+JSON.stringify(d.uploads_root),"Installer: "+(d.installer_signed_url||"N/A"),"Template: "+(d.template_signed_url||"N/A")];',
            '      showMsg("storageMsg",!!(d.installer_signed_url&&d.installer_signed_url.length>10),t.join("\\n"));',
            '    })',
            '    .catch(function(e){showMsg("storageMsg",false,"Error: "+e.message);})',
            '    .finally(function(){var b=el("btnTestStorage");if(b)b.disabled=false;});',
            '});',
            '',
            'on("btnGodMode","click",function(){',
            '  var email=(el("godEmail").value||"").trim();',
            '  if(!email){showMsg("godMsg",false,"Email is required.");return;}',
            '  var btn=el("btnGodMode");if(btn)btn.disabled=true;',
            '  showMsg("godMsg",true,"Granting access...");',
            '  post("/admin/god-add",{',
            '    email:email,',
            '    role:(el("godRole").value||"monthly"),',
            '    full_name:(el("godName").value||"").trim(),',
            '    discord_username:(el("godUser").value||"").trim(),',
            '    send_email:el("godSendEmail").checked,',
            '    create_nt:el("godNT").checked,',
            '    assign_discord:el("godDiscord").checked',
            '  },function(d){',
            '    var p=[];',
            '    if(d.supabase)p.push("\\u2713 DB");',
            '    if(d.nt_license)p.push("\\u2713 NT");',
            '    if(d.discord)p.push("\\u2713 Discord");',
            '    if(d.email_sent)p.push("\\u2713 Email");',
            '    showMsg("godMsg",true,"\\u26a1 Done! "+(p.length?p.join(" | "):"Access granted"));',
            '    ["godEmail","godName","godUser"].forEach(function(i){var e=el(i);if(e)e.value="";});',
            '    var b=el("btnGodMode");if(b)b.disabled=false;',
            '  },function(e){',
            '    showMsg("godMsg",false,"Error: "+e);',
            '    var b=el("btnGodMode");if(b)b.disabled=false;',
            '  });',
            '});',
            '',
            'on("btnCancel","click",function(){',
            '  var email=(el("manualEmail").value||"").trim();',
            '  var type=(el("manualType").value||"monthly");',
            '  if(!email){showMsg("cancelMsg",false,"Enter an email first.");return;}',
            '  doCancel(email,type);',
            '});',
            '',
            'function doCancel(email,type){',
            '  showMsg("cancelMsg",true,"Cancelling "+email+"...");',
            '  post("/admin/cancel",{email:email,type:type},',
            '    function(d){var note=d.db_note?" (Note: "+d.db_note+")":"";var action=type==="lifetime"?"Revoked":"Cancelled";showMsg("cancelMsg",true,"\\u2713 "+action+": "+email+(d.nt_revoked?" \\u2014 NT revoked":"")+(d.db_updated?" \\u2014 DB updated":"")+note);setTimeout(function(){location.reload();},2000);},',
            '    function(e){showMsg("cancelMsg",false,"Error: "+e);}',
            '  );',
            '}',
            '',
            'document.addEventListener("click",function(e){',
            '  var btn=e.target.closest(".abtn");',
            '  if(!btn)return;',
            '  if(btn.classList.contains("abtn-rm")){',
            '    if(btn.dataset.confirm!=="yes"){',
            '      btn.textContent="CONFIRM?";btn.dataset.confirm="yes";',
            '      btn.style.background="linear-gradient(135deg,#92400e,#d97706)";',
            '      setTimeout(function(){if(btn.dataset.confirm==="yes"){btn.textContent="REMOVE";btn.dataset.confirm="";btn.style.background="";}},3000);',
            '      return;',
            '    }',
            '    btn.disabled=true;btn.textContent="...";',
            '    showMsg("cancelMsg",true,"Removing roles from @"+btn.dataset.uname+"...");',
            '    post("/admin/remove-role",{discord_user_id:btn.dataset.uid},',
            '      function(){showMsg("cancelMsg",true,"\\u2713 Removed @"+btn.dataset.uname);setTimeout(function(){location.reload();},1500);},',
            '      function(e){showMsg("cancelMsg",false,"Error: "+e);btn.disabled=false;btn.textContent="REMOVE";}',
            '    );',
            '    return;',
            '  }',
            '  if(btn.dataset.email){',
            '    if(btn.dataset.confirm!=="yes"){',
            '      btn.dataset.confirm="yes";',
            '      var orig=btn.textContent;',
            '      btn.textContent="CONFIRM?";',
            '      btn.style.background="linear-gradient(135deg,#92400e,#d97706)";',
            '      setTimeout(function(){if(btn.dataset.confirm==="yes"){btn.textContent=orig;btn.dataset.confirm="";btn.style.background="";}},3000);',
            '      return;',
            '    }',
            '    btn.disabled=true;btn.textContent="...";',
            '    doCancel(btn.dataset.email,btn.dataset.type);',
            '  }',
            '});',
            '',
            'on("btnEchoGrant","click",function(){',
            '  var email=(el("echoGrantEmail").value||"").trim();',
            '  if(!email){showMsg("echoGrantMsg",false,"Email is required.");return;}',
            '  var btn=el("btnEchoGrant");if(btn)btn.disabled=true;',
            '  showMsg("echoGrantMsg",true,"Granting Echo license...");',
            '  post("/admin/echo-grant",{email:email,full_name:(el("echoGrantName").value||"").trim(),send_email:el("echoGrantSendEmail").checked},',
            '    function(d){showMsg("echoGrantMsg",true,"\u2713 Echo License: "+(d.license_key||"granted")+" | Email: "+d.email);el("echoGrantEmail").value="";el("echoGrantName").value="";var b=el("btnEchoGrant");if(b)b.disabled=false;},',
            '    function(e){showMsg("echoGrantMsg",false,"Error: "+e);var b=el("btnEchoGrant");if(b)b.disabled=false;}',
            '  );',
            '});',
            '',
            'document.addEventListener("click",function(ev){',
            '  var btn=ev.target.closest(".echo-cancel-btn,.echo-reactivate-btn,.echo-reset-btn,.echo-email-btn");',
            '  if(!btn)return;',
            '  var id=btn.dataset.echoid;',
            '  if(!id)return;',
            '  btn.disabled=true;var orig=btn.textContent;btn.textContent="...";',
            '  var url,confirm_msg;',
            '  if(btn.classList.contains("echo-cancel-btn")){url="/admin/echo-licenses/"+id+"/cancel";confirm_msg="Cancel this Echo license? Customer will lose access.";}',
            '  else if(btn.classList.contains("echo-reactivate-btn")){url="/admin/echo-licenses/"+id+"/reactivate";confirm_msg="Reactivate this Echo license?";}',
            '  else if(btn.classList.contains("echo-reset-btn")){url="/admin/echo-licenses/"+id+"/reset-machine";confirm_msg="Reset this machine ID? Customer can activate on a new machine.";}',
            '  else if(btn.classList.contains("echo-email-btn")){url="/admin/echo-licenses/"+id+"/resend-email";confirm_msg="Resend welcome email to this customer?";}',
            '  if(!confirm(confirm_msg)){btn.disabled=false;btn.textContent=orig;return;}',
            '  post(url,{},',
            '    function(d){if(d.ok){showMsg("echoGrantMsg",true,"\u2713 Done");setTimeout(function(){location.reload();},1200);}else{showMsg("echoGrantMsg",false,d.error||"Error");btn.disabled=false;btn.textContent=orig;}},',
            '    function(e){showMsg("echoGrantMsg",false,"Error: "+e);btn.disabled=false;btn.textContent=orig;}',
            '  );',
            '});',
            '',
            'console.log("[HVT Admin] JS loaded OK. Key present:", !!K);',
        ].join('\n');

        const css = `*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#000;min-height:100vh;padding:28px 20px;color:#fff}
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,0.06)}
.brand{font-size:18px;font-weight:700;letter-spacing:3px;text-transform:uppercase}
.restricted{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:20px;padding:5px 14px;font-size:11px;color:#f87171;letter-spacing:2px;font-weight:700}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin-bottom:28px}
.sc{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:18px 20px;position:relative;overflow:hidden}
.sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.sc-b::before{background:linear-gradient(90deg,#1e3a8a,#2254F5,#1e3a8a)}
.sc-g::before{background:linear-gradient(90deg,#92610a,#f6ad55,#92610a)}
.sc-p::before{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95)}
.sc-gr::before{background:linear-gradient(90deg,#14532d,#16a34a,#14532d)}
.sc-c::before{background:linear-gradient(90deg,#164e63,#06b6d4,#164e63)}
.snum{font-size:32px;font-weight:700;color:#fff;line-height:1}
.slbl{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#475569;margin-top:5px;font-weight:600}
.sec{margin-bottom:28px}
.sec-ttl{font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#64748b;margin-bottom:14px}
.box{border-radius:14px;padding:24px;margin-bottom:16px}
.box-nt{background:rgba(6,182,212,0.04);border:1px solid rgba(6,182,212,0.15)}
.box-gr{background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.15)}
.box-pu{background:rgba(124,58,237,0.05);border:1px solid rgba(124,58,237,0.15)}
.box-re{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08)}
.bbar{height:2px;margin:-24px -24px 20px;border-radius:14px 14px 0 0}
.bbar-cy{background:linear-gradient(90deg,#164e63,#06b6d4,#164e63)}
.bbar-gr{background:linear-gradient(90deg,#14532d,#16a34a,#14532d)}
.bbar-pu{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95)}
.bbar-re{background:linear-gradient(90deg,#7f1d1d,#dc2626,#7f1d1d)}
.boxtitle{font-size:15px;font-weight:700;margin-bottom:4px}
.boxsub{color:#64748b;font-size:13px;margin-bottom:18px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
@media(max-width:600px){.row2{grid-template-columns:1fr}}
label{display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:7px}
input,select{width:100%;padding:11px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:9px;color:#fff;font-size:14px;outline:none;font-family:'DM Sans',sans-serif;margin-bottom:12px}
input:focus,select:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,0.15)}
input::placeholder{color:#334155}
select option{background:#111}
.chks{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:18px}
.chk{display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:13px;cursor:pointer}
.chk input{width:16px;height:16px;margin:0;accent-color:#a78bfa}
.btn{padding:11px 28px;border:none;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;transition:opacity .15s}
.btn:hover{opacity:.8}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-cy{background:linear-gradient(135deg,#164e63,#06b6d4);color:#fff}
.btn-gr{background:linear-gradient(135deg,#14532d,#16a34a);color:#fff}
.btn-pu{background:linear-gradient(135deg,#4c1d95,#7c3aed);color:#fff}
.btn-re{background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff}
.msg{margin-top:14px;padding:11px 14px;border-radius:9px;font-size:13px;display:none;line-height:1.5;white-space:pre-wrap;word-break:break-all}
.msg.show{display:block}
.ok{background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2)}
.er{background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2)}
.tabs{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}
.tab{padding:7px 16px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;border:1px solid rgba(255,255,255,0.08);color:#64748b;background:transparent;transition:all .15s}
.tab.on{background:rgba(34,84,245,0.12);border-color:rgba(37,99,235,0.35);color:#2254F5}
.tp{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:14px;overflow:hidden}
.pt{height:3px}
.pt-b{background:linear-gradient(90deg,#1e3a8a,#2254F5,#1e3a8a)}
.pt-g{background:linear-gradient(90deg,#92610a,#f6ad55,#92610a)}
.pt-p{background:linear-gradient(90deg,#4c1d95,#7c3aed,#4c1d95)}
.pt-gr{background:linear-gradient(90deg,#14532d,#16a34a,#14532d)}
table{width:100%;border-collapse:collapse}
th{padding:11px 13px;text-align:left;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#334155;border-bottom:1px solid rgba(255,255,255,0.05)}
td{padding:11px 13px;border-bottom:1px solid rgba(255,255,255,0.03);font-size:13px}
tr:last-child td{border-bottom:none}
.em{color:#64748b}
.dt{color:#475569;font-size:12px}
td.empty{padding:20px;text-align:center;color:#334155}
.abtn{background:linear-gradient(135deg,#991b1b,#dc2626);color:#fff;border:none;border-radius:6px;padding:5px 13px;font-size:11px;font-weight:700;letter-spacing:1px;cursor:pointer;transition:opacity .15s}
.abtn:hover{opacity:.8}
.abtn:disabled{opacity:.4;cursor:not-allowed}
.ntbadge{display:inline-flex;align-items:center;gap:8px;background:rgba(6,182,212,0.08);border:1px solid rgba(6,182,212,0.2);border-radius:20px;padding:5px 14px;font-size:13px;font-weight:700}`;

        const html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1.0">\n<title>HVT Admin</title>\n<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">\n<style>\n' + css + '\n</style>\n</head>\n<body>\n\n<div class="hdr">\n  <div>\n    <div class="brand">High Velocity Trading</div>\n    <div style="font-size:10px;color:#334155;letter-spacing:3px;text-transform:uppercase;margin-top:2px;">Admin Control Panel &mdash; ' + BUILD_TS + '</div>\n  </div>\n  <div style="display:flex;align-items:center;gap:12px;">\n    <span style="font-size:12px;color:' + ntColor + ';font-weight:600;">NT ' + ntStatus + '</span>\n    <div class="restricted">&#9888; RESTRICTED</div>\n  </div>\n</div>\n\n<div class="stats">\n  <div class="sc sc-b"><div class="snum">' + totalActive + '</div><div class="slbl">Total Active</div></div>\n  <div class="sc sc-b"><div class="snum">' + activeMonthly + '</div><div class="slbl">Monthly Active</div></div>\n  <div class="sc sc-g"><div class="snum">' + activeLifetime + '</div><div class="slbl">Lifetime Active</div></div>\n  <div class="sc sc-p"><div class="snum">' + activeDiscord + '</div><div class="slbl">Discord $37</div></div>\n  <div class="sc sc-gr"><div class="snum">' + lvCount + '</div><div class="slbl">Live on Discord</div></div>\n  <div class="sc sc-c"><div class="snum" style="color:' + ntColor + ';">' + (ntToken ? '&#10003;' : '&#10007;') + '</div><div class="slbl">NT API Status</div></div>\n  <div class="sc sc-c"><div class="snum" style="color:#e8c878;">' + echoCount + '</div><div class="slbl">Echo Active</div></div>\n</div>\n\n<div class="sec">\n  <div class="sec-ttl">&#9670; NinjaTrader API</div>\n  <div class="box box-nt">\n    <div class="bbar bbar-cy"></div>\n    <div class="boxtitle" style="color:#67e8f9;">NT Ecosystem API</div>\n    <div class="boxsub">Auto-authenticates every 45 min. Auth failures: ' + ntAuthFails + '</div>\n    <div style="margin-bottom:16px;"><span class="ntbadge" style="color:' + ntColor + ';">' + ntStatus + '</span></div>\n    <button class="btn btn-cy" id="btnRefreshNT">&#8635; FORCE RE-LOGIN</button>\n    <div class="msg" id="ntMsg"></div>\n  </div>\n  <div class="box box-gr">\n    <div class="bbar bbar-gr"></div>\n    <div class="boxtitle" style="color:#4ade80;">Supabase Storage</div>\n    <div class="boxsub">Test bucket access and file paths for downloads.</div>\n    <button class="btn btn-gr" id="btnTestStorage">&#128196; TEST STORAGE</button>\n    <div class="msg" id="storageMsg"></div>\n  </div>\n  <div class="box" style="background:rgba(212,168,83,0.04);border:1px solid rgba(212,168,83,0.2);">\n    <div class="bbar" style="background:linear-gradient(90deg,#92610a,#e8c878,#92610a);"></div>\n    <div class="boxtitle" style="color:#e8c878;">HVT Echo Control Panel</div>\n    <div class="boxsub">Full Echo license management — view all licenses, cancel, reset machine IDs, resend emails.</div>\n    <a href="/admin/echo-licenses?key=' + key + '" class="btn" style="display:inline-block;text-decoration:none;background:linear-gradient(135deg,#92610a,#e8c878);color:#000;">&#128640; OPEN ECHO CONTROL PANEL</a>\n  </div>\n</div>\n\n<div class="sec">\n  <div class="sec-ttl">&#9889; God Mode \u2014 Grant Access</div>\n  <div class="box box-pu">\n    <div class="bbar bbar-pu"></div>\n    <div class="boxtitle" style="color:#c4b5fd;">Grant Full Access Instantly</div>\n    <div class="boxsub">Creates Supabase record, NT license, Discord role, sends magic login link.</div>\n    <div class="row2">\n      <div><label>Email *</label><input type="text" id="godEmail" placeholder="their@email.com"></div>\n      <div><label>Access Type</label><select id="godRole"><option value="monthly">Monthly Member</option><option value="lifetime">Lifetime Member</option><option value="discord">Discord Room ($37)</option></select></div>\n    </div>\n    <div class="row2">\n      <div><label>Full Name</label><input type="text" id="godName" placeholder="John Smith"></div>\n      <div><label>Discord Username</label><input type="text" id="godUser" placeholder="username"></div>\n    </div>\n    <div class="chks">\n      <label class="chk"><input type="checkbox" id="godSendEmail" checked> Send login email</label>\n      <label class="chk"><input type="checkbox" id="godNT" checked> Create NT license</label>\n      <label class="chk"><input type="checkbox" id="godDiscord"> Assign Discord role</label>\n    </div>\n    <button class="btn btn-pu" id="btnGodMode">&#9889; GRANT ACCESS NOW</button>\n    <div class="msg" id="godMsg"></div>\n  </div>\n</div>\n\n<div class="sec">\n  <div class="sec-ttl">Manual Access Removal</div>\n  <div class="box box-re">\n    <div class="bbar bbar-re"></div>\n    <div class="boxtitle">Cancel / Revoke by Email</div>\n    <div class="boxsub">Cancels Authnet sub, removes Discord role, revokes NT license, marks cancelled in Supabase.</div>\n    <label>Member Email</label>\n    <input type="email" id="manualEmail" placeholder="member@email.com">\n    <label>Membership Type</label>\n    <select id="manualType"><option value="monthly">Monthly Membership</option><option value="lifetime">Lifetime License</option><option value="discord">Discord Room ($37)</option></select>\n    <button class="btn btn-re" id="btnCancel">&#128293; CANCEL ACCESS</button>\n    <div class="msg" id="cancelMsg"></div>\n  </div>\n</div>\n\n<div class="sec">\n  <div class="sec-ttl">Member Management</div>\n  <div class="tabs">\n    <button class="tab on" data-tab="monthly">Monthly (' + mCount + ')</button>\n    <button class="tab" data-tab="lifetime">Lifetime (' + lCount + ')</button>\n    <button class="tab" data-tab="discord37">Discord $37 (' + dCount + ')</button>\n    <button class="tab" data-tab="live">Live on Discord (' + lvCount + ')</button>\n    <button class="tab" data-tab="echo">Echo (' + echoTotal + ')</button>\n  </div>\n  <div id="tp-monthly" class="tp"><div class="pt pt-b"></div><div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Expires</th><th>NT</th><th>Action</th></tr></thead><tbody>' + memberRows + '</tbody></table></div></div>\n  <div id="tp-lifetime" class="tp" style="display:none"><div class="pt pt-g"></div><div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>License Key</th><th>NT</th><th>Action</th></tr></thead><tbody>' + licenseRows + '</tbody></table></div></div>\n  <div id="tp-discord37" class="tp" style="display:none"><div class="pt pt-p"></div><div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Expires</th><th>Discord</th><th>Action</th></tr></thead><tbody>' + discordRows + '</tbody></table></div></div>\n  <div id="tp-live" class="tp" style="display:none"><div class="pt pt-gr"></div><div style="overflow-x:auto"><table><thead><tr><th>Display Name</th><th>Username</th><th>Discord ID</th><th>Action</th></tr></thead><tbody>' + liveRows + '</tbody></table></div></div>\n  <div id="tp-echo" class="tp" style="display:none"><div class="pt" style="background:linear-gradient(90deg,#92610a,#e8c878,#92610a);height:3px;"></div><div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Email</th><th>License Key</th><th>Status</th><th>Machine ID</th><th>Date</th><th>Actions</th></tr></thead><tbody>' + echoRows + '</tbody></table></div></div>\n</div>\n\n<div class="sec">\n  <div class="sec-ttl">HVT Echo \u2014 Grant License</div>\n  <div class="box" style="background:rgba(212,168,83,0.03);border:1px solid rgba(212,168,83,0.18);">\n    <div class="bbar" style="background:linear-gradient(90deg,#92610a,#e8c878,#92610a);"></div>\n    <div class="boxtitle" style="color:#e8c878;">Grant Echo License</div>\n    <div class="boxsub">Creates or reactivates an Echo license and optionally sends the welcome email.</div>\n    <div class="row2">\n      <div><label>Email *</label><input type="text" id="echoGrantEmail" placeholder="customer@email.com"></div>\n      <div><label>Full Name</label><input type="text" id="echoGrantName" placeholder="John Smith"></div>\n    </div>\n    <div class="chks">\n      <label class="chk"><input type="checkbox" id="echoGrantSendEmail" checked> Send welcome email with license key</label>\n    </div>\n    <button class="btn" id="btnEchoGrant" style="background:linear-gradient(135deg,#92610a,#e8c878);color:#000;">&#128640; GRANT ECHO LICENSE</button>\n    <div class="msg" id="echoGrantMsg"></div>\n  </div>\n</div>\n\n<script>\n' + adminJS + '\n</script>\n</body>\n</html>';

        res.send(html);
    } catch (e) { console.error('[AdminPanel]', e.message, e.stack); res.status(500).send('<h1 style="color:red">Admin panel error: ' + e.message + '</h1>'); }
});

// ─── ADMIN: TEST STORAGE ───────────────────────────────────────────────────────
router.get('/admin/test-storage', adm, adminGuard, async (req, res) => {
    const results = {};
    try {
        const { data: buckets, error: bErr } = await supabase.storage.listBuckets();
        results.buckets = bErr ? { error: bErr.message } : (buckets || []).map(b => b.name);
        const { data: files, error: fErr } = await supabase.storage.from('uploads').list('', { limit: 20 });
        results.uploads_root = fErr ? { error: fErr.message } : (files || []).map(f => f.name);
        const { data: pkg, error: pErr } = await supabase.storage.from('uploads').list('packages', { limit: 20 });
        results.packages_folder = pErr ? { error: pErr.message } : (pkg || []).map(f => f.name);
        const { data: tpl, error: tErr } = await supabase.storage.from('uploads').list('templates', { limit: 20 });
        results.templates_folder = tErr ? { error: tErr.message } : (tpl || []).map(f => f.name);
        const { data: sd, error: sErr } = await supabase.storage.from('uploads').createSignedUrl('HVTMasterAccessNQ.zip', 60);
        results.installer_signed_url = sErr ? { error: sErr.message } : 'OK — ' + sd.signedUrl.substring(0, 80) + '...';
        const { data: td, error: tde } = await supabase.storage.from('uploads').createSignedUrl('HVT NQ TEMPLATE.xml', 60);
        results.template_signed_url = tde ? { error: tde.message } : 'OK — ' + td.signedUrl.substring(0, 80) + '...';
    } catch (e) { results.exception = e.message; }
    res.json(results);
});

// ─── ADMIN: EMAIL PREVIEW ─────────────────────────────────────────────────────
router.get('/admin/email-preview', adm, adminGuard, (req, res) => {
    const type    = req.query.type || 'monthly';
    const name    = 'Alex';
    const monthly = type === 'monthly';

    const wrapPreview = content => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000000;font-family:'DM Sans',Arial,sans-serif;">
<div style="max-width:600px;margin:40px auto;padding:20px;">
  <div style="text-align:center;margin-bottom:32px;">
    <div style="display:inline-block;border-top:1px solid rgba(255,255,255,0.1);border-bottom:1px solid rgba(255,255,255,0.1);padding:12px 32px;">
      <span style="font-size:18px;font-weight:700;color:#fff;letter-spacing:3px;text-transform:uppercase;">HIGH VELOCITY TRADING</span><br>
      <span style="font-size:10px;color:#64748b;letter-spacing:4px;text-transform:uppercase;">Member Services</span>
    </div>
  </div>
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;">
    <div style="height:3px;background:linear-gradient(90deg,#2254F5,#2254F5,#2254F5);"></div>
    <div style="padding:36px 32px;">${content}</div>
  </div>
  <div style="text-align:center;margin-top:24px;color:#334155;font-size:11px;line-height:1.8;">
    &copy; 2026 High Velocity Trading. All rights reserved.<br>
    <a href="https://highvelocitytrading.com" style="color:#64748b;text-decoration:none;">highvelocitytrading.com</a>
  </div>
</div></body></html>`;

    const toggleBar = `<div style="background:#0f172a;border-bottom:1px solid #1e293b;padding:12px 20px;display:flex;gap:12px;align-items:center;position:sticky;top:0;z-index:100;">
      <span style="color:#64748b;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Preview:</span>
      <a href="/admin/email-preview?type=monthly" style="padding:6px 16px;border-radius:6px;font-size:12px;font-weight:700;text-decoration:none;${monthly ? 'background:#1d4ed8;color:#fff;' : 'background:#1e293b;color:#64748b;'}">Monthly</a>
      <a href="/admin/email-preview?type=lifetime" style="padding:6px 16px;border-radius:6px;font-size:12px;font-weight:700;text-decoration:none;${!monthly ? 'background:#d97706;color:#fff;' : 'background:#1e293b;color:#64748b;'}">Lifetime</a>
      <span style="color:#334155;font-size:11px;margin-left:auto;">Admin preview only — not a real email</span>
    </div>`;

    const emailBody = wrapPreview(monthly
        ? `<div style="text-align:center;padding-bottom:8px;"><div style="display:inline-block;background:rgba(34,84,245,0.1);border:1px solid rgba(34,84,245,0.25);border-radius:20px;padding:5px 18px;margin-bottom:22px;"><span style="color:#60a5fa;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">Monthly Membership — Active</span></div><h1 style="color:#ffffff;font-size:26px;font-weight:800;margin:0 0 10px;letter-spacing:-0.5px;">Welcome to the Team, ${name}.</h1><p style="color:#64748b;font-size:14px;margin:0;">Thank you for joining High Velocity Trading.</p></div>`
        : `<div style="text-align:center;padding-bottom:8px;"><div style="display:inline-block;background:rgba(246,173,85,0.1);border:1px solid rgba(246,173,85,0.3);border-radius:20px;padding:5px 18px;margin-bottom:22px;"><span style="color:#f6ad55;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">Lifetime Access — Active</span></div><h1 style="color:#ffffff;font-size:26px;font-weight:800;margin:0 0 10px;letter-spacing:-0.5px;">Welcome to the Team, ${name}.</h1><p style="color:#64748b;font-size:14px;margin:0;">Thank you for investing in yourself.</p></div>`
    );
    res.send(toggleBar + emailBody);
});

// ─── ADMIN: PROP ACTIVATIONS ───────────────────────────────────────────────────
router.get('/admin/prop-activations', adm, async (req, res) => {
    const secret = req.query.secret || req.headers['x-admin-secret'];
    if (secret !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
        const { data, error } = await supabase.from(PROP_FIRM_TABLE).select('*').order('created_at', { ascending: false });
        if (error) return res.status(500).json({ ok: false, error: error.message });

        const total   = (data || []).length;
        const active  = (data || []).filter(r => r.status === 'active').length;
        const revoked = total - active;
        const firmCounts = {};
        (data || []).forEach(r => { firmCounts[r.firm_name] = (firmCounts[r.firm_name] || 0) + 1; });
        const topFirms = Object.entries(firmCounts).sort((a,b) => b[1]-a[1]).slice(0,5)
            .map(([name, count]) => `<span style="display:inline-block;background:#111827;border:1px solid #1e293b;border-radius:6px;padding:4px 10px;font-size:12px;color:#94a3b8;margin:2px;">${name} <strong style="color:#fff;">${count}</strong></span>`).join(' ');

        const rows = (data || []).map(r => `
        <tr>
          <td style="padding:11px 14px;color:#e2e8f0;font-size:13px;">${esc(r.email)}</td>
          <td style="padding:11px 14px;color:#94a3b8;font-size:13px;">${esc(r.member_name || '—')}</td>
          <td style="padding:11px 14px;font-family:monospace;color:#2254F5;font-size:13px;font-weight:700;letter-spacing:1px;">${esc(r.hvt_id || '—')}</td>
          <td style="padding:11px 14px;color:#60a5fa;font-size:13px;font-weight:600;">${esc(r.firm_name)}</td>
          <td style="padding:11px 14px;">
            <span style="padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;
              background:${r.status==='active'?'rgba(34,197,94,0.1)':'rgba(239,68,68,0.1)'};
              color:${r.status==='active'?'#4ade80':'#f87171'};">${r.status}</span>
          </td>
          <td style="padding:11px 14px;color:#475569;font-size:11px;">${esc(r.nt_license_id || '—')}</td>
          <td style="padding:11px 14px;color:#475569;font-size:12px;">${new Date(r.created_at).toLocaleString()}</td>
          <td style="padding:11px 14px;">
            ${r.status === 'active'
              ? `<button onclick="revokeRow('${r.id}',this)" style="background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.25);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:600;transition:background .15s;">Revoke</button>`
              : '<span style="color:#334155;font-size:12px;">—</span>'}
          </td>
        </tr>`).join('');

        res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>HVT — Prop Activations</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#000;color:#fff;padding:36px 28px;min-height:100vh}
h1{font-size:22px;font-weight:700;letter-spacing:-.3px;margin-bottom:4px}
.sub{color:#64748b;font-size:14px;margin-bottom:28px}
.stats{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.stat{background:#0d1117;border:1px solid #1e293b;border-radius:10px;padding:16px 22px;min-width:120px}
.stat-val{font-size:26px;font-weight:700;color:#fff}
.stat-lbl{font-size:12px;color:#64748b;margin-top:2px;text-transform:uppercase;letter-spacing:.8px}
.firms{margin-bottom:24px}
.firms-lbl{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.search-wrap{margin-bottom:16px}
.search-wrap input{background:#0d1117;border:1px solid #1e293b;border-radius:8px;padding:10px 14px;color:#fff;font-size:14px;width:320px;outline:none}
.search-wrap input:focus{border-color:#2254F5}
table{width:100%;border-collapse:collapse;background:#0d1117;border-radius:12px;overflow:hidden;border:1px solid #1e293b}
th{padding:11px 14px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;background:#111827;border-bottom:1px solid #1e293b}
tr{border-bottom:1px solid #0f172a}
tr:hover td{background:rgba(255,255,255,0.015)}
tr:last-child{border-bottom:none}
</style>
</head><body>
<h1>Prop Firm Activations</h1>
<div class="sub">All accounts authorized through the Prop Firm Activation system</div>
<div class="stats">
  <div class="stat"><div class="stat-val">${total}</div><div class="stat-lbl">Total</div></div>
  <div class="stat"><div class="stat-val" style="color:#4ade80">${active}</div><div class="stat-lbl">Active</div></div>
  <div class="stat"><div class="stat-val" style="color:#f87171">${revoked}</div><div class="stat-lbl">Revoked</div></div>
</div>
${topFirms ? `<div class="firms"><div class="firms-lbl">By Prop Firm</div>${topFirms}</div>` : ''}
<div class="search-wrap"><input type="text" id="srch" placeholder="Search email or firm..." oninput="filterRows(this.value)"/></div>
<table id="tbl">
  <thead><tr>
    <th>Email</th><th>Name</th><th>HVT ID</th><th>Prop Firm</th><th>Status</th><th>NT License ID</th><th>Date</th><th>Action</th>
  </tr></thead>
  <tbody id="tbody">${rows}</tbody>
</table>
<script>
function filterRows(q) {
  q = q.toLowerCase();
  document.querySelectorAll('#tbody tr').forEach(function(tr) {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}
async function revokeRow(id, btn) {
  if (!confirm('Revoke this activation? The user will lose indicator access.')) return;
  btn.disabled = true; btn.textContent = 'Revoking...';
  try {
    var r = await fetch('/admin/prop-activations/' + id + '/revoke', {
      method: 'POST',
      headers: { 'x-admin-secret': new URLSearchParams(location.search).get('key') || '' }
    });
    var d = await r.json();
    if (d.ok) {
      var td = btn.closest('tr').querySelectorAll('td')[4];
      td.innerHTML = '<span style="padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;background:rgba(239,68,68,0.1);color:#f87171;">REVOKED</span>';
      btn.style.display = 'none';
    } else {
      alert(d.error || 'Revoke failed. Try again.');
      btn.disabled = false; btn.textContent = 'Revoke';
    }
  } catch(e) {
    alert('Network error. Try again.');
    btn.disabled = false; btn.textContent = 'Revoke';
  }
}
</script>
</body></html>`);
    } catch(e) { console.error('[AdminPropList]', e.message); res.status(500).json({ ok: false, error: 'Server error.' }); }
});

// ─── ADMIN: REVOKE PROP ACTIVATION ────────────────────────────────────────────
router.post('/admin/prop-activations/:id/revoke', adm, express.json(), async (req, res) => {
    const secret = req.query.secret || req.headers['x-admin-secret'];
    if (secret !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ ok: false, error: 'Missing id.' });
        const { data: record, error: fetchErr } = await supabase.from(PROP_FIRM_TABLE).select('nt_license_id, status').eq('id', id).maybeSingle();
        if (fetchErr || !record) return res.status(404).json({ ok: false, error: 'Activation not found.' });
        if (record.status === 'revoked') return res.json({ ok: true, message: 'Already revoked.' });
        if (record.nt_license_id) {
            try { await ntRevokeLicense(record.nt_license_id); }
            catch(e) { console.error('[PropRevoke] NT revoke error:', e.message); }
        }
        const { error } = await supabase.from(PROP_FIRM_TABLE).update({ status: 'revoked', updated_at: nowISO() }).eq('id', id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        console.log(`[PropRevoke] ✅ Revoked activation id=${id}`);
        res.json({ ok: true });
    } catch(e) { console.error('[PropRevoke] Fatal:', e.message); res.status(500).json({ ok: false, error: 'Server error.' }); }
});

// ─── ADMIN: ECHO LICENSES PAGE ─────────────────────────────────────────────────
router.get('/admin/echo-licenses', adm, adminGuard, async (req, res) => {
    try {
        const { data, error } = await supabase.from(ECHO_TABLE).select('*').order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });

        const total    = (data || []).length;
        const active   = (data || []).filter(r => r.status === 'active').length;
        const activated = (data || []).filter(r => r.machine_id).length;
        const cancelled = (data || []).filter(r => r.status === 'cancelled').length;
        const revenue  = total * 97;

        const rows = (data || []).map(r => `
            <tr data-id="${r.id}">
              <td>${esc(r.full_name || '—')}</td>
              <td style="color:#64748b;">${esc(r.email)}</td>
              <td style="font-family:monospace;color:#e8c878;font-size:12px;font-weight:700;">${esc(r.license_key)}</td>
              <td>
                <span style="padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;
                  background:${r.status === 'active' ? 'rgba(212,168,83,0.14)' : r.status === 'cancelled' ? 'rgba(239,68,68,0.1)' : 'rgba(251,191,36,0.1)'};
                  color:${r.status === 'active' ? '#e8c878' : r.status === 'cancelled' ? '#f87171' : '#fbbf24'};">
                  ${r.status}
                </span>
              </td>
              <td style="font-family:monospace;font-size:11px;color:${r.machine_id ? '#60a5fa' : '#334155'};">
                ${r.machine_id ? r.machine_id.substring(0, 16) + '...' : 'Not yet activated'}
              </td>
              <td style="color:#475569;font-size:12px;">${new Date(r.created_at).toLocaleDateString()}</td>
              <td style="white-space:nowrap;">
                <div style="display:flex;gap:4px;flex-wrap:wrap;">
                  ${r.status === 'active'
                      ? `<button onclick="cancelEcho('${r.id}', this)" style="background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.25);border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;font-weight:600;">Cancel</button>`
                      : r.status === 'cancelled'
                        ? `<button onclick="reactivateEcho('${r.id}', this)" style="background:rgba(34,197,94,0.1);color:#22c55e;border:1px solid rgba(34,197,94,0.25);border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;font-weight:600;">Reactivate</button>`
                        : ''
                  }
                  ${r.machine_id
                      ? `<button onclick="resetMachine('${r.id}', this)" style="background:rgba(96,165,250,0.1);color:#60a5fa;border:1px solid rgba(96,165,250,0.25);border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;font-weight:600;">Reset</button>`
                      : ''
                  }
                  <button onclick="resendEmail('${r.id}', this)" style="background:rgba(168,85,247,0.1);color:#a855f7;border:1px solid rgba(168,85,247,0.25);border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;font-weight:600;">Email</button>
                </div>
              </td>
            </tr>`).join('');

        res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>HVT Echo — Licenses</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#000;color:#fff;padding:36px 28px;min-height:100vh}
h1{font-size:22px;font-weight:700;margin-bottom:4px}
.sub{color:#64748b;font-size:14px;margin-bottom:28px}
.stats{display:flex;gap:16px;margin-bottom:24px}
.stat{background:#0d1117;border:1px solid #1e293b;border-radius:10px;padding:16px 22px}
.stat-val{font-size:28px;font-weight:700}
.stat-lbl{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-top:2px}
.search{background:#0d1117;border:1px solid #1e293b;border-radius:8px;padding:10px 14px;color:#fff;font-size:14px;width:320px;outline:none;margin-bottom:16px}
table{width:100%;border-collapse:collapse;background:#0d1117;border-radius:12px;overflow:hidden;border:1px solid #1e293b}
th{padding:11px 14px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;background:#111827;border-bottom:1px solid #1e293b}
td{padding:11px 14px;border-bottom:1px solid #0f172a;font-size:13px}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,0.015)}
</style></head><body>
<a href="/admin?key=${req.query.key}" style="color:#2254F5;font-size:13px;text-decoration:none;">&larr; Back to Admin</a>
<h1 style="margin-top:20px;">🚀 HVT Echo Control Panel</h1>
<div class="sub">Complete license management system • 100% bulletproof</div>
<div class="stats">
  <div class="stat"><div class="stat-val" style="color:#e8c878;">${total}</div><div class="stat-lbl">Total</div></div>
  <div class="stat"><div class="stat-val" style="color:#4ade80;">${active}</div><div class="stat-lbl">Active</div></div>
  <div class="stat"><div class="stat-val" style="color:#60a5fa;">${activated}</div><div class="stat-lbl">Machines Registered</div></div>
  <div class="stat"><div class="stat-val" style="color:#f87171;">${cancelled}</div><div class="stat-lbl">Cancelled</div></div>
  <div class="stat"><div class="stat-val" style="color:#00D4AA;">$${revenue.toLocaleString()}</div><div class="stat-lbl">Revenue</div></div>
</div>
<input class="search" type="text" placeholder="Search email or license key..." oninput="filter(this.value)" />
<table>
  <thead><tr>
    <th>Name</th><th>Email</th><th>License Key</th><th>Status</th><th>Machine ID</th><th>Date</th><th>Actions</th>
  </tr></thead>
  <tbody id="tbody">${rows}</tbody>
</table>
<script>
var K = '${req.query.key}';
function filter(q){q=q.toLowerCase();document.querySelectorAll('#tbody tr').forEach(function(tr){tr.style.display=tr.textContent.toLowerCase().includes(q)?'':'none';});}
async function cancelEcho(id,btn){
  if(!confirm('❌ Cancel this Echo license? The customer will lose access.')) return;
  btn.disabled=true;btn.textContent='Cancelling...';
  try {
    var r=await fetch('/admin/echo-licenses/'+id+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:K})});
    var d=await r.json();
    if(d.ok){location.reload();} else {alert(d.error||'Error');btn.disabled=false;btn.textContent='Cancel';}
  } catch(e) {alert('Error: '+e.message);btn.disabled=false;btn.textContent='Cancel';}
}
async function reactivateEcho(id,btn){
  if(!confirm('✅ Reactivate this Echo license? The customer will regain access.')) return;
  btn.disabled=true;btn.textContent='Reactivating...';
  try {
    var r=await fetch('/admin/echo-licenses/'+id+'/reactivate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:K})});
    var d=await r.json();
    if(d.ok){location.reload();} else {alert(d.error||'Error');btn.disabled=false;btn.textContent='Reactivate';}
  } catch(e) {alert('Error: '+e.message);btn.disabled=false;btn.textContent='Reactivate';}
}
async function resetMachine(id,btn){
  if(!confirm('🔄 Reset this machine ID? The customer can activate on a new machine.')) return;
  btn.disabled=true;btn.textContent='Resetting...';
  try {
    var r=await fetch('/admin/echo-licenses/'+id+'/reset-machine',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:K})});
    var d=await r.json();
    if(d.ok){location.reload();} else {alert(d.error||'Error');btn.disabled=false;btn.textContent='Reset';}
  } catch(e) {alert('Error: '+e.message);btn.disabled=false;btn.textContent='Reset';}
}
async function resendEmail(id,btn){
  if(!confirm('📧 Resend welcome email to this customer?')) return;
  btn.disabled=true;btn.textContent='Sending...';
  try {
    var r=await fetch('/admin/echo-licenses/'+id+'/resend-email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:K})});
    var d=await r.json();
    if(d.ok){alert('✅ Email sent successfully!');btn.disabled=false;btn.textContent='Email';} else {alert(d.error||'Error');btn.disabled=false;btn.textContent='Email';}
  } catch(e) {alert('Error: '+e.message);btn.disabled=false;btn.textContent='Email';}
}
</script>
</body></html>`);
    } catch (e) { console.error('[EchoAdmin]', e.message); res.status(500).send('Error: ' + e.message); }
});

// ─── ADMIN: ECHO — CANCEL A LICENSE ───────────────────────────────────────────
router.post('/admin/echo-licenses/:id/cancel', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { id } = req.params;
        const { error } = await supabase.from(ECHO_TABLE).update({ status: 'cancelled', updated_at: nowISO() }).eq('id', id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        console.log(`[EchoAdmin] License cancelled: ${id}`);
        res.json({ ok: true });
    } catch (e) { console.error('[EchoAdmin cancel]', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// ─── ADMIN: ECHO — RESET MACHINE ID ───────────────────────────────────────────
router.post('/admin/echo-licenses/:id/reset-machine', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { id } = req.params;
        const { error } = await supabase.from(ECHO_TABLE).update({ machine_id: null, updated_at: nowISO() }).eq('id', id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        console.log(`[EchoAdmin] Machine ID reset: ${id}`);
        res.json({ ok: true });
    } catch (e) { console.error('[EchoAdmin reset]', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// ─── ADMIN: ECHO — REACTIVATE A LICENSE ───────────────────────────────────────
router.post('/admin/echo-licenses/:id/reactivate', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { id } = req.params;
        const { error } = await supabase.from(ECHO_TABLE).update({ status: 'active', updated_at: nowISO() }).eq('id', id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        console.log(`[EchoAdmin] ✅ License reactivated: ${id}`);
        res.json({ ok: true });
    } catch (e) { console.error('[EchoAdmin reactivate]', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// ─── ADMIN: ECHO — RESEND WELCOME EMAIL ───────────────────────────────────────
router.post('/admin/echo-licenses/:id/resend-email', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { id } = req.params;
        const { data: license, error } = await supabase.from(ECHO_TABLE).select('*').eq('id', id).single();
        if (error || !license) return res.status(404).json({ ok: false, error: 'License not found' });
        await sendEchoWelcome(license.email, license.full_name, license.license_key);
        console.log(`[EchoAdmin] ✅ Email resent: ${license.email}`);
        res.json({ ok: true });
    } catch (e) { console.error('[EchoAdmin email]', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// ─── ADMIN: ECHO — GRANT ACCESS MANUALLY ──────────────────────────────────────
router.post('/admin/echo-grant', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const email    = (req.body.email || '').toLowerCase().trim();
        const fullName = (req.body.full_name || '').trim();
        const sendMail = req.body.send_email !== false;
        if (!email) return res.status(400).json({ error: 'Email required' });

        const { data: existing } = await supabase.from(ECHO_TABLE).select('license_key, status').eq('email', email).maybeSingle();
        let licenseKey;
        if (existing) {
            licenseKey = existing.license_key;
            await supabase.from(ECHO_TABLE).update({ status: 'active', updated_at: nowISO() }).eq('email', email);
        } else {
            licenseKey = genEchoKey();
            await supabase.from(ECHO_TABLE).insert({
                email, full_name: fullName || null, license_key: licenseKey,
                status: 'active', machine_id: null, purchase_date: nowISO(), updated_at: nowISO()
            });
        }

        if (sendMail) {
            try { await sendEchoWelcome(email, fullName, licenseKey); }
            catch (e) { console.error('[EchoGrant] Email error:', e.message); }
        }

        console.log(`[EchoGrant] ✅ Granted to ${email} | ${licenseKey}`);
        res.json({ ok: true, license_key: licenseKey, email });
    } catch (e) { console.error('[EchoGrant]', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// ─── ADMIN: VIDEO MANAGEMENT PAGE ─────────────────────────────────────────────
router.get('/admin/videos', adm, adminGuard, async (req, res) => {
    try {
        const { data: lessons, error } = await supabase.from(COURSE_LESSONS_TABLE).select('*').order('section').order('lesson_order');
        if (error) console.error('[VideoAdmin] DB error:', error.message);

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HVT — Video Management</title>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'DM Sans',sans-serif;background:#000;color:#fff;min-height:100vh}
        .header{background:#0d1117;border-bottom:1px solid #1e293b;padding:20px 28px;display:flex;align-items:center;justify-content:space-between}
        .header h1{font-size:20px;font-weight:700;color:#fff;display:flex;align-items:center;gap:10px}
        .header p{font-size:13px;color:#64748b;margin-top:4px}
        .back-btn{color:#2254F5;text-decoration:none;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
        .upload-section{margin:28px;background:#0d1117;border:1px solid #1e293b;border-radius:16px;overflow:hidden}
        .upload-header{padding:20px 24px;border-bottom:1px solid #1e293b}
        .upload-header h2{font-size:16px;font-weight:700;color:#fff;margin-bottom:4px}
        .upload-header p{font-size:13px;color:#64748b}
        .upload-form{padding:24px}
        .form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
        .form-group{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
        .form-group.full{grid-column:1/-1}
        label{font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#64748b}
        input,select,textarea{background:#0a0a0e;border:1px solid #1e293b;border-radius:8px;color:#fff;font-family:'DM Sans',sans-serif;font-size:14px;padding:10px 14px;outline:none;transition:border-color .2s}
        input:focus,select:focus,textarea:focus{border-color:#2254F5}
        select option{background:#111}
        textarea{height:80px;resize:vertical}
        .drop-zone{border:2px dashed #1e293b;border-radius:12px;padding:40px;text-align:center;cursor:pointer;transition:all .2s;margin-bottom:16px}
        .drop-zone:hover,.drop-zone.dragover{border-color:#2254F5;background:rgba(34,84,245,0.04)}
        .drop-zone-icon{font-size:36px;margin-bottom:12px}
        .drop-zone-text{font-size:15px;font-weight:600;color:#e2e8f0;margin-bottom:6px}
        .drop-zone-subtext{font-size:13px;color:#64748b}
        .progress-wrap{display:none;margin-bottom:16px}
        .progress-bar{background:#1e293b;border-radius:4px;height:8px;overflow:hidden}
        .progress-fill{background:#2254F5;height:100%;width:0%;transition:width .3s}
        .progress-text{font-size:12px;color:#64748b;margin-top:6px}
        .upload-btn{background:linear-gradient(135deg,#1e3a8a,#2254F5);color:#fff;border:none;border-radius:10px;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;padding:14px 24px;width:100%;transition:opacity .2s}
        .upload-btn:hover{opacity:.85}
        .upload-btn:disabled{opacity:.5;cursor:not-allowed}
        .success-notification{display:none;background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.2);border-radius:10px;color:#4ade80;font-size:14px;margin-bottom:20px;padding:14px 18px}
        .lessons-section{margin:0 28px 28px}
        .lessons-section h3{font-size:16px;font-weight:700;margin-bottom:16px}
        .lesson-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
        .lesson-card{background:#0d1117;border:1px solid #1e293b;border-radius:12px;overflow:hidden}
        .lesson-header{background:#111827;padding:14px 18px;display:flex;justify-content:space-between;align-items:flex-start}
        .lesson-title{font-size:14px;font-weight:700;color:#fff}
        .lesson-section{font-size:11px;color:#64748b;letter-spacing:1px;text-transform:uppercase;margin-top:2px}
        .lesson-meta{padding:14px 18px;font-size:13px;color:#64748b;border-bottom:1px solid #1e293b}
        .lesson-actions{padding:12px 18px}
        .delete-btn{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:6px;color:#f87171;cursor:pointer;font-size:12px;font-weight:600;padding:5px 12px;text-decoration:none;transition:background .2s}
        .delete-btn:hover{background:rgba(239,68,68,0.2)}
    </style>
</head>
<body>
    <div class="header">
        <a href="/admin?key=${req.query.key}" class="back-btn">← Back to Admin Dashboard</a>
        <h1>📹 Course Video Management</h1>
        <p>Upload and manage course videos • Direct Supabase upload bypasses Railway size limits</p>
    </div>

    <div class="upload-section">
        <div class="upload-header">
            <h2>Upload New Video</h2>
            <p>Add videos to your course library. Files upload directly to Supabase (no Railway size limits)</p>
        </div>

        <div class="success-notification" id="successNotification"></div>

        <form class="upload-form" id="uploadForm" enctype="multipart/form-data">
            <div class="form-row">
                <div class="form-group">
                    <label for="section">Section</label>
                    <select name="section" id="section" required>
                        <option value="">Select Section</option>
                        <option value="Introduction">Introduction</option>
                        <option value="Indicators">Indicators</option>
                        <option value="Risk Management">Risk Management</option>
                        <option value="Psychology">Psychology</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="lesson_order">Lesson Order</label>
                    <input type="number" name="lesson_order" id="lesson_order" min="1" max="100" required>
                </div>
            </div>
            <div class="form-group">
                <label for="title">Video Title</label>
                <input type="text" name="title" id="title" placeholder="e.g., Welcome to HVT Psychology" required>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="duration">Duration</label>
                    <input type="text" name="duration" id="duration" placeholder="e.g., 5m 30s">
                </div>
            </div>
            <div class="form-group full">
                <label for="description">Description (Optional)</label>
                <textarea name="description" id="description" placeholder="Brief description of what this lesson covers..."></textarea>
            </div>

            <div class="drop-zone" id="dropZone">
                <div class="drop-zone-content">
                    <div class="drop-zone-icon">📹</div>
                    <div class="drop-zone-text">Drop video file here or click to browse</div>
                    <div class="drop-zone-subtext">Supports MP4, MOV, AVI • No file size limit with direct Supabase upload</div>
                </div>
                <input type="file" id="videoFile" name="video" accept="video/*" style="display: none;" required>
            </div>

            <div class="progress-wrap" id="progressWrap">
                <div class="progress-bar">
                    <div class="progress-fill" id="progressFill"></div>
                </div>
                <div class="progress-text" id="progressText">Uploading...</div>
            </div>

            <input type="hidden" name="key" value="${req.query.key}">
            <button type="submit" class="upload-btn" id="uploadBtn">🚀 Upload Video (Direct to Supabase)</button>
        </form>
    </div>

    <div class="lessons-section">
        <h3>📚 Course Content</h3>
        <div class="lesson-grid">
            ${(lessons || []).map(lesson => `
                <div class="lesson-card">
                    <div class="lesson-header">
                        <div class="lesson-title">${lesson.title}</div>
                        <div class="lesson-section">${lesson.section}</div>
                    </div>
                    <div class="lesson-meta">
                        Order: ${lesson.lesson_order} • Duration: ${lesson.duration || 'Not set'} •
                        Status: ${lesson.is_active ? 'Active' : 'Inactive'}
                        ${lesson.description ? '<br>' + lesson.description : ''}
                    </div>
                    <div class="lesson-actions">
                        <a href="#" onclick="deleteLesson(${lesson.id})" class="lesson-action delete-btn">Delete</a>
                    </div>
                </div>
            `).join('')}
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
    <script>
        const { createClient } = supabase;
        const supabaseClient = createClient('${SUPABASE_URL}', '${SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY}');

        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('videoFile');
        const uploadForm = document.getElementById('uploadForm');
        const uploadBtn = document.getElementById('uploadBtn');
        const progressWrap = document.getElementById('progressWrap');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');

        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault(); dropZone.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length > 0) { fileInput.files = files; updateDropZoneText(files[0].name); }
        });
        fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) updateDropZoneText(e.target.files[0].name); });
        function updateDropZoneText(filename) { dropZone.querySelector('.drop-zone-text').textContent = 'Selected: ' + filename; }

        uploadForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            const formData = new FormData(uploadForm);
            const section = formData.get('section');
            const title = formData.get('title');
            const lessonOrder = formData.get('lesson_order');
            const duration = formData.get('duration');
            const description = formData.get('description');
            const videoFile = formData.get('video');
            if (!section || !title || !lessonOrder || !videoFile) { alert('Please fill in all required fields and select a video file.'); return; }
            try {
                uploadBtn.disabled = true; uploadBtn.textContent = '⏳ Uploading to Supabase...';
                progressWrap.style.display = 'block';
                const timestamp = Date.now();
                const cleanTitle = title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
                const fileName = section.toLowerCase().replace(/\\s+/g, '-') + '/' + cleanTitle + '-' + timestamp + '.' + videoFile.name.split('.').pop();
                const { data: uploadData, error: uploadError } = await supabaseClient.storage
                    .from('course-videos').upload(fileName, videoFile, {
                        onUploadProgress: (progress) => {
                            const percent = Math.round((progress.loaded / progress.total) * 100);
                            progressFill.style.width = percent + '%';
                            progressText.textContent = 'Uploading: ' + percent + '%';
                        }
                    });
                if (uploadError) throw uploadError;
                progressText.textContent = 'Saving to database...';
                const response = await fetch('/admin/videos/upload', { method: 'POST', body: formData });
                const result = await response.json();
                if (result.success) {
                    const notification = document.getElementById('successNotification');
                    const sectionName = section.replace('-', ' ');
                    notification.innerHTML = '<strong>✅ Video Successfully Uploaded!</strong><div style="font-size:12px;margin-top:4px;">"' + title + '" in ' + sectionName + ' section<br>Video is now available to members on the course page.</div>';
                    notification.style.display = 'block';
                    document.getElementById('uploadForm').reset();
                    setTimeout(function() { notification.style.display = 'none'; }, 5000);
                } else { alert('Upload failed: ' + (result.error || 'Unknown error')); }
            } catch (error) { alert('Upload failed: ' + error.message); }
            finally { uploadBtn.disabled = false; uploadBtn.textContent = '🚀 Upload Video (Direct to Supabase)'; progressWrap.style.display = 'none'; progressFill.style.width = '0%'; }
        });

        function deleteLesson(id) {
            if (confirm('Are you sure you want to delete this lesson? This action cannot be undone.')) {
                fetch('/admin/videos/delete', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: id, key: '${req.query.key}' })
                }).then(response => response.json()).then(result => {
                    if (result.success) { location.reload(); } else { alert('Delete failed: ' + result.error); }
                });
            }
        }
    </script>
</body>
</html>`;
        res.send(html);
    } catch (e) { console.error('[VideoAdmin]', e.message); res.status(500).send('Error loading video management'); }
});

// ─── ADMIN: VIDEO UPLOAD (metadata only — video already in Supabase storage) ──
router.post('/admin/videos/upload', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { title, section, lesson_order, duration, description } = req.body;
        if (!title || !section || !lesson_order) return res.status(400).json({ success: false, error: 'Title, section and lesson_order are required' });
        const { data, error } = await supabase.from(COURSE_LESSONS_TABLE).insert({
            title, section, lesson_order: parseInt(lesson_order),
            duration: duration || null, description: description || null,
            is_active: true, created_at: nowISO(), updated_at: nowISO()
        }).select().single();
        if (error) return res.status(500).json({ success: false, error: error.message });
        console.log(`[VideoUpload] ✅ Lesson saved: ${title} | Section: ${section}`);
        res.json({ success: true, lesson: data });
    } catch (e) { console.error('[VideoUpload]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// ─── ADMIN: VIDEO DELETE ───────────────────────────────────────────────────────
router.post('/admin/videos/delete', adm, express.json(), async (req, res) => {
    if (req.body?.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, error: 'ID required' });
        const { error } = await supabase.from(COURSE_LESSONS_TABLE).delete().eq('id', id);
        if (error) return res.status(500).json({ success: false, error: error.message });
        console.log(`[VideoDelete] ✅ Lesson deleted: id=${id}`);
        res.json({ success: true });
    } catch (e) { console.error('[VideoDelete]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
