import { enableBetterStackConsoleMirror } from '../lib/customer-support/betterstack.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

enableBetterStackConsoleMirror();
import {
  authorizeCron,
  checkBusinessHours,
  respondUnauthorized,
} from '../lib/customer-support/cron-auth.js';
import { runClassifier } from '../lib/customer-support/classify.js';

export const config = {
  maxDuration: 60,
};

/**
 * Vercel Cron: classify info@ emails (IMAP + Gemini + Stripe + Gmail labels).
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
