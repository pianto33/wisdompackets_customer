import { betterStack } from './betterstack.js';
import { isWithinNewMexicoBusinessHours } from './classify.js';

/**
 * Log on every cron hit so Vercel / Better Stack always show activity.
 * @param {'classify'|'respond'} job
 * @param {import('@vercel/node').VercelRequest} req
 */
export function logCronInvocation(job, req) {
  const denverHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: 'numeric',
      hour12: false,
    }).format(new Date())
  );

  const meta = {
    job,
    method: req.method,
    vercelEnv: process.env.VERCEL_ENV || 'unknown',
    region: process.env.VERCEL_REGION || 'unknown',
    denverHour,
    inBusinessHours: isWithinNewMexicoBusinessHours(),
    hasCronSecret: Boolean(process.env.CRON_SECRET),
    hasBlob: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    hasImap: Boolean(process.env.IMAP_USER && process.env.IMAP_PASSWORD),
    hasGemini: Boolean(process.env.GEMINI_API_KEY),
    hasStripe: Boolean(process.env.STRIPE_SECRET_KEY),
    hasResend: Boolean(process.env.RESEND_API_KEY),
    betterStack: betterStack.isEnabled(),
    userAgent: req.headers['user-agent'] || null,
  };

  const line = `[customer-support-cron] ${job} invoked`;
  console.log(line, meta);
  return meta;
}

/**
 * @param {'classify'|'respond'} job
 * @param {string} reason
 */
export function logCronSkipped(job, reason, extra = {}) {
  const line = `[customer-support-cron] ${job} skipped: ${reason}`;
  console.log(line, extra);
}
