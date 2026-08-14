/**
 * Política de reembolsos en Stripe (soporte manual, scripts y bot auto).
 *
 * REGLAS DE CARGO:
 * 1. Siempre el ÚLTIMO pago (cargo succeeded más reciente por `created`).
 * 2. Un solo cargo por cliente, salvo allowMultipleRefunds + explicitChargeIds.
 * 3. Si el cargo tiene >30 días → revisión humana (no auto-refund).
 * 4. Si el mail pide un cargo que no es el último → revisión humana (no auto-refund).
 *
 * AUTO-REFUND (cron respond, classification Desuscripción + Refund):
 * - Solo con STRIPE_AUTO_REFUND_ENABLED (default true).
 * - Metadata obligatoria: source=auto_support_bot.
 * - Doble tope 24h por cuenta Stripe: máx N bot (default 5) O máx M totales (default 12).
 */

export const REFUND_POLICY_MAX_CHARGES_DEFAULT = 1;
export const REFUND_MAX_CHARGE_AGE_DAYS = 30;
export const AUTO_REFUND_METADATA_SOURCE = 'auto_support_bot';
export const AUTO_REFUND_MAX_BOT_PER_24H_DEFAULT = 5;
export const AUTO_REFUND_MAX_TOTAL_PER_24H_DEFAULT = 12;

/**
 * @param {{ status: string, refunded?: boolean, amount_refunded?: number }} charge
 */
export function isRefundableCharge(charge) {
  return charge.status === 'succeeded' && !charge.refunded && (charge.amount_refunded ?? 0) === 0;
}

/**
 * @param {{ created: number }} charge
 * @param {number} [nowMs]
 */
export function getChargeAgeDays(charge, nowMs = Date.now()) {
  return (nowMs - charge.created * 1000) / (1000 * 60 * 60 * 24);
}

/**
 * @param {{ created: number }} charge
 * @param {number} [maxDays]
 */
export function isChargeWithinRefundWindow(charge, maxDays = REFUND_MAX_CHARGE_AGE_DAYS) {
  return getChargeAgeDays(charge) <= maxDays;
}

/**
 * Ordena por fecha descendente — el primero es siempre el último pago.
 * @param {Array<{ created: number }>} charges
 */
export function sortChargesNewestFirst(charges) {
  return [...charges].sort((a, b) => b.created - a.created);
}

/**
 * @param {Array<{ id: string, created: number }>} refundableSorted
 */
export function getLatestRefundableCharge(refundableSorted) {
  return refundableSorted[0] ?? null;
}

