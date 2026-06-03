import { enableBetterStackConsoleMirror } from '../lib/customer-support/betterstack.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  authorizeCron,
  checkBusinessHours,
  respondUnauthorized,
} from '../lib/customer-support/cron-auth.js';
import { logCronInvocation } from '../lib/customer-support/cron-runtime.js';
import { runClassifier } from '../lib/customer-support/classify.js';

enableBetterStackConsoleMirror();

export const config = {
  maxDuration: 60,
};

/**
 * Vercel Cron: classify info@ emails (IMAP + Gemini + Stripe + Gmail labels).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  logCronInvocation('classify', req);

  if (!authorizeCron(req)) {
    return respondUnauthorized(res);
  }

  if (!checkBusinessHours(res)) {
    return;
  }

  try {
    console.log('[customer-support-classify] starting IMAP sync...');
    const result = await runClassifier();
    console.log('[customer-support-classify] finished', result);
    return res.status(200).json({ ok: true, ...result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[customer-support-classify] failed:', message);
    return res.status(500).json({ ok: false, error: message });
  }
}
