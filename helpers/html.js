// helpers/html.js
// Shared HTML page template functions used across portal, billing, admin, and license routes.
// These generate full HTML pages and reusable UI components.

'use strict';

const { APP_URL, DISCORD_INVITE_URL } = require('../config/constants');

// ─── SVG ASSETS ───────────────────────────────────────────────────────────────
const V_LOGO_SVG = `<svg width="20" height="18" viewBox="0 0 20 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1L10 16.5L19 1" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function ninjaLogoSVG() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 17.5V6.5L11 12l-5 5.5Z" fill="#2254F5" opacity="0.95"/><path d="M12.5 18V6l5.5 6-5.5 6Z" fill="#2254F5" opacity="0.95"/><path d="M4.5 19.2h15" stroke="rgba(255,255,255,0.08)" stroke-width="1.2" opacity="0.9"/></svg>`;
}

// ─── PAGE SHELL ───────────────────────────────────────────────────────────────
// Full branded HTML page wrapper with nav, hero, and footer
function shell(title, body, hero) {
    const pill      = (hero && hero.pill)  ? hero.pill  : 'MEMBER PORTAL';
    const heroTitle = (hero && hero.title) ? hero.title : 'Your Edge Starts Here';
    const heroSub   = (hero && hero.sub)   ? hero.sub   : 'Access your live trading room, course, and billing — all in one place.';
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<link rel="icon" type="image/png" href="/favicon.png?v=1">
<title>${title} – High Velocity Trading</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Bebas+Neue&family=Montserrat:wght@800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Sans',sans-serif;background:#000000;min-height:100vh;margin:0;padding:110px 20px 24px;color:#fff;position:relative;overflow-x:hidden;display:flex;flex-direction:column;align-items:center;}
.hvt-bg{position:fixed;inset:0;z-index:0;pointer-events:none;background:#000000;}
.hvt-bg::before{content:'';position:absolute;top:0;left:0;width:65%;height:65%;background:radial-gradient(ellipse at 15% 30%,#00001C 0%,transparent 65%);pointer-events:none;}
.hero{text-align:center;margin-bottom:16px;position:relative;z-index:1;}
.hero-pill{display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.25);border-radius:999px;color:#2254F5;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-family:'DM Sans',sans-serif;padding:6px 18px;}
.hero-pill{display:inline-block;}.hero h1{display:block;font-size:32px;font-weight:800;color:#fff;letter-spacing:-0.5px;margin:14px 0 8px;line-height:1.1;font-family:'DM Sans',sans-serif;}.hero-sub{display:block;color:#64748b;font-size:14px;line-height:1.6;max-width:440px;margin:0 auto;}
.hero-div{height:1px;background:linear-gradient(90deg,transparent,rgba(34,84,245,0.3),transparent);margin:16px auto 0;max-width:200px;}
.topnav-wrap{position:fixed;top:0;left:0;right:0;z-index:10;}
.topnav{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:64px;width:100%;background:rgba(10,10,12,0.85);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.08);position:relative;}
.topnav-logo{display:flex;align-items:center;gap:0;text-decoration:none;}
.topnav-logo img{height:29px;width:auto;object-fit:contain;display:block;background:transparent;}
.topnav-left{display:flex;align-items:center;gap:12px;}
.topnav-left a.topnav-link{color:rgba(255,255,255,0.65);font-size:14px;font-weight:500;text-decoration:none;letter-spacing:0.2px;padding:8px 0;transition:color .2s;}
.topnav-left a.topnav-link:hover{color:rgba(255,255,255,0.85);}
.topnav-right{display:flex;align-items:center;gap:12px;flex-shrink:0;}
.topnav-right a.topnav-link,.topnav-right a.topnav-out{color:rgba(255,255,255,0.82);font-size:13px;font-weight:600;font-family:'DM Sans',sans-serif;text-decoration:none;letter-spacing:0.02em;padding:8px 0;transition:color .2s;}
.topnav-right a.topnav-link:hover,.topnav-right a.topnav-out:hover{color:#fff;}
.topnav-cta{display:inline-block;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.9);font-size:13px;font-weight:500;text-decoration:none;padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);letter-spacing:0.2px;transition:background .2s,color .2s,border-color .2s;}
.topnav-cta:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.18);}
.prop-firm-btn{display:inline-block;background:#2254F5;color:#fff;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;letter-spacing:0.02em;text-decoration:none;padding:8px 14px;border-radius:6px;border:none;transition:background .2s ease,color .2s ease;white-space:nowrap;}
.prop-firm-btn:hover{background:#2d5cf7;color:#fff;}
.prop-firm-btn:active{opacity:0.92;}
@media(max-width:600px){
  .topnav{padding:0 12px;}
  .topnav-left a.topnav-link{display:none;}
  .topnav-right a.topnav-link,.topnav-right a.topnav-out{display:none;}
  .topnav-right a.topnav-cta{display:inline-block;}
  .topnav-logo img{height:21px;}
}
.card{width:100%;max-width:460px;background:rgba(255,255,255,0.03);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(34,84,245,0.2);border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.6);position:relative;z-index:1;}
.ct{height:3px;background:linear-gradient(90deg,#2254F5,#2254F5,#2254F5);}
.cb{padding:36px 32px;}
.ttl{font-size:22px;font-weight:700;letter-spacing:0.5px;color:#fff;margin-bottom:8px;}
.sub{color:#64748b;font-size:13px;line-height:1.6;margin-bottom:28px;}
.div{height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.1),transparent);margin-bottom:28px;}
label{display:block;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:8px;}
input[type=email],input[type=text]{width:100%;padding:13px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:#fff;font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s;margin-bottom:20px;font-family:'DM Sans',sans-serif;}
input:focus{border-color:#2254F5;box-shadow:0 0 0 3px rgba(34,84,245,0.2);}
input::placeholder{color:#334155;}
.btn{width:100%;padding:14px;background:#2254F5;color:#fff;border:none;border-radius:999px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 20px rgba(34,84,245,0.3);transition:opacity .2s,transform .1s;}
.btn:hover{opacity:.9;transform:translateY(-1px);}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none;}
.btn-red{background:linear-gradient(135deg,#991b1b,#dc2626);box-shadow:0 4px 20px rgba(220,38,38,0.3);}
.msg{margin-top:16px;padding:12px 16px;border-radius:12px;font-size:13px;text-align:center;display:none;line-height:1.5;}
.msg.show{display:block;}
.ok{background:rgba(74,222,128,0.08);color:#4ade80;border:1px solid rgba(74,222,128,0.2);}
.er{background:rgba(248,113,113,0.08);color:#f87171;border:1px solid rgba(248,113,113,0.2);}
.fl{text-align:center;margin-top:20px;font-size:12px;color:#334155;position:relative;z-index:1;}
.fl a{color:#64748b;text-decoration:none;}
.ntBadge{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:rgba(34,84,245,0.05);border:1px solid rgba(34,84,245,0.18);margin-bottom:18px;}
.ntIcon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:rgba(34,84,245,0.12);border:1px solid rgba(34,84,245,0.22);flex-shrink:0;}
.ntTitle{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#2254F5;font-weight:700;line-height:1;}
.ntDesc{color:#94a3b8;font-size:12.5px;line-height:1.55;margin-top:6px;}
.nt-signup-wrap{text-align:center;margin-top:12px;}
.nt-signup-btn{display:inline-block;padding:10px 18px;background:#D9452A;color:#000;border:none;border-radius:8px;font-family:'Montserrat',sans-serif;font-size:15px;font-weight:800;letter-spacing:1.5px;text-decoration:none;box-shadow:0 4px 16px rgba(217,69,42,0.4);transition:transform .2s ease,box-shadow .2s ease,background .2s ease;margin-left:-36px;}
.nt-signup-btn:hover{transform:scale(1.06);box-shadow:0 6px 24px rgba(217,69,42,0.5);background:#E04F35;}
.tr-install-btn{display:inline-block;padding:12px 24px;background:#2254F5;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:8px;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;letter-spacing:0.5px;text-decoration:none;box-shadow:0 2px 12px rgba(34,84,245,0.25);transition:background .2s,box-shadow .2s,transform .2s;}
.tr-install-btn:hover{background:#2d5cf7;box-shadow:0 4px 20px rgba(34,84,245,0.35);transform:translateY(-1px);}
.tr-install-btn:active{transform:translateY(0);box-shadow:0 1px 8px rgba(34,84,245,0.2);}
.discord-join-btn{display:inline-flex;align-items:center;gap:10px;padding:12px 24px;background:#5865F2;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:8px;font-size:13px;font-weight:600;letter-spacing:0.3px;text-decoration:none;box-shadow:0 2px 12px rgba(88,101,242,0.25);transition:background .2s,box-shadow .2s,transform .2s;}
.discord-join-btn:hover{background:#4752C4;box-shadow:0 4px 20px rgba(88,101,242,0.35);transform:translateY(-1px);}
.discord-join-btn img{height:22px;width:auto;object-fit:contain;flex-shrink:0;display:block;}
</style></head><body>
<div class="hvt-bg" aria-hidden="true"></div>
<div class="topnav-wrap">
  <nav class="topnav">
    <div class="topnav-left">
      <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="topnav-logo"><img src="/hvt-logo.cropped.png" alt="High Velocity Trading" style="height:29px;width:auto;object-fit:contain;display:block;" onerror="this.onerror=null;this.style.display='none'" /></a>
    </div>
    <div class="topnav-right" style="display:flex;align-items:center;gap:12px;">
      ${hero && hero.hideNav ? '' : '<a href="/member" class="topnav-link">Portal</a><a href="/billing/confirm-session" class="topnav-out">Billing</a><a href="/logout" class="topnav-out">Log out</a><a href="/prop-activation" class="prop-firm-btn">Prop Firms</a>'}
    </div>
  </nav>
</div>
<div class="hero">
  <span class="hero-pill">${pill}</span>
  <h1>${heroTitle}</h1>
  <p class="hero-sub">${heroSub}</p>
  <div class="hero-div"></div>
</div>
${body}
<div class="fl" style="margin-top:20px;"><a href="https://highvelocitytrading.com">&larr; highvelocitytrading.com</a></div>
</body></html>`;
}

// ─── RESULT PAGE ──────────────────────────────────────────────────────────────
// Renders a simple success / error / info result card inside the shell
function resultPage(type, title, msg) {
    const m = {
        success: { i: '&#10003;', c: '#4ade80', b: 'rgba(74,222,128,0.08)',   r: 'rgba(74,222,128,0.2)'   },
        error:   { i: '&#10005;', c: '#f87171', b: 'rgba(248,113,113,0.08)',  r: 'rgba(248,113,113,0.2)'  },
        info:    { i: '&#8505;',  c: '#2254F5', b: 'rgba(34,84,245,0.08)',    r: 'rgba(34,84,245,0.2)'    }
    }[type] || { i: '&#10005;', c: '#f87171', b: 'rgba(248,113,113,0.08)', r: 'rgba(248,113,113,0.2)' };
    return shell(title, `<div class="card" style="max-width:460px;width:100%;"><div class="ct"></div><div class="cb" style="text-align:center;">
      <div style="width:56px;height:56px;border-radius:50%;background:${m.b};border:1px solid ${m.r};display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:22px;color:${m.c};">${m.i}</div>
      <div class="ttl" style="margin-bottom:16px;">${title}</div>
      <div style="background:${m.b};border:1px solid ${m.r};border-radius:10px;padding:16px;color:${m.c};font-size:14px;line-height:1.6;">${msg}</div>
    </div></div>`);
}

// ─── MEMBER PORTAL DASHBOARD ──────────────────────────────────────────────────
// Renders the full member portal carousel dashboard
function memberPortalHtml(s) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Member Portal — HVT</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{width:100%;overflow-x:hidden}
body{font-family:'DM Sans',sans-serif;background:#000000;min-height:100vh;width:100%;margin:0;color:#fff;position:relative;overflow-x:hidden}
.member-bg{position:fixed;inset:0;z-index:0;pointer-events:none;background:#000000}
.member-bg::before{content:'';position:absolute;top:0;left:0;width:70%;height:60%;background:radial-gradient(ellipse at 20% 20%,#00001C 0%,transparent 60%);pointer-events:none}
.topnav-wrap{position:fixed;top:0;left:0;right:0;z-index:10}
.topnav{display:flex;align-items:center;justify-content:space-between;padding:0 28px;height:64px;width:100%;background:rgba(10,10,12,0.85);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.08);position:relative}
.topnav-logo{display:flex;align-items:center;text-decoration:none}
.topnav-logo img{height:29px;width:auto;object-fit:contain;display:block;background:transparent;}
.topnav-left{display:flex;align-items:center;gap:12px}
.topnav-left a.topnav-link{color:rgba(255,255,255,0.65);font-size:14px;font-weight:500;text-decoration:none;letter-spacing:0.2px;padding:8px 0;transition:color .2s}
.topnav-left a.topnav-link:hover{color:rgba(255,255,255,0.85)}
.topnav-right{display:flex;align-items:center;gap:12px}
.topnav-out{color:rgba(255,255,255,0.82);font-size:13px;font-weight:600;font-family:'DM Sans',sans-serif;text-decoration:none;letter-spacing:0.02em;padding:8px 0;transition:color .2s}
.topnav-out:hover{color:#fff}
.topnav-cta{display:inline-block;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.9);font-size:13px;font-weight:500;text-decoration:none;padding:8px 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);letter-spacing:0.2px;transition:background .2s,color .2s,border-color .2s}
.topnav-cta:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.18)}
.prop-firm-btn{display:inline-block;background:#2254F5;color:#fff;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;letter-spacing:0.02em;text-decoration:none;padding:8px 14px;border-radius:6px;border:none;transition:background .2s ease,color .2s ease;white-space:nowrap}
.prop-firm-btn:hover{background:#2d5cf7;color:#fff}
.prop-firm-btn:active{opacity:0.92}
@media(max-width:600px){
  .topnav{padding:0 12px;}
  .topnav-left a.topnav-link{display:none;}
  .topnav-right a.topnav-out{display:none;}
  .topnav-right a.topnav-cta{display:inline-block;}
  .topnav-logo img{height:21px;}
}
.portal-wrap{position:relative;z-index:1;width:100%;max-width:900px;margin-left:auto;margin-right:auto;margin-inline:auto;padding:100px 24px 64px;box-sizing:border-box}
.hero-section{position:relative;text-align:center;margin-bottom:32px;width:100%}
.hero-section-inner{display:inline-block;padding:8px 0 20px 0;border-radius:0;border:none;background:transparent;opacity:0;animation:heroLoadIn 0.55s cubic-bezier(0.22,1,0.36,1) forwards}
@keyframes heroLoadIn{0%{opacity:0;transform:translateY(12px)}100%{opacity:1;transform:translateY(0)}}
.hero-section .pill{display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.25);border-radius:999px;color:#2254F5;font-size:11px;letter-spacing:3px;text-transform:uppercase;padding:6px 18px;margin-bottom:12px}
.hero-section h1{font-size:38px;font-weight:700;letter-spacing:-0.5px;margin-bottom:6px;color:#fff;opacity:0;animation:heroTextIn 0.6s cubic-bezier(0.22,1,0.36,1) 0.1s forwards}
.hero-section h1 .hero-name{background:linear-gradient(90deg,#1d4ed8,#2563eb,#38bdf8);background-size:200% 100%;background-clip:text;-webkit-background-clip:text;color:transparent;text-shadow:0 0 10px rgba(37,99,235,0.45),0 0 20px rgba(37,99,235,0.25),0 0 32px rgba(56,189,248,0.15);animation:heroNameGradient 5s ease-in-out infinite;}
@keyframes heroNameGradient{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
@keyframes heroTextIn{0%{opacity:0;transform:translateY(8px)}100%{opacity:1;transform:translateY(0)}}
.hero-section p{color:#94a3b8;font-size:16px;line-height:1.5}
.hero-div{height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.12),transparent);margin:16px auto 0;max-width:200px}
.section-label{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#64748b;margin:0 0 16px;text-align:center}
.carousel-section{margin-bottom:40px;width:100%;min-width:0}
.carousel-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;gap:16px;flex-wrap:wrap}
.carousel-heading{font-size:22px;font-weight:700;letter-spacing:-0.3px;color:#fff;line-height:1.3;max-width:480px}
.carousel-nav{display:flex;align-items:center;gap:8px;flex-shrink:0}
.carousel-btn{width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.7);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
.carousel-btn:hover{background:rgba(255,255,255,0.08);color:#fff;border-color:rgba(255,255,255,0.2)}
.carousel-btn svg{width:20px;height:20px}
.carousel-scroll{display:flex;gap:20px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;padding:12px 0 8px;-webkit-overflow-scrolling:touch;width:100%;max-width:100%;min-width:0;direction:ltr}
.carousel-scroll::-webkit-scrollbar{height:6px}
.carousel-scroll::-webkit-scrollbar-track{background:rgba(255,255,255,0.04);border-radius:3px}
.carousel-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:3px}
.pcard{display:block;text-decoration:none;border-radius:20px;border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.03);overflow:hidden;transition:all .25s;position:relative;flex:0 0 300px;scroll-snap-align:start;min-height:260px;--c:#2254F5;--c2:#2254F5;--cb:rgba(34,84,245,0.12)}
.pcard:hover{transform:translateY(-4px);border-color:rgba(34,84,245,0.6);box-shadow:0 16px 48px rgba(34,84,245,0.25)}
.pcard.pcard-gold:hover{border-color:rgba(212,168,83,0.55);box-shadow:0 16px 48px rgba(212,168,83,0.28)}
.pcard .bar{height:3px;background:linear-gradient(90deg,var(--c2),var(--c),var(--c2))}
.pcard .inner{padding:28px;display:flex;flex-direction:column;height:100%;box-sizing:border-box}
.pcard .icon{width:48px;height:48px;border-radius:12px;background:var(--cb);display:flex;align-items:center;justify-content:center;margin-bottom:18px;flex-shrink:0;color:#2254F5}
.pcard h3{font-size:17px;font-weight:700;color:#fff;margin-bottom:8px}
.pcard p{color:#64748b;font-size:14px;line-height:1.6;margin-bottom:20px;flex:1}
.pcard .arrow{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--c);opacity:0.9;display:flex;align-items:center;gap:6px}
.pcard .arrow .arr{width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center}
@media(max-width:640px){.pcard{flex:0 0 260px}}
.help{text-align:center;margin-top:48px;padding-top:28px;border-top:1px solid rgba(255,255,255,0.06);color:#64748b;font-size:13px}
.help a{color:#94a3b8;text-decoration:none}
.echo-shop-cta:hover{opacity:0.98;transform:translateY(-1px);box-shadow:0 8px 36px rgba(212,168,83,0.55);}
</style></head><body>
<div class="member-bg" aria-hidden="true"></div>
<div class="topnav-wrap">
  <nav class="topnav">
    <div class="topnav-left">
      <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="topnav-logo"><img src="/hvt-logo.cropped.png" alt="High Velocity Trading" style="height:29px;width:auto;object-fit:contain;display:block;" onerror="this.onerror=null;this.style.display='none'" /></a>
    </div>
    <div class="topnav-right">
      <a href="/billing/confirm-session" class="topnav-out">Billing</a>
      <a href="/logout" class="topnav-out">Log out</a>
      <a href="/prop-activation" class="prop-firm-btn">Prop Firms</a>
    </div>
  </nav>
</div>
<div class="portal-wrap">
  <div class="hero-section">
    <div class="hero-section-inner">
      <span class="pill">MEMBER PORTAL</span>
      <h1>Welcome back, <span class="hero-name">${s.name}</span></h1>
      <p>Stay sharp. Stay ahead.</p>
      <div class="hero-div"></div>
    </div>
  </div>
  <p class="section-label">Your dashboard</p>
  <div class="carousel-section">
    <div class="carousel-header">
      <h2 class="carousel-heading"></h2>
      <div class="carousel-nav">
        <button type="button" class="carousel-btn" id="carousel-prev" aria-label="Previous"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
        <button type="button" class="carousel-btn" id="carousel-next" aria-label="Next"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></button>
      </div>
    </div>
    <div class="carousel-scroll" id="carousel-scroll">
    <a class="pcard" href="/trading-room">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/></svg></div>
        <h3>Get Started</h3>
        <p>Activate your Discord access and NinjaTrader indicators. Takes less than 2 minutes.</p>
        <div class="arrow">Get Started <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
      </div>
    </a>
    <a class="pcard" href="/course">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/></svg></div>
        <h3>Course Library</h3>
        <p>Step-by-step trading videos built on the HVT system. Learn at your own pace.</p>
        <div class="arrow">Watch Now <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
      </div>
    </a>
    <a class="pcard" href="/trading-journal">
      <div class="bar"></div>
      <div class="inner">
        <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25"/></svg></div>
        <h3>Trading Journal</h3>
        <p>Log your trades, review performance, and track your progress with the HVT system.</p>
        <div class="arrow">Open Journal <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
      </div>
    </a>
    <a class="pcard pcard-gold" href="/shop" style="--c:#e8c878;--c2:#d4a853;--cb:rgba(212,168,83,0.16);">
      <div class="bar" style="background:linear-gradient(90deg,#e8c878,#d4a853,#c9a227);"></div>
      <div class="inner">
        <div class="icon" style="background:rgba(212,168,83,0.14);color:#f0d78c;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 0 0 3.75-.615A2.993 2.993 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 0 0 2.25 1.016 2.993 2.993 0 0 0 2.25-1.016 3.001 3.001 0 0 0 3.75.614m-16.5 0a3.004 3.004 0 0 1-.621-4.72l1.189-1.19A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72M6.75 18h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .414.336.75.75.75Z"/></svg></div>
        <h3>Member Shop</h3>
        <p>Exclusive tools available only to HVT members. HVT Echo and future releases.</p>
        <div class="arrow" style="color:#e8c878;">Shop Now <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
      </div>
    </a>
  </div>
  </div>
  <div style="margin-bottom:40px;background:#0a0a0e;border:1px solid rgba(212,168,83,0.35);border-radius:20px;overflow:hidden;position:relative;box-shadow:0 0 0 1px rgba(212,168,83,0.12),0 20px 50px rgba(0,0,0,0.35),0 0 40px rgba(212,168,83,0.08);">
    <div style="height:3px;background:linear-gradient(90deg,#e8c878,#d4a853,#c9a227);"></div>
    <div style="padding:32px 36px;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;">
      <div style="flex:1;min-width:220px;">
        <div style="display:inline-block;background:rgba(212,168,83,0.12);border:1px solid rgba(232,200,120,0.35);border-radius:999px;padding:3px 14px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#e8c878;margin-bottom:14px;">Members Only</div>
        <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.3px;margin-bottom:6px;">HVT Echo is Live</div>
        <div style="font-size:13px;color:#64748b;line-height:1.6;max-width:420px;">Copy your trades to up to 5 prop firm accounts simultaneously. One execution. Five accounts hit. Exclusive to HVT members.</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:10px;flex-shrink:0;">
        <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-1px;line-height:1;">$97 <span style="font-size:13px;color:#475569;font-weight:400;">one-time</span></div>
        <a href="/shop" class="echo-shop-cta" style="display:inline-block;background:linear-gradient(135deg,#c9a227,#d4a853,#e5c76b);color:#0f0f0f;text-decoration:none;padding:13px 32px;border-radius:999px;font-size:14px;font-weight:800;letter-spacing:0.5px;white-space:nowrap;box-shadow:0 4px 28px rgba(212,168,83,0.5);border:1px solid rgba(255,236,180,0.45);transition:opacity .2s,transform .15s;">Shop Now &rarr;</a>
      </div>
    </div>
  </div>
  <div class="help">Need help? Call <a href="tel:7864614235">786-461-4235</a> or email <a href="mailto:alerts@hvt-mail.com">alerts@hvt-mail.com</a></div>
</div>
<script>
(function(){
  var el=document.getElementById('carousel-scroll');
  var prev=document.getElementById('carousel-prev');
  var next=document.getElementById('carousel-next');
  if(!el||!prev||!next)return;
  el.scrollLeft=0;
  var cardWidth=320;
  prev.onclick=function(){ el.scrollBy({left:-cardWidth,behavior:'smooth'}); };
  next.onclick=function(){ el.scrollBy({left:cardWidth,behavior:'smooth'}); };
})();
</script>
</body></html>`;
}

module.exports = { V_LOGO_SVG, ninjaLogoSVG, shell, resultPage, memberPortalHtml };
