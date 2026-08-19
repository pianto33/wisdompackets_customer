/** Subscription statuses the bot may cancel via Stripe. */
export const CANCELABLE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'];

/**
 * @param {{ status: string, id: string }[]} subscriptions
 * @returns {{ status: string, id: string } | undefined}
 */
export function findCancelableSubscription(subscriptions) {
  return subscriptions.find((s) => CANCELABLE_SUBSCRIPTION_STATUSES.includes(s.status));
}

const ALREADY_CANCELED_STATUSES = new Set(['canceled', 'incomplete_expired']);

function isMissingSubscriptionError(err) {
  return err?.code === 'resource_missing' || /no such subscription/i.test(String(err?.message || ''));
}

/**
 * Cancel if the sub is still cancelable; reuse it if already canceled.
 * Re-lists by customer when Stripe says the stored id does not exist.
 *
 * @param {import('stripe').default} stripe
 * @param {{ customerId?: string | null, subscriptionId?: string | null }} ids
 * @returns {Promise<{ subscription: object | null, alreadyCanceled: boolean }>}
 */
export async function cancelOrReuseSubscription(stripe, { customerId, subscriptionId }) {
  if (subscriptionId) {
    try {
      const existing = await stripe.subscriptions.retrieve(subscriptionId);
      if (CANCELABLE_SUBSCRIPTION_STATUSES.includes(existing.status)) {
        return { subscription: await stripe.subscriptions.cancel(existing.id), alreadyCanceled: false };
      }
      if (ALREADY_CANCELED_STATUSES.has(existing.status)) {
        return { subscription: existing, alreadyCanceled: true };
      }
    } catch (err) {
      if (!isMissingSubscriptionError(err)) throw err;
    }
  }

  if (!customerId) return { subscription: null, alreadyCanceled: false };

  const listed = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  const active = findCancelableSubscription(listed.data);
  if (active) {
    return { subscription: await stripe.subscriptions.cancel(active.id), alreadyCanceled: false };
  }
  const latest = listed.data[0];
  if (latest && ALREADY_CANCELED_STATUSES.has(latest.status)) {
    return { subscription: latest, alreadyCanceled: true };
  }
  return { subscription: latest || null, alreadyCanceled: false };
}
