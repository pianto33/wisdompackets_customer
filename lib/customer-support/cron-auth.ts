import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isWithinNewMexicoBusinessHours } from './classify.js';

/** Classify + respond: 10:00–23:59 UTC, todos los días (incluye sáb/dom). */
export const CRON_UTC_WINDOW = { startHour: 10, endHourInclusive: 23 };
/** @deprecated misma ventana que CRON_UTC_WINDOW */
export const RESPOND_UTC_WINDOW = CRON_UTC_WINDOW;

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

export function getUtcHour(now = new Date()): number {
  return now.getUTCHours();
}

export function isWithinCronUtcHours(now = new Date()): boolean {
  const hour = getUtcHour(now);
  return hour >= CRON_UTC_WINDOW.startHour && hour <= CRON_UTC_WINDOW.endHourInclusive;
}

/** @deprecated alias de isWithinCronUtcHours */
export function isWithinRespondUtcHours(now = new Date()): boolean {
  return isWithinCronUtcHours(now);
}

export function respondOutsideBusinessHours(res: VercelResponse) {
  const utcHour = getUtcHour();
  console.log('[customer-support-cron] outside cron UTC window — no IMAP/respond', {
    timezone: 'UTC',
    window: '10:00-23:59',
    utcHour,
  });
  return res.status(200).json({
    ok: true,
    skipped: true,
    reason: 'outside_business_hours',
    timezone: 'UTC',
    window: '10:00-23:59',
    utcHour,
  });
}

export function respondOutsideRespondUtcHours(res: VercelResponse) {
  return respondOutsideBusinessHours(res);
}

/** Classify y respond: 10:00–23:59 UTC todos los días. */
export function checkBusinessHours(res: VercelResponse): boolean {
  if (!isWithinNewMexicoBusinessHours()) {
    respondOutsideBusinessHours(res);
    return false;
  }
  return true;
}

export function checkRespondHours(res: VercelResponse): boolean {
  return checkBusinessHours(res);
}
