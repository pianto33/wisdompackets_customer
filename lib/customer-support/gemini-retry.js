const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_STATUS = new Set(['UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'DEADLINE_EXCEEDED']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(err) {
  const code = err?.status ?? err?.code ?? err?.error?.code;
  const status = String(err?.status ?? err?.error?.status ?? '').toUpperCase();
  const message = String(err?.message ?? err?.error?.message ?? '').toLowerCase();
  const blob = JSON.stringify(err ?? {}).toLowerCase();

  if (code && RETRYABLE_CODES.has(Number(code))) return true;
  if (RETRYABLE_STATUS.has(status)) return true;
  if (message.includes('high demand') || message.includes('try again')) return true;
  if (blob.includes('unavailable') || blob.includes('"code":503')) return true;
  return false;
}

/**
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number, baseDelayMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withGeminiRetry(fn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableGeminiError(err) || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), 20000);
      console.warn(
        `[Gemini] attempt ${attempt}/${maxAttempts} failed (${err?.message || err}), retry in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}
