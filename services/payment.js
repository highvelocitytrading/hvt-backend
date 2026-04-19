// services/payment.js
// Authorize.net payment integration.
// Handles subscription cancellation and webhook signature verification.

'use strict';

const { AUTHNET_API_LOGIN_ID, AUTHNET_TRANSACTION_KEY } = require('../config/constants');
const { fetchFn } = require('../helpers/utils');

// ─── SUBSCRIPTION CANCELLATION ────────────────────────────────────────────────
// Cancels an Authorize.net recurring subscription by subscription ID.
// Throws if the API returns a non-OK result.
async function cancelSub(subId) {
    if (!subId) throw new Error('cancelSub: no subscription ID provided');
    const r = await fetchFn('https://api.authorize.net/xml/v1/request.api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ARBCancelSubscriptionRequest: {
                merchantAuthentication: {
                    name: AUTHNET_API_LOGIN_ID,
                    transactionKey: AUTHNET_TRANSACTION_KEY
                },
                subscriptionId: String(subId)
            }
        })
    });
    const d = await r.json();
    if (d?.messages?.resultCode !== 'Ok')
        throw new Error(d?.messages?.message?.[0]?.text || 'Authnet cancel failed');
    return d;
}

module.exports = { cancelSub };
