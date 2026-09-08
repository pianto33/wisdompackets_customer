/**
 * Extract searchable billing clues from a support email (alt emails, last4,
 * amount + currency). Used before the not-found template and on follow-ups.
 */

const OUR_DOMAIN_RE =
  /@(?:voxpages\.com|wisdompackets\.com|gistlyapp\.com|stripe\.com|gmail\.google\.com)$/i;

const SUPPORT_LOCAL_PARTS = new Set([
  'info',
  'soporte',
  'support',
  'help',
  'noreply',
  'no-reply',
  'billing',
]);

/** Stripe zero-decimal currencies (amount is already in major units). */
const ZERO_DECIMAL = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
  'huf',
]);

const CURRENCY_ALIASES = {
  euro: 'eur',
  euros: 'eur',
  '€': 'eur',
  dollar: 'usd',
  dollars: 'usd',
  $: 'usd',
  '£': 'gbp',
  forint: 'huf',
  ft: 'huf',
  zloty: 'pln',
  zł: 'pln',
  zl: 'pln',
};

const LAST4_RE =
  /(?:\*{2,}|\bx{2,}|\bend(?:ing)?(?:\s+in)?|\blast\s*4|\búltimos?\s*(?:4|cuatro)|\butols[oó]\s*4|\bkártya|\bkartya|\btarjeta|\bcard|card\s*(?:ending|number)|számla|számára)[^\d\n]{0,40}(\d{4})\b/gi;

const AMOUNT_RE =
  /(?:^|[^\d])(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d{1,7})\s*(EUR|USD|GBP|HUF|PLN|CAD|MXN|CHF|CZK|RON|AUD|€|\$|£|Ft|ft|zł|zl)\b/gi;

const AMOUNT_CURRENCY_FIRST_RE =
  /(?:EUR|USD|GBP|HUF|PLN|CAD|MXN|CHF|CZK|RON|AUD|€|\$|£)\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d{1,7})\b/gi;

/**
 * @param {string} email
 */
export function isInternalSupportEmail(email) {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized || !normalized.includes('@')) return true;
  if (OUR_DOMAIN_RE.test(normalized)) return true;
  const local = normalized.split('@')[0];
  return SUPPORT_LOCAL_PARTS.has(local);
}

/**
 * @param {string} raw
 * @param {string} currencyToken
 */
function normalizeCurrency(currencyToken) {
  const token = String(currencyToken || '')
    .trim()
    .toLowerCase();
  if (CURRENCY_ALIASES[token]) return CURRENCY_ALIASES[token];
  if (token === '€') return 'eur';
  if (token === '$') return 'usd';
  if (token === '£') return 'gbp';
  return token.replace(/[^a-z]/g, '').slice(0, 3);
}

/**
 * Parse "19,90" / "19.90" / "6800" into a major-unit number.
 * @param {string} raw
 */
export function parseAmountMajor(raw) {
  const cleaned = String(raw || '').trim();
  if (!cleaned) return null;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    // 1.234,56 vs 1,234.56
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      return Number(cleaned.replace(/\./g, '').replace(',', '.'));
    }
    return Number(cleaned.replace(/,/g, ''));
  }
  if (cleaned.includes(',')) {
    const parts = cleaned.split(',');
    // 19,90 → decimal comma
    if (parts.length === 2 && parts[1].length <= 2) {
      return Number(`${parts[0].replace(/\./g, '')}.${parts[1]}`);
    }
    return Number(cleaned.replace(/,/g, ''));
  }
  return Number(cleaned);
}

/**
 * Candidate Stripe `amount` values for Search API (minor units, or major for zero-decimal).
 * HUF is zero-decimal in Stripe docs but some charges appear *100 — try both.
 * @param {number} major
 * @param {string} currency
 * @returns {number[]}
 */
export function stripeAmountCandidates(major, currency) {
  if (!Number.isFinite(major) || major <= 0) return [];
  const cur = String(currency || '').toLowerCase();
  if (ZERO_DECIMAL.has(cur)) {
    const asMajor = Math.round(major);
    const asCents = Math.round(major * 100);
    return [...new Set([asMajor, asCents])];
  }
  return [Math.round(major * 100)];
}

/**
 * @param {string} [subject]
 * @param {string} [body]
 */
export function extractSupportClues(subject = '', body = '') {
  const text = `${subject || ''}\n${body || ''}`;

  const emails = [
    ...new Set(
      (text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map((e) => e.toLowerCase())
    ),
  ].filter((e) => !isInternalSupportEmail(e));

  const last4s = [];
  for (const match of text.matchAll(LAST4_RE)) {
    const digits = match[1];
    if (digits && !['0000', '9999'].includes(digits)) {
      last4s.push(digits);
    }
  }

  /** @type {{ major: number, currency: string, raw: string }[]} */
  const amounts = [];
  for (const match of text.matchAll(AMOUNT_RE)) {
    const major = parseAmountMajor(match[1]);
    const currency = normalizeCurrency(match[2]);
    if (major != null && Number.isFinite(major) && currency.length === 3) {
      amounts.push({ major, currency, raw: match[0].trim() });
    }
  }
  for (const match of text.matchAll(AMOUNT_CURRENCY_FIRST_RE)) {
    const major = parseAmountMajor(match[1]);
    const currency = normalizeCurrency(match[0].replace(match[1], '').trim());
    if (major != null && Number.isFinite(major) && currency.length === 3) {
      amounts.push({ major, currency, raw: match[0].trim() });
    }
  }

  // Dedupe amounts by currency+major
  const seenAmt = new Set();
  const uniqueAmounts = [];
  for (const amt of amounts) {
    const key = `${amt.currency}:${amt.major}`;
    if (seenAmt.has(key)) continue;
    seenAmt.add(key);
    uniqueAmounts.push(amt);
  }

  return {
    emails,
    last4s: [...new Set(last4s)],
    amounts: uniqueAmounts,
  };
}

/**
 * @param {{ emails?: string[], last4s?: string[], amounts?: unknown[] }} clues
 */
export function cluesHaveSearchableSignal(clues) {
  if (!clues) return false;
  return (
    (clues.emails && clues.emails.length > 0) ||
    (clues.last4s && clues.last4s.length > 0) ||
    (clues.amounts && clues.amounts.length > 0)
  );
}
