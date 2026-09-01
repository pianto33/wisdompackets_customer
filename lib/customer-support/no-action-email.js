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
