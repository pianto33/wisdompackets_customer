import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ImapFlow } from 'imapflow';
import Stripe from 'stripe';
import { Resend } from 'resend';
import { getQueue, saveQueue, logRun } from './queue-store.js';
import { getResponderOutcomeLabels } from './gmail-labels.js';
import { findMessageByMessageId, applyLabelUpdateAtLocation } from './imap-utils.js';
import { assertStripeCancelAllowed } from './action-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(__dirname, 'templates');

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const alertRecipient = process.env.ALERT_EMAIL_RECIPIENT || 'pianto33.tp@gmail.com';
const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@wisdompackets.com';

function formatDate(dateString, language = 'en') {
  if (language === 'es') {
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
 * Core responder: cancel in Stripe, send templates, update Gmail labels.
 */
export async function runResponder() {
  console.log('Starting customer support email responder...');

  if (!stripe) {
    console.error('Stripe client not initialized. STRIPE_SECRET_KEY missing.');
    return { status: 'SKIPPED', reason: 'missing_stripe', actionsProcessedCount: 0 };
  }
  if (!resend) {
    console.error('Resend client not initialized. RESEND_API_KEY missing.');
    return { status: 'SKIPPED', reason: 'missing_resend', actionsProcessedCount: 0 };
  }

  const queue = await getQueue();
  const pendingItems = queue.filter((item) => item.status === 'PENDING_ACTION');

  console.log(`Found ${pendingItems.length} pending support actions to process.\n`);

  let successCount = 0;
  let failedCount = 0;

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

  try {
    for (const item of pendingItems) {
      const lang = item.language || 'en';
      console.log(`\n--- Responding to Email ID: ${item.id} (${item.fromEmail}) [Lang: ${lang}] ---`);

      try {
        if (item.stripeTag === 'Not-Found') {
          const templateName = lang === 'es' ? 'suscription-not-found.html' : 'suscription-not-found-en.html';
          const subject =
            lang === 'es' ? 'Suscripción no encontrada - WisdomPackets' : 'Subscription Not Found - WisdomPackets';

          const templatePath = path.join(templatesDir, templateName);
          if (!fs.existsSync(templatePath)) {
            throw new Error(`Template not found at ${templatePath}`);
          }

          let html = fs.readFileSync(templatePath, 'utf-8');
          html = html.replace('{{CUSTOMER_EMAIL}}', item.fromEmail);

          await resend.emails.send({
            from: `WisdomPackets Support <${fromEmail}>`,
            to: item.fromEmail,
            subject,
            html,
          });

          item.status = 'PROCESSED_NOT_FOUND';
          item.processedAt = new Date().toISOString();
          await syncResponderGmailLabels(imapClient, item, item.status);
          successCount++;
        } else if (item.stripeTag === 'Found') {
          if (!item.stripeSubscriptionId) {
            throw new Error('stripeSubscriptionId is missing for a Found status');
          }

          try {
            assertStripeCancelAllowed(item);
          } catch (guardErr) {
            console.error(`[action-guard] BLOCKED cancel for ${item.fromEmail}:`, guardErr.message);
            await resend.emails.send({
              from: `WisdomPackets Alerts <${fromEmail}>`,
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
            subscription = await stripe.subscriptions.cancel(item.stripeSubscriptionId);
          } catch (stripeErr) {
            console.error(`Stripe subscription cancellation FAILED:`, stripeErr.message);

            await resend.emails.send({
              from: `WisdomPackets Alerts <${fromEmail}>`,
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
            const templateName =
              lang === 'es' ? 'succesful-unsuscription.html' : 'succesful-unsuscription-en.html';
            const subject =
              lang === 'es'
                ? 'Confirmación de cancelación de membresía - WisdomPackets'
                : 'Membership Cancellation Confirmation - WisdomPackets';
            const templatePath = path.join(templatesDir, templateName);
            let html = fs.readFileSync(templatePath, 'utf-8');
            html = html
              .replace(/\{\{UNSUSCRIPTION_DATE\}\}/g, formattedDate)
              .replace(/\{\{EXPIRATION_DATE\}\}/g, formattedDate);

            await resend.emails.send({
              from: `WisdomPackets Support <${fromEmail}>`,
              to: item.fromEmail,
              subject,
              html,
            });
          } else if (item.classification === 'Desuscripción + Refund') {
            const templateName =
              lang === 'es'
                ? 'succesful-unsuscription-refund-link.html'
                : 'succesful-unsuscription-refund-link-en.html';
            const subject =
              lang === 'es'
                ? 'Cancelación de membresía y reembolso iniciado - WisdomPackets'
                : 'Membership Cancellation and Refund Initiated - WisdomPackets';

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

            const templatePath = path.join(templatesDir, templateName);
            let html = fs.readFileSync(templatePath, 'utf-8');
            html = html
              .replace(/\{\{REFUND_RECEIPT_URL\}\}/g, receiptUrl)
              .replace(/\{\{UNSUSCRIPTION_DATE\}\}/g, formattedDate)
              .replace(/\{\{EXPIRATION_DATE\}\}/g, formattedDate);

            await resend.emails.send({
              from: `WisdomPackets Support <${fromEmail}>`,
              to: item.fromEmail,
              subject,
              html,
            });
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

    await saveQueue(queue);

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
