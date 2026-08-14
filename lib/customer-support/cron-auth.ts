import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isWithinNewMexicoBusinessHours } from './classify.js';

/** Respond cron: 11:00–22:59 UTC (11am–11pm). */
export const RESPOND_UTC_WINDOW = { startHour: 11, endHourExclusive: 23 };

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

/** True during 11:00–22:59 UTC inclusive of the 22h slot (until 23:00). */
export function isWithinRespondUtcHours(now = new Date()): boolean {
  const hour = getUtcHour(now);
  return hour >= RESPOND_UTC_WINDOW.startHour && hour < RESPOND_UTC_WINDOW.endHourExclusive;
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

export function respondOutsideRespondUtcHours(res: VercelResponse) {
  const utcHour = getUtcHour();
  console.log('[customer-support-cron] outside respond UTC window — no respond', {
    timezone: 'UTC',
    window: '11:00-23:00',
    utcHour,
  });
  return res.status(200).json({
    ok: true,
    skipped: true,
    reason: 'outside_respond_utc_hours',
    timezone: 'UTC',
    window: '11:00-23:00',
    utcHour,
  });
}

/** Classify: 09:00–21:00 America/Denver. */
export function checkBusinessHours(res: VercelResponse): boolean {
  if (!isWithinNewMexicoBusinessHours()) {
    respondOutsideBusinessHours(res);
    return false;
  }
  return true;
}

/** Respond: 11:00–23:00 UTC. */
export function checkRespondHours(res: VercelResponse): boolean {
  if (!isWithinRespondUtcHours()) {
    respondOutsideRespondUtcHours(res);
    return false;
  }
  return true;
}
