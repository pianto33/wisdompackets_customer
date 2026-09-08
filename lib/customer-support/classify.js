import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { GoogleGenAI } from '@google/genai';
import Stripe from 'stripe';
import { getQueue, upsertQueueItems, logRun } from './queue-store.js';
import {
  WP_LABELS,
  ensureWpLabels,
  addGmailLabels,
  getClassificationLabels,
  getUntaggedInfoEmailsGmraw,
} from './gmail-labels.js';
import { findSupportRecipient, MAILBOXES_TO_SCAN } from './imap-utils.js';
import { withGeminiRetry } from './gemini-retry.js';
import { getQueueStorageMode } from './queue-store.js';
import { evaluateAutomatedAction, getMinCancelConfidence } from './action-guard.js';
import { normalizeSupportLanguage } from './support-language.js';
import { logClassificationDecision } from './classification-log.js';
import { notifyRefundRequest } from './refund-alerts.js';
import { isNoActionSupportEmail } from './no-action-email.js';
import { detectResolvedFollowUp } from './followup.js';
import { PRODUCT_CODE, resolveItemProduct } from './product-scope.js';
import { lookupStripeCustomer } from './stripe-customer-lookup.js';
import { findOwnerProductByClues } from './cross-product-lookup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptPath = path.join(__dirname, 'prompts/email_classifier.txt');

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

export { getQueue, saveQueue, upsertQueueItems, logRun } from './queue-store.js';
export { WP_LABELS, ALL_WP_LABELS } from './gmail-labels.js';

const OPEN_QUEUE_STATUSES = new Set(['PENDING_ACTION', 'NEEDS_HUMAN_REVIEW', 'FAILED']);

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

/**
 * Collapse older open queue rows for the same customer so one request does not
 * spawn several NEEDS_HUMAN_REVIEW / PENDING_ACTION siblings.
 * @param {object[]} queue
 * @param {object} primary
 */
function supersedeOpenDuplicates(queue, primary) {
  const email = normalizeEmail(primary.fromEmail);
  if (!email) return [];

  return (Array.isArray(queue) ? queue : [])
    .filter(
      (item) =>
        item?.id &&
        item.id !== primary.id &&
        normalizeEmail(item.fromEmail) === email &&
        resolveItemProduct(item) === PRODUCT_CODE &&
        OPEN_QUEUE_STATUSES.has(String(item.status || ''))
    )
    .map((item) => ({
      ...item,
      status: 'PROCESSED_NO_ACTION',
      processedAt: new Date().toISOString(),
      errorDetails: `superseded_by_${primary.id}`,
      actionGuard: {
        ...(item.actionGuard || {}),
        blockers: [...new Set([...(item.actionGuard?.blockers || []), 'duplicate_open_thread'])],
      },
    }));
}

function queueStatusForClassification(classification) {
  if (classification === 'Otros') {
    return 'NEEDS_HUMAN_REVIEW';
  }
  return 'PENDING_ACTION';
}

/**
 * Core business logic: classify a single email, check Stripe, and save to queue
 */
/**
 * Closes a case without contacting the customer, and marks the thread answered.
 * @returns {Promise<Record<string, unknown>>}
 */
async function enqueueSilentClose({
  messageId,
  subject,
  fromEmail,
  body,
  imapUid,
  imapMailbox,
  supportInbox,
  reasoning,
  blocker,
}) {
  const queueItem = {
    id: messageId,
    product: PRODUCT_CODE,
    supportInbox,
    receivedAt: new Date().toISOString(),
    fromEmail,
    subject,
    bodySnippet: body ? body.substring(0, 300) : '',
    classification: 'Otros',
    confidence: 1,
    classificationReasoning: reasoning,
    actionGuard: { requiresHumanReview: false, blockers: [blocker] },
    language: 'en',
    stripeTag: 'Not-Found',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    status: 'PROCESSED_NO_ACTION',
    gmailLabels: getClassificationLabels({
      classification: 'Otros',
      stripeTag: 'Not-Found',
      needsAutomatedResponse: false,
      noActionRequired: true,
    }),
    imapUid,
    imapMailbox,
    processedAt: new Date().toISOString(),
    errorDetails: null,
  };

  await upsertQueueItems([queueItem]);
  return queueItem;
}

