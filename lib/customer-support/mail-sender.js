import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { getSupportBrandName, getSupportOutboundEmail } from './support-emails.js';

/**
 * @returns {'gmail' | 'resend'}
 */
export function getEmailProvider() {
  const raw = (process.env.EMAIL_PROVIDER || 'gmail').trim().toLowerCase();
  return raw === 'resend' ? 'resend' : 'gmail';
}

export function isEmailConfigured() {
  if (getEmailProvider() === 'resend') {
    return Boolean(process.env.RESEND_API_KEY);
  }

  const user = process.env.SMTP_USER || process.env.IMAP_USER;
  const pass = process.env.SMTP_PASSWORD || process.env.IMAP_PASSWORD;
  return Boolean(user && pass);
}

function getSmtpConfig() {
  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: {
      user: process.env.SMTP_USER || process.env.IMAP_USER,
      pass: process.env.SMTP_PASSWORD || process.env.IMAP_PASSWORD,
    },
  };
}

let gmailTransporter = null;

function getGmailTransporter() {
  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport(getSmtpConfig());
  }
  return gmailTransporter;
}

/** @param {string | null | undefined} messageId */
export function normalizeMessageId(messageId) {
  if (!messageId?.trim()) return null;
  const trimmed = messageId.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed;
  return `<${trimmed.replace(/^<|>$/g, '')}>`;
}

/** Subject line Gmail uses (with In-Reply-To) to keep conversation threading. */
export function buildReplySubject(originalSubject) {
  const subject = (originalSubject || '').trim() || '(sin asunto)';
  if (/^re:\s/i.test(subject)) return subject;
  return `Re: ${subject}`;
}

/** @param {string | null | undefined} inReplyTo @param {string[] | undefined} references */
export function buildThreadHeaders(inReplyTo, references) {
  const replyId = normalizeMessageId(inReplyTo);
  if (!replyId) return null;

  const refIds = (references || [])
    .map(normalizeMessageId)
    .filter(Boolean);

  if (!refIds.includes(replyId)) {
    refIds.push(replyId);
  }

  return {
    'In-Reply-To': replyId,
    References: refIds.join(' '),
  };
}

/**
 * @param {{
 *   to: string | string[],
 *   subject: string,
 *   html: string,
 *   fromName?: string,
 *   replyTo?: string,
 *   inReplyTo?: string | null,
 *   references?: string[] | null,
 * }} params
 */
export async function sendEmail({
  to,
  subject,
  html,
  fromName,
  replyTo,
  inReplyTo,
  references,
}) {
  if (!isEmailConfigured()) {
    throw new Error(
      getEmailProvider() === 'resend'
        ? 'RESEND_API_KEY missing'
        : 'SMTP/IMAP credentials missing (SMTP_USER + SMTP_PASSWORD or IMAP_USER + IMAP_PASSWORD)'
    );
  }

  const brand = getSupportBrandName();
  const resolvedFromName = fromName || `${brand} Support`;
  const fromAddress = getSupportOutboundEmail();
  const replyToAddress = replyTo || fromAddress;
  const recipients = Array.isArray(to) ? to : [to];
  const threadHeaders = buildThreadHeaders(inReplyTo, references || undefined);

  if (getEmailProvider() === 'resend') {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from: `${resolvedFromName} <${fromAddress}>`,
      to: recipients,
      subject,
      html,
      reply_to: replyToAddress,
      headers: threadHeaders || undefined,
    });
    if (error) throw new Error(error.message);
    return { provider: 'resend', id: data?.id };
  }

  const info = await getGmailTransporter().sendMail({
    from: `${resolvedFromName} <${fromAddress}>`,
    replyTo: replyToAddress,
    to: recipients.join(', '),
    subject,
    html,
    headers: threadHeaders || undefined,
  });

  return { provider: 'gmail', id: info.messageId, response: info.response };
}

export async function sendSupportEmail(params) {
  return sendEmail({
    ...params,
    fromName: params.fromName || `${getSupportBrandName()} Support`,
  });
}

export async function sendAlertEmail(params) {
  return sendEmail({
    ...params,
    fromName: params.fromName || `${getSupportBrandName()} Alerts`,
  });
}

/**
 * Reply to a queued support ticket so Gmail threads it with the original message.
 * @param {{ id?: string, subject?: string, fromEmail: string }} item
 * @param {{ html: string }} params
 */
export async function sendCustomerThreadReply(item, { html }) {
  return sendSupportEmail({
    to: item.fromEmail,
    subject: buildReplySubject(item.subject),
    html,
    inReplyTo: item.id,
  });
}
