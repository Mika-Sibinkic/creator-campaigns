// tests/logger.test.ts
//
// Hermetic unit test for src/lib/logger.ts. The sink is injected so nothing
// touches stdout; asserts line shape, level gating, child-field merging,
// request-id extraction, and never-throw on hostile meta.
//
// Run: npx tsx tests/logger.test.ts

import { createLogger, requestLogger, _setSink, type LogLevel } from '../src/lib/logger';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

const lines: { parsed: Record<string, unknown>; level: LogLevel }[] = [];
_setSink((line, level) => {
  lines.push({ parsed: JSON.parse(line) as Record<string, unknown>, level });
});

function last(): Record<string, unknown> {
  return lines[lines.length - 1].parsed;
}

async function main() {
  delete process.env.LOG_LEVEL;

  // 1. Line shape: ts/level/scope/msg + meta merged flat.
  lines.length = 0;
  const log = createLogger('test-scope');
  log.info('hello', { count: 3 });
  assert(lines.length === 1, 'info emits one line');
  assert(last().level === 'info', 'line carries level');
  assert(last().scope === 'test-scope', 'line carries scope');
  assert(last().msg === 'hello', 'line carries msg');
  assert(last().count === 3, 'meta merges onto the line');
  assert(
    typeof last().ts === 'string' && !Number.isNaN(Date.parse(last().ts as string)),
    'ts is a valid ISO timestamp',
  );

  // 2. Level gating: default threshold is info → debug suppressed.
  lines.length = 0;
  log.debug('invisible');
  assert(lines.length === 0, 'debug suppressed at default level');
  process.env.LOG_LEVEL = 'debug';
  log.debug('visible');
  assert(lines.length === 1 && last().msg === 'visible', 'LOG_LEVEL=debug re-enables debug');
  process.env.LOG_LEVEL = 'error';
  log.warn('hidden');
  assert(lines.length === 1, 'LOG_LEVEL=error suppresses warn');
  log.error('boom');
  assert(last().msg === 'boom' && last().level === 'error', 'error always emits at error level');
  delete process.env.LOG_LEVEL;

  // 3. Child loggers: ambient fields carry, later fields win.
  lines.length = 0;
  const child = log.child({ campaign_id: 'c-1', firm_id: 'f-1' });
  child.info('scoped');
  assert(last().campaign_id === 'c-1' && last().firm_id === 'f-1', 'child fields on every line');
  const grandchild = child.child({ campaign_id: 'c-2' });
  grandchild.info('rescoped');
  assert(last().campaign_id === 'c-2', 'grandchild overrides parent field');
  assert(last().firm_id === 'f-1', 'grandchild keeps inherited field');

  // 4. requestLogger picks up x-request-id (the audit-correlation header).
  lines.length = 0;
  const req = new Request('http://localhost/x', {
    headers: { 'x-request-id': 'req-abc' },
  });
  requestLogger('route', req).info('handled');
  assert(last().request_id === 'req-abc', 'request_id extracted from header');
  requestLogger('route').info('no header');
  assert(!('request_id' in last()), 'no request_id key when header absent');

  // 5. Hostile meta never throws: Error flattens, circular degrades.
  lines.length = 0;
  log.error('with error', { err: new Error('kaboom') });
  assert(last().err === 'kaboom', 'Error meta flattens to message');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  let threw = false;
  try {
    log.info('circular', { circular });
  } catch {
    threw = true;
  }
  assert(!threw, 'circular meta does not throw');
  assert(last().logger_note === 'meta was not serializable', 'circular meta degrades with a note');

  // 6. Severity → sink channel mapping (Vercel level tagging).
  lines.length = 0;
  log.warn('w');
  assert(lines[0].level === 'warn', 'warn routed to warn channel');

  console.log(`logger test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
