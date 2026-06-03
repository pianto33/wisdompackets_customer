export function runResponder(): Promise<{
  status: string;
  reason?: string;
  actionsProcessedCount: number;
  successesCount?: number;
  failuresCount?: number;
}>;
