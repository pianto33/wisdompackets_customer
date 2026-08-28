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
 *
 * Patterns run against the raw text AND a diacritic-folded copy, so anything
 * that hinges on an accented letter needs an ASCII twin: `zrezygnować` is
 * folded to `zrezygnowac`, and a trailing \\b after a non-ASCII letter never
 * matches.
 */
const UNSUBSCRIBE_PATTERNS = [
  // Spanish
  /\b(dar(se)?\s+de\s+baja)\b/i,
  /\b(cancel(ar|ación|e|en|aría|aci[oó]n)?)\b/i,
  /\b(no\s+quiero).{0,40}(suscripci[oó]n|subscription|membres[ií]a|premium)\b/i,
  /\b(stop|detener).{0,30}(charg|cobra|bill|suscripci)/i,
  /\b(baja|desuscri)/i,
  /\b(no|nunca)\s+(me\s+)?(he|eh|ha)?\s*(suscrib|suscri|dado\s+de\s+alta|apuntad|registrad|inscrib|contratad)/i,
  /\b(quiero|quisiera|deseo|solicito|necesito|pido)\s+(que\s+)?(me\s+)?(lo\s+|la\s+)?(quit|saca|retir|elimin|anul|cancel|desactiv|borr)/i,
  /\b(quit|saca|retir|elimin|borr)\w*\s+(el\s+|la\s+|mi\s+|los\s+|las\s+)?(suscrip|subscrip|membres|cargo|cobro|pago)/i,
  /\bno\s+quiero\s+(seguir\s+)?(pagar|pagando|abonar)/i,
  /\bno\s+me\s+(mand|envi|cobr|carg)\w*\s+m[aá]s\b/i,
  // English
  /\b(unsubscribe|cancel\s+(my\s+)?subscri(?:ption|ptiom)?)\b/i,
  /\b(don'?t|do\s+not)\s+want.{0,30}(subscri|suscripci|charg|bill)/i,
  /\b(delete|remove|close).{0,25}(my\s+)?(account|subscription|membership)\b/i,
  /\b(my\s+)?(account|membership)\s+(deletion|removal|cancellation)\b/i,
  /\b(i\s+)?(want|need)\s+to\s+(cancel|delete|remove|unsubscribe)\b/i,
  /\bbeing\s+(?:still\s+)?(?:charged|billed)\b/i,
  /\bnever\s+(ordered|subscribed|signed\s+up)\b/i,
  /\b(not|never)\s+(recall|remember).{0,30}(subscri|signing|charg)/i,
  /\bdon'?t\s+remember\s+(ever\s+)?(using|signing|subscrib|order)/i,
  /\bdidn'?t\s+(sign\s+up|subscribe|order|authori[sz]e|agree)\b/i,
  // A charge complaint alone is often plain support ("charged but no access"),
  // so it only counts paired with an "I never wanted this" signal.
  /\b(unexpected|unauthori[sz]ed|accidental|fraudulent)\w*\s+(charge|payment|billing|subscription)/i,
  /\bcharged\b.{0,50}(never|didn'?t|did\s+not|without\s+my|by\s+mistake|out\s+of\s+nowhere)/i,
  /\b(never|didn'?t|did\s+not|out\s+of\s+nowhere)\b.{0,50}\bcharged\b/i,
  // Portuguese (landings)
  /\b(cancel(ar|amento|ei|em)|anular|desistir|encerrar)\b/i,
  /\b(assinatura|inscri[cç][aã]o|subscri[cç][aã]o).{0,40}(cancel|anul|desist|encerr)/i,
  /\b(n[aã]o\s+(quero|pedi|assine[ei])).{0,40}(assinatura|subscri|inscri)/i,
  // Polish (no trailing \\b: the folded copy ends in a bare consonant)
  /\b(anulowa[cć]|anulow(anie|uj|uj[eę]|ujemy)|rezygnacj[aąe]|zrezygnowa[cć]|wypisa[cć]|odsubskrybowa[cć])/i,
  /\bsubskrypcj[aąeęi]\b/i,
  /\bprosz[eę].{0,30}(anulow|rezygn|usun)/i,
  /\bnie\s+(chc[eę]|zamawia[lł]em|zapisywa[lł]em)/i,
  // Hungarian
  /\b(lemond(ani|ás|om|juk|ta|ják)?|leiratkoz|megsz[uü]ntet)\b/i,
  /\b(le\s*mond|le\s+is\s+mond)/i,
  /\bvisszavonok\b/i,
  /\b(vissza\s*mond(ani|om|ta)?)\b/i,
  /\bel[oő]fizet[eé]s.{0,40}(lemond|vissza|megsz[uü]nt)/i,
  /\b(vissza|megsz[uü]nt).{0,40}el[oő]fizet[eé]s/i,
  /\bnem\s+(rendeltem|iratkoztam|k[eé]rtem|akarom)/i,
  // Czech (landings cz → cs)
  /\b(zru[sš]it|zru[sš](en[ií]|te|[ií]m)|odhl[aá]sit|ukon[cč]it|p[rř]edplatn)/i,
  /\b(nechci|neobjednal|nep[rř]edplatil).{0,40}(p[rř]edplat|odb[eě]r|slu[zž]b)/i,
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
  /\b(cargo|cobro)\s+(indebido|fraudulento|duplicado|no\s+reconocido)/i,
  /\bno\s+reconozco\b.{0,40}(cargo|cobro|pago|suscrip|importe)/i,
  /\bme\s+(han|an|ha)\s+(cobrado|descontado|debitado)\b/i,
  // Portuguese
  /\b(reembolso|devolu[cç][aã]o|devolver|estorno|estornar)\b/i,
  /\b(cobran[cç]a|pagamento).{0,40}(indevid|n[aã]o\s+autoriz|sem\s+consent)/i,
  // Polish
  /\b(zwrot|odszkodowan)\b/i,
  // Hungarian (spacing + word-order variants: "vissza térítést", "vissza a pénzem", "utalják vissza")
  /\b(visszatérít|visszafizet|pénzt?\s*vissza|visszakér|visszaad)\b/i,
  /\b(vissza\s*t[eé]r[ií]t|vissza\s*fizet|vissza\s*utal|visszautal)/i,
  /\b(utal[jájáa-z]*\s*vissza)\b/i,
  /\b(vissza.{0,25}p[eé]nz|p[eé]nz.{0,25}vissza)\b/i,
  /\b(levont|levonás|levon[aá]st?|terhel(?:és|t)|felszámol)/i,
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
  const n = Number(process.env.AUTO_CANCEL_MIN_CONFIDENCE ?? '0.90');
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.9;
}

function normalizeText(subject = '', body = '') {
  return `${subject}\n${body}`.toLowerCase();
}

function foldDiacritics(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function matchesAny(patterns, subject, body) {
  const raw = normalizeText(subject, body);
  const folded = foldDiacritics(raw);
  return patterns.some((re) => re.test(raw) || re.test(folded));
}

export function hasUnsubscribeIntent(subject, body) {
  return matchesAny(UNSUBSCRIBE_PATTERNS, subject, body);
}

export function hasRefundIntent(subject, body) {
  return matchesAny(REFUND_PATTERNS, subject, body);
}

const ACTIONABLE_CLASSIFICATIONS = new Set(['Desuscripción', 'Desuscripción + Refund']);

/**
 * Keywords win over Gemini: refund → baja+refund; solo baja → baja;
 * Gemini +Refund sin keyword de refund se degrada a baja.
 */
export function resolveEffectiveClassification({ classification, subject, body }) {
  if (hasRefundIntent(subject, body)) return 'Desuscripción + Refund';
  if (hasUnsubscribeIntent(subject, body)) return 'Desuscripción';
  return classification;
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
  const refund = hasRefundIntent(subject, body);
  const unsub = hasUnsubscribeIntent(subject, body);
  const resolvedClassification = refund
    ? 'Desuscripción + Refund'
    : unsub
      ? 'Desuscripción'
      : classification;

  const base = {
    resolvedClassification,
    geminiClassification: classification,
    minConfidenceThreshold: minConfidence,
    confidence,
  };

  if (!isAutoCancelGloballyEnabled()) {
    return {
      ...base,
      stripeCancelAllowed: false,
      automatedEmailAllowed: false,
      requiresHumanReview: true,
      reasons: ['STRIPE_AUTO_CANCEL_ENABLED está desactivado'],
      blockers: ['auto_cancel_disabled'],
    };
  }

  if (!ACTIONABLE_CLASSIFICATIONS.has(resolvedClassification)) {
    return {
      ...base,
      stripeCancelAllowed: false,
      automatedEmailAllowed: false,
      requiresHumanReview: true,
      reasons:
        classification === 'Otros'
          ? ['Clasificación Otros — sin acciones automáticas']
          : [`Clasificación no reconocida: ${classification}`],
      blockers: [classification === 'Otros' ? 'classification_otros' : 'unknown_classification'],
    };
  }

  const blockers = [];
  const reasons = [];

  if (confidence < minConfidence) {
    blockers.push('low_confidence');
    reasons.push(
      `Confianza Gemini ${(confidence * 100).toFixed(0)}% < mínimo ${(minConfidence * 100).toFixed(0)}%`
    );
  }

  if (!unsub && !refund) {
    blockers.push('no_action_keywords');
    reasons.push('El texto no contiene frases claras de baja ni de reembolso');
  }

  if (blockers.length > 0) {
    return {
      ...base,
      stripeCancelAllowed: false,
      automatedEmailAllowed: false,
      requiresHumanReview: true,
      reasons,
      blockers,
    };
  }

  let okReason = 'Validación OK: confianza + palabras clave + flag de entorno';
  if (classification === 'Desuscripción + Refund' && !refund && unsub) {
    okReason = 'Gemini dijo refund; keywords solo baja → flujo cancelación';
  } else if (classification !== 'Desuscripción + Refund' && refund) {
    okReason = 'Keywords de refund → flujo cancelación + refund';
  } else if (!unsub && refund) {
    okReason = 'Pide refund sin decir cancelar → flujo cancelación + refund';
  }

  return {
    ...base,
    stripeCancelAllowed: true,
    automatedEmailAllowed: true,
    requiresHumanReview: false,
    reasons: [okReason],
    blockers: [],
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
    body: queueItem.bodySnippet ?? queueItem.body ?? '',
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
