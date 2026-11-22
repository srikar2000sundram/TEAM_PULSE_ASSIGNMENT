import { getCorrelationId } from './correlation.js';
import { createRedactor, type RedactionOptions, type Redactor } from './redact.js';

export const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof logLevels)[number];
export type LogLevelSetting = LogLevel | 'silent';

const SEVERITY: Record<LogLevelSetting, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};

export type LogFields = Record<string, unknown>;

/** Same call shapes as pino, so Fastify and other libraries can use it directly. */
export interface LogMethod {
  (message: string): void;
  (fields: LogFields, message?: string): void;
}

export interface Logger {
  readonly level: LogLevelSetting;
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions extends RedactionOptions {
  /** Logical source of the line, for example `habit-service`. Becomes the `service` field. */
  readonly service: string;
  readonly level?: LogLevelSetting;
  /** Receives one JSON line per log call. Defaults to standard output. */
  readonly write?: (line: string) => void;
  /** Injectable for deterministic tests. */
  readonly now?: () => Date;
}

const defaultWrite = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * Structured JSON logger: one line per event, shaped for CloudWatch Logs Insights.
 * Fields are redacted before serialisation, and the current correlation id is attached
 * automatically. Output example:
 * {"level":"info","time":"2026-11-20T08:15:00.000Z","service":"habit-service",
 *  "correlationId":"...","msg":"habit created","habitId":"..."}
 */
export function createLogger(options: LoggerOptions): Logger {
  const redact = createRedactor(options);
  return build(options, redact, {});
}

function build(options: LoggerOptions, redact: Redactor, bindings: LogFields): Logger {
  const threshold = SEVERITY[options.level ?? 'info'];
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());

  const method =
    (level: LogLevel): LogMethod =>
    (first: string | LogFields, second?: string): void => {
      if (SEVERITY[level] < threshold) return;

      const fields = typeof first === 'string' ? {} : first;
      const message = typeof first === 'string' ? first : second;
      const correlationId = getCorrelationId();

      // Reserved fields are written last so callers cannot overwrite them.
      const record = {
        ...(redact({ ...bindings, ...fields }) as LogFields),
        level,
        time: now().toISOString(),
        service: options.service,
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(message === undefined ? {} : { msg: message }),
      };
      write(safeStringify(record));
    };

  return {
    level: options.level ?? 'info',
    trace: method('trace'),
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
    fatal: method('fatal'),
    child: (extra) => build(options, redact, { ...bindings, ...extra }),
  };
}

/** Logging must never throw: fall back to a minimal line if serialisation fails (for example BigInt). */
function safeStringify(record: LogFields): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({
      level: record.level,
      time: record.time,
      service: record.service,
      msg: 'log serialisation failed',
    });
  }
}
