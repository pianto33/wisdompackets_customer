export function getQueueStorageMode():
  | 'vercel-blob'
  | 'missing-blob-on-vercel'
  | 'local-filesystem';

export function getQueue(): Promise<unknown[]>;
export function saveQueue(queue: unknown[]): Promise<void>;
export function logRun(details: Record<string, unknown>): Promise<void>;
