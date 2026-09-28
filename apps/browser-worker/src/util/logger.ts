/**
 * Structured JSON logging with the correlation identifiers the platform traces on.
 * One line per event, machine-readable, and never carrying an unmasked secret —
 * callers pass values through the masker before they reach here.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  correlationId?: string;
  executionId?: string;
  discoveryRunId?: string;
  testCaseId?: string;
  projectId?: string;
  tenantId?: string;
  jobId?: string;
  [key: string]: unknown;
}

export class Logger {
  constructor(
    private readonly minLevel: LogLevel,
    private readonly base: LogContext = {},
    private readonly sink: (line: string) => void = line => process.stdout.write(line + '\n')
  ) {}

  /** Derives a logger that carries extra context on every line it writes. */
  child(context: LogContext): Logger {
    return new Logger(this.minLevel, { ...this.base, ...context }, this.sink);
  }

  debug(message: string, context?: LogContext): void { this.write('debug', message, context); }
  info(message: string, context?: LogContext): void { this.write('info', message, context); }
  warn(message: string, context?: LogContext): void { this.write('warn', message, context); }

  error(message: string, error?: unknown, context?: LogContext): void {
    const details = error instanceof Error
      ? { error: error.message, stack: error.stack }
      : error !== undefined ? { error: String(error) } : {};
    this.write('error', message, { ...context, ...details });
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    this.sink(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: 'qanxt-browser-worker',
      message,
      ...this.base,
      ...context
    }));
  }
}
