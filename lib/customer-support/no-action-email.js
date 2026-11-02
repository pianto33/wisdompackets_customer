import { extractOwnPart } from './quoted-text.js';

/**
 * Mails de agradecimiento o cierre sin nueva solicitud → cerrar sin revisión humana.
 */
export function isNoActionSupportEmail(subject, body) {
  const ownPart = extractOwnPart(subject, body);

  if (!ownPart || ownPart.length > 250) return false;

  const lower = ownPart.toLowerCase().replace(/\s+/g, ' ').trim();
  const cancelWords = /cancel|refund|unsubscribe|baja|reembolso|devoluc|zrušit|zrusit|charge|cargo|help|ayuda|problem|issue|login|password|suscri/;
  if (cancelWords.test(lower)) return false;

  const thankOnly =
    /^(thank you very much|thank you|thanks a lot|thanks|muchas gracias|gracias|ok thanks|perfect thanks|received thanks|děkuji|dekuji)[.!,?\s]*$/i.test(
      lower
    );
  if (thankOnly) return true;

  return (
    lower.length <= 80 &&
    /^(thank|thanks|gracias|ok|perfect|great|received|noted|understood|entendido)[.!,?\s]*$/i.test(lower)
  );
}

const COMMERCIAL_PITCH = [
  /partnership proposal/i,
  /propuesta comercial/i,
  /propuesta de (colaboraci[oó]n|alianza|negocio|patrocinio)/i,
  /business (proposal|opportunity|partnership)/i,
  /collaboration (proposal|opportunity)/i,
  /(we|we['’]d|we would) (like|love) to (explore |discuss )?(a )?(partnership|collaborat)/i,
  /guest post/i,
  /link[- ]building/i,
  /seo (services|proposal|outreach|package)/i,
  /sponsorship opportunit/i,
  /media partnership/i,
  /oportunidad de negocio/i,
  /alianza comercial/i,
  /content partnership/i,
  /licensing (proposal|opportunit)/i,
  /non-exclusive partnership/i,
  /white[- ]label (solution|partnership|offer)/i,
];

const BILLING_REQUEST = /cancel|refund|unsubscribe|baja|reembolso|devoluc|chargeback|me cobr|cargo indebido|charged me|suscripci[oó]n|el[oő]fizet|visszat[eé]r[ií]t/i;

/**
 * Pitch comercial (partnership, SEO, guest post, licensing) sin pedido de baja o refund.
 * Se cierra sin respuesta ni revisión humana.
 */
export function isCommercialOutreach(subject, body) {
  const text = `${subject || ''}\n${body || ''}`.replace(/\s+/g, ' ').slice(0, 6000);
  if (!text.trim()) return false;
  if (BILLING_REQUEST.test(text)) return false;
  return COMMERCIAL_PITCH.some((pattern) => pattern.test(text));
}
