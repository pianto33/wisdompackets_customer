/**
 * Product scoping for the queue shared by VoxPages (SV), WisdomPackets (WP)
 * and Gistly (GL).
 *
 * The three deploys read the same Vercel Blob queue and the same Gmail inbox,
 * but each one owns a different Stripe account, template set, outbound From
 * address and Gmail label prefix. An item must only ever be answered by the
 * cron of its own product, otherwise Stripe fails with "No such customer" and
 * the customer gets the wrong branding.
 */

export const PRODUCT_CODE = 'WP';

export const KNOWN_PRODUCT_CODES = ['SV', 'WP', 'GL'];

/**
 * The mailbox the customer wrote to is the strongest signal available: it is
 * what decides brand, template, From address and Stripe account. Everything
 * else here is a fallback for items that predate the stored address.
 */
const PRODUCT_BY_INBOUND_ADDRESS = new Map([
  ['info@voxpages.com', 'SV'],
  ['soporte@voxpages.com', 'SV'],
  ['support@voxpages.com', 'SV'],
  ['help@voxpages.com', 'SV'],
  ['info@wisdompackets.com', 'WP'],
  ['info@gistlyapp.com', 'GL'],
]);

/** GL goes first: legacy Gistly items also carry `WP/Clasificado`. */
const LABEL_PREFIX_PRIORITY = ['GL', 'WP', 'SV'];

const STRIPE_KEY_ENV_BY_PRODUCT = {
  SV: 'STRIPE_SECRET_KEY_SV',
  WP: 'STRIPE_SECRET_KEY_WP',
  GL: 'STRIPE_SECRET_KEY_GL',
};

export function isKnownProduct(code) {
  return KNOWN_PRODUCT_CODES.includes(String(code || '').toUpperCase());
}

/**
 * Product that owns a support address.
 * @param {string} email
 * @returns {'SV'|'WP'|'GL'|null}
 */
export function productForInboundAddress(email) {
  const normalized = String(email || '')
    .toLowerCase()
    .trim();
  if (!normalized) return null;

  const exact = PRODUCT_BY_INBOUND_ADDRESS.get(normalized);
  if (exact) return exact;

  // Forwarded/prefixed recipients such as "Soporte <info@voxpages.com>".
  for (const [address, code] of PRODUCT_BY_INBOUND_ADDRESS) {
    if (normalized.includes(address)) return code;
  }
  return null;
}

/**
 * First recognized support address among a message's recipients.
 * @param {string[]} addresses To / Cc / Delivered-To / X-Forwarded-To
 * @returns {'SV'|'WP'|'GL'|null}
 */
export function productForRecipients(addresses = []) {
  for (const address of addresses) {
    const code = productForInboundAddress(address);
    if (code) return code;
  }
  return null;
}

/**
 * Signals in order of trust: the mailbox written to, then the classifier's tag,
 * then Gmail labels.
 *
 * @param {Record<string, unknown>} item
 * @returns {'SV'|'WP'|'GL'|null} null when no signal is conclusive — either the
 * item carries no product hint, or its labels name two products. Callers must
 * then read the recipient off the message instead of guessing.
 */
export function resolveItemProduct(item) {
  // 1. Mailbox written to — the address decides which Stripe account applies.
  const fromInbox = productForInboundAddress(item?.supportInbox);
  if (fromInbox) return fromInbox;

  // 2. Tag written by the classifier, itself derived from the mailbox.
  const explicit = String(item?.product || '').toUpperCase();
  if (isKnownProduct(explicit)) return explicit;

  // 3. Gmail labels, for items enqueued before the tag existed. Only
  // `Clasificado` counts: it is applied by the owning product's classifier,
  // whereas a stray `Respondido-*` may come from another product's cron.
  const labels = (Array.isArray(item?.gmailLabels) ? item.gmailLabels : []).map(String);
  const classified = LABEL_PREFIX_PRIORITY.filter((code) => labels.includes(`${code}/Clasificado`));

  if (classified.length === 1) return classified[0];
  if (classified.length > 1) {
    // Gistly kept `WP/Clasificado` from before it had its own prefix, so that
    // pair is not a real conflict. Anything else means two classifiers ran on
    // the same message: stay silent and let the mailbox decide.
    return classified.includes('GL') && classified.length === 2 && classified.includes('WP')
      ? 'GL'
      : null;
  }

  return LABEL_PREFIX_PRIORITY.find((code) => labels.some((l) => l.startsWith(`${code}/`))) ?? null;
}

export function isItemForThisProduct(item) {
  return resolveItemProduct(item) === PRODUCT_CODE;
}

/**
 * @param {Array<Record<string, unknown>>} items
 * @returns {{ mine: object[], others: object[], unowned: object[] }} `unowned`
 * items still need a product decided before anyone may act on them.
 */
export function partitionByProduct(items = []) {
  const mine = [];
  const others = [];
  const unowned = [];

  for (const item of items) {
    const product = resolveItemProduct(item);
    if (product === PRODUCT_CODE) mine.push(item);
    else if (product) others.push(item);
    else unowned.push(item);
  }

  return { mine, others, unowned };
}

/**
 * `STRIPE_SECRET_KEY` always means the local product; the per-product vars are
 * only needed by deploys allowed to look across accounts.
 * @param {string} product
 */
export function getStripeKeyForProduct(product) {
  const code = String(product || '').toUpperCase();
  if (!isKnownProduct(code)) return null;
  if (code === PRODUCT_CODE) {
    return process.env[STRIPE_KEY_ENV_BY_PRODUCT[code]] || process.env.STRIPE_SECRET_KEY || null;
  }
  return process.env[STRIPE_KEY_ENV_BY_PRODUCT[code]] || null;
}

export function getOtherProductsWithStripeKey() {
  return KNOWN_PRODUCT_CODES.filter((code) => code !== PRODUCT_CODE)
    .map((code) => ({ product: code, key: getStripeKeyForProduct(code) }))
    .filter((entry) => Boolean(entry.key));
}
