export function processEmail(args: {
  messageId: string;
  subject: string;
  fromEmail: string;
  body: string;
  imapUid?: number | null;
  imapMailbox?: string | null;
}): Promise<Record<string, unknown>>;

export const WP_LABELS: Record<string, string>;
export const ALL_WP_LABELS: string[];

export function runClassifier(): Promise<{
  status: string;
  emailsProcessedCount: number;
  errorsCount: number;
}>;

export function isWithinNewMexicoBusinessHours(): boolean;

export function getQueue(): Promise<unknown[]>;
export function saveQueue(queue: unknown[]): Promise<void>;
export function logRun(details: Record<string, unknown>): Promise<void>;
