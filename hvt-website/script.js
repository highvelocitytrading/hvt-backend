/* =====================================================
   HIGH VELOCITY TRADING — SCRIPTS
   ===================================================== */
// ─── HVT PAYMENT HANDLERS (global — required by Accept.js) ───
var hvtData = {};
function hvtEsc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function hvtHandlePayment(response) {
    var errEl = document.getElementById('hvtErr2');
    if (response.messages.resultCode === 'Error') {
        var msg = response.messages.message.map(function(m) { return m.text; }).join(' ');
        if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
        var payForm = document.getElementById('hvtForm2');
        if (payForm) payForm.style.display = '';
        return;
    }
    if (!response.opaqueData || !response.opaqueData.dataDescriptor) {
        if (errEl) { errEl.textContent = 'Payment token missing. Please refresh and try again.'; errEl.style.display = 'block'; }
        return;
    }
    hvtData.opaqueDesc  = response.opaqueData.dataDescriptor;
    hvtData.opaqueValue = response.opaqueData.dataValue;
    hvtProcessPayment();
}
function hvtProcessPayment() {
    var BACKEND = 'https://app.highvelocitytrading.com';
    var loading = document.getElementById('checkoutLoading');
    var payForm = document.getElementById('hvtForm2');
    if (payForm)  payForm.style.display = 'none';
    if (loading)  loading.classList.remove('hidden');
    // Route each plan to its correct Supabase submission endpoint
    var CONTACT_URLS = {
        lifetime: BACKEND + '/api/submit/license',   // → license_keys table
        discord:  BACKEND + '/api/submit/discord',   // → discord_members table
        echo:     BACKEND + '/api/submit/echo',      // → hvt_echo_licenses table
    };
    var contactUrl = CONTACT_URLS[hvtData.plan] || (BACKEND + '/api/submit/membership');
    fetch(BACKEND + '/api/payment/charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            plan: hvtData.plan, email: hvtData.email,
            full_name: hvtData.full_name,
            opaqueDataDescriptor: hvtData.opaqueDesc,
            opaqueDataValue: hvtData.opaqueValue
        })
    })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
    .then(function(result) {
        if (!result.data.ok) throw new Error(result.data.error || 'Payment failed. Please try again.');
        var body = { email: hvtData.email, full_name: hvtData.full_name, phone: hvtData.phone || null };
        // Lifetime and Echo are one-time charges — pass transaction_id so Supabase can link the record
        if ((hvtData.plan === 'lifetime' || hvtData.plan === 'echo') && result.data.transaction_id) {
            body.transaction_id = result.data.transaction_id;
        }
        return fetch(contactUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    })
    .then(function() {
        if (loading) loading.classList.add('hidden');
        hvtShowSuccess();
    })
    .catch(function(err) {
        if (loading) loading.classList.add('hidden');
        if (payForm) payForm.style.display = '';
        var e = document.getElementById('hvtErr2');
        if (e) { e.textContent = err.message || 'Something went wrong. Please try again.'; e.style.display = 'block'; }
    });
}
function hvtShowSuccess() {
    var BACKEND = 'https://app.highvelocitytrading.com';
    var wrap = document.getElementById('checkoutFormWrap');
    if (!wrap) return;
    var SUCCESS = {
        monthly:  { label: 'Monthly Member',      portal: true,  next: ['Go to Member Portal and click <strong>Get Started</strong> to activate', 'Course library and indicators ready inside', 'Manage or cancel anytime from your account portal'] },
        lifetime: { label: 'Lifetime Member',     portal: true,  next: ['Go to Member Portal and click <strong>Get Started</strong> to activate', 'Course library and indicators ready inside', 'Lifetime software updates — no future charges'] },
        discord:  { label: 'Trading Room Member', portal: false, next: ['Check <strong>' + hvtEsc(hvtData.email) + '</strong> for your Discord setup instructions', 'Join the server and follow the steps in the email', 'Cancel anytime — no long-term commitment'] },
        echo:     { label: 'HVT Echo License',    portal: false, next: ['Your license key has been sent to <strong>' + hvtEsc(hvtData.email) + '</strong>', 'Full install guide included — works with all major prop firms', 'License is machine-locked to one computer'] },
    };
    var meta      = SUCCESS[hvtData.plan] || SUCCESS['monthly'];
    var planLabel = meta.label;
    var nextItems = meta.next;
    var nextHTML = nextItems.map(function(t) {
        return '<div class="hvt-next-item">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' +
            t + '</div>';
    }).join('');
    wrap.innerHTML =
        '<div class="hvt-form hvt-success">' +
        '<div class="hvt-brand" style="margin-bottom:8px;">' +
        '<img src="assets/HVTlogonew.png" alt="High Velocity Trading" class="hvt-brand-logo">' +
        '</div>' +
        '<div class="hvt-success-icon"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#0055fe" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg></div>' +
        '<h3 class="hvt-success-title">You\'re in.</h3>' +
        '<p class="hvt-success-msg">Welcome to High Velocity Trading. You\'re now a <strong>' + planLabel + '</strong> member.</p>' +
        '<div class="hvt-next" style="text-align:left;width:100%;margin-bottom:32px;">' +
        '<p class="hvt-next-title">What happens next</p>' +
        nextHTML +
        '</div>' +
        (meta.portal
            ? '<a href="' + BACKEND + '/login" class="btn btn-primary" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;width:100%;height:52px;">Go to Member Portal</a>'
            : '<button onclick="document.getElementById(\'checkoutOverlay\').style.display=\'none\'" class="btn btn-primary" style="width:100%;height:52px;">Done</button>'
        ) +
        '</div>';
}

