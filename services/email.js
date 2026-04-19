// services/email.js
// Resend email service and all transactional email functions.
// Every email sent by the application passes through this file.

'use strict';

const { RESEND_API_KEY, FROM_EMAIL, APP_URL } = require('../config/constants');
const { fetchFn, esc } = require('../helpers/utils');

// ─── CORE SEND ────────────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
    console.log('[Email] Attempting to send to:', to, 'Subject:', subject);
    if (!RESEND_API_KEY) {
        console.error('[Email] RESEND_API_KEY not set – skipping send', { to, subject });
        return { skipped: true };
    }
    try {
        const r = await fetchFn('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
            body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
        });
        const d = await r.json();
        console.log('[Email] Resend response:', d);
        if (!r.ok) throw new Error(`Resend: ${JSON.stringify(d)}`);
        return d;
    } catch (e) {
        console.error('[Email] Error sending email:', e.message);
        throw e;
    }
}

// ─── HTML WRAPPER ─────────────────────────────────────────────────────────────
// Wraps email body content in the HVT branded email shell
function wrap(content) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
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
}

// ─── WELCOME EMAILS ───────────────────────────────────────────────────────────
// Sends the branded welcome email for monthly or lifetime membership activations
async function sendWelcome(email, fullName, type) {
    const name    = fullName?.split(' ')[0] || 'Trader';
    const monthly = type === 'monthly';
    const subject = monthly
        ? `Welcome to the Team, ${name} — Your HVT Membership is Active`
        : `Welcome to the Team, ${name} — Your HVT Lifetime Access is Active`;

    const monthlyHtml = wrap(`
      <div style="text-align:center;padding-bottom:8px;">
        <div style="display:inline-block;background:rgba(34,84,245,0.1);border:1px solid rgba(34,84,245,0.25);border-radius:20px;padding:5px 18px;margin-bottom:22px;">
          <span style="color:#60a5fa;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">Monthly Membership — Active</span>
        </div>
        <h1 style="color:#ffffff;font-size:26px;font-weight:800;margin:0 0 10px;letter-spacing:-0.5px;">Welcome to the Team, ${name}.</h1>
        <p style="color:#64748b;font-size:14px;margin:0;">Thank you for joining High Velocity Trading. We're glad to have you.</p>
      </div>

      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.08),transparent);margin:28px 0;"></div>

      <p style="color:#94a3b8;font-size:14px;line-height:1.9;margin:0 0 28px;">Your monthly membership is now live. You have full access to our proprietary NinjaTrader indicator suite, the member course library, and the option to join our live Trading Room. Everything you need to get started is outlined below — take it one step at a time.</p>

      <div style="text-align:center;margin-bottom:32px;">
        <a href="${APP_URL}/login" style="display:inline-block;background:linear-gradient(135deg,#1a3fd4,#2254F5);color:#fff;text-decoration:none;padding:16px 44px;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:1px;box-shadow:0 4px 20px rgba(34,84,245,0.45);">ACCESS YOUR MEMBER PORTAL &rarr;</a>
        <p style="color:#334155;font-size:11px;margin-top:10px;">Enter your email on the portal to receive your secure login link.</p>
      </div>

      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent);margin:0 0 28px;"></div>

      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#475569;font-weight:700;margin-bottom:18px;">How to Get Set Up</div>

      <div style="border:1px solid rgba(255,255,255,0.07);border-radius:12px;overflow:hidden;margin-bottom:28px;">

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:#1e3a8a;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#93c5fd;margin-top:1px;">1</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Log into Your Member Portal</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;">Go to your member portal, enter your email, and click the secure link we send you. From there you can access the course library and your account at any time.</div>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:#1e3a8a;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#93c5fd;margin-top:1px;">2</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Set Up NinjaTrader &amp; Activate Your Indicators</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;margin-bottom:12px;">If you don't have NinjaTrader 8 yet, download it using our affiliate link below — it's free to get started. Once installed, your indicators are activated by simply entering the email address you used to purchase.</div>
              <a href="https://ninjatraderus.pxf.io/Pz0bWN" style="display:inline-block;background:rgba(34,84,245,0.12);border:1px solid rgba(34,84,245,0.3);color:#60a5fa;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:12px;font-weight:700;letter-spacing:1px;">DOWNLOAD NINJATRADER FREE &rarr;</a>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:#1e3a8a;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#93c5fd;margin-top:1px;">3</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Join the HVT Discord Server</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;margin-bottom:12px;">Our Discord is where the community lives. Join the server using the button at the top of our website, then head to your member portal to activate your Trading Room role — you'll need your Discord username to complete this step.</div>
              <a href="https://discord.gg/2xG96nV4Hn" style="display:inline-block;background:rgba(34,84,245,0.12);border:1px solid rgba(34,84,245,0.3);color:#60a5fa;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:12px;font-weight:700;letter-spacing:1px;">JOIN DISCORD &rarr;</a>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:#1e3a8a;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#93c5fd;margin-top:1px;">4</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Watch the Course &amp; Learn the System</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;">Your member portal includes full access to our course library. Start from the beginning — the foundation videos will make everything else click faster.</div>
            </div>
          </div>
        </div>

      </div>

      <div style="background:rgba(248,113,113,0.05);border:1px solid rgba(248,113,113,0.15);border-radius:10px;padding:14px 18px;margin-bottom:28px;">
        <p style="color:#fca5a5;font-size:12px;line-height:1.7;margin:0;"><strong>Membership Note:</strong> Your Trading Room access and indicator license are tied to your active monthly subscription. Should your payment lapse, access will be paused automatically.</p>
      </div>

      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px 20px;text-align:center;">
        <p style="color:#475569;font-size:13px;margin:0 0 4px;">Questions? We're here.</p>
        <p style="color:#94a3b8;font-size:15px;font-weight:700;margin:0;">&#128222;&nbsp; 786-461-4235</p>
      </div>`);

    const lifetimeHtml = wrap(`
      <div style="text-align:center;padding-bottom:8px;">
        <div style="display:inline-block;background:rgba(246,173,85,0.1);border:1px solid rgba(246,173,85,0.3);border-radius:20px;padding:5px 18px;margin-bottom:22px;">
          <span style="color:#f6ad55;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">Lifetime Access — Active</span>
        </div>
        <h1 style="color:#ffffff;font-size:26px;font-weight:800;margin:0 0 10px;letter-spacing:-0.5px;">Welcome to the Team, ${name}.</h1>
        <p style="color:#64748b;font-size:14px;margin:0;">Thank you for investing in yourself. This is just the beginning.</p>
      </div>

      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(246,173,85,0.15),transparent);margin:28px 0;"></div>

      <p style="color:#94a3b8;font-size:14px;line-height:1.9;margin:0 0 28px;">Your lifetime membership is active — you now have permanent access to our full NinjaTrader indicator suite and the complete course library. As a lifetime member, you also receive <strong style="color:#f6ad55;">3 months of Trading Room access completely free</strong>. After that, you can continue at our monthly rate if you'd like to stay in the room. Everything you need to get going is below.</p>

      <div style="text-align:center;margin-bottom:32px;">
        <a href="${APP_URL}/login" style="display:inline-block;background:linear-gradient(135deg,#b45309,#d97706,#f6ad55);color:#0f172a;text-decoration:none;padding:16px 44px;border-radius:10px;font-size:15px;font-weight:800;letter-spacing:1px;box-shadow:0 4px 24px rgba(246,173,85,0.4);">ACCESS YOUR MEMBER PORTAL &rarr;</a>
        <p style="color:#334155;font-size:11px;margin-top:10px;">Enter your email on the portal to receive your secure login link.</p>
      </div>

      <div style="background:rgba(246,173,85,0.06);border:1px solid rgba(246,173,85,0.15);border-radius:12px;padding:16px 20px;margin-bottom:28px;text-align:center;">
        <div style="color:#f6ad55;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">&#127775; Lifetime Benefit</div>
        <div style="color:#e2e8f0;font-size:14px;line-height:1.7;">Your first <strong style="color:#f6ad55;">3 months of Trading Room access are included free</strong> with your lifetime membership. After 3 months, you can continue at the standard monthly rate — no obligation.</div>
      </div>

      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent);margin:0 0 28px;"></div>

      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#475569;font-weight:700;margin-bottom:18px;">How to Get Set Up</div>

      <div style="border:1px solid rgba(255,255,255,0.07);border-radius:12px;overflow:hidden;margin-bottom:28px;">

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(246,173,85,0.15);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#f6ad55;margin-top:1px;">1</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Log into Your Member Portal</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;">Visit your member portal, enter your email, and click the secure link we send you. From there you have lifetime access to the full course library and your account dashboard.</div>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(246,173,85,0.15);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#f6ad55;margin-top:1px;">2</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Set Up NinjaTrader &amp; Activate Your Indicators</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;margin-bottom:12px;">No NinjaTrader yet? Download it for free using our link below. Once installed, your lifetime indicator license activates automatically — just enter the email address you used at checkout.</div>
              <a href="https://ninjatraderus.pxf.io/Pz0bWN" style="display:inline-block;background:rgba(246,173,85,0.1);border:1px solid rgba(246,173,85,0.3);color:#f6ad55;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:12px;font-weight:700;letter-spacing:1px;">DOWNLOAD NINJATRADER FREE &rarr;</a>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(246,173,85,0.15);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#f6ad55;margin-top:1px;">3</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Join the HVT Discord &amp; Activate Your Free Trading Room Access</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;margin-bottom:12px;">Join the server from the button at the top of our website, then head to your member portal to activate your Trading Room role. You'll need your Discord username — it's found by clicking your profile picture at the bottom left of Discord.</div>
              <a href="https://discord.gg/2xG96nV4Hn" style="display:inline-block;background:rgba(246,173,85,0.1);border:1px solid rgba(246,173,85,0.3);color:#f6ad55;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:12px;font-weight:700;letter-spacing:1px;">JOIN DISCORD &rarr;</a>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(246,173,85,0.15);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#f6ad55;margin-top:1px;">4</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Start the Course</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;">Your portal has the complete course library waiting for you. Start from Module 1 — even experienced traders find the foundation material changes how they see the market.</div>
            </div>
          </div>
        </div>

      </div>

      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px 20px;text-align:center;">
        <p style="color:#475569;font-size:13px;margin:0 0 4px;">Questions? We're here.</p>
        <p style="color:#94a3b8;font-size:15px;font-weight:700;margin:0;">&#128222;&nbsp; 786-461-4235</p>
      </div>`);

    const html = monthly ? monthlyHtml : lifetimeHtml;
    await sendEmail(email, subject, html);
    console.log(`[Email] ${type} welcome → ${email}`);
}

