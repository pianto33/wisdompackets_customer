import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  authorizeCron,
  checkBusinessHours,
  respondUnauthorized,
} from '../../lib/customer-support/cron-auth.js';
import { runResponder } from '../../lib/customer-support/respond.js';

/**
 * Vercel Cron: process PENDING_ACTION queue (Stripe cancel + Resend + Gmail labels).
 * Schedule: 15 min past each hour (after classify cron).
 *
 * Required env: CRON_SECRET, STRIPE_SECRET_KEY, RESEND_API_KEY, BLOB_READ_WRITE_TOKEN
 * Optional: IMAP_* (Gmail label updates after respond)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorizeCron(req)) {
    return respondUnauthorized(res);
  }

  if (!checkBusinessHours(res)) {
    return;
  }

  try {
    const result = await runResponder();
    return res.status(200).json({ ok: true, ...result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[customer-support-respond]', message);
    return res.status(500).json({ ok: false, error: message });
  }
}
