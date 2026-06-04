/**
 * Gmail labels (tags) for WisdomPackets customer support automation.
 *
 * Rule: any email to info@wisdompackets.com WITHOUT "WP/Clasificado" needs human review.
 */

export const WP_LABELS = {
  /** Applied by classifier on every processed info@ email */
  CLASIFICADO: 'WP/Clasificado',

  /** Gemini classification */
  DESUSCRIPCION: 'WP/Desuscripción',
  DESUSCRIPCION_REFUND: 'WP/Desuscripción+Refund',
  OTROS: 'WP/Otros',

  /** Requires manual reply (always paired with WP/Otros) */
  REVISION_HUMANA: 'WP/Revisión-Humana',

  /** Stripe lookup result */
  STRIPE_FOUND: 'WP/Stripe-Found',
  STRIPE_NOT_FOUND: 'WP/Stripe-NotFound',

  /** Waiting for respond cron */
  PENDIENTE_RESPUESTA: 'WP/Pendiente-Respuesta',

  /** Applied by respond cron */
  RESPONDIDO_AUTO: 'WP/Respondido-Auto',
  RESPONDIDO_SIN_CUENTA: 'WP/Respondido-SinCuenta',
  ERROR: 'WP/Error',
  ARCHIVADO: 'WP/Archivado',
};

/** All labels the automation may create */
export const ALL_WP_LABELS = Object.values(WP_LABELS);

const GMAIL_RAW_UNTAGGED_QUERY = 'to:info@wisdompackets.com -label:"WP/Clasificado"';

export function getUntaggedInfoEmailsGmraw() {
  return GMAIL_RAW_UNTAGGED_QUERY;
}

/**
 * @param {import('imapflow').ImapFlow} client
 */
export async function ensureWpLabels(client) {
  for (const label of ALL_WP_LABELS) {
    try {
      await client.mailboxCreate(label);
    } catch {
      // already exists
    }
  }
}

/**
 * @param {import('imapflow').ImapFlow} client
 * @param {number} uid
 * @param {string[]} labelsToAdd
 */
export async function addGmailLabels(client, uid, labelsToAdd) {
  if (!labelsToAdd.length) return;
  await client.messageFlagsAdd(uid, labelsToAdd, { useLabels: true });
}

/**
 * @param {import('imapflow').ImapFlow} client
 * @param {number} uid
 * @param {string[]} labelsToRemove
 */
export async function removeGmailLabels(client, uid, labelsToRemove) {
  if (!labelsToRemove.length) return;
  await client.messageFlagsRemove(uid, labelsToRemove, { useLabels: true });
}

/**
 * Labels applied right after classification.
 */
export function getClassificationLabels({
  classification,
  stripeTag,
  needsAutomatedResponse,
  needsHumanReview = false,
}) {
  const labels = [WP_LABELS.CLASIFICADO];

  if (classification === 'Desuscripción') {
    labels.push(WP_LABELS.DESUSCRIPCION);
  } else if (classification === 'Desuscripción + Refund') {
    labels.push(WP_LABELS.DESUSCRIPCION_REFUND);
  } else {
    labels.push(WP_LABELS.OTROS, WP_LABELS.REVISION_HUMANA);
  }

  if (['Desuscripción', 'Desuscripción + Refund'].includes(classification)) {
    labels.push(stripeTag === 'Found' ? WP_LABELS.STRIPE_FOUND : WP_LABELS.STRIPE_NOT_FOUND);
    if (needsAutomatedResponse) {
      labels.push(WP_LABELS.PENDIENTE_RESPUESTA);
    }
    if (needsHumanReview) {
      labels.push(WP_LABELS.REVISION_HUMANA);
    }
  }

  return labels;
}

/**
 * Labels applied after respond cron finishes.
 */
export function getResponderOutcomeLabels(queueStatus) {
  const remove = [WP_LABELS.PENDIENTE_RESPUESTA];
  const add = [];

  if (queueStatus === 'PROCESSED_SUCCESS') {
    add.push(WP_LABELS.RESPONDIDO_AUTO);
  } else if (queueStatus === 'PROCESSED_NOT_FOUND') {
    add.push(WP_LABELS.RESPONDIDO_SIN_CUENTA);
  } else if (queueStatus === 'FAILED') {
    add.push(WP_LABELS.ERROR, WP_LABELS.REVISION_HUMANA);
  }

  return { add, remove };
}
