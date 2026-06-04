import { enableBetterStackConsoleMirror } from '../lib/customer-support/betterstack.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isWithinNewMexicoBusinessHours } from '../lib/customer-support/classify.js';
import { betterStack } from '../lib/customer-support/betterstack.js';
import { getQueueStorageMode } from '../lib/customer-support/queue-store.js';

enableBetterStackConsoleMirror();

/**
 * Health check — útil para ver logs en Vercel/Better Stack sin esperar al cron.
 * GET https://wisdompackets-customer.vercel.app/api/health
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const denverHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: 'numeric',
      hour12: false,
    }).format(new Date())
  );

  const queueStorage = getQueueStorageMode();
  const configOk = queueStorage === 'vercel-blob' || queueStorage === 'local-filesystem';

  const status = {
    ok: configOk,
    app: 'wisdompackets-customer',
    timestamp: new Date().toISOString(),
    vercelEnv: process.env.VERCEL_ENV || null,
    denverHour,
    inBusinessHours: isWithinNewMexicoBusinessHours(),
    queueStorage,
    config: {
      betterStack: betterStack.isEnabled(),
      blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
      imap: Boolean(process.env.IMAP_USER && process.env.IMAP_PASSWORD),
      gemini: Boolean(process.env.GEMINI_API_KEY),
      stripe: Boolean(process.env.STRIPE_SECRET_KEY),
      resend: Boolean(process.env.RESEND_API_KEY),
      cronSecret: Boolean(process.env.CRON_SECRET),
    },
  };

  console.log('[customer-support] health', status);
  return res.status(configOk ? 200 : 503).json(status);
}
