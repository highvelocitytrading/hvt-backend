// index.js
// Express application entry point: server setup, middleware mounting, and route registration.

'use strict';

require('dotenv').config();

const path    = require('path');
const express = require('express');

const { securityHeaders, notFound, errorHandler } = require('./middleware/errorHandler');
const { corsForForms }                            = require('./middleware/cors');

const webhooksRouter              = require('./routes/webhooks');
const formsRouter                 = require('./routes/forms');
const paymentRouter               = require('./routes/payment');
const licensesRouter              = require('./routes/licenses');
const echoRouter                  = require('./routes/echo');
const { billingRouter, cancelRouter } = require('./routes/billing');
const portalRouter                = require('./routes/portal');
const adminRouter                 = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 8080;

app.set('trust proxy', 1);

const SITE = path.join(__dirname, 'hvt-website');

// ─── GLOBAL MIDDLEWARE ────────────────────────────────────────────────────────
app.use(securityHeaders);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', etag: true, index: false }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '7d', etag: true }));

// ─── MARKETING SITE (hvt-website) ────────────────────────────────────────────
// Serve all static assets (CSS, JS, images, fonts) from hvt-website/
app.use(express.static(SITE, { maxAge: '1h', etag: true, index: false }));

// Explicit HTML page routes — clean URLs without .html extension
app.get('/',                  (req, res) => res.sendFile(path.join(SITE, 'index.html')));
app.get('/checkout-discord',  (req, res) => res.sendFile(path.join(SITE, 'checkout-discord.html')));
app.get('/checkout-echo',     (req, res) => res.sendFile(path.join(SITE, 'checkout-echo.html')));
app.get('/terms',             (req, res) => res.sendFile(path.join(SITE, 'terms.html')));
app.get('/privacy',           (req, res) => res.sendFile(path.join(SITE, 'privacy.html')));
app.get('/contact',           (req, res) => res.sendFile(path.join(SITE, 'contact.html')));
app.get('/cancellation',      (req, res) => res.sendFile(path.join(SITE, 'cancellation.html')));
app.get('/risk-disclosure',   (req, res) => res.sendFile(path.join(SITE, 'risk-disclosure.html')));

// ─── STATIC ASSET FALLBACKS ───────────────────────────────────────────────────
app.get('/favicon.png',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.png')));
app.get('/hvt-logo.cropped.png',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'hvt-logo.cropped.png')));

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use('/api/submit',  corsForForms);
app.use('/api/payment', corsForForms);
app.use(webhooksRouter);
app.use(formsRouter);
app.use(paymentRouter);
app.use(licensesRouter);
app.use('/api/echo', echoRouter);
app.use('/billing', billingRouter);
app.use('/cancel',  cancelRouter);
app.use(portalRouter);
app.use(adminRouter);

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[HVT] Server running on port ${PORT}`));
