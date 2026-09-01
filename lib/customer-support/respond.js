import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ImapFlow } from 'imapflow';
import Stripe from 'stripe';
import { getQueue, upsertQueueItems, logRun } from './queue-store.js';
import { getResponderOutcomeLabels } from './gmail-labels.js';
import {
  findMessageByMessageId,
  applyLabelUpdateAtLocation,
  ensureMailboxOpen,
} from './imap-utils.js';
import { assertStripeCancelAllowed, getMinCancelConfidence } from './action-guard.js';
import {
  normalizeSupportLanguage,
  resolveSupportTemplatePath,
} from './support-language.js';
import { logClassificationDecision } from './classification-log.js';
import { isEmailConfigured, sendAlertEmail, sendCustomerThreadReply } from './mail-sender.js';
import { attemptBotAutoRefund } from './stripe-refund.js';
import { notifyAutoRefundOutcome } from './refund-alerts.js';
import { cancelOrReuseSubscription } from './stripe-utils.js';
import {
  PRODUCT_CODE,
  partitionByProduct,
  productForInboundAddress,
  productForRecipients,
} from './product-scope.js';
import {
  findOwnerProductByEmail,
  isMissingStripeResourceError,
  resolveProductForUntaggedEmail,
} from './cross-product-lookup.js';
import { recoverOrphanPendingItems } from './recover-orphans.js';
import { processEmail } from './classify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(__dirname, 'templates');

/** Cap on Stripe lookups spent per run deciding who owns untagged items. */
const MAX_UNOWNED_ITEMS_PER_RUN = 10;

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const alertRecipient = process.env.ALERT_EMAIL_RECIPIENT || 'pianto33.tp@gmail.com';

function formatDate(dateString, language = 'en') {
  const lang = normalizeSupportLanguage(language);
  if (lang === 'es') {
    if (!dateString) return 'el final del periodo contratado';
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return 'el final del periodo contratado';
    }
  }
  if (lang === 'hu') {
    if (!dateString) return 'a számlázási időszak végén';
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('hu-HU', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return 'a számlázási időszak végén';
    }
  }
  if (!dateString) return 'the end of the billing period';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return 'the end of the billing period';
  }
}

/**
 * @param {import('imapflow').ImapFlow | null} imapClient
 * @param {Record<string, unknown>} item
 * @param {string} queueStatus
 */
async function syncResponderGmailLabels(imapClient, item, queueStatus) {
  if (!imapClient) return;

  const location =
    item.imapUid && item.imapMailbox
      ? { mailbox: item.imapMailbox, uid: item.imapUid }
      : await findMessageByMessageId(imapClient, item.id);

  const labelUpdate = getResponderOutcomeLabels(queueStatus);
  await applyLabelUpdateAtLocation(imapClient, location, labelUpdate);
}

/**
 * Recovers the support address an old queue item was sent to, so the mailbox
 * can decide the product instead of guessing from Stripe.
 *
 * @param {import('imapflow').ImapFlow | null} imapClient
 * @param {Record<string, unknown>} item
 * @returns {Promise<'SV'|'WP'|'GL'|null>}
 */
async function productFromMailbox(imapClient, item) {
  const stored = productForInboundAddress(item.supportInbox);
  if (stored) return stored;
  if (!imapClient) return null;

  const location =
    item.imapUid && item.imapMailbox
      ? { mailbox: item.imapMailbox, uid: item.imapUid }
      : await findMessageByMessageId(imapClient, item.id);
  if (!location) return null;

  await ensureMailboxOpen(imapClient, location.mailbox);
  const meta = await imapClient.fetchOne(location.uid, { envelope: true }, { uid: true });
  const recipients = [...(meta?.envelope?.to || []), ...(meta?.envelope?.cc || [])].map(
    (entry) => entry.address
  );

  const product = productForRecipients(recipients);
  if (product) {
    item.supportInbox = recipients.find((address) => productForInboundAddress(address)) || null;
  }
  return product;
}

/**
 * Items enqueued before product tagging existed and without a prefixed Gmail
 * label. The mailbox they were sent to decides; a Stripe lookup is only the
 * last resort for messages we can no longer read.
 *
 * @param {import('imapflow').ImapFlow | null} imapClient
 * @param {Array<Record<string, unknown>>} unowned
 * @returns {Promise<object[]>} the items that received a product tag; the tag
 * must be persisted even when the owner is another product.
 */
