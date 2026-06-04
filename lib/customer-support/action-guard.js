/**
 * Safety layer: Gemini classifies, but Stripe/Resend destructive actions
 * require deterministic checks (confidence + keywords + env flags).
 *
 * NOTE: This system never calls Stripe Refunds API — "Desuscripción + Refund"
 * only sends an email with receipt link. The risky action is subscription.cancel.
 */

const UNSUBSCRIBE_PATTERNS = [
  /\b(dar(se)?\s+de\s+baja)\b/i,
  /\b(cancel(ar|ación|e|en|aría)?)\b/i,
  /\b(unsubscribe|cancel\s+(my\s+)?subscription)\b/i,
  /\b(no\s+quiero).{0,40}(suscripci[oó]n|subscription|membres[ií]a|premium)\b/i,
  /\b(stop|detener).{0,30}(charg|cobra|bill|suscripci)/i,
  /\b(don'?t|do\s+not)\s+want.{0,30}(subscri|suscripci|charg|bill)/i,
  /\b(baja|desuscri)/i,
];

const REFUND_PATTERNS = [
  /\b(reembolso|devoluci[oó]n|devolver(?:me)?)\b/i,
  /\b(refund|money\s+back|chargeback)\b/i,
  /\b(return\s+my\s+(payment|money))\b/i,
];

export function isAutoCancelGloballyEnabled() {
  const v = process.env.STRIPE_AUTO_CANCEL_ENABLED;
  if (v === undefined || v === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

export function getMinCancelConfidence() {
  const n = Number(process.env.AUTO_CANCEL_MIN_CONFIDENCE ?? '0.92');
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.92;
}

function normalizeText(subject = '', body = '') {
  return `${subject}\n${body}`.toLowerCase();
}

export function hasUnsubscribeIntent(subject, body) {
  const text = normalizeText(subject, body);
  return UNSUBSCRIBE_PATTERNS.some((re) => re.test(text));
}

export function hasRefundIntent(subject, body) {
  const text = normalizeText(subject, body);
  return REFUND_PATTERNS.some((re) => re.test(text));
}

/**
 * @param {{
 *   classification: string,
 *   confidence?: number,
 *   subject?: string,
 *   body?: string,
 * }} input
 */
export function evaluateAutomatedAction(input) {
  const { classification, confidence = 0, subject = '', body = '' } = input;
  const minConfidence = getMinCancelConfidence();
  const reasons = [];
  const blockers = [];

  if (!isAutoCancelGloballyEnabled()) {
    return {
      stripeCancelAllowed: false,
      automatedEmailAllowed: false,
      requiresHumanReview: true,
      reasons: ['STRIPE_AUTO_CANCEL_ENABLED está desactivado'],
      blockers: ['auto_cancel_disabled'],
    };
  }

  if (classification === 'Otros') {
    return {
      stripeCancelAllowed: false,
      automatedEmailAllowed: false,
      requiresHumanReview: true,
      reasons: ['Clasificación Otros — sin acciones automáticas'],
      blockers: ['classification_otros'],
    };
  }

  if (!['Desuscripción', 'Desuscripción + Refund'].includes(classification)) {
    return {
      stripeCancelAllowed: false,
      automatedEmailAllowed: false,
      requiresHumanReview: true,
      reasons: [`Clasificación no reconocida: ${classification}`],
      blockers: ['unknown_classification'],
    };
  }

  if (confidence < minConfidence) {
    blockers.push('low_confidence');
    reasons.push(
      `Confianza Gemini ${(confidence * 100).toFixed(0)}% < mínimo ${(minConfidence * 100).toFixed(0)}%`
    );
  }

  if (!hasUnsubscribeIntent(subject, body)) {
    blockers.push('no_unsubscribe_keywords');
    reasons.push('El texto no contiene frases claras de baja/cancelación');
  }

  if (classification === 'Desuscripción + Refund' && !hasRefundIntent(subject, body)) {
    blockers.push('no_refund_keywords');
    reasons.push('Clasificado como reembolso pero el mail no menciona refund/reembolso');
  }

  if (blockers.length > 0) {
    return {
      stripeCancelAllowed: false,
      automatedEmailAllowed: false,
      requiresHumanReview: true,
      reasons,
      blockers,
      minConfidenceThreshold: minConfidence,
      confidence,
    };
  }

  return {
    stripeCancelAllowed: true,
    automatedEmailAllowed: true,
    requiresHumanReview: false,
    reasons: ['Validación OK: confianza + palabras clave + flag de entorno'],
    blockers: [],
    minConfidenceThreshold: minConfidence,
    confidence,
  };
}

/**
 * Second check immediately before Stripe cancel (defense in depth).
 */
export function assertStripeCancelAllowed(queueItem) {
  const guard = evaluateAutomatedAction({
    classification: queueItem.classification,
    confidence: queueItem.confidence ?? 0,
    subject: queueItem.subject ?? '',
    body: queueItem.bodySnippet ?? '',
  });

  if (!guard.stripeCancelAllowed) {
    const msg = `Cancelación bloqueada: ${guard.reasons.join('; ')}`;
    const err = new Error(msg);
    err.code = 'ACTION_GUARD_BLOCKED';
    err.guard = guard;
    throw err;
  }

  return guard;
}
