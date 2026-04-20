// services/authnet.js
// Authorize.net API integration for Accept.js payment processing.
// Handles one-time charges (lifetime) and recurring subscriptions (monthly).

'use strict';

const { AUTHNET_API_LOGIN_ID, AUTHNET_TRANSACTION_KEY, AUTHNET_API_URL } = require('../config/constants');
const { fetchFn } = require('../helpers/utils');

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function splitName(fullName) {
    const parts = (fullName || '').trim().split(/\s+/);
    const first = parts[0] || 'Customer';
    const last  = parts.slice(1).join(' ') || '.';
    return { first, last };
}

function todayYMD() {
    return new Date().toISOString().slice(0, 10);
}

function authHeaders() {
    return {
        merchantAuthentication: {
            name:           AUTHNET_API_LOGIN_ID,
            transactionKey: AUTHNET_TRANSACTION_KEY,
        },
    };
}

async function callAuthnet(body) {
    const res = await fetchFn(AUTHNET_API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
    });
    const data = await res.json();
    // Authorize.net wraps errors in messages.resultCode === 'Error'
    const resultCode = data?.messages?.resultCode;
    if (resultCode === 'Error') {
        const msg = data?.messages?.message?.[0]?.text || 'Authorize.net error';
        throw new Error(msg);
    }
    return data;
}

// ─── ONE-TIME CHARGE (LIFETIME) ───────────────────────────────────────────────
// Returns { transactionId: string }
async function chargeCard({ opaqueDataDescriptor, opaqueDataValue, amount, email, fullName }) {
    const { first, last } = splitName(fullName);

    const data = await callAuthnet({
        createTransactionRequest: {
            ...authHeaders(),
            transactionRequest: {
                transactionType: 'authCaptureTransaction',
                amount:          String(amount),
                payment: {
                    opaqueData: {
                        dataDescriptor: opaqueDataDescriptor,
                        dataValue:      opaqueDataValue,
                    },
                },
                order: {
                    description: 'HVT Lifetime License',
                },
                customer: {
                    type:  'individual',
                    email,
                },
                billTo: {
                    firstName: first,
                    lastName:  last,
                    email,
                },
                transactionSettings: {
                    setting: [
                        { settingName: 'duplicateWindow', settingValue: '60' },
                    ],
                },
            },
        },
    });

    const responseCode = data?.transactionResponse?.responseCode;
    if (responseCode !== '1') {
        const errText = data?.transactionResponse?.errors?.[0]?.errorText
            || data?.transactionResponse?.messages?.[0]?.description
            || 'Card declined.';
        throw new Error(errText);
    }

    const transactionId = data?.transactionResponse?.transId;
    if (!transactionId) throw new Error('No transaction ID returned from Authorize.net.');

    return { transactionId };
}

// ─── RECURRING SUBSCRIPTION (MONTHLY) ────────────────────────────────────────
// Returns { subscriptionId: string }
async function createSubscription({ opaqueDataDescriptor, opaqueDataValue, amount, intervalMonths, email, fullName, planName }) {
    const { first, last } = splitName(fullName);

    const data = await callAuthnet({
        ARBCreateSubscriptionRequest: {
            ...authHeaders(),
            subscription: {
                name:            planName || 'HVT Monthly',
                paymentSchedule: {
                    interval: {
                        length: String(intervalMonths || 1),
                        unit:   'months',
                    },
                    startDate:        todayYMD(),
                    totalOccurrences: '9999',
                    trialOccurrences: '0',
                },
                amount:       String(amount),
                trialAmount:  '0.00',
                payment: {
                    opaqueData: {
                        dataDescriptor: opaqueDataDescriptor,
                        dataValue:      opaqueDataValue,
                    },
                },
                billTo: {
                    firstName: first,
                    lastName:  last,
                    email,
                },
                customer: {
                    email,
                },
            },
        },
    });

    const subscriptionId = data?.subscriptionId;
    if (!subscriptionId) throw new Error('No subscription ID returned from Authorize.net.');

    return { subscriptionId: String(subscriptionId) };
}

module.exports = { chargeCard, createSubscription };
