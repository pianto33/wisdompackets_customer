const INFO_EMAIL = 'info@wisdompackets.com';

const MAILBOXES_TO_SCAN = ['INBOX', '[Gmail]/All Mail', 'WisdomPackets Support'];

/**
 * @param {import('mailparser').ParsedMail} parsed
 */
export function extractInfoRecipientEmails(parsed) {
  const toEmails =
    parsed.to && parsed.to.value ? parsed.to.value.map((t) => (t.address || '').toLowerCase()) : [];

  const deliveredTo = parsed.headers.get('delivered-to');
  if (deliveredTo) {
    const val = typeof deliveredTo === 'string' ? deliveredTo : deliveredTo.value || '';
    toEmails.push((typeof val === 'string' ? val : '').toLowerCase());
  }
  const xForwardedTo = parsed.headers.get('x-forwarded-to');
  if (xForwardedTo) {
    const val = typeof xForwardedTo === 'string' ? xForwardedTo : xForwardedTo.value || '';
    toEmails.push((typeof val === 'string' ? val : '').toLowerCase());
  }

  return toEmails;
}

export function isEmailToInfo(parsed) {
  return extractInfoRecipientEmails(parsed).some((email) => email.includes(INFO_EMAIL));
}

export { MAILBOXES_TO_SCAN };

/**
 * Find a message UID by Message-ID across support mailboxes.
 * @param {import('imapflow').ImapFlow} client
 * @param {string} messageId
 * @returns {Promise<{ mailbox: string, uid: number } | null>}
 */
export async function findMessageByMessageId(client, messageId) {
  if (!messageId) return null;

  const normalized = messageId.replace(/^<|>$/g, '');

  for (const mailbox of MAILBOXES_TO_SCAN) {
    try {
      await client.mailboxOpen(mailbox);
      const uids = await client.search({
        header: { 'message-id': normalized },
      });
      if (uids.length > 0) {
        return { mailbox, uid: uids[0] };
      }
    } catch {
      // mailbox missing
    }
  }

  return null;
}

/**
 * @param {import('imapflow').ImapFlow} client
 * @param {{ mailbox: string, uid: number } | null} location
 * @param {{ add: string[], remove: string[] }} labelUpdate
 */
export async function applyLabelUpdateAtLocation(client, location, labelUpdate) {
  if (!location) return;

  const { addGmailLabels, removeGmailLabels } = await import('./gmail-labels.js');

  await client.mailboxOpen(location.mailbox);
  if (labelUpdate.remove?.length) {
    await removeGmailLabels(client, location.uid, labelUpdate.remove);
  }
  if (labelUpdate.add?.length) {
    await addGmailLabels(client, location.uid, labelUpdate.add);
  }
}
