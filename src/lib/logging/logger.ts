/**
 * Structured JSON logging with secret redaction.
 * One line per event so runs can be grepped/replayed later.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERN = /(api[_-]?key|apikey|token|secret|password|authorization|bearer)/i;

function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_PATTERN.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    // Redact anything that looks like a long opaque credential.
    //
    // Les préfixes `sk`/`rk`/`pk`/`ghp` exigent le SÉPARATEUR qui les suit dans
    // tous les formats réels (`sk-`, `sk_live_`, `sk-ant-`, `rk_live_`,
    // `pk_live_`, `ghp_`). Sans lui, la règle mangeait des mots ordinaires
    // commençant par « sk » : `skipped_outgoing`, `skipped_pre_outreach` et
    // trois autres codes de refus du rail entrant sortaient en `[redacted]`,
    // ce qui détruisait silencieusement la donnée de diagnostic qu'ils
    // portaient. Aucun format de clé connu n'est perdu au passage — `xox…` et
    // `Bearer ` gardent exactement la forme qu'ils avaient.
    if (/^(?:(?:sk|rk|pk|ghp)[-_]|xox|Bearer)[-_A-Za-z0-9]{12,}$/.test(value)) return '[redacted]';
    return value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function threshold(): number {
  const raw = (process.env.OUTBOUND_LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[level] < threshold()) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(redact(bindings) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(record);
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger = createLogger({ app: 'hermes' });