export async function processEmail({
  messageId,
  subject,
  fromEmail,
  body,
  imapUid = null,
  imapMailbox = null,
  supportInbox = null,
  queue = null,
}) {
  console.log(`\n--- Processing Email from: ${fromEmail} ---`);

  if (isNoActionSupportEmail(subject, body)) {
    console.log('[classify] No-action email (agradecimiento/cierre) — auto-resuelto');
    return enqueueSilentClose({
      messageId,
      subject,
      fromEmail,
      body,
      imapUid,
      imapMailbox,
      supportInbox,
      reasoning: 'Agradecimiento o cierre sin nueva solicitud.',
      blocker: 'no_action_reply',
    });
  }

  const followUp = detectResolvedFollowUp({
    fromEmail,
    subject,
    body,
    queue: queue || (await getQueue()),
  });

  if (followUp.decision === 'close') {
    console.log(`[classify] Follow-up de un caso ya resuelto (${followUp.reason}) — cerrado sin mail`);
    return enqueueSilentClose({
      messageId,
      subject,
      fromEmail,
      body,
      imapUid,
      imapMailbox,
      supportInbox,
      reasoning: `Follow-up de un caso ya resuelto (${followUp.reason}); no pide nada nuevo.`,
      blocker: 'already_resolved',
    });
  }

  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  let promptTemplate = '';
  if (fs.existsSync(promptPath)) {
    promptTemplate = fs.readFileSync(promptPath, 'utf-8');
  } else {
    throw new Error(`Classifier prompt not found at ${promptPath}`);
  }

  const prompt = promptTemplate
    .replace('{{SUBJECT}}', subject || '(No Subject)')
    .replace('{{FROM}}', fromEmail)
    .replace('{{BODY}}', body || '(Empty Body)');

  console.log('Sending email body to Gemini for semantic analysis...');
  const response = await withGeminiRetry(() =>
    ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    })
  );

  const rawJson = response.text.trim();
  let classificationResult;
  try {
    classificationResult = JSON.parse(rawJson);
  } catch {
    console.error('Failed to parse Gemini JSON response. Raw output:', rawJson);
    classificationResult = {
      classification: 'Otros',
      confidence: 0.5,
      language: 'en',
      reasoning: 'Error al procesar la respuesta del modelo, se asume Otros.',
    };
  }

  const minThreshold = getMinCancelConfidence();
  console.log(
    `[gemini] classification=${classificationResult.classification} confidence=${(classificationResult.confidence * 100).toFixed(1)}% threshold=${(minThreshold * 100).toFixed(0)}% meetsThreshold=${classificationResult.confidence >= minThreshold}`
  );
  console.log(`[gemini] reasoning: ${classificationResult.reasoning}`);

  const actionGuard = evaluateAutomatedAction({
    classification: classificationResult.classification,
    confidence: classificationResult.confidence ?? 0,
    subject,
    body,
  });
  const resolvedClassification =
    actionGuard.resolvedClassification || classificationResult.classification;

  let stripeTag = 'Not-Found';
  let stripeCustomerId = null;
  let stripeSubscriptionId = null;
  let stripeMatchMethod = null;
  let stripeMatchedEmail = null;
  let ownerProduct = PRODUCT_CODE;

  if (stripe && ['Desuscripción', 'Desuscripción + Refund'].includes(resolvedClassification)) {
    console.log(`Checking Stripe for email: ${fromEmail}...`);
    try {
      const hit = await lookupStripeCustomer(stripe, {
        fromEmail,
        subject,
        body,
      });
      stripeTag = hit.stripeTag;
      stripeCustomerId = hit.customerId;
      stripeSubscriptionId = hit.subscriptionId;
      stripeMatchMethod = hit.matchMethod;
      stripeMatchedEmail = hit.matchedEmail;

      if (stripeTag === 'Found') {
        console.log(
          `Stripe customer found: ${stripeCustomerId} via ${stripeMatchMethod}` +
            (stripeSubscriptionId ? ` (sub ${stripeSubscriptionId})` : '')
        );
      } else {
        console.log('No Stripe customer found with From/clues on local account.');
        const cross = await findOwnerProductByClues({
          fromEmail,
          subject,
          body,
          includeLocal: false,
        });
        if (cross.checked && cross.product && cross.product !== PRODUCT_CODE) {
          ownerProduct = cross.product;
          stripeTag = 'Found';
          stripeCustomerId = cross.customerId || null;
          stripeSubscriptionId = cross.subscriptionId || null;
          stripeMatchMethod = cross.matchMethod || 'cross_product';
          stripeMatchedEmail = cross.matchedEmail || null;
          console.log(
            `[classify] reassigned to ${ownerProduct} via ${stripeMatchMethod}` +
              (stripeCustomerId ? ` (${stripeCustomerId})` : '')
          );
        }
      }
    } catch (err) {
      console.error('Stripe check failed:', err.message);
    }
  }

  let queueStatus = queueStatusForClassification(resolvedClassification);
  if (queueStatus === 'PENDING_ACTION' && actionGuard.requiresHumanReview) {
    queueStatus = 'NEEDS_HUMAN_REVIEW';
  }
  if (followUp.decision === 'human') {
    console.log(`[classify] ${followUp.reason} — a revisión humana, sin respuesta automática`);
    queueStatus = 'NEEDS_HUMAN_REVIEW';
  }
  if (ownerProduct !== PRODUCT_CODE) {
    queueStatus = 'PENDING_ACTION';
  }

  const decisionLog = logClassificationDecision({
    fromEmail,
    subject,
    classification: resolvedClassification,
    confidence: classificationResult.confidence ?? 0,
    reasoning: classificationResult.reasoning,
    actionGuard,
    queueStatus,
    stripeTag,
  });

  if (resolvedClassification === 'Desuscripción + Refund') {
    await notifyRefundRequest({
      fromEmail,
      subject,
      confidence: classificationResult.confidence ?? 0,
      queueStatus,
      stripeTag,
      bodySnippet: body ? body.substring(0, 500) : '',
      scenario: decisionLog.scenario,
    });
  }

  const gmailLabels = getClassificationLabels({
    classification: resolvedClassification,
    stripeTag,
    needsAutomatedResponse: queueStatus === 'PENDING_ACTION',
    needsHumanReview: queueStatus === 'NEEDS_HUMAN_REVIEW',
  });

  const queueItem = {
    id: messageId,
    product: ownerProduct,
    supportInbox,
    receivedAt: new Date().toISOString(),
    fromEmail,
    subject,
    bodySnippet: body ? body.substring(0, 4000) : '',
    classification: resolvedClassification,
    geminiClassification: classificationResult.classification,
    confidence: classificationResult.confidence ?? 0,
    classificationReasoning: classificationResult.reasoning ?? '',
    actionGuard,
    language: normalizeSupportLanguage(classificationResult.language || 'en'),
    stripeTag,
    stripeCustomerId,
    stripeSubscriptionId,
    stripeMatchMethod,
    stripeMatchedEmail,
    status: queueStatus,
    gmailLabels,
    imapUid,
    imapMailbox,
    processedAt: null,
    errorDetails: null,
  };

  const known = queue || (await getQueue());
  const superseded = supersedeOpenDuplicates(known, queueItem);
  await upsertQueueItems([queueItem, ...superseded]);
  if (superseded.length) {
    console.log(
      `[classify] superseded ${superseded.length} open duplicate(s) for ${fromEmail}`
    );
  }
  console.log(`Enqueued email with status: ${queueItem.status}`);
  return queueItem;
}

