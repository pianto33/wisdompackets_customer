/**
 * Customers who write again after their case was already closed.
 *
 * Most of these are acknowledgements, or the same request repeated because the
 * confirmation mail crossed with their reply. Re-running the full flow answers
 * them a second time; leaving them open puts them back in the human queue for
 * nothing. Either way the operator ends up reading a case that is already done.
 */

import { hasRefundIntent, hasUnsubscribeIntent } from './action-guard.js';
import { PRODUCT_CODE, resolveItemProduct } from './product-scope.js';
import { extractOwnPart } from './quoted-text.js';
import { cluesHaveSearchableSignal, extractSupportClues } from './stripe-clues.js';

/**
 * @typedef {'process'|'close'|'human'} FollowUpDecision
 * @typedef {{
 *   isFollowUp: boolean,
 *   decision: FollowUpDecision,
 *   reason?: string,
 *   prior?: Record<string, unknown>[],
 * }} FollowUpVerdict
 */

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

/**
 * @param {{
 *   fromEmail: string,
 *   subject?: string,
 *   body?: string,
 *   queue?: Record<string, unknown>[],
 * }} input
 * @returns {FollowUpVerdict}
 */
export function detectResolvedFollowUp({ fromEmail, subject = '', body = '', queue = [] }) {
  const email = normalizeEmail(fromEmail);
  if (!email) return { isFollowUp: false, decision: 'process' };

  const prior = (Array.isArray(queue) ? queue : []).filter(
    (item) =>
      normalizeEmail(item?.fromEmail) === email &&
      resolveItemProduct(item) === PRODUCT_CODE &&
      String(item?.status || '').startsWith('PROCESSED_')
  );

  if (prior.length === 0) return { isFollowUp: false, decision: 'process' };

  // After not-found: never resend the template. If the reply carries searchable
  // clues (alt email, last4, amount), re-run lookup; otherwise escalate.
  if (prior.some((item) => item.status === 'PROCESSED_NOT_FOUND')) {
    const clues = extractSupportClues(subject, body);
    if (cluesHaveSearchableSignal(clues)) {
      return {
        isFollowUp: true,
        decision: 'process',
        reason: 'follow_up_after_not_found_with_clues',
        prior,
      };
    }
    return { isFollowUp: true, decision: 'human', reason: 'follow_up_after_not_found', prior };
  }

  const ownPart = extractOwnPart(subject, body);
  const wantsRefund = hasRefundIntent('', ownPart);
  const wantsUnsubscribe = hasUnsubscribeIntent('', ownPart);

  // Only a recorded refund counts. When in doubt we re-run the flow, where
  // Stripe is the one that decides there is nothing left to refund.
  const alreadyRefunded = prior.some((item) => Boolean(item.autoRefundId || item.refundId));
  const alreadyCanceled = prior.some(
    (item) =>
      item.stripeTag === 'Found' &&
      (item.status === 'PROCESSED_SUCCESS' || item.status === 'PROCESSED_MANUAL')
  );

  if (wantsRefund && !alreadyRefunded) {
    return { isFollowUp: true, decision: 'process', reason: 'refund_not_yet_issued', prior };
  }

  if (wantsUnsubscribe && !alreadyCanceled) {
    return { isFollowUp: true, decision: 'process', reason: 'cancel_not_yet_done', prior };
  }

  return {
    isFollowUp: true,
    decision: 'close',
    reason: wantsRefund || wantsUnsubscribe ? 'request_already_fulfilled' : 'no_new_request',
    prior,
  };
}
