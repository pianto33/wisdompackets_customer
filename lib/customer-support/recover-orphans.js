/**
 * Safety net for items the classifier enqueued but the responder can no longer
 * find in the queue.
 *
 * `Pendiente-Respuesta` is only ever applied by our own classifier, and it
 * means "this one is approved, answer it". So a message carrying that label
 * with no matching queue entry is not a judgement call that went to a human —
 * it is a lost write, and without this it would sit unanswered forever.
 *
 * Recovery re-runs the classifier on the original message, which costs a Gemini
 * call, hence the per-run cap.
 */

import { simpleParser } from 'mailparser';
import { ensureMailboxOpen, findSupportRecipient } from './imap-utils.js';
import { PRODUCT_CODE, productForInboundAddress } from './product-scope.js';

const PENDING_LABEL = `${PRODUCT_CODE}/Pendiente-Respuesta`;
const MAILBOX = '[Gmail]/All Mail';

/** Cheap enough to scan, bounded so a mislabelled backlog cannot stall a run. */
const MAX_CANDIDATES_SCANNED = 60;

function normalizeMessageId(value) {
  return String(value || '')
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase();
}

/**
 * @param {{
 *   client: import('imapflow').ImapFlow | null,
 *   queue: Record<string, unknown>[],
 *   processEmail: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *   limit?: number,
 * }} input
 * @returns {Promise<{ recovered: object[], scanned: number, skipped: number }>}
 */
export async function recoverOrphanPendingItems({ client, queue, processEmail, limit = 5 }) {
  if (!client) return { recovered: [], scanned: 0, skipped: 0 };

  const known = new Set((queue || []).map((item) => normalizeMessageId(item?.id)));

  await ensureMailboxOpen(client, MAILBOX);
  const uids = await client.search({ gmraw: `label:"${PENDING_LABEL}"` }, { uid: true });
  if (!uids?.length) return { recovered: [], scanned: 0, skipped: 0 };

  // Newest first: a lost item is almost always from the last few runs.
  const candidates = [...uids].sort((a, b) => b - a).slice(0, MAX_CANDIDATES_SCANNED);

  const recovered = [];
  let skipped = 0;

  for (const uid of candidates) {
    if (recovered.length >= limit) {
      skipped++;
      continue;
    }

    try {
      const meta = await client.fetchOne(uid, { envelope: true }, { uid: true });
      const messageId = normalizeMessageId(meta?.envelope?.messageId);
      if (!messageId || known.has(messageId)) continue;

      const download = await client.download(uid, undefined, { uid: true });
      const parsed = await simpleParser(download.content);

      const supportInbox = findSupportRecipient(parsed);
      if (productForInboundAddress(supportInbox) !== PRODUCT_CODE) continue;

      const fromEmail = parsed.from?.value?.[0]?.address;
      if (!fromEmail) continue;

      console.warn(
        `[recover] ${fromEmail} carries ${PENDING_LABEL} but is missing from the queue; re-classifying.`
      );

      const item = await processEmail({
        messageId: parsed.messageId || `imap_uid_${MAILBOX}_${uid}`,
        subject: parsed.subject || '',
        fromEmail,
        body: parsed.text || parsed.html || '',
        imapUid: uid,
        imapMailbox: MAILBOX,
        supportInbox,
        queue,
      });

      recovered.push(item);
      known.add(normalizeMessageId(item.id));
    } catch (err) {
      console.error(`[recover] UID ${uid} could not be recovered:`, err.message);
    }
  }

  return { recovered, scanned: candidates.length, skipped };
}
