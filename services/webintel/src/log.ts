/**
 * Structured JSON logging to stdout, collected by journald.
 *
 * Two rules, both enforced here rather than left to callers:
 *   - keys that look like a credential are redacted, whatever the caller passed;
 *   - page bodies are never logged, only their size.
 */
import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /(token|secret|authorization|cookie|password|passwd|api[-_]?key|bearer|credential)/i;

export type LogFields = Record<string, unknown>;

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string' && value.length > 400) {
      out[key] = `${value.slice(0, 400)}…[${value.length} chars]`;
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redact(value as LogFields);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(
  level: LogLevel = 'info',
  base: LogFields = {},
  write: (line: string) => void = (line) => process.stdout.write(line),
): Logger {
  const emit = (severity: LogLevel, event: string, fields: LogFields = {}): void => {
    if (ORDER[severity] < ORDER[level]) return;
    const payload = {
      ts: new Date().toISOString(),
      level: severity,
      service: 'hermes-webintel',
      event,
      ...redact({ ...base, ...fields }),
    };
    write(`${JSON.stringify(payload)}\n`);
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }, write),
  };
}

/** Turns an unknown throwable into a short, loggable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