// ─── DISCORD WELCOME ──────────────────────────────────────────────────────────
async function sendDiscordWelcome(email, fullName) {
    const name = fullName?.split(' ')[0] || 'Trader';
    const activateLink = `${APP_URL}/trading-room`;
    const html = wrap(`
      <div style="text-align:center;margin-bottom:8px;">
        <div style="display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.2);border-radius:20px;padding:6px 18px;margin-bottom:20px;">
          <span style="color:#2254F5;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Discord Trading Room Access</span>
        </div>
        <h2 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 8px;letter-spacing:1px;">You're In, ${name}!</h2>
        <p style="color:#94a3b8;font-size:14px;margin:0;">Your $37/month Trading Room membership is now active.</p>
      </div>
      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.1),transparent);margin:28px 0;"></div>
      <div style="background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.15);border-radius:10px;padding:14px 18px;margin-bottom:28px;">
        <p style="color:#f87171;font-size:13px;line-height:1.6;margin:0;">&#9888;&#65039; <strong>Access Note:</strong> Trading Room access is tied to your active $37/month subscription. Access will be removed if payment stops.</p>
      </div>
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#64748b;margin-bottom:14px;font-weight:700;">ACTIVATE IN 2 EASY STEPS</div>
      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;margin-bottom:28px;">
        <div style="padding:22px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="display:flex;align-items:flex-start;gap:16px;">
            <div style="width:36px;height:36px;border-radius:50%;background:#2254F5;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;flex-shrink:0;margin-top:2px;">1</div>
            <div style="flex:1;">
              <div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:6px;">Join the HVT Discord Server</div>
              <div style="color:#94a3b8;font-size:13px;line-height:1.6;margin-bottom:16px;">Click the button below to visit our website and join the Discord server. <strong style="color:#fff;">You must join the server first</strong> before you can get your Trading Room role.</div>
              <a href="https://discord.gg/2xG96nV4Hn" style="display:inline-block;background:#2254F5;color:#fff;text-decoration:none;padding:13px 28px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">JOIN DISCORD SERVER &rarr;</a>
            </div>
          </div>
        </div>
        <div style="padding:22px 24px;">
          <div style="display:flex;align-items:flex-start;gap:16px;">
            <div style="width:36px;height:36px;border-radius:50%;background:#2254F5;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;flex-shrink:0;margin-top:2px;">2</div>
            <div style="flex:1;">
              <div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:6px;">Activate Your Trading Room Role</div>
              <div style="color:#94a3b8;font-size:13px;line-height:1.6;margin-bottom:16px;">Once you have joined the server, click the button below. You will enter <strong style="color:#fff;">this email address</strong> and your <strong style="color:#fff;">Discord username</strong> &mdash; your Trading Room role will be assigned instantly.</div>
              <a href="${activateLink}" style="display:inline-block;background:#2254F5;color:#fff;text-decoration:none;padding:13px 28px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">GET STARTED &rarr;</a>
            </div>
          </div>
        </div>
      </div>
      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px 18px;margin-bottom:20px;">
        <p style="color:#475569;font-size:12px;line-height:1.6;margin:0;">&#128161; <strong style="color:#94a3b8;">Finding your Discord username:</strong> Open Discord &rarr; click your profile photo at the bottom left &rarr; your username is shown below your display name (lowercase, may include numbers e.g. <em>johntrader22</em>).</p>
      </div>
      <div style="background:rgba(34,84,245,0.04);border:1px solid rgba(34,84,245,0.12);border-radius:10px;padding:16px 20px;text-align:center;">
        <p style="color:#475569;font-size:13px;margin:0 0 8px;">Need help? We will walk you through everything.</p>
        <p style="color:#94a3b8;font-size:15px;font-weight:700;margin:0;">&#128222; 786-461-4235</p>
      </div>`);
    await sendEmail(email, 'Your HVT Trading Room Access Is Ready — 2 Steps to Activate', html);
    console.log(`[Email] Discord welcome → ${email}`);
}

