/**
 * Safety net for items whose product tag is wrong or missing.
 *
 * When Stripe answers "No such customer" the item almost always belongs to
 * another product. We never act with a foreign Stripe account (the reply would
 * carry the wrong brand, From and labels); instead we find the real owner and
 * re-tag the item so that product's own cron picks it up.
 *
 * Besides From-email, we also try billing clues (alt emails, last4, amount)
 * across configured cross-product Stripe keys.
 */

import Stripe from 'stripe';
import {
  PRODUCT_CODE,
  KNOWN_PRODUCT_CODES,
  getOtherProductsWithStripeKey,
  getStripeKeyForProduct,
} from './product-scope.js';
import { extractSupportClues, cluesHaveSearchableSignal } from './stripe-clues.js';
import { lookupStripeCustomer } from './stripe-customer-lookup.js';

const MISSING_RESOURCE_PATTERN = /no such (customer|subscription)|resource_missing/i;

export function isMissingStripeResourceError(err) {
  if (!err) return false;
  return err.code === 'resource_missing' || MISSING_RESOURCE_PATTERN.test(String(err.message || ''));
}

async function hasCustomerWithEmail(key, email) {
  const stripe = new Stripe(key);
  const { data } = await stripe.customers.list({ email, limit: 1 });
  return data.length > 0 ? data[0].id : null;
}

/**
 * @param {string} email
 * @returns {Promise<{ checked: boolean, product: string|null, customerId?: string, matchMethod?: string }>}
 * `checked: false` means no other Stripe key is configured, so a null product
 * must NOT be read as "this customer exists nowhere".
 */
export async function findOwnerProductByEmail(email) {
  const candidates = getOtherProductsWithStripeKey();
  if (!email || candidates.length === 0) {
    return { checked: false, product: null };
  }

  for (const { product, key } of candidates) {
    try {
      const customerId = await hasCustomerWithEmail(key, email);
      if (customerId) {
        return { checked: true, product, customerId, matchMethod: 'from_email' };
      }
    } catch (err) {
      console.warn(`[cross-product] Stripe lookup on ${product} failed:`, err.message);
    }
  }

  return { checked: true, product: null };
}

/**
 * Find which product owns a customer using From + clues in the mail body.
 * Prefers other products when the local account already missed a From match
 * (caller typically invokes this after local Not-Found).
 *
 * @param {{ fromEmail: string, subject?: string, body?: string, includeLocal?: boolean }} input
 */
export async function findOwnerProductByClues({
  fromEmail,
  subject = '',
  body = '',
  includeLocal = false,
}) {
  const clues = extractSupportClues(subject, body);
  const emailsToTry = [
    String(fromEmail || '')
      .trim()
      .toLowerCase(),
    ...clues.emails,
  ].filter(Boolean);
  const uniqueEmails = [...new Set(emailsToTry)];

  const candidates = [
    ...(includeLocal
      ? [{ product: PRODUCT_CODE, key: getStripeKeyForProduct(PRODUCT_CODE) }]
      : []),
    ...getOtherProductsWithStripeKey(),
  ].filter((entry) => Boolean(entry.key));

  if (candidates.length === 0) {
    return { checked: false, product: null, clues };
  }

  for (const email of uniqueEmails) {
    for (const { product, key } of candidates) {
      if (!includeLocal && product === PRODUCT_CODE) continue;
      try {
        const customerId = await hasCustomerWithEmail(key, email);
        if (customerId) {
          return {
            checked: true,
            product,
            customerId,
            matchMethod: email === String(fromEmail || '').trim().toLowerCase() ? 'from_email' : 'alt_email',
            matchedEmail: email,
            clues,
          };
        }
      } catch (err) {
        console.warn(`[cross-product] email lookup on ${product} failed:`, err.message);
      }
    }
  }

  if (!cluesHaveSearchableSignal(clues)) {
    return { checked: true, product: null, clues };
  }

  for (const { product, key } of candidates) {
    try {
      const stripe = new Stripe(key);
      const hit = await lookupStripeCustomer(stripe, { fromEmail, subject, body });
      if (hit.stripeTag === 'Found' && hit.matchMethod && hit.matchMethod !== 'from_email') {
        return {
          checked: true,
          product,
          customerId: hit.customerId,
          subscriptionId: hit.subscriptionId,
          matchMethod: hit.matchMethod,
          matchedEmail: hit.matchedEmail,
          clues,
        };
      }
    } catch (err) {
      console.warn(`[cross-product] clue lookup on ${product} failed:`, err.message);
    }
  }

  return { checked: true, product: null, clues };
}

/**
 * Decides the product for an item that carries no product tag, preferring the
 * local account so this cron can keep serving its own backlog.
 * @param {string} email
 */
export async function resolveProductForUntaggedEmail(email) {
  const localKey = getStripeKeyForProduct(PRODUCT_CODE);
  if (localKey && email) {
    try {
      if (await hasCustomerWithEmail(localKey, email)) {
        return { checked: true, product: PRODUCT_CODE };
      }
    } catch (err) {
      console.warn(`[cross-product] Stripe lookup on ${PRODUCT_CODE} failed:`, err.message);
      return { checked: false, product: null };
    }
  }

  return findOwnerProductByEmail(email);
}

export { KNOWN_PRODUCT_CODES };
