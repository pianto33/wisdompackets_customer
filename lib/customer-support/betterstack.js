/**
 * Better Stack (Logtail) — wisdompackets-customer
 * https://betterstack.com/docs/logs/ingesting-data/http/logs/
 */

const APP_NAME = 'wisdompackets-customer';

class BetterStackService {
  constructor() {
    this.sourceToken = process.env.BETTERSTACK_SOURCE_TOKEN;
    this.ingestingHost =
      process.env.BETTERSTACK_INGESTING_HOST || 'in.logs.betterstack.com';
    this.endpoint = `https://${this.ingestingHost}`;
  }

  isEnabled() {
    return Boolean(this.sourceToken);
  }

  /**
   * @param {'debug'|'info'|'warn'|'error'|'fatal'} level
   * @param {string} message
   * @param {Record<string, unknown>} [metadata]
   */
  async sendLog(level, message, metadata) {
    if (!this.sourceToken) return;

    try {
      const body = {
        dt: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'),
        level,
        message,
        app: APP_NAME,
        environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
        ...metadata,
      };

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.sourceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        process.stderr.write(
          `[BetterStack] Failed ${response.status}: ${text}\n`
        );
      }
    } catch (err) {
      process.stderr.write(`[BetterStack] Error: ${err?.message || err}\n`);
    }
  }

  info(message, metadata) {
    return this.sendLog('info', message, metadata);
  }

  warn(message, metadata) {
    return this.sendLog('warn', message, metadata);
  }

  error(message, metadata) {
    return this.sendLog('error', message, metadata);
  }
}

export const betterStack = new BetterStackService();

let consoleMirrorEnabled = false;

/** Mirror console.log/warn/error to Better Stack (call once at process entry). */
export function enableBetterStackConsoleMirror() {
  if (consoleMirrorEnabled || !betterStack.isEnabled()) return;
  consoleMirrorEnabled = true;

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const formatArgs = (args) =>
    args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ');

  console.log = (...args) => {
    originalLog(...args);
    betterStack.info(formatArgs(args));
  };

  console.warn = (...args) => {
    originalWarn(...args);
    betterStack.warn(formatArgs(args));
  };

  console.error = (...args) => {
    originalError(...args);
    betterStack.error(formatArgs(args));
  };
}

/**
 * Structured run summary (IMAP_SYNC / EMAIL_RESPONDER).
 * @param {Record<string, unknown>} entry
 */
export async function logRunToBetterStack(entry) {
  const type = String(entry.type || 'UNKNOWN');
  const status = String(entry.status || 'UNKNOWN');
  const level =
    status === 'FAILED' ? 'error' : status === 'PARTIAL_SUCCESS' ? 'warn' : 'info';

  await betterStack.sendLog(level, `customer_support.${type}.${status}`, {
    run: entry,
  });
}
