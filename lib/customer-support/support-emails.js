/** Outbound address for all automated replies. */
export const SUPPORT_OUTBOUND_EMAIL = 'noreply@wisdompackets.com';

export function getSupportOutboundEmail() {
  const raw =
    process.env.MAIL_FROM_ADDRESS ||
    process.env.RESEND_FROM_EMAIL ||
    SUPPORT_OUTBOUND_EMAIL;
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

export function getSupportBrandName() {
  return process.env.SUPPORT_BRAND_NAME || 'WisdomPackets';
}
