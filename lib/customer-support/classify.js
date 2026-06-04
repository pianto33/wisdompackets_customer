import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { GoogleGenAI } from '@google/genai';
import Stripe from 'stripe';
import { getQueue, saveQueue, logRun } from './queue-store.js';
import {
  WP_LABELS,
  ensureWpLabels,
  addGmailLabels,
  getClassificationLabels,
  getUntaggedInfoEmailsGmraw,
} from './gmail-labels.js';
import { isEmailToInfo, MAILBOXES_TO_SCAN } from './imap-utils.js';
import { withGeminiRetry } from './gemini-retry.js';
import { getQueueStorageMode } from './queue-store.js';
import { evaluateAutomatedAction, getMinCancelConfidence } from './action-guard.js';
import { logClassificationDecision } from './classification-log.js';
import { notifyRefundRequest } from './refund-alerts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptPath = path.join(__dirname, 'prompts/email_classifier.txt');

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

export { getQueue, saveQueue, logRun } from './queue-store.js';
export { WP_LABELS, ALL_WP_LABELS } from './gmail-labels.js';

function queueStatusForClassification(classification) {
  if (classification === 'Otros') {
    return 'NEEDS_HUMAN_REVIEW';
  }
  return 'PENDING_ACTION';
}

/**
 * Core business logic: classify a single email, check Stripe, and save to queue
 */
export async function processEmail({
  messageId,
  subject,
  fromEmail,
  body,
  imapUid = null,
  imapMailbox = null,
}) {
  console.log(`\n--- Processing Email from: ${fromEmail} ---`);

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

  let stripeTag = 'Not-Found';
  let stripeCustomerId = null;
  let stripeSubscriptionId = null;

  if (stripe && ['Desuscripción', 'Desuscripción + Refund'].includes(classificationResult.classification)) {
    console.log(`Checking Stripe for email: ${fromEmail}...`);
    try {
      const customers = await stripe.customers.list({
        email: fromEmail.trim().toLowerCase(),
        limit: 5,
      });

      if (customers.data.length > 0) {
        const customer = customers.data[0];
        stripeCustomerId = customer.id;
        console.log(`Stripe customer found: ${customer.id}`);

        const subscriptions = await stripe.subscriptions.list({
          customer: customer.id,
          status: 'all',
          limit: 5,
        });

        const activeSub = subscriptions.data.find((s) => ['active', 'trialing'].includes(s.status));

        if (activeSub) {
          stripeSubscriptionId = activeSub.id;
          stripeTag = 'Found';
          console.log(`Stripe active/trialing subscription found: ${activeSub.id} (Status: ${activeSub.status})`);
        } else if (subscriptions.data.length > 0) {
          const anySub = subscriptions.data[0];
          stripeSubscriptionId = anySub.id;
          stripeTag = 'Found';
          console.log(`Stripe inactive subscription found: ${anySub.id} (Status: ${anySub.status})`);
        } else {
          console.log('Stripe customer exists but has no subscriptions.');
        }
      } else {
        console.log('No Stripe customer found with this email.');
      }
    } catch (err) {
      console.error('Stripe check failed:', err.message);
    }
  }

  const actionGuard = evaluateAutomatedAction({
    classification: classificationResult.classification,
    confidence: classificationResult.confidence ?? 0,
    subject,
    body,
  });

  let queueStatus = queueStatusForClassification(classificationResult.classification);
  if (queueStatus === 'PENDING_ACTION' && actionGuard.requiresHumanReview) {
    queueStatus = 'NEEDS_HUMAN_REVIEW';
  }

  const decisionLog = logClassificationDecision({
    fromEmail,
    subject,
    classification: classificationResult.classification,
    confidence: classificationResult.confidence ?? 0,
    reasoning: classificationResult.reasoning,
    actionGuard,
    queueStatus,
    stripeTag,
  });

  if (classificationResult.classification === 'Desuscripción + Refund') {
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
    classification: classificationResult.classification,
    stripeTag,
    needsAutomatedResponse: queueStatus === 'PENDING_ACTION',
    needsHumanReview: queueStatus === 'NEEDS_HUMAN_REVIEW',
  });

  const queue = await getQueue();
  const existingIndex = queue.findIndex((item) => item.id === messageId);

  const queueItem = {
    id: messageId,
    receivedAt: new Date().toISOString(),
    fromEmail,
    subject,
    bodySnippet: body ? body.substring(0, 300) : '',
    classification: classificationResult.classification,
    confidence: classificationResult.confidence ?? 0,
    classificationReasoning: classificationResult.reasoning ?? '',
    actionGuard,
    language: classificationResult.language || 'en',
    stripeTag,
    stripeCustomerId,
    stripeSubscriptionId,
    status: queueStatus,
    gmailLabels,
    imapUid,
    imapMailbox,
    processedAt: null,
    errorDetails: null,
  };

  if (existingIndex >= 0) {
    queue[existingIndex] = queueItem;
  } else {
    queue.push(queueItem);
  }

  await saveQueue(queue);
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
          uids = await client.search({ gmraw });
        } else {
          uids = await client.search({ seen: false });
          console.warn('Gmail X-GM-EXT-1 not available; falling back to unread-only search.');
        }
      } catch (searchErr) {
        console.error(`Search failed in "${mailbox}":`, searchErr.message);
        continue;
      }

      console.log(`Mailbox "${mailbox}": ${uids.length} candidate message(s) without WP/Clasificado.`);

      for (const uid of uids) {
        try {
          const meta = await client.fetchOne(uid, { labels: true }, { uid: true });
          if (meta?.labels?.has(WP_LABELS.CLASIFICADO)) {
            continue;
          }

          const download = await client.download(uid);
          const parsed = await simpleParser(download.content);

          if (!isEmailToInfo(parsed)) {
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
          });

          const labelsToApply = queueItem.gmailLabels || [];
          await addGmailLabels(client, uid, labelsToApply);
          console.log(`Applied Gmail labels: ${labelsToApply.join(', ')}`);

          await client.messageFlagsAdd(uid, ['\\Seen']);

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

export function isWithinNewMexicoBusinessHours() {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: 'numeric',
      hour12: false,
    }).format(new Date())
  );
  return hour >= 9 && hour < 21;
}
