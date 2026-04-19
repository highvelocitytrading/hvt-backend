// index.js
// Express application entry point: server setup, middleware mounting, and route registration.

'use strict';

require('dotenv').config();

const path    = require('path');
const express = require('express');

const { securityHeaders, notFound, errorHandler } = require('./middleware/errorHandler');

const webhooksRouter              = require('./routes/webhooks');
const licensesRouter              = require('./routes/licenses');
const echoRouter                  = require('./routes/echo');
const { billingRouter, cancelRouter } = require('./routes/billing');
const portalRouter                = require('./routes/portal');
const adminRouter                 = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 8080;

app.set('trust proxy', 1);

// ─── GLOBAL MIDDLEWARE ────────────────────────────────────────────────────────
app.use(securityHeaders);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', etag: true, index: false }));

// ─── STATIC ASSET FALLBACKS ───────────────────────────────────────────────────
app.get('/favicon.png',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.png')));
app.get('/hvt-logo.cropped.png',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'hvt-logo.cropped.png')));

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use(webhooksRouter);
app.use(licensesRouter);
app.use(echoRouter);
app.use('/billing', billingRouter);
app.use('/cancel',  cancelRouter);
app.use(portalRouter);
app.use(adminRouter);

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[HVT] Server running on port ${PORT}`));