async function tagUnownedItems(imapClient, unowned) {
  const tagged = [];

  for (const item of unowned.slice(0, MAX_UNOWNED_ITEMS_PER_RUN)) {
    let product = await productFromMailbox(imapClient, item);
    let source = 'mailbox';

    if (!product) {
      const lookup = await resolveProductForUntaggedEmail(item.fromEmail);
      product = lookup.checked ? lookup.product : null;
      source = 'stripe';
    }

    if (!product) {
      console.warn(
        `[product-scope] Could not decide product for ${item.fromEmail} (${item.id}); leaving pending.`
      );
      continue;
    }

    item.product = product;
    tagged.push(item);
    console.log(`[product-scope] Tagged ${item.fromEmail} as ${product} (via ${source}).`);
  }

  return tagged;
}

/**
 * Hands an item to the product whose Stripe account actually holds the
 * customer. Answering it here would send our template, From and labels for
 * someone else's product, so the item stays PENDING_ACTION for its owner.
 *
 * @returns {Promise<boolean>} true when the item was re-routed
 */
async function tryRerouteToOwnerProduct(item, stripeErr) {
  if (!isMissingStripeResourceError(stripeErr)) return false;

  // The mailbox wins. If the customer wrote to one of our support addresses the
  // case is ours, and a missing Stripe customer is a data problem for a human,
  // not a reason to answer them under another brand.
  if (productForInboundAddress(item.supportInbox) === PRODUCT_CODE) {
    console.warn(
      `[product-scope] ${item.fromEmail} escribió a ${item.supportInbox} (${PRODUCT_CODE}); no se re-rutea.`
    );
    return false;
  }

  // One hop only: a customer present in two accounts could otherwise bounce
  // between the two crons forever.
  if (item.reroutedFrom) return false;

  const { checked, product, customerId } = await findOwnerProductByEmail(item.fromEmail);
  if (!checked || !product || product === PRODUCT_CODE) return false;

  item.product = product;
  item.status = 'PENDING_ACTION';
  item.reroutedFrom = PRODUCT_CODE;
  // The stored ids belong to our account; hand over the owner's customer and
  // let it resolve the subscription itself.
  item.stripeCustomerId = customerId || null;
  item.stripeSubscriptionId = null;
  item.errorDetails = `Re-routed from ${PRODUCT_CODE} to ${product}: ${stripeErr.message}`;

  console.warn(`[product-scope] Re-routed ${item.fromEmail} to ${product}.`);
  await sendAlertEmail({
    to: alertRecipient,
    subject: `[INFO] Caso re-ruteado a ${product} — ${item.fromEmail}`,
    html: `
      <p>El cron de ${PRODUCT_CODE} no encontró el cliente en su cuenta de Stripe y lo devolvió a la cola con el producto corregido.</p>
      <ul>
        <li><strong>Cliente:</strong> ${item.fromEmail}</li>
        <li><strong>Escribió a:</strong> ${item.supportInbox || '(casilla desconocida)'}</li>
        <li><strong>Producto correcto:</strong> ${product}</li>
        <li><strong>Error Stripe:</strong> ${stripeErr.message}</li>
      </ul>
      <p>El cron de ${product} lo procesará en su próxima corrida.</p>
    `,
  });

  return true;
}

/**
 * Core responder: cancel in Stripe, send templates, update Gmail labels.
 */
