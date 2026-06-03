import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  authorizeCron,
  checkBusinessHours,
  respondUnauthorized,
} from '../../lib/customer-support/cron-auth.js';
import { runClassifier } from '../../lib/customer-support/classify.js';

/**
 * Vercel Cron: classify info@ emails (IMAP + Gemini + Stripe + Gmail labels).
 * Schedule: hourly. Runs only 09:00–20:59 America/Denver.
 *
 * Required: CRON_SECRET, GEMINI_API_KEY, IMAP_*, STRIPE_SECRET_KEY, BLOB_READ_WRITE_TOKEN
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorizeCron(req)) {
    return respondUnauthorized(res);
  }

  if (!checkBusinessHours(res)) {
    return;
  }

  try {
    const result = await runClassifier();
    return res.status(200).json({ ok: true, ...result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[customer-support-classify]', message);
    return res.status(500).json({ ok: false, error: message });
  }
}
