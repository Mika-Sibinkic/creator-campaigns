// src/lib/logger.ts
//
// Zero-dependency structured logger. One JSON object per line to stdout /
// stderr (Vercel captures both and tags severity from the console method), so
// log search stops being "grep prose" and becomes "filter on fields".
//
// Line shape:
//   { ts, level, scope, request_id?, campaign_id?, firm_id?, msg, ...meta }
//
// Doctrine:
//   - NEVER throws. A logging failure must not take down a money path; an
//     unserializable meta value degrades to its String() form.
//   - No secrets. Callers pass ids and statuses, not keys or bodies. The
//     logger does not scrub (that is audit.ts's PII job) — it just makes the
//     discipline cheap by taking structured fields instead of interpolation.
//   - `child()` carries request scoping: routes build one logger per request
//     (reusing the same x-request-id that audit.ts threads into audit_log
//     metadata, so a log line and an audit row correlate on request_id) and
//     hand children to library code.
//   - LOG_LEVEL env gates verbosity (default 'info'; 'debug' opts in).
//   - The sink is injectable (`_setSink`) so tests assert emitted lines
//     without capturing stdout.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Ambient fields attached to every line a logger (and its children) emits. */
export interface LogFields {
  request_id?: string;
  campaign_id?: string;
  firm_id?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** New logger with `fields` merged onto this one's ambient fields. */
  child(fields: LogFields): Logger;
}

type Sink = (line: string, level: LogLevel) => void;

/** Default sink: console, mapped by severity so Vercel's log level matches. */
const consoleSink: Sink = (line, level) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

let sink: Sink = consoleSink;

/** Test seam. Pass null to restore the console sink. */
export function _setSink(fn: Sink | null): void {
  sink = fn ?? consoleSink;
}

function minRank(): number {
  const raw = (process.env.LOG_LEVEL ?? '').trim().toLowerCase() as LogLevel;
  return LEVEL_RANK[raw] ?? LEVEL_RANK.info;
}

/** Meta values must never break the line. Errors flatten to their message. */
function safeValue(v: unknown): unknown {
  if (v instanceof Error) return v.message;
  return v;
}

function emit(
  level: LogLevel,
  scope: string,
  fields: LogFields,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  try {
    if (LEVEL_RANK[level] < minRank()) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      scope,
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) record[k] = safeValue(v);
    }
    record.msg = msg;
    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        if (v !== undefined) record[k] = safeValue(v);
      }
    }
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // Circular / non-serializable meta — degrade rather than drop the event.
      line = JSON.stringify({
        ts: record.ts,
        level,
        scope,
        msg,
        logger_note: 'meta was not serializable',
      });
    }
    sink(line, level);
  } catch {
    // A broken sink must never cascade into the caller.
  }
}

export function createLogger(scope: string, fields: LogFields = {}): Logger {
  return {
    debug: (msg, meta) => emit('debug', scope, fields, msg, meta),
    info: (msg, meta) => emit('info', scope, fields, msg, meta),
    warn: (msg, meta) => emit('warn', scope, fields, msg, meta),
    error: (msg, meta) => emit('error', scope, fields, msg, meta),
    child: (extra) => createLogger(scope, { ...fields, ...extra }),
  };
}

/**
 * Request-scoped logger: picks up the `x-request-id` the middleware/client
 * already sends (the same header audit.ts persists into audit_log metadata),
 * so one id joins the log stream, the audit trail and a client bug report.
 */
export function requestLogger(
  scope: string,
  req?: Request,
  fields: LogFields = {},
): Logger {
  const requestId = req?.headers.get('x-request-id') ?? undefined;
  return createLogger(scope, {
    ...(requestId ? { request_id: requestId } : {}),
    ...fields,
  });
}
