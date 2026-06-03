export class BetterStackService {
  isEnabled(): boolean;
  sendLog(
    level: 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<void>;
  info(message: string, metadata?: Record<string, unknown>): Promise<void>;
  warn(message: string, metadata?: Record<string, unknown>): Promise<void>;
  error(message: string, metadata?: Record<string, unknown>): Promise<void>;
}

export const betterStack: BetterStackService;
export function enableBetterStackConsoleMirror(): void;
export function logRunToBetterStack(entry: Record<string, unknown>): Promise<void>;
