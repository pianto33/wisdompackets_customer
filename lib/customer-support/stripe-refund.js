/**
 * Política de reembolsos en Stripe (soporte manual o scripts).
 *
 * REGLAS:
 * 1. Siempre el ÚLTIMO pago (cargo succeeded más reciente por `created`).
 * 2. Un solo cargo por cliente, salvo allowMultipleRefunds + explicitChargeIds.
 * 3. Si el cargo tiene >30 días → revisión humana (no auto-refund).
 * 4. Si el mail pide un cargo que no es el último → revisión humana (no auto-refund).
 */

export const REFUND_POLICY_MAX_CHARGES_DEFAULT = 1;
export const REFUND_MAX_CHARGE_AGE_DAYS = 30;

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
 * @property {boolean} [operatorApprovedNonLatest] Operador confirmó cargo que no es el último
 * @property {boolean} [operatorApprovedStale] Operador confirmó cargo con >30 días
 */

/**
 * Elige qué cargos reembolsar y valida la política.
 *
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
 * Último pago reembolsable si cumple política; si no, null + motivo.
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
  const results = [];

  for (const charge of selected) {
    const refund = await stripe.refunds.create({
      charge: charge.id,
      reason: 'requested_by_customer',
    });
    results.push({ refund, charge });
  }

  return results;
}

/**
 * @param {import('stripe').Stripe} stripe
 * @param {string} customerId
 */
export async function listRefundableCharges(stripe, customerId) {
  const { data } = await stripe.charges.list({ customer: customerId, limit: 20 });
  return sortChargesNewestFirst(data).filter(isRefundableCharge);
}