// ─── COURSE / LOGIN LINK ──────────────────────────────────────────────────────
async function sendCourseEmail(email, token) {
    const url  = `${APP_URL}/course/confirm?token=${token}`;
    const html = wrap(`
      <div style="text-align:center;margin-bottom:8px;">
        <div style="display:inline-block;background:rgba(34,84,245,0.08);border:1px solid rgba(34,84,245,0.2);border-radius:20px;padding:6px 18px;margin-bottom:20px;">
          <span style="color:#2254F5;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Member Access</span>
        </div>
        <h2 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 8px;">Your Access Link is Ready</h2>
        <p style="color:#94a3b8;font-size:14px;margin:0;">Expires in <strong style="color:#fff;">24 hours</strong>. Do not share this link.</p>
      </div>
      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.1),transparent);margin:28px 0;"></div>
      <div style="text-align:center;margin-bottom:28px;">
        <a href="${url}" style="display:inline-block;background:#2254F5;color:#fff;text-decoration:none;padding:16px 48px;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;box-shadow:0 4px 24px rgba(34,84,245,0.35);">ACCESS MEMBER PORTAL</a>
      </div>
      <p style="text-align:center;color:#334155;font-size:12px;margin-bottom:24px;">Secure link &middot; Expires in 24 hours</p>
      <div style="background:rgba(34,84,245,0.04);border:1px solid rgba(34,84,245,0.12);border-radius:10px;padding:14px 18px;">
        <p style="color:#475569;font-size:13px;margin:0;">&#128274; If you did not request this, ignore this email.</p>
      </div>`);
    await sendEmail(email, 'Access Your HVT Member Portal', html);
}