export async function runResponder() {
  console.log('Starting customer support email responder...');

  if (!stripe) {
    console.error('Stripe client not initialized. STRIPE_SECRET_KEY missing.');
    return { status: 'SKIPPED', reason: 'missing_stripe', actionsProcessedCount: 0 };
  }
  if (!isEmailConfigured()) {
    console.error('Email client not configured. Set Gmail SMTP (SMTP_USER/SMTP_PASSWORD or IMAP_USER/IMAP_PASSWORD).');
    return { status: 'SKIPPED', reason: 'missing_email', actionsProcessedCount: 0 };
  }

  let imapClient = null;
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const password = process.env.IMAP_PASSWORD;

  if (host && user && password) {
    imapClient = new ImapFlow({
      host,
      port: parseInt(process.env.IMAP_PORT || '993', 10),
      secure: process.env.IMAP_SECURE !== 'false',
      auth: { user, pass: password },
      logger: false,
    });
    try {
      await imapClient.connect();
    } catch (err) {
      console.warn('IMAP connect failed; responder will skip Gmail label updates.', err.message);
      imapClient = null;
    }
  }

  let successCount = 0;
  let failedCount = 0;

  try {
    const queue = await getQueue();
    const allPending = queue.filter((item) => item.status === 'PENDING_ACTION');
    const { mine, others, unowned } = partitionByProduct(allPending);

    // Needs the IMAP client: untagged items are resolved by reading which
    // support address they were sent to.
    const taggedItems = await tagUnownedItems(imapClient, unowned);
    const pendingItems = [...mine, ...taggedItems.filter((item) => item.product === PRODUCT_CODE)];

    console.log(
      `Found ${allPending.length} pending action(s): ${pendingItems.length} for ${PRODUCT_CODE}, ` +
        `${others.length} owned by other products, ${unowned.length} untagged.\n`
    );

    // Anything Gmail says we approved but the queue has lost. Rebuilt from the
    // message itself so it can be answered in this same run.
    const { recovered, skipped } = await recoverOrphanPendingItems({
      client: imapClient,
      queue,
      processEmail,
    });
    const recoveredPending = recovered.filter((item) => item.status === 'PENDING_ACTION');
    if (recovered.length) {
      console.warn(
        `[recover] rebuilt ${recovered.length} orphan item(s), ${recoveredPending.length} actionable` +
          (skipped ? `; ${skipped} left for the next run` : '')
      );
      pendingItems.push(...recoveredPending);

      // A rebuilt item that lands on a terminal status is never handled by the
      // loop below, so its labels have to be settled here. Otherwise it keeps
      // `Pendiente-Respuesta` and gets re-classified, at Gemini's expense,
      // on every single run.
      for (const item of recovered) {
        if (item.status === 'PENDING_ACTION') continue;
        await syncResponderGmailLabels(imapClient, item, item.status);
      }
    }

    /**
     * Only the items this run actually touched go back to the store, so the
     * other two products keep whatever they wrote while this run was in flight.
     */
    const touchedItems = new Set([...pendingItems, ...taggedItems]);

    /**
     * One customer, one mail per run. The same request routinely arrives as
     * several messages — a contact form plus a direct mail, or the customer
     * writing twice — and answering each of them sends the same template three
     * times. The extras inherit whatever outcome their sibling got, so a
     * failure still surfaces on every message instead of looking resolved.
     */
    const primaryByCustomer = new Map();
    const duplicateItems = [];
    for (const item of pendingItems) {
      const key = String(item.fromEmail || '')
        .trim()
        .toLowerCase();
      if (!key) continue;
      if (primaryByCustomer.has(key)) duplicateItems.push(item);
      else primaryByCustomer.set(key, item);
    }

    if (duplicateItems.length) {
      console.log(
        `${duplicateItems.length} duplicate message(s) from customers already handled in this run; ` +
          'labelling only.'
      );
    }

    for (const item of primaryByCustomer.values()) {
      const lang = normalizeSupportLanguage(item.language || 'en');
      const threshold = getMinCancelConfidence();
      console.log(
        `\n--- Responding to Email ID: ${item.id} (${item.fromEmail}) [Lang: ${lang}] classification=${item.classification} confidence=${((item.confidence ?? 0) * 100).toFixed(1)}% threshold=${(threshold * 100).toFixed(0)}% ---`
      );

      try {
        if (item.stripeTag === 'Not-Found') {
          const templatePath = resolveSupportTemplatePath(
            templatesDir,
            'notFound',
            lang
          );

          let html = fs.readFileSync(templatePath, 'utf-8');
          html = html.replace('{{CUSTOMER_EMAIL}}', item.fromEmail);

          await sendCustomerThreadReply(item, { html });

          item.status = 'PROCESSED_NOT_FOUND';
          item.processedAt = new Date().toISOString();
          await syncResponderGmailLabels(imapClient, item, item.status);
          successCount++;
        } else if (item.stripeTag === 'Found') {
          if (!item.stripeSubscriptionId && !item.stripeCustomerId) {
            throw new Error('stripeSubscriptionId is missing for a Found status');
          }

          try {
            assertStripeCancelAllowed(item);
          } catch (guardErr) {
            console.error(`[action-guard] BLOCKED cancel for ${item.fromEmail}:`, guardErr.message);
            await sendAlertEmail({
              to: alertRecipient,
              subject: `[REVISIÓN] Cancelación automática bloqueada — ${item.fromEmail}`,
              html: `
                <p>El respondedor bloqueó una cancelación en Stripe por seguridad:</p>
                <ul>
                  <li><strong>Cliente:</strong> ${item.fromEmail}</li>
                  <li><strong>Clasificación Gemini:</strong> ${item.classification}</li>
                  <li><strong>Confianza:</strong> ${((item.confidence ?? 0) * 100).toFixed(0)}%</li>
                  <li><strong>Motivo:</strong> ${guardErr.message}</li>
                </ul>
                <p>Revisá el mail en Gmail (label WP/Revisión-Humana) y cancelá manualmente si corresponde.</p>
              `,
            });
            item.status = 'NEEDS_HUMAN_REVIEW';
            item.processedAt = new Date().toISOString();
            item.errorDetails = guardErr.message;
            await syncResponderGmailLabels(imapClient, item, item.status);
            failedCount++;
            continue;
          }

          let subscription;
          try {
            const resolved = await cancelOrReuseSubscription(stripe, {
              customerId: item.stripeCustomerId,
              subscriptionId: item.stripeSubscriptionId,
            });
            subscription = resolved.subscription;
            if (!subscription) {
              throw new Error('No cancelable or canceled subscription found for customer');
            }
            if (resolved.alreadyCanceled) {
              console.log(
                `[respond] subscription already canceled for ${item.fromEmail}: ${subscription.id}`
              );
            }
          } catch (stripeErr) {
            console.error(`Stripe subscription cancellation FAILED:`, stripeErr.message);

            if (await tryRerouteToOwnerProduct(item, stripeErr)) {
              continue;
            }

            await sendAlertEmail({
              to: alertRecipient,
              subject: `[ALERTA] Fallo al desuscribir a ${item.fromEmail} en Stripe`,
              html: `
              <h3>Alerta de Soporte - Fallo al cancelar suscripción en Stripe</h3>
              <ul>
                <li><strong>Email Cliente:</strong> ${item.fromEmail}</li>
                <li><strong>Stripe Subscription ID:</strong> ${item.stripeSubscriptionId}</li>
                <li><strong>Error:</strong> ${stripeErr.message}</li>
              </ul>
            `,
            });

            item.status = 'FAILED';
            item.processedAt = new Date().toISOString();
            item.errorDetails = stripeErr.message;
            await syncResponderGmailLabels(imapClient, item, item.status);
            failedCount++;
            continue;
          }

          const periodEnd = subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null;
          const formattedDate = formatDate(periodEnd, lang);

          if (item.classification === 'Desuscripción') {
            const templatePath = resolveSupportTemplatePath(
              templatesDir,
              'unsubscribe',
              lang
            );
            let html = fs.readFileSync(templatePath, 'utf-8');
            html = html
              .replace(/\{\{UNSUSCRIPTION_DATE\}\}/g, formattedDate)
              .replace(/\{\{EXPIRATION_DATE\}\}/g, formattedDate);

            await sendCustomerThreadReply(item, { html });
          } else if (item.classification === 'Desuscripción + Refund') {
            logClassificationDecision({
              fromEmail: item.fromEmail,
              subject: item.subject,
              classification: item.classification,
              confidence: item.confidence ?? 0,
              reasoning: item.classificationReasoning,
              actionGuard: item.actionGuard,
              queueStatus: 'respond_refund_email_sent',
              stripeTag: item.stripeTag,
            });

            let autoRefundOutcome = 'disabled';
            try {
              const auto = await attemptBotAutoRefund(stripe, {
                customerId: item.stripeCustomerId,
                product: PRODUCT_CODE,
              });
              if (auto.executed) {
                autoRefundOutcome = 'executed';
                item.autoRefundId = auto.refund?.id || null;
                item.autoRefundChargeId = auto.charge?.id || null;
                await notifyAutoRefundOutcome({
                  fromEmail: item.fromEmail,
                  subject: item.subject,
                  outcome: 'executed',
                  refundId: auto.refund?.id,
                  chargeId: auto.charge?.id,
                  botCount: auto.counts?.botCount,
                  totalCount: auto.counts?.totalCount,
                });
              } else if (auto.reason === 'cap') {
                autoRefundOutcome = auto.capReason === 'total' ? 'cap_total' : 'cap_bot';
                await notifyAutoRefundOutcome({
                  fromEmail: item.fromEmail,
                  subject: item.subject,
                  outcome: autoRefundOutcome,
                  chargeId: auto.charge?.id,
                  botCount: auto.counts?.botCount,
                  totalCount: auto.counts?.totalCount,
                });
              } else if (auto.reason === 'policy') {
                autoRefundOutcome = 'policy';
                await notifyAutoRefundOutcome({
                  fromEmail: item.fromEmail,
                  subject: item.subject,
                  outcome: 'policy',
                  detail: (auto.details?.reasons || []).join(', '),
                  chargeId: auto.charge?.id,
                });
              } else if (auto.reason === 'disabled') {
                autoRefundOutcome = 'disabled';
                await notifyAutoRefundOutcome({
                  fromEmail: item.fromEmail,
                  subject: item.subject,
                  outcome: 'disabled',
                });
              }
            } catch (refundErr) {
              console.error('[auto-refund] failed:', refundErr.message);
              autoRefundOutcome = 'error';
              await notifyAutoRefundOutcome({
                fromEmail: item.fromEmail,
                subject: item.subject,
                outcome: 'error',
                detail: refundErr.message,
              });
            }
            item.autoRefundOutcome = autoRefundOutcome;

            let receiptUrl = 'https://www.wisdompackets.com/home';
            try {
              const invoices = await stripe.invoices.list({
                customer: item.stripeCustomerId,
                limit: 5,
              });
              const paidInvoice = invoices.data.find((inv) => inv.status === 'paid' && inv.charge);
              if (paidInvoice?.charge) {
                const charge = await stripe.charges.retrieve(paidInvoice.charge);
                if (charge.receipt_url) receiptUrl = charge.receipt_url;
              }
            } catch (invErr) {
              console.warn('Could not retrieve invoice receipt URL.', invErr.message);
            }

            const templatePath = resolveSupportTemplatePath(
              templatesDir,
              'unsubscribeRefund',
              lang
            );
            let html = fs.readFileSync(templatePath, 'utf-8');
            html = html
              .replace(/\{\{REFUND_RECEIPT_URL\}\}/g, receiptUrl)
              .replace(/\{\{UNSUSCRIPTION_DATE\}\}/g, formattedDate)
              .replace(/\{\{EXPIRATION_DATE\}\}/g, formattedDate);

            await sendCustomerThreadReply(item, { html });
          }

          item.status = 'PROCESSED_SUCCESS';
          item.processedAt = new Date().toISOString();
          await syncResponderGmailLabels(imapClient, item, item.status);
          successCount++;
        }
      } catch (err) {
        console.error(`Unexpected error processing item ${item.id}:`, err.message);
        item.status = 'FAILED';
        item.processedAt = new Date().toISOString();
        item.errorDetails = err.message;
        await syncResponderGmailLabels(imapClient, item, item.status);
        failedCount++;
      }
    }

    for (const item of duplicateItems) {
      const primary = primaryByCustomer.get(String(item.fromEmail).trim().toLowerCase());
      item.status = primary?.status || 'NEEDS_HUMAN_REVIEW';
      item.processedAt = new Date().toISOString();
      item.errorDetails = primary?.errorDetails ?? null;
      item.duplicateOf = primary?.id || null;
      await syncResponderGmailLabels(imapClient, item, item.status);
    }

    await upsertQueueItems([...touchedItems]);

    await logRun({
      type: 'EMAIL_RESPONDER',
      status: failedCount > 0 ? 'PARTIAL_SUCCESS' : 'SUCCESS',
      actionsProcessedCount: pendingItems.length,
      successesCount: successCount,
      failuresCount: failedCount,
    });

    return {
      status: failedCount > 0 ? 'PARTIAL_SUCCESS' : 'SUCCESS',
      actionsProcessedCount: pendingItems.length,
      successesCount: successCount,
      failuresCount: failedCount,
    };
  } finally {
    if (imapClient) {
      try {
        await imapClient.logout();
      } catch {
        // ignore
      }
    }
  }
}