// ─── GLOBAL ERROR BOUNDARY ───────────────────────────
window.addEventListener('error', (e) => {
    // Suppress noisy third-party errors from crashing the page;
    // log in dev, silent in prod.
    if (e.filename && !e.filename.includes(window.location.origin)) return;
    console.warn('[HVT] Caught JS error:', e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
    console.warn('[HVT] Unhandled promise rejection:', e.reason);
    e.preventDefault(); // stop browser from printing red error
});

document.addEventListener('DOMContentLoaded', () => {

    // ─── NAV: scroll glass effect ───────────────────────
    const nav = document.getElementById('nav');
    if (nav) {
        const onNavScroll = () => {
            nav.classList.toggle('nav--scrolled', window.scrollY > 20);
        };
        window.addEventListener('scroll', onNavScroll, { passive: true });
    }

    // ─── HAMBURGER MENU ─────────────────────────────────
    const hamburger = document.getElementById('hamburger');
    const mobileMenu = document.getElementById('mobileMenu');

    if (hamburger && mobileMenu) {
        hamburger.addEventListener('click', () => {
            const isOpen = hamburger.classList.toggle('open');
            if (isOpen) {
                mobileMenu.classList.add('open');
                document.body.style.overflow = 'hidden';
            } else {
                mobileMenu.classList.remove('open');
                document.body.style.overflow = '';
            }
        });

        mobileMenu.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                hamburger.classList.remove('open');
                mobileMenu.classList.remove('open');
                document.body.style.overflow = '';
            });
        });
    }

    // ─── HERO ROTATING TEXT ─────────────────────────────
    const rotateItems = document.querySelectorAll('.rotate-item');
    if (rotateItems.length > 1) {
        let current = 0;
        setInterval(() => {
            rotateItems[current].classList.remove('active');
            current = (current + 1) % rotateItems.length;
            rotateItems[current].classList.add('active');
        }, 2800);
    }

    // ─── FEATURE TABS ────────────────────────────────────
    const tabs = document.querySelectorAll('.feature-tab');
    const panels = document.querySelectorAll('.feature-panel');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            if (tab.classList.contains('active')) return;

            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));

            tab.classList.add('active');
            const panel = document.getElementById('panel-' + target);
            if (!panel) return;

            // Re-trigger bar animations by briefly removing and re-adding active
            panel.classList.remove('active');
            void panel.offsetWidth; // force reflow
            panel.classList.add('active');
        });
    });

    // ─── FAQ ACCORDION ───────────────────────────────────
    document.querySelectorAll('.faq-q').forEach(btn => {
        btn.addEventListener('click', () => {
            const item   = btn.closest('.faq-item');
            const isOpen = item.classList.contains('open');

            // Close all
            document.querySelectorAll('.faq-item.open').forEach(el => {
                el.classList.remove('open');
                el.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
            });

            // Open clicked
            if (!isOpen) {
                item.classList.add('open');
                btn.setAttribute('aria-expanded', 'true');
            }
        });
    });

    // ─── PRICING TOGGLE ──────────────────────────────────
    const pricingToggle = document.getElementById('pricingToggle');
    if (pricingToggle) {
        const opts = pricingToggle.querySelectorAll('.toggle-opt');
        const planMonthly = document.getElementById('plan-monthly');
        const planLifetime = document.getElementById('plan-lifetime');

        opts.forEach(opt => {
            opt.addEventListener('click', () => {
                const plan = opt.dataset.plan;
                opts.forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                pricingToggle.dataset.active = plan;

                if (plan === 'lifetime') {
                    planMonthly.style.display = 'none';
                    planLifetime.style.display = 'block';
                } else {
                    planMonthly.style.display = 'block';
                    planLifetime.style.display = 'none';
                }
            });
        });
    }

    // ─── HERO STAGGER REVEAL ─────────────────────────────
    // Hero is in viewport on load — stagger each element in
    const heroReveals = document.querySelectorAll('.hero-container .reveal');
    heroReveals.forEach((el, i) => {
        setTimeout(() => el.classList.add('visible'), 80 + i * 130);
    });

    // ─── HERO BULL — Cloudflare R2, preload-all, play-once ───
    const bullCanvas = document.getElementById('bullExplosionCanvas');

    if (bullCanvas) {
        const ctx          = bullCanvas.getContext('2d', { alpha: true });
        const BASE_URL     = 'https://pub-ae4c5aafb8f24f34aaac5fc0a105eae3.r2.dev/';
        const FIRST        = 2039;
        const LAST         = 2138;
        const FRAME_COUNT  = LAST - FIRST + 1; // 100
        const FPS          = 24;
        const MS_PER_FRAME = 1000 / FPS;       // ~41.67ms
        const bitmaps      = new Array(FRAME_COUNT).fill(null);

        let playhead       = 0;
        let lastFrameTime  = null;

        const frameUrl = (i) =>
            `${BASE_URL}Sequence%2001_${FIRST + i}.png`;

        // ── Canvas sizing — full viewport, device-pixel-crisp ──────────────
        const syncSize = () => {
            const dpr = window.devicePixelRatio || 1;
            bullCanvas.width  = Math.round(window.innerWidth  * dpr);
            bullCanvas.height = Math.round(window.innerHeight * dpr);
            paint(bitmaps[playhead]); // safe — paint() guards against null
        };

        // ── Draw bull at 42% viewport height, right-of-center ─────────────
        const paint = (img) => {
            if (!img) return;
            const cw = bullCanvas.width;
            const ch = bullCanvas.height;
            const iw = img.naturalWidth  || img.width;
            const ih = img.naturalHeight || img.height;
            const sh = ch * 0.42;
            const sw = iw * (sh / ih);
            ctx.clearRect(0, 0, cw, ch);
            ctx.drawImage(img, cw * 0.62 - sw / 2, ch * 0.50 - sh / 2, sw, sh);
        };

        let finished = false;

        // ── RAF loop — plays once, freezes on last frame ───────────────────
        const tick = (timestamp) => {
            if (finished) return;
            if (!lastFrameTime) lastFrameTime = timestamp;

            const elapsed = timestamp - lastFrameTime;
            if (elapsed >= MS_PER_FRAME) {
                const steps   = Math.floor(elapsed / MS_PER_FRAME);
                playhead      = Math.min(playhead + steps, FRAME_COUNT - 1);
                lastFrameTime = timestamp - (elapsed % MS_PER_FRAME);
                paint(bitmaps[playhead]);

                if (playhead >= FRAME_COUNT - 1) {
                    finished = true;
                    return;
                }
            }
            requestAnimationFrame(tick);
        };

        // ── Load one frame using Image() — bypasses CORS for display ───────
        const loadOne = (i) => new Promise((resolve) => {
            const img    = new Image();
            img.onload   = () => { bitmaps[i] = img; resolve(); };
            img.onerror  = () => resolve();
            img.src      = frameUrl(i);
        });

        // ── Preload ALL frames concurrently, then play ─────────────────────
        const preloadAll = async () => {
            const promises = Array.from({ length: FRAME_COUNT }, (_, i) => loadOne(i));

            promises[0].then(() => {
                if (bitmaps[0]) { syncSize(); paint(bitmaps[0]); }
            });

            await Promise.all(promises);
            lastFrameTime = null;
            requestAnimationFrame(tick);
        };

        syncSize();
        preloadAll();
        window.addEventListener('resize', syncSize, { passive: true });
    }

    // ─── CHECKOUT MODAL ──────────────────────────────────
    const checkoutOverlay   = document.getElementById('checkoutOverlay');
    const checkoutBody      = checkoutOverlay ? checkoutOverlay.querySelector('.checkout-body') : null;
    const checkoutClose     = document.getElementById('checkoutClose');
    const checkoutFormWrap  = document.getElementById('checkoutFormWrap');
    const checkoutLoading   = document.getElementById('checkoutLoading');
    const checkoutPlanLabel = document.getElementById('checkoutPlanLabel');

    let checkoutOpen        = false;
    let scrollPos           = 0;
    let activePlan          = null;
    let lastFocusedElement  = null;
    const openCheckout = (plan) => {
        const PLAN_META = {
            monthly:  { label: 'Monthly — $497/mo'      },
            lifetime: { label: 'Lifetime — $2,497'       },
            discord:  { label: 'Trading Room — $37/mo'  },
            echo:     { label: 'Echo Algo — $97'         },
        };
        if (!PLAN_META[plan]) return;
        hvtData = { plan };
        scrollPos = window.scrollY;
        if (checkoutPlanLabel) checkoutPlanLabel.textContent = PLAN_META[plan].label;
        checkoutFormWrap.innerHTML = '';
        checkoutLoading.classList.remove('hidden');
        if (checkoutOverlay) {
            document.body.style.overflow = 'hidden';
            checkoutOverlay.classList.add('open');
        }
        checkoutOpen = true;
        activePlan   = plan;
        if (checkoutBody) checkoutBody.scrollTop = 0;
        history.pushState({ checkout: plan }, '', window.location.pathname);
        fetch('https://app.highvelocitytrading.com/api/payment/config')
            .then(r => r.json())
            .then(cfg => {
                hvtData._apiLoginID = cfg.apiLoginID;
                hvtData._clientKey  = cfg.clientKey;
                hvtData._env        = cfg.env;
                // Prime the hidden AcceptUI button with real credentials
                const hiddenBtn = document.getElementById('hvtAcceptUIHidden');
                if (hiddenBtn) {
                    hiddenBtn.setAttribute('data-apiLoginID', cfg.apiLoginID || '');
                    hiddenBtn.setAttribute('data-clientKey',  cfg.clientKey  || '');
                }
                // Preload Accept.js now so it finds the hidden button and initializes
                const acceptSrc = cfg.env === 'sandbox'
                    ? 'https://jstest.authorize.net/v3/AcceptUI.js'
                    : 'https://js.authorize.net/v3/AcceptUI.js';
                if (!document.querySelector('script[src="' + acceptSrc + '"]')) {
                    const s = document.createElement('script');
                    s.src = acceptSrc; s.charset = 'utf-8';
                    document.head.appendChild(s);
                }
                checkoutLoading.classList.add('hidden');
                hvtStep1();
            })
            .catch(() => {
                checkoutLoading.classList.add('hidden');
                hvtStep1();
            });
    };
    // Expose so standalone checkout pages (checkout-discord.html etc.) can call it directly
    window.openCheckout = openCheckout;

    // ─── NATIVE CHECKOUT STEPS ───────────────────────────
    const CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
    const LOCK_SVG  = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

    const PLAN_CONFIG = {
        monthly: {
            badge:   'monthly',
            label:   'Monthly',
            name:    'Monthly Access',
            desc:    'Full software suite, billed monthly',
            price:   '$497',
            period:  '/month',
            feats:   ['Full HVT software suite', 'All algorithm updates included', 'Private member Discord', 'Cancel anytime'],
        },
        lifetime: {
            badge:   'lifetime',
            label:   'Lifetime',
            name:    'Lifetime Access',
            desc:    'One payment — full access forever',
            price:   '$2,497',
            period:  'one-time',
            feats:   ['Full HVT software suite', 'Lifetime algorithm updates', 'Private member Discord', 'Priority support'],
        },
        discord: {
            badge:   'discord',
            label:   'Add-On',
            name:    'HVT Trading Room',
            desc:    'Live alerts & community, billed monthly',
            price:   '$37',
            period:  '/month',
            feats:   ['Real-time trade alerts', 'Live market commentary', 'Direct coach access', 'Cancel anytime'],
        },
        echo: {
            badge:   'echo',
            label:   'Add-On',
            name:    'HVT Echo Algo',
            desc:    'Automated signal tool — one-time license',
            price:   '$97',
            period:  'one-time',
            feats:   ['Plug-and-play NinjaTrader algo', 'Works with all major prop firms', 'Lifetime license key', 'Free updates included'],
        },
    };

    function hvtOrderCard(plan) {
        const p = PLAN_CONFIG[plan];
        if (!p) return '';
        const featsHTML = p.feats.map(f =>
            '<li class="hvt-order-feat">' + CHECK_SVG + f + '</li>'
        ).join('');
        return '<div class="hvt-order-card">' +
            '<div class="hvt-order-top">' +
            '<div class="hvt-order-left">' +
            '<span class="hvt-order-badge ' + p.badge + '">' + p.label + '</span>' +
            '<p class="hvt-order-name">' + p.name + '</p>' +
            '<p class="hvt-order-desc">' + p.desc + '</p>' +
            '</div>' +
            '<div class="hvt-order-price-wrap">' +
            '<div class="hvt-order-price">' + p.price + '</div>' +
            '<div class="hvt-order-period">' + p.period + '</div>' +
            '</div>' +
            '</div>' +
            '<ul class="hvt-order-features">' + featsHTML + '</ul>' +
            '</div>';
    }

    function hvtBrandHeader() {
        return '<div class="hvt-brand">' +
            '<img src="assets/HVTlogonew.png" alt="High Velocity Trading" class="hvt-brand-logo">' +
            '<span class="hvt-brand-sub">Secure Checkout</span>' +
            '</div>';
    }

    function hvtStepIndicator(active) {
        const s1class = active === 1 ? 'hvt-step active' : 'hvt-step done';
        const s1inner = active === 1 ? '1' : '&#10003;';
        const lineClass = active === 2 ? 'hvt-step-line done' : 'hvt-step-line';
        const s2class = active === 2 ? 'hvt-step active' : 'hvt-step';
        const l1color = active === 1 ? 'color:var(--accent)' : 'color:#4ade80';
        const l2color = active === 2 ? 'color:var(--accent)' : 'color:var(--text-3)';
        return '<div class="hvt-steps-row">' +
            '<div class="hvt-steps-inner">' +
            '<div class="hvt-step-col"><span class="' + s1class + '">' + s1inner + '</span>' +
            '<span class="hvt-step-col-label" style="' + l1color + '">Details</span></div>' +
            '<span class="' + lineClass + '" style="margin-bottom:18px;"></span>' +
            '<div class="hvt-step-col"><span class="' + s2class + '">2</span>' +
            '<span class="hvt-step-col-label" style="' + l2color + '">Payment</span></div>' +
            '</div>' +
            '</div>';
    }

    function hvtStep1(prefill) {
        const vName  = prefill && prefill.full_name ? hvtEsc(prefill.full_name) : '';
        const vEmail = prefill && prefill.email     ? hvtEsc(prefill.email)     : '';
        const vPhone = prefill && prefill.phone     ? hvtEsc(prefill.phone)     : '';

        checkoutFormWrap.innerHTML =
            '<form id="hvtForm1" class="hvt-form" novalidate>' +
            hvtBrandHeader() +
            hvtOrderCard(hvtData.plan) +
            '<div class="hvt-divider"></div>' +
            hvtStepIndicator(1) +
            '<div class="hvt-field"><label for="hvtName">Full Name</label>' +
            '<input type="text" id="hvtName" placeholder="John Smith" autocomplete="name" required value="' + vName + '"></div>' +
            '<div class="hvt-field"><label for="hvtEmail">Email Address</label>' +
            '<input type="email" id="hvtEmail" placeholder="john@example.com" autocomplete="email" required value="' + vEmail + '"></div>' +
            '<div class="hvt-field"><label for="hvtEmailConfirm">Confirm Email Address</label>' +
            '<input type="email" id="hvtEmailConfirm" placeholder="john@example.com" autocomplete="off" required value=""></div>' +
            '<div class="hvt-field"><label for="hvtPhone">Phone <span class="hvt-optional">optional</span></label>' +
            '<input type="tel" id="hvtPhone" placeholder="+1 (555) 000-0000" autocomplete="tel" value="' + vPhone + '"></div>' +
            '<div id="hvtErr1" class="hvt-error-box" style="display:none;"></div>' +
            '<button type="submit" class="hvt-btn-primary">Continue to Payment ' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>' +
            '</button>' +
            '<p class="hvt-secure">' + LOCK_SVG + ' Secured by Authorize.net &amp; 256-bit SSL</p>' +
            '</form>';

        const nameEl         = document.getElementById('hvtName');
        const emailEl        = document.getElementById('hvtEmail');
        const emailConfirmEl = document.getElementById('hvtEmailConfirm');
        const phoneEl        = document.getElementById('hvtPhone');
        const errEl          = document.getElementById('hvtErr1');
        setTimeout(() => nameEl && nameEl.focus(), 60);

        // Prevent paste on confirm field so user must type it manually
        emailConfirmEl.addEventListener('paste', e => e.preventDefault());

        document.getElementById('hvtForm1').addEventListener('submit', e => {
            e.preventDefault();
            const name         = nameEl.value.trim();
            const email        = emailEl.value.trim();
            const emailConfirm = emailConfirmEl.value.trim();
            const phone        = phoneEl.value.trim();
            nameEl.classList.remove('is-error');
            emailEl.classList.remove('is-error');
            emailConfirmEl.classList.remove('is-error');
            errEl.style.display = 'none';
            if (!name || name.length < 2) {
                nameEl.classList.add('is-error');
                errEl.textContent = 'Please enter your full name.';
                errEl.style.display = 'block'; return;
            }
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                emailEl.classList.add('is-error');
                errEl.textContent = 'Please enter a valid email address.';
                errEl.style.display = 'block'; return;
            }
            if (!emailConfirm) {
                emailConfirmEl.classList.add('is-error');
                errEl.textContent = 'Please confirm your email address.';
                errEl.style.display = 'block'; return;
            }
            if (email.toLowerCase() !== emailConfirm.toLowerCase()) {
                emailEl.classList.add('is-error');
                emailConfirmEl.classList.add('is-error');
                errEl.textContent = 'Email addresses do not match. Please check and try again.';
                errEl.style.display = 'block'; return;
            }
            hvtData.full_name = name;
            hvtData.email     = email;
            hvtData.phone     = phone || null;
            hvtStep2();
        });
    }
    function hvtStep2() {
        const plan    = hvtData.plan;
        const loginID = hvtData._apiLoginID || '';
        const NEXT = {
            monthly:  ['Go to Member Portal and click <strong>Get Started</strong> to begin', 'Course library with video tutorials is available inside', 'Manage or cancel anytime from your account portal'],
            lifetime: ['Go to Member Portal and click <strong>Get Started</strong> to begin', 'Course library with video tutorials is available inside', 'Lifetime software updates — no future charges'],
            discord:  ['Check your email for Discord invite instructions', 'Join the server and follow the steps in the email', 'Cancel anytime from your account'],
            echo:     ['License key will be emailed to you shortly', 'Follow the install guide included in your email', 'Machine-locked — one computer per license'],
        };
        const nextItems = (NEXT[plan] || []).map(t =>
            '<div class="hvt-next-item">' + CHECK_SVG + t + '</div>'
        ).join('');

        const planCfg   = PLAN_CONFIG[plan] || {};
        const recurring = plan === 'monthly' || plan === 'discord';
        const orderLine = (planCfg.name || '') + ' — ' + (planCfg.price || '') + (recurring ? '/mo' : ' one-time');

        const missingCreds = !loginID;

        checkoutFormWrap.innerHTML =
            '<div id="hvtForm2" class="hvt-form">' +
            hvtBrandHeader() +
            '<div class="hvt-summary">' +
            '<span class="hvt-summary-name">' + orderLine + '</span>' +
            '<span class="hvt-summary-secure">' + LOCK_SVG + ' Secure</span>' +
            '</div>' +
            '<div class="hvt-customer-row">' +
            '<div class="hvt-customer-avatar">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' +
            '</div>' +
            '<div class="hvt-customer-info">' +
            '<span class="hvt-customer-name">' + hvtEsc(hvtData.full_name) + '</span>' +
            '<span class="hvt-customer-email">' + hvtEsc(hvtData.email) + '</span>' +
            '</div>' +
            '</div>' +
            '<div class="hvt-divider"></div>' +
            hvtStepIndicator(2) +
            (missingCreds
                ? '<div class="hvt-error-box">Payment credentials missing — ensure AUTHNET_CLIENT_KEY and AUTHNET_ENV are set in Railway.</div>'
                : '<button type="button" id="hvtPayNowBtn" class="hvt-btn-primary">Pay Now</button>'
            ) +
            '<div id="hvtErr2" class="hvt-error-box" style="display:none;"></div>' +
            '<div class="hvt-next">' +
            '<p class="hvt-next-title">What happens next</p>' +
            nextItems +
            '</div>' +
            '<button type="button" class="hvt-back" id="hvtBackBtn">&#8592; Back to your details</button>' +
            '<p class="hvt-secure">' + LOCK_SVG + ' Payment secured by Authorize.net &amp; 256-bit SSL</p>' +
            '</div>';

        document.getElementById('hvtBackBtn').addEventListener('click', () => {
            hvtStep1({ full_name: hvtData.full_name, email: hvtData.email, phone: hvtData.phone });
        });

        if (!missingCreds) {
            document.getElementById('hvtPayNowBtn').addEventListener('click', () => {
                // Trigger the hidden AcceptUI button — always initialized by Accept.js
                const trigger = document.getElementById('hvtAcceptUIHidden');
                if (trigger) {
                    trigger.click();
                } else {
                    const e = document.getElementById('hvtErr2');
                    if (e) { e.textContent = 'Payment could not be initialized. Please refresh and try again.'; e.style.display = 'block'; }
                }
            });
        }
    }
    const closeCheckout = () => {
        if (!checkoutOpen) return;
        if (checkoutOverlay) checkoutOverlay.classList.remove('open');
        checkoutOpen = false;
        document.body.style.overflow = '';
        window.scrollTo(0, scrollPos);
        setTimeout(() => {
            checkoutFormWrap.innerHTML = '';
            checkoutLoading.classList.remove('hidden');
            activePlan = null;
        }, 400);
        if (lastFocusedElement) lastFocusedElement.focus();
    };

    // Close button
    checkoutClose && checkoutClose.addEventListener('click', () => {
        if (checkoutOverlay) {
            closeCheckout();
            history.pushState({}, '', '/');
        } else {
            // Standalone checkout page — go back to site
            window.location.href = '/';
        }
    });

    // Escape key closes modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && checkoutOpen) {
            closeCheckout();
            history.pushState({}, '', '/');
        }
    });

    // ── Focus trap: keep Tab/Shift+Tab inside the open overlay ────────
    checkoutOverlay && checkoutOverlay.addEventListener('keydown', (e) => {
        if (!checkoutOpen || e.key !== 'Tab') return;
        const focusable = Array.from(
            checkoutOverlay.querySelectorAll(
                'a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'
            )
        ).filter(el => !el.closest('[style*="display:none"]'));
        if (!focusable.length) return;
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
        }
    });

    // Browser back button
    window.addEventListener('popstate', () => {
        if (checkoutOpen) {
            if (checkoutOverlay) closeCheckout();
            else window.location.href = '/';
        }
    });

    // Intercept pricing CTA buttons
    document.querySelectorAll('[data-plan]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            lastFocusedElement = btn;
            openCheckout(btn.dataset.plan);
            if (checkoutClose) requestAnimationFrame(() => checkoutClose.focus());
        });
    });

    // ─── SCROLL REVEAL ───────────────────────────────────
    const revealEls = document.querySelectorAll('.reveal:not(.hero-container .reveal)');

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });

    revealEls.forEach(el => observer.observe(el));

});
