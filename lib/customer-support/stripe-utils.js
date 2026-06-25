/** Subscription statuses the bot may cancel via Stripe. */
export const CANCELABLE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'];

/**
 * @param {{ status: string, id: string }[]} subscriptions
 * @returns {{ status: string, id: string } | undefined}
 */
export function findCancelableSubscription(subscriptions) {
  return subscriptions.find((s) => CANCELABLE_SUBSCRIPTION_STATUSES.includes(s.status));
}
