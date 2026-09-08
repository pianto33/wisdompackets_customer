import fs from 'fs';
import path from 'path';

/** Idiomas con plantilla propia en soporte automático. Cualquier otro valor → en. */
export const SUPPORT_LANGUAGES = ['es', 'hu', 'cs', 'en'];

const TEMPLATE_BY_KIND = {
  notFound: {
    es: 'suscription-not-found.html',
    hu: 'suscription-not-found-hu.html',
    cs: 'suscription-not-found-cs.html',
    en: 'suscription-not-found-en.html',
  },
  unsubscribe: {
    es: 'succesful-unsuscription.html',
    hu: 'succesful-unsuscription-hu.html',
    cs: 'succesful-unsuscription-cs.html',
    en: 'succesful-unsuscription-en.html',
  },
  unsubscribeRefund: {
    es: 'succesful-unsuscription-refund-link.html',
    hu: 'succesful-unsuscription-refund-link-hu.html',
    cs: 'succesful-unsuscription-refund-link-cs.html',
    en: 'succesful-unsuscription-refund-link-en.html',
  },
};

const SUBJECT_BY_KIND = {
  notFound: {
    es: 'Suscripción no encontrada - WisdomPackets',
    hu: 'Előfizetés nem található - WisdomPackets',
    cs: 'Předplatné nenalezeno - WisdomPackets',
    en: 'Subscription Not Found - WisdomPackets',
  },
  unsubscribe: {
    es: 'Confirmación de cancelación de membresía - WisdomPackets',
    hu: 'Tagság lemondásának megerősítése - WisdomPackets',
    cs: 'Potvrzení zrušení členství - WisdomPackets',
    en: 'Membership Cancellation Confirmation - WisdomPackets',
  },
  unsubscribeRefund: {
    es: 'Cancelación de membresía y reembolso iniciado - WisdomPackets',
    hu: 'Tagság lemondva és visszatérítés elindítva - WisdomPackets',
    cs: 'Zrušení členství a zahájení refundace - WisdomPackets',
    en: 'Membership Cancellation and Refund Initiated - WisdomPackets',
  },
};

export function resolveSupportEmailSubject(kind, language) {
  const lang = normalizeSupportLanguage(language);
  const subjects = SUBJECT_BY_KIND[kind];
  if (!subjects) throw new Error(`Unknown support subject kind: ${kind}`);
  return subjects[lang] ?? subjects.en;
}

/**
 * Normaliza el idioma detectado por Gemini (es | hu | cs | en). Fallback: en.
 * Acepta también "cz" (código de país del landing).
 */
export function normalizeSupportLanguage(language) {
  const code = (language || 'en').toLowerCase().trim();
  if (code === 'cz') return 'cs';
  if (code === 'es' || code === 'hu' || code === 'cs' || code === 'en') return code;
  return 'en';
}

/** @deprecated alias */
export function resolveSupportTemplateLang(language) {
  return normalizeSupportLanguage(language);
}

/**
 * Ruta de plantilla HTML: intenta el idioma pedido; si no existe el archivo → inglés.
 */
export function resolveSupportTemplatePath(templatesDir, kind, language) {
  const lang = normalizeSupportLanguage(language);
  const names = TEMPLATE_BY_KIND[kind];
  if (!names) {
    throw new Error(`Unknown support template kind: ${kind}`);
  }
  const preferred = path.join(templatesDir, names[lang]);
  if (fs.existsSync(preferred)) return preferred;
  const fallback = path.join(templatesDir, names.en);
  if (!fs.existsSync(fallback)) {
    throw new Error(`Template not found: ${preferred} (fallback ${fallback} missing)`);
  }
  return fallback;
}
