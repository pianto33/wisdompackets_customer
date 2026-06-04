import { getMinCancelConfidence } from './action-guard.js';

/**
 * Escenarios explícitos para Better Stack / Vercel Logs.
 */
export function resolveClassificationScenario(classification, queueStatus) {
  if (classification === 'Otros') return 'otros_sin_accion_automatica';

  if (classification === 'Desuscripción + Refund') {
    return queueStatus === 'PENDING_ACTION'
      ? 'refund_aprobado_para_auto_cancel'
      : 'refund_bloqueado_revision_humana';
  }

  if (classification === 'Desuscripción') {
    return queueStatus === 'PENDING_ACTION'
      ? 'baja_aprobada_para_auto_cancel'
      : 'baja_bloqueada_revision_humana';
  }

  return 'clasificacion_desconocida';
}

/**
 * Log estructurado: confianza Gemini vs umbral configurado.
 */
export function logClassificationDecision({
  fromEmail,
  subject,
  classification,
  confidence,
  reasoning,
  actionGuard,
  queueStatus,
  stripeTag,
}) {
  const minConfidenceThreshold = getMinCancelConfidence();
  const confidencePercent = Number((confidence * 100).toFixed(1));
  const thresholdPercent = Number((minConfidenceThreshold * 100).toFixed(0));
  const confidenceMeetsThreshold = confidence >= minConfidenceThreshold;
  const scenario = resolveClassificationScenario(classification, queueStatus);

  const payload = {
    scenario,
    fromEmail,
    subject: subject?.slice(0, 120) || '',
    classification,
    confidence,
    confidencePercent,
    minConfidenceThreshold,
    thresholdPercent,
    confidenceMeetsThreshold,
    queueStatus,
    stripeTag,
    actionGuardAllowed: actionGuard?.stripeCancelAllowed ?? false,
    actionGuardBlockers: actionGuard?.blockers ?? [],
    actionGuardReasons: actionGuard?.reasons ?? [],
    classificationReasoning: reasoning || '',
  };

  console.log(`[classification-decision] ${scenario}`, JSON.stringify(payload));
  return payload;
}
