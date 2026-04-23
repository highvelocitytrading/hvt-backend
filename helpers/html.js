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
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<link href="https://api.fontshare.com/v2/css?f[]=general-sans@300,400,500,600,700&display=swap" rel="stylesheet">
<style>
:root{
  --accent:#0055fe;
  --accent-soft:rgba(0,85,254,0.12);
  --text:#fff;
  --text-2:rgba(255,255,255,0.65);
  --text-3:rgba(255,255,255,0.40);
  --glass-bg:linear-gradient(165deg,rgba(255,255,255,0.045) 0%,rgba(255,255,255,0.02) 55%,rgba(255,255,255,0.015) 100%);
  --glass-border:rgba(255,255,255,0.08);
  --glass-shadow:0 1px 0 inset rgba(255,255,255,0.10),0 12px 40px rgba(0,0,0,0.40);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;overflow-x:hidden}
body{font-family:'Inter','General Sans',system-ui,sans-serif;background:#000;min-height:100vh;color:var(--text);position:relative;-webkit-font-smoothing:antialiased}
/* Two controlled blue gradient spots over solid black — everything else is pure #000 */
body::before{content:'';position:fixed;inset:0;background:
  radial-gradient(ellipse 45% 40% at 18% 12%,rgba(0,40,180,0.32) 0%,transparent 70%),
  radial-gradient(ellipse 40% 45% at 88% 88%,rgba(0,30,140,0.22) 0%,transparent 72%);
  pointer-events:none;z-index:-1}

/* ───── NAV ──────────────────────────────────────────────────── */
.nav{position:fixed;top:16px;left:0;right:0;z-index:20;padding:0 24px;pointer-events:none}
.nav-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;position:relative;pointer-events:auto}
.nav-logo{display:flex;align-items:center;gap:0;text-decoration:none;flex-shrink:0;margin-top:-14px;margin-left:-20px}
.nav-logo .logo-img{height:94px;width:auto;object-fit:contain;filter:drop-shadow(0 2px 10px rgba(0,85,254,0.30))}
.nav-wordmark{font-size:14px;font-weight:500;color:rgba(255,255,255,0.90);letter-spacing:0.14em;text-transform:uppercase;white-space:nowrap;margin-left:-50px;opacity:1;transform:translateX(0);filter:blur(0);transition:opacity .35s cubic-bezier(0.22,1,0.36,1),transform .45s cubic-bezier(0.22,1,0.36,1),filter .35s ease,letter-spacing .45s cubic-bezier(0.22,1,0.36,1),margin-left .45s cubic-bezier(0.22,1,0.36,1)}
.nav.is-collapsed .nav-wordmark{opacity:0;transform:translateX(-14px);filter:blur(4px);letter-spacing:0.04em;margin-left:-80px;pointer-events:none}
.nav-pill{position:absolute;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:6px 8px;background:rgba(255,255,255,0.05);backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);border:1px solid rgba(255,255,255,0.08);border-radius:100px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.06),0 4px 24px rgba(0,0,0,0.25)}
.nav-pill a{font-size:13px;font-weight:500;color:rgba(255,255,255,0.55);text-decoration:none;letter-spacing:0.01em;padding:8px 18px;border-radius:100px;transition:color .18s,background .18s}
.nav-pill a:hover{color:#fff;background:rgba(255,255,255,0.08)}
.nav-pill a.active{color:var(--accent);background:rgba(0,85,254,0.12)}
.nav-cta{display:flex;align-items:center;gap:10px;flex-shrink:0}
.nav-cta a{font-size:13px;font-weight:500;letter-spacing:0.01em;text-decoration:none;padding:8px 18px;border-radius:100px;transition:background .18s,border-color .18s,color .18s}
.nav-link-ghost{color:rgba(255,255,255,0.55);padding:8px 0 !important;border-radius:0 !important}
.nav-link-ghost:hover{color:#fff}
.nav-btn-primary{color:#fff;background:var(--accent);box-shadow:0 6px 20px rgba(0,85,254,0.35),inset 0 1px 0 rgba(255,255,255,0.18)}
.nav-btn-primary:hover{background:#1a6aff;box-shadow:0 10px 28px rgba(0,85,254,0.45),inset 0 1px 0 rgba(255,255,255,0.22)}
@media(max-width:820px){
  .nav-pill{display:none}
}
@media(max-width:560px){
  .nav{padding:0 12px;top:12px}
  .nav-link-ghost{display:none}
  .nav-logo{margin-top:-8px;margin-left:-8px}
  .nav-logo .logo-img{height:60px}
  .nav-wordmark{margin-left:-30px;font-size:11px}
}

/* ───── LAYOUT ───────────────────────────────────────────────── */
.portal-wrap{position:relative;z-index:1;width:100%;max-width:1080px;margin:0 auto;padding:120px 24px 80px}

/* ───── HERO (original — do not restyle) ─────────────────────── */
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

/* ───── SECTION LABEL + CAROUSEL NAV ─────────────────────────── */
.dash-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
.section-label{font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:var(--text-3);font-weight:600}
.carousel-nav{display:flex;gap:8px}
.carousel-btn{width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,0.10);background:rgba(255,255,255,0.04);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:rgba(255,255,255,0.70);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
.carousel-btn:hover{background:rgba(255,255,255,0.09);color:#fff;border-color:rgba(255,255,255,0.22);box-shadow:0 0 20px rgba(0,85,254,0.18)}
.carousel-btn svg{width:18px;height:18px}

/* ───── CAROUSEL ─────────────────────────────────────────────── */
.carousel-section{margin-bottom:48px;width:100%}
.carousel-scroll{display:flex;gap:20px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;padding:8px 4px 16px;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.18) transparent}
.carousel-scroll::-webkit-scrollbar{height:6px}
.carousel-scroll::-webkit-scrollbar-track{background:transparent}
.carousel-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.14);border-radius:3px}

/* ───── LIQUID GLASS CARDS ───────────────────────────────────── */
.pcard{--c:#0055fe;--c-soft:rgba(0,85,254,0.14);display:flex;flex-direction:column;text-decoration:none;flex:0 0 320px;scroll-snap-align:start;min-height:280px;position:relative;background:var(--glass-bg);backdrop-filter:blur(40px) saturate(160%);-webkit-backdrop-filter:blur(40px) saturate(160%);border:1px solid var(--glass-border);border-radius:22px;box-shadow:var(--glass-shadow);overflow:hidden;transition:transform .35s cubic-bezier(0.22,1,0.36,1),box-shadow .35s,border-color .35s}
/* Top highlight line */
.pcard::before{content:'';position:absolute;top:0;left:16%;right:16%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.22),transparent);pointer-events:none}
/* Top gentle fade */
.pcard::after{content:'';position:absolute;top:0;left:0;right:0;height:45%;background:linear-gradient(180deg,rgba(255,255,255,0.04) 0%,transparent 100%);pointer-events:none;border-radius:22px 22px 0 0}
.pcard:hover{transform:translateY(-4px);border-color:rgba(0,85,254,0.40);box-shadow:0 1px 0 inset rgba(100,170,255,0.20),0 22px 60px rgba(0,0,0,0.45),0 0 60px rgba(0,85,254,0.22)}
.pcard-inner{position:relative;z-index:1;padding:28px;display:flex;flex-direction:column;height:100%}
.pcard-icon{width:52px;height:52px;border-radius:14px;background:var(--c-soft);border:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;color:var(--c);margin-bottom:20px;flex-shrink:0;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:inset 0 1px 0 rgba(255,255,255,0.12)}
.pcard h3{font-family:'General Sans','Inter',sans-serif;font-size:18px;font-weight:600;color:#fff;letter-spacing:-0.01em;margin-bottom:8px}
.pcard p{color:var(--text-2);font-size:14px;line-height:1.6;margin-bottom:22px;flex:1}
.pcard-arrow{display:inline-flex;align-items:center;gap:10px;font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:var(--c)}
.pcard-arrow .arr{width:32px;height:32px;border-radius:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;transition:transform .2s,background .2s}
.pcard:hover .pcard-arrow .arr{transform:translateX(3px);background:rgba(0,85,254,0.22);border-color:rgba(0,85,254,0.35)}
/* Gold variant (shop) */
.pcard-gold{--c:#e8c878;--c-soft:rgba(212,168,83,0.16)}
.pcard-gold:hover{border-color:rgba(212,168,83,0.45);box-shadow:0 1px 0 inset rgba(255,220,150,0.18),0 22px 60px rgba(0,0,0,0.45),0 0 60px rgba(212,168,83,0.22)}
.pcard-gold .pcard-icon{color:#f0d78c;border-color:rgba(232,200,120,0.18)}
@media(max-width:640px){.pcard{flex:0 0 280px}}

/* ───── FEATURED ECHO PROMO (liquid glass gold) ──────────────── */
.echo-promo{position:relative;margin-bottom:44px;padding:36px;border-radius:22px;overflow:hidden;background:linear-gradient(165deg,rgba(232,200,120,0.08) 0%,rgba(255,255,255,0.03) 50%,rgba(120,90,20,0.06) 100%);backdrop-filter:blur(40px) saturate(160%);-webkit-backdrop-filter:blur(40px) saturate(160%);border:1px solid rgba(212,168,83,0.28);box-shadow:0 1px 0 inset rgba(255,236,180,0.14),0 20px 60px rgba(0,0,0,0.40),0 0 60px rgba(212,168,83,0.10)}
.echo-promo::before{content:'';position:absolute;top:0;left:10%;right:10%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,220,150,0.5),transparent);pointer-events:none}
.echo-promo::after{content:'';position:absolute;top:0;left:0;right:0;height:40%;background:linear-gradient(180deg,rgba(255,220,150,0.05) 0%,transparent 100%);pointer-events:none;border-radius:22px 22px 0 0}
.echo-promo-inner{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:28px;flex-wrap:wrap}
.echo-promo-text{flex:1;min-width:240px}
.echo-badge{display:inline-block;background:rgba(212,168,83,0.14);border:1px solid rgba(232,200,120,0.38);border-radius:999px;padding:4px 14px;font-size:9px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#f0d78c;margin-bottom:14px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.echo-title{font-family:'General Sans','Inter',sans-serif;font-size:24px;font-weight:700;letter-spacing:-0.02em;color:#fff;margin-bottom:8px}
.echo-desc{font-size:14px;color:var(--text-2);line-height:1.6;max-width:440px}
.echo-promo-right{display:flex;flex-direction:column;align-items:flex-end;gap:14px;flex-shrink:0}
.echo-price{font-family:'General Sans','Inter',sans-serif;font-size:30px;font-weight:800;letter-spacing:-0.03em;color:#fff;line-height:1}
.echo-price span{font-size:13px;font-weight:400;color:rgba(255,255,255,0.42);margin-left:4px}
.echo-cta{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,#c9a227 0%,#e5c76b 50%,#d4a853 100%);color:#0f0f0f;text-decoration:none;padding:13px 30px;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:0.02em;border:1px solid rgba(255,236,180,0.45);box-shadow:0 6px 30px rgba(212,168,83,0.45),inset 0 1px 0 rgba(255,250,220,0.45);transition:transform .2s,box-shadow .2s,filter .2s}
.echo-cta:hover{transform:translateY(-1px);filter:brightness(1.08);box-shadow:0 10px 38px rgba(212,168,83,0.55),inset 0 1px 0 rgba(255,250,220,0.55)}
@media(max-width:560px){
  .echo-promo{padding:26px}
  .echo-promo-right{align-items:flex-start;width:100%}
}

/* ───── HELP ─────────────────────────────────────────────────── */
.help{text-align:center;margin-top:56px;padding-top:28px;border-top:1px solid rgba(255,255,255,0.06);color:var(--text-3);font-size:13px}
.help a{color:var(--text-2);text-decoration:none;transition:color .18s}
.help a:hover{color:#fff}
</style></head><body>

<nav class="nav">
  <div class="nav-inner">
    <a href="https://highvelocitytrading.com" target="_blank" rel="noopener noreferrer" class="nav-logo">
      <img src='/assets/"V" HVT.png' alt="High Velocity Trading" class="logo-img" onerror="this.onerror=null;this.style.display='none'" />
      <span class="nav-wordmark">HIGH VELOCITY TRADING</span>
    </a>
    <div class="nav-pill">
      <a href="/member" class="active">Portal</a>
      <a href="/course">Course</a>
      <a href="/trading-journal">Journal</a>
      <a href="/shop">Shop</a>
    </div>
    <div class="nav-cta">
      <a href="/billing/confirm-session" class="nav-link-ghost">Billing</a>
      <a href="/logout" class="nav-link-ghost">Log out</a>
      <a href="/prop-activation" class="nav-btn-primary">Prop Firms</a>
    </div>
  </div>
</nav>

<div class="portal-wrap">
  <div class="hero-section">
    <div class="hero-section-inner">
      <span class="pill">MEMBER PORTAL</span>
      <h1>Welcome back, <span class="hero-name">${s.name}</span></h1>
      <p>Stay sharp. Stay ahead.</p>
      <div class="hero-div"></div>
    </div>
  </div>

  <div class="dash-header">
    <span class="section-label">Your Dashboard</span>
    <div class="carousel-nav">
      <button type="button" class="carousel-btn" id="carousel-prev" aria-label="Previous"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
      <button type="button" class="carousel-btn" id="carousel-next" aria-label="Next"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></button>
    </div>
  </div>

  <div class="carousel-section">
    <div class="carousel-scroll" id="carousel-scroll">

      <a class="pcard" href="/trading-room">
        <div class="pcard-inner">
          <div class="pcard-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/></svg></div>
          <h3>Get Started</h3>
          <p>Activate your Discord access and NinjaTrader indicators. Takes less than 2 minutes.</p>
          <div class="pcard-arrow">Get Started <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
        </div>
      </a>

      <a class="pcard" href="/course">
        <div class="pcard-inner">
          <div class="pcard-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/></svg></div>
          <h3>Course Library</h3>
          <p>Step-by-step trading videos built on the HVT system. Learn at your own pace.</p>
          <div class="pcard-arrow">Watch Now <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
        </div>
      </a>

      <a class="pcard" href="/trading-journal">
        <div class="pcard-inner">
          <div class="pcard-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25"/></svg></div>
          <h3>Trading Journal</h3>
          <p>Log your trades, review performance, and track your progress with the HVT system.</p>
          <div class="pcard-arrow">Open Journal <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
        </div>
      </a>

      <a class="pcard pcard-gold" href="/shop">
        <div class="pcard-inner">
          <div class="pcard-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 0 0 3.75-.615A2.993 2.993 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 0 0 2.25 1.016 2.993 2.993 0 0 0 2.25-1.016 3.001 3.001 0 0 0 3.75.614m-16.5 0a3.004 3.004 0 0 1-.621-4.72l1.189-1.19A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72M6.75 18h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .414.336.75.75.75Z"/></svg></div>
          <h3>Member Shop</h3>
          <p>Exclusive tools available only to HVT members. HVT Echo and future releases.</p>
          <div class="pcard-arrow">Shop Now <span class="arr"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span></div>
        </div>
      </a>

    </div>
  </div>

  <div class="echo-promo">
    <div class="echo-promo-inner">
      <div class="echo-promo-text">
        <span class="echo-badge">Members Only</span>
        <div class="echo-title">HVT Echo is Live</div>
        <p class="echo-desc">Copy your trades to up to 5 prop firm accounts simultaneously. One execution. Five accounts hit. Exclusive to HVT members.</p>
      </div>
      <div class="echo-promo-right">
        <div class="echo-price">$97<span>one-time</span></div>
        <a href="/shop" class="echo-cta">Shop Now
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </a>
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
  if(el&&prev&&next){
    var step=340;
    prev.addEventListener('click',function(){el.scrollBy({left:-step,behavior:'smooth'})});
    next.addEventListener('click',function(){el.scrollBy({left:step,behavior:'smooth'})});
  }
  // Collapse the wordmark on scroll — V stays, "HIGH VELOCITY TRADING" fades out
  var nav=document.querySelector('.nav');
  if(nav){
    var threshold=28;
    var ticking=false;
    function sync(){
      ticking=false;
      if(window.scrollY>threshold) nav.classList.add('is-collapsed');
      else nav.classList.remove('is-collapsed');
    }
    window.addEventListener('scroll',function(){
      if(!ticking){ requestAnimationFrame(sync); ticking=true; }
    },{passive:true});
    sync();
  }
})();
</script>
</body></html>`;
}

module.exports = { V_LOGO_SVG, ninjaLogoSVG, shell, resultPage, memberPortalHtml };
