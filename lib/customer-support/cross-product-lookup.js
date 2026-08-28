/**
 * Safety net for items whose product tag is wrong or missing.
 *
 * When Stripe answers "No such customer" the item almost always belongs to
 * another product. We never act with a foreign Stripe account (the reply would
 * carry the wrong brand, From and labels); instead we find the real owner and
 * re-tag the item so that product's own cron picks it up.
 */

import Stripe from 'stripe';
import {
  PRODUCT_CODE,
  getOtherProductsWithStripeKey,
  getStripeKeyForProduct,
} from './product-scope.js';

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
 * @returns {Promise<{ checked: boolean, product: string|null, customerId?: string }>}
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
      if (customerId) return { checked: true, product, customerId };
    } catch (err) {
      console.warn(`[cross-product] Stripe lookup on ${product} failed:`, err.message);
    }
  }

  return { checked: true, product: null };
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