// ─── CANCELLATION CONFIRMATION ────────────────────────────────────────────────
async function sendCancelConfirmEmail(email, expiresAt) {
    const expDate = new Date(expiresAt);
    const dateStr = expDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000;font-family:'DM Sans',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:40px 20px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#0d1117;border-radius:16px;border:1px solid rgba(255,255,255,0.08);overflow:hidden;max-width:560px;width:100%;">
      <tr><td style="height:4px;background:linear-gradient(90deg,#2254F5,#3b6ff5);"></td></tr>
      <tr><td style="padding:36px 40px 28px;">
        <p style="margin:0 0 24px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#2254F5;">HIGH VELOCITY TRADING</p>
        <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#fff;line-height:1.2;">Cancellation Confirmed</h1>
        <p style="margin:0 0 20px;font-size:15px;color:#94a3b8;line-height:1.7;">Your cancellation request has been processed. <strong style="color:#fff;">You will not be charged again.</strong></p>
        <div style="background:rgba(34,84,245,0.06);border:1px solid rgba(34,84,245,0.2);border-radius:12px;padding:20px 24px;margin:0 0 24px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#2254F5;">YOUR ACCESS CONTINUES UNTIL</p>
          <p style="margin:0;font-size:22px;font-weight:700;color:#fff;">${dateStr}</p>
          <p style="margin:8px 0 0;font-size:13px;color:#64748b;">All features — Discord, indicators, trading journal, and course — remain fully active until this date.</p>
        </div>
        <p style="margin:0 0 28px;font-size:14px;color:#64748b;line-height:1.7;">After ${dateStr}, your access will be automatically removed. If you change your mind before then, reply to this email or call us at <strong style="color:#94a3b8;">786-461-4235</strong> and we can reactivate your membership.</p>
        <p style="margin:0;font-size:13px;color:#334155;">— The HVT Team</p>
      </td></tr>
      <tr><td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
        <p style="margin:0;font-size:11px;color:#1e2d3d;">High Velocity Trading &nbsp;|&nbsp; <a href="https://highvelocitytrading.com" style="color:#1e2d3d;text-decoration:none;">highvelocitytrading.com</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
    await sendEmail(email, 'Your HVT Membership Has Been Cancelled — Access Continues Until ' + dateStr, html);
}