export function isAutoRefundEnabled() {
  const v = process.env.STRIPE_AUTO_REFUND_ENABLED;
  if (v === undefined || v === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

export function getAutoRefundMaxBotPer24h() {
  const n = Number(process.env.AUTO_REFUND_MAX_BOT_PER_24H ?? AUTO_REFUND_MAX_BOT_PER_24H_DEFAULT);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : AUTO_REFUND_MAX_BOT_PER_24H_DEFAULT;
}

export function getAutoRefundMaxTotalPer24h() {
  const n = Number(process.env.AUTO_REFUND_MAX_TOTAL_PER_24H ?? AUTO_REFUND_MAX_TOTAL_PER_24H_DEFAULT);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : AUTO_REFUND_MAX_TOTAL_PER_24H_DEFAULT;
}

/**
 * @param {{ botCount: number, totalCount: number }} counts
 * @param {{ maxBot?: number, maxTotal?: number }} [opts]
 */
export function isAutoRefundAtCap(counts, opts = {}) {
  const maxBot = opts.maxBot ?? getAutoRefundMaxBotPer24h();
  const maxTotal = opts.maxTotal ?? getAutoRefundMaxTotalPer24h();
  const botCount = counts.botCount ?? 0;
  const totalCount = counts.totalCount ?? 0;

  if (botCount >= maxBot) {
    return { atCap: true, capReason: 'bot', maxBot, maxTotal, botCount, totalCount };
  }
  if (totalCount >= maxTotal) {
    return { atCap: true, capReason: 'total', maxBot, maxTotal, botCount, totalCount };
  }
  return { atCap: false, capReason: null, maxBot, maxTotal, botCount, totalCount };
}

/**
 * Lista refunds recientes en Stripe y cuenta bot vs total en ventana 24h.
 * @param {import('stripe').Stripe} stripe
 */
export async function countRefundsLast24h(stripe) {
  const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  let botCount = 0;
  let totalCount = 0;
  let startingAfter;

  for (let page = 0; page < 20; page++) {
    const res = await stripe.refunds.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    if (!res.data.length) break;

    let leftWindow = false;
    for (const refund of res.data) {
      if (refund.created < since) {
        leftWindow = true;
        break;
      }
      totalCount += 1;
      if (refund.metadata?.source === AUTO_REFUND_METADATA_SOURCE) {
        botCount += 1;
      }
    }

    if (leftWindow || !res.has_more) break;
    startingAfter = res.data[res.data.length - 1].id;
  }

  return {
    botCount,
    totalCount,
    ...isAutoRefundAtCap({ botCount, totalCount }),
  };
}

/**
 * Evalúa si un cargo puede reembolsarse sin intervención del operador.
 *
 * @param {{ id: string, created: number }} charge
 * @param {{ id: string, created: number } | null} latestCharge
 * @param {{ operatorApprovedNonLatest?: boolean, operatorApprovedStale?: boolean }} [overrides]
 */
export function evaluateChargeRefundPolicy(charge, latestCharge, overrides = {}) {
  const { operatorApprovedNonLatest = false, operatorApprovedStale = false } = overrides;
  const blockers = [];

  const isLatest = latestCharge ? charge.id === latestCharge.id : true;
  if (!isLatest && !operatorApprovedNonLatest) {
    blockers.push('non_latest_charge');
  }

  const ageDays = getChargeAgeDays(charge);
  if (!isChargeWithinRefundWindow(charge) && !operatorApprovedStale) {
    blockers.push('charge_older_than_30_days');
  }

  return {
    allowed: blockers.length === 0,
    blockers,
    isLatest,
    ageDays: Math.floor(ageDays),
    requiresOperatorReview: blockers.length > 0,
  };
}

/**
 * @typedef {Object} RefundSelectOptions
 * @property {boolean} [allowMultipleRefunds]
 * @property {string[]} [explicitChargeIds]
 * @property {boolean} [operatorApprovedNonLatest]
 * @property {boolean} [operatorApprovedStale]
 * @property {boolean} [autoBot] Si true, marca metadata source=auto_support_bot
 * @property {string} [product] SV | WP | GL
 */

/**
 * @param {Array<{ id: string, created: number, status: string, refunded?: boolean, amount_refunded?: number }>} charges
 * @param {RefundSelectOptions} [options]
 */
export function selectChargesForRefund(charges, options = {}) {
  const {
    allowMultipleRefunds = false,
    explicitChargeIds = null,
    operatorApprovedNonLatest = false,
    operatorApprovedStale = false,
  } = options;

  const refundable = sortChargesNewestFirst(charges).filter(isRefundableCharge);
  const latest = getLatestRefundableCharge(refundable);

  let selected;

  if (explicitChargeIds?.length) {
    if (!allowMultipleRefunds && explicitChargeIds.length > 1) {
      throw new Error(
        'REFUND_POLICY: reembolsar más de un cargo requiere allowMultipleRefunds explícito del operador'
      );
    }
    selected = refundable.filter((ch) => explicitChargeIds.includes(ch.id));
    if (selected.length !== explicitChargeIds.length) {
      const missing = explicitChargeIds.filter((id) => !selected.some((ch) => ch.id === id));
      throw new Error(`REFUND_POLICY: cargos no reembolsables o inexistentes: ${missing.join(', ')}`);
    }
  } else {
    if (allowMultipleRefunds) {
      throw new Error('REFUND_POLICY: allowMultipleRefunds requiere explicitChargeIds');
    }
    selected = refundable.slice(0, REFUND_POLICY_MAX_CHARGES_DEFAULT);
  }

  const overrides = { operatorApprovedNonLatest, operatorApprovedStale };
  const evaluations = selected.map((ch) => ({
    charge: ch,
    ...evaluateChargeRefundPolicy(ch, latest, overrides),
  }));
  const blocked = evaluations.filter((e) => !e.allowed);

  if (blocked.length) {
    const reasons = blocked.flatMap(({ charge: ch, blockers }) =>
      blockers.map((code) => {
        if (code === 'non_latest_charge') {
          return `el cargo ${ch.id} no es el último pago — consultar al operador`;
        }
        if (code === 'charge_older_than_30_days') {
          return `el cargo ${ch.id} tiene más de ${REFUND_MAX_CHARGE_AGE_DAYS} días — consultar al operador`;
        }
        return code;
      })
    );
    throw new Error(`REFUND_POLICY: ${reasons.join('; ')}`);
  }

  return selected;
}

/**
 * @param {Array<{ id: string, created: number, status: string, refunded?: boolean, amount_refunded?: number }>} charges
 * @param {RefundSelectOptions} [options]
 */
export function assessAutoRefund(charges, options = {}) {
  const refundable = sortChargesNewestFirst(charges).filter(isRefundableCharge);
  const latest = getLatestRefundableCharge(refundable);
  if (!latest) {
    return { canAutoRefund: false, charge: null, reasons: ['no_refundable_charge'] };
  }

  const evaluation = evaluateChargeRefundPolicy(latest, latest, options);
  if (!evaluation.allowed) {
    return { canAutoRefund: false, charge: latest, reasons: evaluation.blockers, evaluation };
  }

  return { canAutoRefund: true, charge: latest, evaluation };
}

/**
 * @param {Array<{ id: string, created: number, status: string, refunded?: boolean, amount_refunded?: number }>} charges
 * @param {RefundSelectOptions} [options]
 */
export function selectLatestRefundableCharge(charges, options = {}) {
  const [charge] = selectChargesForRefund(charges, options);
  return charge ?? null;
}

/**
 * @param {import('stripe').Stripe} stripe
 * @param {Array<{ id: string, created: number, status: string, refunded?: boolean, amount_refunded?: number }>} charges
 * @param {RefundSelectOptions} [options]
 */
export async function createCustomerRefunds(stripe, charges, options = {}) {
  const selected = selectChargesForRefund(charges, options);
  const { autoBot = false, product = null } = options;
  const results = [];

  for (const charge of selected) {
    /** @type {import('stripe').Stripe.RefundCreateParams} */
    const params = {
      charge: charge.id,
      reason: 'requested_by_customer',
    };
    if (autoBot) {
      params.metadata = {
        source: AUTO_REFUND_METADATA_SOURCE,
        ...(product ? { product: String(product) } : {}),
      };
    }
    const refund = await stripe.refunds.create(params);
    results.push({ refund, charge });
  }

  return results;
}

/**
 * Intenta auto-refund del último pago (política + doble tope Stripe).
 * @param {import('stripe').Stripe} stripe
 * @param {{ customerId: string, product: string }} input
 */
export async function attemptBotAutoRefund(stripe, { customerId, product }) {
  if (!isAutoRefundEnabled()) {
    return { executed: false, reason: 'disabled' };
  }
  if (!customerId) {
    return { executed: false, reason: 'no_customer' };
  }

  const { data: allCharges } = await stripe.charges.list({ customer: customerId, limit: 20 });
  const assess = assessAutoRefund(allCharges);
  if (!assess.canAutoRefund) {
    return {
      executed: false,
      reason: 'policy',
      details: assess,
      charge: assess.charge,
    };
  }

  const counts = await countRefundsLast24h(stripe);
  if (counts.atCap) {
    return {
      executed: false,
      reason: 'cap',
      capReason: counts.capReason,
      counts,
      charge: assess.charge,
    };
  }

  const results = await createCustomerRefunds(stripe, allCharges, {
    autoBot: true,
    product,
  });

  return {
    executed: true,
    reason: 'ok',
    results,
    counts,
    charge: assess.charge,
    refund: results[0]?.refund ?? null,
  };
}

/**
 * @param {import('stripe').Stripe} stripe
 * @param {string} customerId
 */
export async function listRefundableCharges(stripe, customerId) {
  const { data } = await stripe.charges.list({ customer: customerId, limit: 20 });
  return sortChargesNewestFirst(data).filter(isRefundableCharge);
}
