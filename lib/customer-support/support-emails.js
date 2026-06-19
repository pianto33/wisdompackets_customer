/** Outbound address for all automated replies. */
export const SUPPORT_OUTBOUND_EMAIL = 'noreply@wisdompackets.com';

export function getSupportOutboundEmail() {
  return (process.env.RESEND_FROM_EMAIL || SUPPORT_OUTBOUND_EMAIL).trim().toLowerCase();
}

export function getSupportBrandName() {
  return process.env.SUPPORT_BRAND_NAME || 'WisdomPackets';
}