// ─── BILLING & CANCEL MAGIC LINKS ─────────────────────────────────────────────
async function sendMagicLink(email, token, type) {
    const url       = `${APP_URL}/${type}/confirm?token=${token}`;
    const isBilling = type === 'billing';
    const subject   = isBilling ? 'Access Your HVT Billing Portal' : 'Cancel Your HVT Membership';
    const title     = isBilling ? 'Billing Portal Access' : 'Membership Cancellation';
    const btnText   = isBilling ? 'VIEW MY BILLING' : 'CONFIRM CANCELLATION';
    const btnColor  = isBilling ? '#2254F5' : '#dc2626';
    const desc      = isBilling
        ? 'Click below to access your billing dashboard. Expires in <strong style="color:#fff;">1 hour</strong>.'
        : 'Click below to confirm cancellation of your HVT Membership. Expires in <strong style="color:#fff;">1 hour</strong>.';
    const html = wrap(`
      <div style="text-align:center;margin-bottom:24px;"><span style="font-size:20px;font-weight:700;color:#fff;">${title}</span></div>
      <p style="color:#94a3b8;font-size:14px;line-height:1.7;text-align:center;margin-bottom:32px;">${desc}</p>
      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.1),transparent);margin-bottom:32px;"></div>
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${url}" style="display:inline-block;background:${btnColor};color:#fff;text-decoration:none;padding:16px 48px;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:2px;">${btnText}</a>
      </div>
      <p style="text-align:center;color:#334155;font-size:12px;margin-bottom:20px;">Secure link &middot; Expires in 1 hour</p>
      <div style="background:rgba(34,84,245,0.04);border:1px solid rgba(34,84,245,0.12);border-radius:10px;padding:14px 18px;">
        <p style="color:#475569;font-size:13px;margin:0;">&#128274; If you did not request this, ignore this email.</p>
      </div>`);
    await sendEmail(email, subject, html);
}

