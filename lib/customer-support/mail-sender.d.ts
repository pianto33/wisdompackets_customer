export function isEmailConfigured(): boolean;
export function normalizeMessageId(messageId: string | null | undefined): string | null;
export function buildReplySubject(originalSubject: string | null | undefined): string;
export function buildThreadHeaders(
  inReplyTo: string | null | undefined,
  references?: string[] | null
): { 'In-Reply-To': string; References: string } | null;
export function sendEmail(params: {
  to: string | string[];
  subject: string;
  html: string;
  fromName?: string;
  replyTo?: string;
  inReplyTo?: string | null;
  references?: string[] | null;
}): Promise<{ provider: string; id?: string; response?: string }>;
export function sendSupportEmail(
  params: Parameters<typeof sendEmail>[0]
): ReturnType<typeof sendEmail>;
export function sendAlertEmail(params: Parameters<typeof sendEmail>[0]): ReturnType<typeof sendEmail>;
export function sendCustomerThreadReply(
  item: { id?: string; subject?: string; fromEmail: string },
  params: { html: string }
): ReturnType<typeof sendEmail>;