/**
 * Optional archive label (Gmail move to custom folder is unreliable over IMAP).
 * @param {import('imapflow').ImapFlow} client
 */
async function archiveProcessedInboxMail(client, uid) {
  try {
    await addGmailLabels(client, uid, ['WP/Archivado']);
  } catch (err) {
    console.warn(`Could not add WP/Archivado label to UID ${uid}:`, err.message);
  }
}

/**
 * IMAP sync: classify all info@ emails missing WP/Clasificado (read or unread).
 */
export async function runClassifier() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const password = process.env.IMAP_PASSWORD;

  if (!host || !user || !password) {
    console.warn('[WARNING] IMAP configuration is missing. Skipping real mailbox sync.');
    await logRun({
      type: 'IMAP_SYNC',
      status: 'SKIPPED',
      reason: 'Missing IMAP configurations',
      emailsProcessedCount: 0,
    });
    return { status: 'SKIPPED', emailsProcessedCount: 0, errorsCount: 0 };
  }

  const queueMode = getQueueStorageMode();
  console.log(`Connecting to IMAP mailbox: ${host}... (queue storage: ${queueMode})`);
  if (queueMode === 'missing-blob-on-vercel') {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN missing on Vercel — cannot persist queue. Add it in Vercel env vars.'
    );
  }

  const client = new ImapFlow({
    host,
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: process.env.IMAP_SECURE !== 'false',
    auth: { user, pass: password },
    logger: false,
  });

  let processedCount = 0;
  let errorCount = 0;
  const seenMessageIds = new Set();

  // Read once and keep it current in memory: follow-up detection needs to see
  // the cases closed earlier in this same run, not just what the store had.
  const knownQueue = await getQueue();

  try {
    await client.connect();
    await ensureWpLabels(client);

    const gmraw = getUntaggedInfoEmailsGmraw();
    const mailboxesToSearch = ['[Gmail]/All Mail', ...MAILBOXES_TO_SCAN.filter((m) => m !== '[Gmail]/All Mail')];

    for (const mailbox of mailboxesToSearch) {
      try {
        await client.mailboxOpen(mailbox);
      } catch (err) {
        console.warn(`Could not open mailbox "${mailbox}":`, err.message);
        continue;
      }

      let uids = [];
      try {
        if (client.capabilities.has('X-GM-EXT-1')) {
          uids = (await client.search({ gmraw }, { uid: true })) || [];
        } else {
          uids = (await client.search({ seen: false }, { uid: true })) || [];
          console.warn('Gmail X-GM-EXT-1 not available; falling back to unread-only search.');
        }
      } catch (searchErr) {
        console.error(`Search failed in "${mailbox}":`, searchErr.message);
        continue;
      }

      if (!Array.isArray(uids)) uids = [];

      console.log(`Mailbox "${mailbox}": ${uids.length} candidate message(s) without WP/Clasificado.`);

      for (const uid of uids) {
        try {
          const meta = await client.fetchOne(uid, { labels: true }, { uid: true });
          if (meta?.labels?.has(WP_LABELS.CLASIFICADO)) {
            continue;
          }

          const download = await client.download(uid, undefined, { uid: true });
          const parsed = await simpleParser(download.content);

          const supportInbox = findSupportRecipient(parsed);
          if (!supportInbox) {
            continue;
          }

          const fromEmail =
            parsed.from && parsed.from.value && parsed.from.value[0] ? parsed.from.value[0].address : '';

          if (!fromEmail) {
            console.warn(`Skipping email with no sender (UID: ${uid})`);
            continue;
          }

          const messageId = parsed.messageId || `imap_uid_${mailbox}_${uid}`;
          if (seenMessageIds.has(messageId)) {
            continue;
          }
          seenMessageIds.add(messageId);

          const subject = parsed.subject || '';
          const body = parsed.text || parsed.html || '';

          const queueItem = await processEmail({
            messageId,
            subject,
            fromEmail,
            body,
            imapUid: uid,
            imapMailbox: mailbox,
            supportInbox,
            queue: knownQueue,
          });
          knownQueue.push(queueItem);

          const labelsToApply = queueItem.gmailLabels || [];
          await addGmailLabels(client, uid, labelsToApply);
          console.log(`Applied Gmail labels: ${labelsToApply.join(', ')}`);

          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });

          if (mailbox === 'INBOX') {
            await archiveProcessedInboxMail(client, uid);
          }

          processedCount++;
        } catch (err) {
          console.error(`Error processing email UID ${uid} in ${mailbox}:`, err.message);
          errorCount++;
        }
      }
    }

    await client.logout();

    await logRun({
      type: 'IMAP_SYNC',
      status: errorCount > 0 ? 'PARTIAL_SUCCESS' : 'SUCCESS',
      emailsProcessedCount: processedCount,
      errorsCount: errorCount,
    });

    return {
      status: errorCount > 0 ? 'PARTIAL_SUCCESS' : 'SUCCESS',
      emailsProcessedCount: processedCount,
      errorsCount: errorCount,
    };
  } catch (err) {
    console.error('IMAP sync failed:', err.message);
    await logRun({
      type: 'IMAP_SYNC',
      status: 'FAILED',
      error: err.message,
      emailsProcessedCount: 0,
    });
    throw err;
  }
}

/** 10:00–23:59 UTC, todos los días (incluye sáb/dom). El nombre es histórico. */
export function isWithinNewMexicoBusinessHours() {
  const hour = new Date().getUTCHours();
  return hour >= 10 && hour <= 23;
}
