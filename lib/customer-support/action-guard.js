/**
 * Safety layer: Gemini classifies, but Stripe destructive actions
 * require deterministic checks (confidence + keywords + env flags).
 *
 * Cancel: subscriptions.cancel when action-guard allows.
 * Refund: cron respond may call Stripe Refunds API (último pago, ≤30 días)
 * subject to AUTO_REFUND_MAX_BOT_PER_24H / AUTO_REFUND_MAX_TOTAL_PER_24H.
 */

/**
 * Keywords for every support/landing language we auto-reply in.
 * Scripts without spaces (th/ja/ar): no \\b — substring match.
 * Latin langs: \\b where safe.
 */
const UNSUBSCRIBE_PATTERNS = [
  // Spanish
  /\b(dar(se)?\s+de\s+baja)\b/i,
  /\b(cancel(ar|ación|e|en|aría|aci[oó]n)?)\b/i,
  /\b(no\s+quiero).{0,40}(suscripci[oó]n|subscription|membres[ií]a|premium)\b/i,
  /\b(stop|detener).{0,30}(charg|cobra|bill|suscripci)/i,
  /\b(baja|desuscri)/i,
  // English
  /\b(unsubscribe|cancel\s+(my\s+)?subscri(?:ption|ptiom)?)\b/i,
  /\b(don'?t|do\s+not)\s+want.{0,30}(subscri|suscripci|charg|bill)/i,
  /\b(delete|remove|close).{0,25}(my\s+)?(account|subscription|membership)\b/i,
  /\b(my\s+)?(account|membership)\s+(deletion|removal|cancellation)\b/i,
  /\b(i\s+)?(want|need)\s+to\s+(cancel|delete|remove|unsubscribe)\b/i,
  /\bbeing\s+(?:still\s+)?(?:charged|billed)\b/i,
  /\bnever\s+(ordered|subscribed|signed\s+up)\b/i,
  /\b(not|never)\s+(recall|remember).{0,30}(subscri|signing|charg)/i,
  // Portuguese (landings)
  /\b(cancel(ar|amento|ei|em)|anular|desistir|encerrar)\b/i,
  /\b(assinatura|inscri[cç][aã]o|subscri[cç][aã]o).{0,40}(cancel|anul|desist|encerr)/i,
  /\b(n[aã]o\s+(quero|pedi|assine[ei])).{0,40}(assinatura|subscri|inscri)/i,
  // Polish
  /\b(anulow(ać|anie|uj|uję|ujemy|ować)|rezygnacj[aą]|subskrypcj[aąęi]|wypisa[ćć]|zrezygnowa[ćć])\b/i,
  /\bprosz[eę].{0,30}(anulow|rezygn)/i,
  // Hungarian
  /\b(lemond(ani|ás|om|juk|ta|ják)?|leiratkoz|megszüntet)\b/i,
  /\b(vissza\s*mond(ani|om|ta)?)\b/i,
  /\belőfizetés.{0,40}(lemond|vissza|megszünt)/i,
  /\b(vissza|megszünt).{0,40}előfizetés\b/i,
  // Czech (landings cz → cs)
  /\b(zrušit|zruš(ení|te|ím)|odhlásit|ukončit|předplatn[éeéy])\b/i,
  /\b(nechci|neobjednal|nepředplatil).{0,40}(předplat|odběr|služb)/i,
  // Malay
  /\b(batal(kan)?|nyahlanggan|berhenti|langganan)\b/i,
  /\b(batal|berhenti|nyah).{0,40}(langganan|langgan|akaun)/i,
  /\b(tidak\s+(langgan|mendaftar|mahu)).{0,40}(langgan|aplikasi|akaun)/i,
  // Thai (no \\b)
  /ยกเลิก/,
  /ยกเลิก.{0,30}(สมาชิก|การสมัคร|แพ็กเกจ|บริการ)/,
  /(สมาชิก|การสมัคร|แพ็กเกจ).{0,30}ยกเลิก/,
  /ไม่ได้สมัคร/,
  /ไม่ต้องการ.{0,20}(สมาชิก|บริการ)/,
  // Arabic (no \\b)
  /إلغاء/,
  /الغاء/,
  /إلغاء.{0,40}(الاشتراك|اشتراك|الحساب)/,
  /الغاء.{0,40}(الاشتراك|اشتراك|الحساب)/,
  /إلغاء الاشتراك/,
  /لم\s*أشترك/,
  /لا\s*أريد.{0,30}(اشتراك|الاشتراك)/,
  // Japanese (no \\b)
  /解約/,
  /退会/,
  /キャンセル/,
  /(購読|サブスク|会員|アカウント).{0,20}(解約|キャンセル|停止|削除)/,
  /(解約|キャンセル|退会|停止).{0,20}(購読|サブスク|会員|アカウント)?/,
  /申し込んでいない/,
  /身に覚えがない/,
];

const REFUND_PATTERNS = [
  // Spanish / English
  /\b(reembolso|devoluci[oó]n|devolver(?:me)?)\b/i,
  /\b(refund|money\s+back|chargeback|reimburs(?:e|ement))\b/i,
  /\b(return\s+my\s+(payment|money))\b/i,
  /\b(cargo|charge|payment|charg).{0,40}(no\s+autorizado|unauthorized|sin\s+permiso|without\s+permission|not\s+recall)/i,
  /\b(no\s+autorizado|unauthorized|sin\s+permiso|not\s+recall).{0,40}(cargo|charge|payment|charg|subscri)/i,
  // Portuguese
  /\b(reembolso|devolu[cç][aã]o|devolver|estorno|estornar)\b/i,
  /\b(cobran[cç]a|pagamento).{0,40}(indevid|n[aã]o\s+autoriz|sem\s+consent)/i,
  // Polish
  /\b(zwrot|odszkodowan)\b/i,
  // Hungarian
  /\b(visszatérít|visszafizet|pénzt?\s*vissza|visszakér|visszaad)\b/i,
  /\b(levont|levonás|terhel(?:és|t)|felszámol)\b/i,
  // Czech
  /\b(refundace|vrácení|vrátit|peníze\s+zpět|vrácení\s+peněz)\b/i,
  /\b(strženo|strhli|neoprávněn).{0,40}(platba|částk|peníze)/i,
  // Malay
  /\b(bayaran\s+balik|kembalikan\s+wang|refund|pulangan)\b/i,
  /\b(caj|cas|caj\s+tanpa|dicas).{0,40}(tanpa|tidak|salah)/i,
  // Thai
  /คืนเงิน/,
  /เงินคืน/,
  /ขอคืน/,
  /ถูกหัก/,
  /เรียกเก็บเงิน/,
  // Arabic
  /استرداد/,
  /استرجاع/,
  /استرد/,
  /استرجاع المبلغ/,
  /استرداد المبلغ/,
  /مبلغ.{0,20}(استرداد|استرجاع)/,
  /خصم.{0,20}(بدون|غير)/,
  // Japanese
  /返金/,
  /払い戻し/,
  /返しても/,
  /課金/,
  /引き落とし/,
  /不正課金/,
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
