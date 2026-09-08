/**
 * Stripe customer lookup with billing clues (alt email, last4, amount).
 * Prefer a single unambiguous match; otherwise leave Not-Found.
 */

import { findCancelableSubscription } from './stripe-utils.js';
import {
  cluesHaveSearchableSignal,
  extractSupportClues,
  stripeAmountCandidates,
} from './stripe-clues.js';

/**
 * @param {import('stripe').Stripe} stripe
 * @param {string} customerId
 */
async function resolveCustomerMatch(stripe, customerId) {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 10,
  });

  const cancelable = findCancelableSubscription(subscriptions.data);
  if (cancelable) {
    return {
      stripeTag: 'Found',
      customerId,
      subscriptionId: cancelable.id,
    };
  }

  if (subscriptions.data.length > 0) {
    return {
      stripeTag: 'Found',
      customerId,
      subscriptionId: subscriptions.data[0].id,
    };
  }

  // Customer exists but nothing to cancel — treat as Not-Found so we ask
  // for more info instead of failing mid-cancel.
  return {
    stripeTag: 'Not-Found',
    customerId,
    subscriptionId: null,
  };
}

/**
 * @param {import('stripe').Stripe} stripe
 * @param {string} email
 */
async function findByEmail(stripe, email) {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;

  const { data } = await stripe.customers.list({ email: normalized, limit: 5 });
  if (!data.length) return null;
  return resolveCustomerMatch(stripe, data[0].id);
}

/**
 * @param {import('stripe').Stripe.Charge[]} charges
 */
function uniqueCustomerFromCharges(charges) {
  const ids = new Set();
  for (const ch of charges) {
    if (ch.customer) ids.add(String(ch.customer));
  }
  if (ids.size === 1) return [...ids][0];
  return null;
}

/**
 * @param {import('stripe').Stripe} stripe
 * @param {string} last4
 */
async function findByLast4(stripe, last4) {
  const digits = String(last4 || '').replace(/\D/g, '');
  if (!/^\d{4}$/.test(digits)) return null;

  try {
    const res = await stripe.charges.search({
      query: `payment_method_details.card.last4:'${digits}'`,
      limit: 25,
    });
    const customerId = uniqueCustomerFromCharges(res.data || []);
    if (!customerId) {
      if ((res.data || []).length > 0) {
        return { ambiguous: true, reason: 'last4_multiple_customers' };
      }
      return null;
    }
    return resolveCustomerMatch(stripe, customerId);
  } catch (err) {
    console.warn(`[stripe-lookup] last4 search failed (${digits}):`, err.message);
    return null;
  }
}

/**
 * @param {import('stripe').Stripe} stripe
 * @param {{ major: number, currency: string }} amount
 */
async function findByAmount(stripe, amount) {
  const currency = String(amount.currency || '').toLowerCase();
  const candidates = stripeAmountCandidates(amount.major, currency);
  /** @type {Map<string, number>} */
  const customerHits = new Map();

  for (const stripeAmount of candidates) {
    try {
      const res = await stripe.charges.search({
        query: `amount:${stripeAmount} AND currency:'${currency}'`,
        limit: 25,
      });
      for (const ch of res.data || []) {
        if (!ch.customer) continue;
        const id = String(ch.customer);
        customerHits.set(id, (customerHits.get(id) || 0) + 1);
      }
    } catch (err) {
      console.warn(
        `[stripe-lookup] amount search failed (${stripeAmount} ${currency}):`,
        err.message
      );
    }
  }

  if (customerHits.size === 1) {
    return resolveCustomerMatch(stripe, [...customerHits.keys()][0]);
  }
  if (customerHits.size > 1) {
    return { ambiguous: true, reason: 'amount_multiple_customers' };
  }
  return null;
}

/**
 * @param {import('stripe').Stripe} stripe
 * @param {{ fromEmail: string, subject?: string, body?: string }} input
 */
export async function lookupStripeCustomer(stripe, { fromEmail, subject = '', body = '' }) {
  const clues = extractSupportClues(subject, body);
  const empty = {
    stripeTag: 'Not-Found',
    customerId: null,
    subscriptionId: null,
    matchMethod: null,
    matchedEmail: null,
    clues,
  };

  if (!stripe) return empty;

  const from = String(fromEmail || '')
    .trim()
    .toLowerCase();

  try {
    const byFrom = await findByEmail(stripe, from);
    if (byFrom?.stripeTag === 'Found') {
      return {
        ...byFrom,
        matchMethod: 'from_email',
        matchedEmail: from,
        clues,
      };
    }

    for (const email of clues.emails) {
      if (email === from) continue;
      const hit = await findByEmail(stripe, email);
      if (hit?.stripeTag === 'Found') {
        console.log(`[stripe-lookup] matched via alt email ${email} (from ${from})`);
        return {
          ...hit,
          matchMethod: 'alt_email',
          matchedEmail: email,
          clues,
        };
      }
    }

    for (const last4 of clues.last4s) {
      const hit = await findByLast4(stripe, last4);
      if (hit?.ambiguous) {
        console.log(`[stripe-lookup] last4 ${last4} ambiguous — skipping`);
        continue;
      }
      if (hit?.stripeTag === 'Found') {
        console.log(`[stripe-lookup] matched via last4 ${last4} (from ${from})`);
        return {
          ...hit,
          matchMethod: 'last4',
          matchedEmail: null,
          clues,
        };
      }
    }

    for (const amount of clues.amounts) {
      const hit = await findByAmount(stripe, amount);
      if (hit?.ambiguous) {
        console.log(`[stripe-lookup] amount ${amount.raw || amount.major} ambiguous — skipping`);
        continue;
      }
      if (hit?.stripeTag === 'Found') {
        console.log(
          `[stripe-lookup] matched via amount ${amount.major} ${amount.currency} (from ${from})`
        );
        return {
          ...hit,
          matchMethod: 'amount',
          matchedEmail: null,
          clues,
        };
      }
    }
  } catch (err) {
    console.error('[stripe-lookup] failed:', err.message);
  }

  return empty;
}

export { cluesHaveSearchableSignal, extractSupportClues };
