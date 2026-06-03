import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isWithinNewMexicoBusinessHours } from './classify.js';

export function authorizeCron(req: VercelRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${cronSecret}`;
}

export function respondUnauthorized(res: VercelResponse) {
  return res.status(401).json({ ok: false, reason: 'unauthorized' });
}

export function respondOutsideBusinessHours(res: VercelResponse) {
  return res.status(200).json({
    ok: true,
    skipped: true,
    reason: 'outside_business_hours',
    timezone: 'America/Denver',
    window: '09:00-21:00',
  });
}

export function checkBusinessHours(res: VercelResponse): boolean {
  if (!isWithinNewMexicoBusinessHours()) {
    respondOutsideBusinessHours(res);
    return false;
  }
  return true;
}
