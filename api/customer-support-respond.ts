import { enableBetterStackConsoleMirror } from '../lib/customer-support/betterstack.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  authorizeCron,
  checkBusinessHours,
  respondUnauthorized,
} from '../lib/customer-support/cron-auth.js';
import { logCronInvocation } from '../lib/customer-support/cron-runtime.js';
import { runResponder } from '../lib/customer-support/respond.js';

enableBetterStackConsoleMirror();

export const config = {
  maxDuration: 60,
};

/**
 * Vercel Cron: process PENDING_ACTION queue (Stripe + Resend + Gmail labels).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  logCronInvocation('respond', req);

  if (!authorizeCron(req)) {
    return respondUnauthorized(res);
  }

  if (!checkBusinessHours(res)) {
    return;
  }

  try {
    console.log('[customer-support-respond] starting queue processing...');
    const result = await runResponder();
    console.log('[customer-support-respond] finished', result);
    return res.status(200).json({ ok: true, ...result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[customer-support-respond] failed:', message);
    return res.status(500).json({ ok: false, error: message });
  }
}
