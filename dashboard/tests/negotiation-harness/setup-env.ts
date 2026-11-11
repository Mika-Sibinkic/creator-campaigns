// tests/negotiation-harness/setup-env.ts
//
// MUST be the FIRST import in the harness. negotiation.ts pulls in audit →
// supabase.ts, which constructs a Supabase client at module-load time and
// throws if the env is missing. We set a dummy, UNREACHABLE env here (executed
// before those modules evaluate), force paper-money + the mock model provider
// for determinism, and stub fetch so the audit-log writer can never touch a
// real network or database.
//
// Everything else in the harness (DB + model I/O) is in-memory; nothing here
// reaches out. Hermetic by construction.

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-dummy';
process.env.OPENAI_API_KEY = 'sk-dummy';
process.env.PAYMENTS_MODE = 'paper';
process.env.MODEL_PROVIDER = 'mock';

// audit() is the only path in this harness that would reach fetch (via the
// service-role client). Return an instant empty-OK so it sees no error and
// stays silent — no network, no hang, no writes to a real DB.
//
// Each audit row is also kept in memory (auditActions / auditRows), so a suite
// can assert that an escalation reached the anomaly feed without any network.
export const auditActions: string[] = [];
export const auditRows: Array<{ action?: unknown; metadata?: Record<string, unknown> }> = [];
globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
  if (String(input).includes('/audit_log') && typeof init?.body === 'string') {
    try {
      const parsed = JSON.parse(init.body) as (typeof auditRows)[number] | typeof auditRows;
      for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
        if (typeof r?.action === 'string') auditActions.push(r.action);
        if (r && typeof r === 'object') auditRows.push(r);
      }
    } catch {
      /* not JSON — nothing to record */
    }
  }
  return new Response('[]', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