// ─── ECHO WELCOME ─────────────────────────────────────────────────────────────
async function sendEchoWelcome(email, fullName, licenseKey) {
    const name    = fullName?.split(' ')[0] || 'Trader';
    const subject = `Your HVT Echo License is Ready — ${name}`;

    const html = wrap(`
      <div style="text-align:center;padding-bottom:8px;">
        <div style="display:inline-block;background:rgba(212,168,83,0.12);border:1px solid rgba(232,200,120,0.35);border-radius:20px;padding:5px 18px;margin-bottom:22px;">
          <span style="color:#e8c878;font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700;">HVT Echo — Active</span>
        </div>
        <h1 style="color:#ffffff;font-size:26px;font-weight:800;margin:0 0 10px;letter-spacing:-0.5px;">You're in, ${name}.</h1>
        <p style="color:#64748b;font-size:14px;margin:0;">Your HVT Echo copy trader is ready to install.</p>
      </div>

      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(212,168,83,0.45),transparent);margin:28px 0;"></div>

      <p style="color:#94a3b8;font-size:14px;line-height:1.9;margin:0 0 28px;">One execution. Five accounts hit. Your license key is below — keep it safe. You will need it to activate HVT Echo inside NinjaTrader 8. This key is locked to one machine.</p>

      <div style="background:#0d1117;border:1px solid rgba(212,168,83,0.4);border-radius:12px;padding:24px;margin-bottom:28px;text-align:center;">
        <div style="font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#64748b;margin-bottom:12px;">Your License Key</div>
        <div style="font-family:monospace;font-size:22px;font-weight:800;color:#e8c878;letter-spacing:3px;word-break:break-all;">${esc(licenseKey)}</div>
        <div style="font-size:11px;color:#334155;margin-top:10px;">One machine. One license. Do not share this key.</div>
      </div>

      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent);margin:0 0 28px;"></div>

      <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#475569;font-weight:700;margin-bottom:18px;">How to Activate</div>

      <div style="border:1px solid rgba(255,255,255,0.07);border-radius:12px;overflow:hidden;margin-bottom:28px;">

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(212,168,83,0.14);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#e8c878;margin-top:1px;">1</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Download HVT Echo</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;margin-bottom:12px;">Click the link below to download your HVT Echo copy trader:</div>
              <div style="text-align:left;"><a href="${APP_URL}/downloads/echo?email=${encodeURIComponent(email)}&license=${licenseKey}" style="background:#00D4AA;color:#000000;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:13px;display:inline-block;">Download HVT Echo</a></div>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(212,168,83,0.14);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#e8c878;margin-top:1px;">2</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Install in NinjaTrader 8</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;">In NinjaTrader go to <strong style="color:#e2e8f0;">Tools → Import → NinjaScript Add-On</strong> and import the HVT Echo package.</div>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(212,168,83,0.14);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#e8c878;margin-top:1px;">3</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Enter Your License Key</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;">When HVT Echo opens for the first time paste your license key above into the activation screen. Your machine will be registered automatically.</div>
            </div>
          </div>
        </div>

        <div style="padding:20px 22px;">
          <div style="display:flex;align-items:flex-start;gap:14px;">
            <div style="min-width:32px;height:32px;border-radius:8px;background:rgba(212,168,83,0.14);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#e8c878;margin-top:1px;">4</div>
            <div>
              <div style="color:#ffffff;font-size:14px;font-weight:700;margin-bottom:5px;">Connect Your Accounts and Trade</div>
              <div style="color:#64748b;font-size:13px;line-height:1.7;">Select your master account, add your follower prop firm accounts, hit Start. One execution hits all of them in under 100ms.</div>
            </div>
          </div>
        </div>

      </div>

      <div style="background:rgba(212,168,83,0.08);border:1px solid rgba(232,200,120,0.25);border-radius:10px;padding:14px 18px;margin-bottom:28px;">
        <p style="color:#fde9a9;font-size:12px;line-height:1.7;margin:0;"><strong>Important:</strong> Your license is locked to one computer. If you switch machines contact us and we will transfer it. Do not share your key — it will deactivate your own access.</p>
      </div>

      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px 20px;text-align:center;">
        <p style="color:#475569;font-size:13px;margin:0 0 4px;">Questions? We are here.</p>
        <p style="color:#94a3b8;font-size:15px;font-weight:700;margin:0;">&#128222;&nbsp; 786-461-4235</p>
      </div>

      <div style="text-align:center;margin-top:24px;">
        <p style="color:#1e293b;font-size:11px;letter-spacing:2px;text-transform:uppercase;">Trade With Structure. No Emotion.</p>
      </div>
    `);

    await sendEmail(email, subject, html);
    console.log(`[EchoEmail] Welcome → ${email} | key: ${licenseKey}`);
}

module.exports = {
    sendEmail, wrap,
    sendWelcome, sendDiscordWelcome, sendCourseEmail,
    sendCancelConfirmEmail, sendMagicLink, sendEchoWelcome
};
