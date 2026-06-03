import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isWithinNewMexicoBusinessHours } from './classify.js';

export function authorizeCron(req: VercelRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${cronSecret}`;
}

export function respondUnauthorized(res: VercelResponse) {
  console.warn('[customer-support-cron] unauthorized — revisá CRON_SECRET en Vercel');
  return res.status(401).json({ ok: false, reason: 'unauthorized' });
}

export function respondOutsideBusinessHours(res: VercelResponse) {
  const denverHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: 'numeric',
      hour12: false,
    }).format(new Date())
  );
  console.log('[customer-support-cron] outside business hours — no IMAP/respond', {
    timezone: 'America/Denver',
    window: '09:00-21:00',
    denverHour,
  });
  return res.status(200).json({
    ok: true,
    skipped: true,
    reason: 'outside_business_hours',
    timezone: 'America/Denver',
    window: '09:00-21:00',
    denverHour,
  });
}

export function checkBusinessHours(res: VercelResponse): boolean {
  if (!isWithinNewMexicoBusinessHours()) {
    respondOutsideBusinessHours(res);
    return false;
  }
  return true;
}
