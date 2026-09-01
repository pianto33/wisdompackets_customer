import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logRunToBetterStack } from './betterstack.js';
import { KNOWN_PRODUCT_CODES, PRODUCT_CODE, resolveItemProduct } from './product-scope.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Queue shared by the three products, one file per product.
 *
 * They used to share a single blob, and because all three classify crons fire
 * on the same minute against a read-merge-write cycle, the last writer silently
 * dropped whatever the other two had just enqueued. Customers were classified,
 * labelled `Pendiente-Respuesta` and then never answered, because the item was
 * gone by the time their own respond cron read the queue.
 *
 * Writing per product removes the shared window entirely: a cron only ever
 * writes its own file. The legacy path stays readable so items enqueued before
 * the split are still visible; nothing writes to it anymore.
 */
const BLOB_LEGACY_QUEUE_PATH = 'customer-support/queue.json';
const BLOB_RUNS_PATH = 'customer-support/runs.json';

function blobQueuePathFor(product) {
  return `customer-support/queue-${product}.json`;
}

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

function getLocalQueuePathFor(product) {
  return path.join(getLocalLogsDir(), `queue-${product}.json`);
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

function readLocalJson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

function writeLocalJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * The file an item belongs to. Falls back to this deploy's product so an item
 * with no resolvable owner still lands somewhere its own cron will read.
 */
function partitionFor(item) {
  const owner = resolveItemProduct(item);
  return owner && KNOWN_PRODUCT_CODES.includes(owner) ? owner : PRODUCT_CODE;
}

/**
 * @param {Array<{ product: string|null, items: unknown[] }>} sources legacy
 * source first, product partitions after.
 */
function mergeSources(sources) {
  /** @type {Map<string, { product: string|null, item: Record<string, unknown> }>} */
  const merged = new Map();

  for (const { product, items } of sources) {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item?.id) continue;
      const id = String(item.id);
      const incumbent = merged.get(id);
      if (!incumbent || partitionWins({ product, item }, incumbent)) {
        merged.set(id, { product, item });
      }
    }
  }

  return [...merged.values()].map((entry) => entry.item);
}

function partitionWins(candidate, incumbent) {
  // Anything written since the split supersedes the pre-split shared file.
  if (incumbent.product === null) return true;
  if (candidate.product === null) return false;

  // Duplicated across two partitions: the file named after the item's own
  // product is the authoritative copy.
  return candidate.product === partitionFor(candidate.item);
}

export async function getQueue() {
  assertWritableQueueStorage();

  if (useBlob()) {
    const sources = await Promise.all([
      readBlobJson(BLOB_LEGACY_QUEUE_PATH, []).then((items) => ({ product: null, items })),
      ...KNOWN_PRODUCT_CODES.map((code) =>
        readBlobJson(blobQueuePathFor(code), []).then((items) => ({ product: code, items }))
      ),
    ]);
    return mergeSources(sources);
  }

  return mergeSources([
    { product: null, items: readLocalJson(getLocalQueuePath()) },
    ...KNOWN_PRODUCT_CODES.map((code) => ({
      product: code,
      items: readLocalJson(getLocalQueuePathFor(code)),
    })),
  ]);
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

async function writePartition(product, group) {
  if (useBlob()) {
    const blobPath = blobQueuePathFor(product);
    const current = await readBlobJson(blobPath, []);
    await writeBlobJson(blobPath, mergeById(current, group));
    return;
  }

  const localPath = getLocalQueuePathFor(product);
  writeLocalJson(localPath, mergeById(readLocalJson(localPath), group));
}

/**
 * Writes only the given items, each into its own product's file, leaving every
 * other entry as the store has it.
 *
 * @param {Array<Record<string, unknown>>} items
 */
export async function upsertQueueItems(items = []) {
  assertWritableQueueStorage();

  const incoming = (Array.isArray(items) ? items : []).filter((item) => item?.id);
  if (incoming.length === 0) return;

  /** @type {Map<string, object[]>} */
  const byProduct = new Map();
  for (const item of incoming) {
    const product = partitionFor(item);
    if (!byProduct.has(product)) byProduct.set(product, []);
    byProduct.get(product).push(item);
  }

  for (const [product, group] of byProduct) {
    await writePartition(product, group);
  }
}

/**
 * Kept for the one-off backlog scripts. Identical to `upsertQueueItems`: a
 * whole-array write is what used to clobber the other products.
 */
export async function saveQueue(queue) {
  await upsertQueueItems(queue);
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
