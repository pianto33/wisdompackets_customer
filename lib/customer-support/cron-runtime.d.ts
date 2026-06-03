import type { VercelRequest } from '@vercel/node';

export function logCronInvocation(
  job: 'classify' | 'respond',
  req: VercelRequest
): Record<string, unknown>;

export function logCronSkipped(
  job: 'classify' | 'respond',
  reason: string,
  extra?: Record<string, unknown>
): void;
