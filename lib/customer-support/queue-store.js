import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logRunToBetterStack } from './betterstack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BLOB_QUEUE_PATH = 'customer-support/queue.json';
const BLOB_RUNS_PATH = 'customer-support/runs.json';

function isVercelRuntime() {
  return Boolean(process.env.VERCEL);
}

function useBlob() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function blobOptions() {
  return {
    token: process.env.BLOB_READ_WRITE_TOKEN,
    storeId: process.env.BLOB_STORE_ID,
    access: 'private',
  };
}

export function getQueueStorageMode() {
  if (useBlob()) return 'vercel-blob';
  if (isVercelRuntime()) return 'missing-blob-on-vercel';
  return 'local-filesystem';
}

function assertWritableQueueStorage() {
  const mode = getQueueStorageMode();
  if (mode === 'missing-blob-on-vercel') {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not set on Vercel. The serverless filesystem is read-only; ' +
        'add a Vercel Blob token in Project Settings → Environment Variables and redeploy.'
    );
  }
}

function getLocalLogsDir() {
  if (process.env.CUSTOMER_SUPPORT_QUEUE_DIR) {
    return process.env.CUSTOMER_SUPPORT_QUEUE_DIR;
  }
  if (isVercelRuntime()) {
    return path.join('/tmp', 'customer-support-logs');
  }
  return path.join(__dirname, '../../activity_logs');
}

function getLocalQueuePath() {
  return path.join(getLocalLogsDir(), 'queue.json');
}

function getLocalRunsPath() {
  return path.join(getLocalLogsDir(), 'runs.json');
}

function isBlobNotFound(err) {
  return (
    err?.name === 'BlobNotFoundError' ||
    String(err?.message || err)
      .toLowerCase()
      .includes('not found')
  );
}

/**
 * Only a missing blob may resolve to the fallback. A blob that exists but comes
 * back without a body (304, empty stream) used to resolve to `[]`, and since
 * every writer merges against this read, one bad read wiped the other products'
 * items from the shared queue.
 */
async function readBlobJson(blobPath, fallback = []) {
  const { get } = await import('@vercel/blob');

  let result;
  try {
    result = await get(blobPath, blobOptions());
  } catch (err) {
    if (isBlobNotFound(err)) return fallback;
    throw err;
  }

  if (!result) return fallback;

  if (!result.stream) {
    throw new Error(
      `Blob ${blobPath} returned no body (statusCode ${result.statusCode ?? 'unknown'}); ` +
        'refusing to treat an existing blob as empty.'
    );
  }

  const text = await new Response(result.stream).text();
  return text ? JSON.parse(text) : fallback;
}

async function writeBlobJson(blobPath, data) {
  const { put } = await import('@vercel/blob');
  await put(blobPath, JSON.stringify(data, null, 2), {
    ...blobOptions(),
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

export async function getQueue() {
  assertWritableQueueStorage();

  if (useBlob()) {
    return readBlobJson(BLOB_QUEUE_PATH, []);
  }

  const queuePath = getLocalQueuePath();
  if (!fs.existsSync(queuePath)) {
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, '[]');
  }
  try {
    return JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
  } catch {
    return [];
  }
}

function mergeById(current, incoming) {
  const merged = new Map();
  for (const item of current) {
    if (item?.id) merged.set(String(item.id), item);
  }
  for (const item of incoming) {
    if (item?.id) merged.set(String(item.id), item);
  }
  return [...merged.values()];
}

function readLocalQueue() {
  const queuePath = getLocalQueuePath();
  if (!fs.existsSync(queuePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
  } catch {
    return [];
  }
}

function writeLocalQueue(queue) {
  const queuePath = getLocalQueuePath();
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf-8');
}

/**
 * Writes only the given items, leaving every other entry as the store has it.
 *
 * Prefer this over `saveQueue` inside crons: the three products share one blob,
 * so handing back a whole array snapshot reverts whatever the other two wrote
 * while this run was in flight.
 *
 * @param {Array<Record<string, unknown>>} items
 */
export async function upsertQueueItems(items = []) {
  assertWritableQueueStorage();

  const incoming = (Array.isArray(items) ? items : []).filter((item) => item?.id);
  if (incoming.length === 0) return;

  if (useBlob()) {
    const current = await readBlobJson(BLOB_QUEUE_PATH, []);
    await writeBlobJson(BLOB_QUEUE_PATH, mergeById(current, incoming));
    return;
  }

  writeLocalQueue(mergeById(readLocalQueue(), incoming));
}

export async function saveQueue(queue) {
  assertWritableQueueStorage();

  if (useBlob()) {
    const current = await readBlobJson(BLOB_QUEUE_PATH, []);
    await writeBlobJson(BLOB_QUEUE_PATH, mergeById(current, queue));
    return;
  }

  writeLocalQueue(queue);
}

export async function logRun(runDetails) {
  const entry = {
    timestamp: new Date().toISOString(),
    ...runDetails,
  };

  if (useBlob()) {
    const runs = await readBlobJson(BLOB_RUNS_PATH, []);
    runs.push(entry);
    await writeBlobJson(BLOB_RUNS_PATH, runs);
  } else if (!isVercelRuntime()) {
    const runsPath = getLocalRunsPath();
    if (!fs.existsSync(runsPath)) {
      fs.mkdirSync(path.dirname(runsPath), { recursive: true });
      fs.writeFileSync(runsPath, '[]');
    }
    try {
      const runs = JSON.parse(fs.readFileSync(runsPath, 'utf-8'));
      runs.push(entry);
      fs.writeFileSync(runsPath, JSON.stringify(runs, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save run log:', err.message);
    }
  } else {
    console.warn('[logRun] skipped local runs.json on Vercel (no BLOB_READ_WRITE_TOKEN)');
  }

  await logRunToBetterStack(entry);
}
