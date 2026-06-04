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

async function readBlobJson(blobPath, fallback = []) {
  const { get } = await import('@vercel/blob');
  try {
    const result = await get(blobPath, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!result || result.statusCode === 404) {
      return fallback;
    }
    const text = await new Response(result.stream).text();
    return text ? JSON.parse(text) : fallback;
  } catch (err) {
    if (String(err?.message || err).toLowerCase().includes('not found')) {
      return fallback;
    }
    throw err;
  }
}

async function writeBlobJson(blobPath, data) {
  const { put } = await import('@vercel/blob');
  await put(blobPath, JSON.stringify(data, null, 2), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    token: process.env.BLOB_READ_WRITE_TOKEN,
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

export async function saveQueue(queue) {
  assertWritableQueueStorage();

  if (useBlob()) {
    await writeBlobJson(BLOB_QUEUE_PATH, queue);
    return;
  }

  const queuePath = getLocalQueuePath();
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf-8');
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
