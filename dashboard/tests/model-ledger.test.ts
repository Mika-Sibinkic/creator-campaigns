// tests/model-ledger.test.ts
//
// Hermetic test for the complete() → api_ledger cost trail
// (src/lib/model-provider.ts). Providers are registered mocks; the ledger
// writer is injected via setLedgerWriter — no network, no Supabase.
//
// Closes the "negotiation-path model spend writes ZERO api_ledger rows" gap:
// asserts every complete() call produces exactly one ledger entry carrying
// the serving provider, the caller's purpose label, token usage, priced cost
// and latency — including after a failover hop.
//
// Run: npx tsx tests/model-ledger.test.ts

import type { LedgerEntry } from '../src/lib/api-ledger';
import {
  complete,
  registerProvider,
  setLedgerWriter,
  estimateModelCostUsd,
} from '../src/lib/model-provider';

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

async function main() {
  // Hermeticity guard — a dev shell exporting real keys must not extend the
  // failover chain into a live vendor.
  process.env.MODEL_FALLBACK_CHAIN = '';

  const entries: LedgerEntry[] = [];
  setLedgerWriter(async (e) => {
    entries.push(e);
  });

  // ── 1. Object-form provider: usage + model land on the row, priced. ──────
  registerProvider('mock-usage', async () => ({
    text: 'hello',
    usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
    model: 'gpt-4o-2024-08-06',
  }));
  process.env.MODEL_PROVIDER = 'mock-usage';

  const s = await complete({ system: 'sys', user: 'u', purpose: 'negotiation.classify' });
  assert(s === 'hello', 'text passthrough with object-form provider');
  assert(entries.length === 1, 'one ledger entry per complete() call');
  const e1 = entries[0];
  assert(e1.source === 'mock-usage', 'source = serving provider');
  assert(e1.endpoint === 'negotiation.classify', 'endpoint = caller purpose');
  assert(e1.campaign_id === null, 'campaign_id null for model calls');
  // 1M in @ $2.50/M + 0.5M out @ $10/M = 2.5 + 5 = $7.50
  assert(Math.abs(e1.cost_usd - 7.5) < 1e-9, `cost priced from usage (got ${e1.cost_usd})`);
  assert(typeof e1.latency_ms === 'number' && e1.latency_ms >= 0, 'latency_ms recorded');
  const m1 = e1.request_meta as Record<string, unknown>;
  assert(m1.prompt_tokens === 1_000_000, 'prompt_tokens on request_meta');
  assert(m1.completion_tokens === 500_000, 'completion_tokens on request_meta');
  assert(m1.model === 'gpt-4o-2024-08-06', 'model on request_meta');
  assert(m1.pricing_known === true, 'pricing_known true for a priced model');

  // ── 2. Legacy string-form provider: still ledgered, unpriced. ────────────
  registerProvider('mock-plain', async () => 'plain');
  process.env.MODEL_PROVIDER = 'mock-plain';
  entries.length = 0;
  await complete({ system: 'sys', user: 'u' });
  assert(entries.length === 1, 'string-form provider still writes a ledger row');
  assert(entries[0].endpoint === 'unlabeled', "no purpose → endpoint 'unlabeled'");
  assert(entries[0].cost_usd === 0, 'no usage → cost 0');
  const m2 = entries[0].request_meta as Record<string, unknown>;
  assert(m2.pricing_known === false, 'no usage → pricing_known false');

  // ── 3. Failover: the row names the provider that actually served. ────────
  registerProvider('mock-down', async () => {
    const err = new Error('rate limited') as Error & { status: number };
    err.status = 429;
    throw err;
  });
  registerProvider('mock-backup', async () => ({
    text: 'served-by-backup',
    usage: { prompt_tokens: 10, completion_tokens: 10 },
    model: 'gemini-2.0-flash',
  }));
  process.env.MODEL_PROVIDER = 'mock-down';
  process.env.MODEL_FALLBACK_CHAIN = 'mock-backup';
  entries.length = 0;
  const s3 = await complete({ system: 'sys', user: 'u', purpose: 'negotiation.counter_copy' });
  assert(s3 === 'served-by-backup', 'failover still returns text');
  assert(entries.length === 1, 'failover writes exactly one row (the success)');
  assert(entries[0].source === 'mock-backup', 'row names the provider that served, not the configured one');
  const m3 = entries[0].request_meta as Record<string, unknown>;
  assert(m3.attempt === 2, 'attempt index records the failover hop');
  process.env.MODEL_FALLBACK_CHAIN = '';

  // ── 4. A ledger writer that throws must not break completion. ───────────
  setLedgerWriter(async () => {
    throw new Error('ledger down');
  });
  process.env.MODEL_PROVIDER = 'mock-plain';
  let threw = false;
  let out = '';
  try {
    out = await complete({ system: 'sys', user: 'u' });
  } catch {
    threw = true;
  }
  assert(!threw && out === 'plain', 'ledger failure never blocks the completion');
  setLedgerWriter(null);

  // ── 5. estimateModelCostUsd edges. ───────────────────────────────────────
  assert(
    estimateModelCostUsd('unknown-model-x', { prompt_tokens: 5, completion_tokens: 5 }).pricing_known === false,
    'unknown model → pricing_known false',
  );
  assert(
    estimateModelCostUsd(null, { prompt_tokens: 5 }).cost_usd === 0,
    'null model → cost 0',
  );
  const gem = estimateModelCostUsd('gemini-2.5-flash', {
    prompt_tokens: 1_000_000,
    completion_tokens: 0,
  });
  assert(gem.pricing_known && Math.abs(gem.cost_usd - 0.3) < 1e-9, 'prefix match prices gemini-2.5-flash input');

  // ── 6. Attribution: the caller's campaign_id reaches the row. ───────────
  // Every LLM row used to be orphaned (campaign_id was hardcoded null), so
  // LLM spend could not be grouped by campaign and "what did this deal cost
  // to negotiate" was unanswerable by construction — which is the entire
  // reason this ledgering exists.
  const CAMPAIGN_ID = '11111111-2222-3333-4444-555555555555';
  setLedgerWriter(async (e) => {
    entries.push(e);
  });
  registerProvider('mock-attrib', async () => ({
    text: 'attributed',
    usage: { prompt_tokens: 2_000_000, completion_tokens: 1_000_000 },
    model: 'gpt-4o-2024-08-06',
  }));
  process.env.MODEL_PROVIDER = 'mock-attrib';
  entries.length = 0;
  await complete({
    system: 'sys',
    user: 'u',
    purpose: 'qualify.screen',
    campaign_id: CAMPAIGN_ID,
  });
  assert(entries.length === 1, 'attributed call writes exactly one ledger row');
  assert(entries[0].campaign_id === CAMPAIGN_ID, 'caller campaign_id reaches the ledger row');
  assert(entries[0].endpoint === 'qualify.screen', 'purpose maps to api_ledger.endpoint');
  // 2M in @ $2.50/M + 1M out @ $10/M = 5 + 10 = $15 — attribution does not
  // cost the row its token pricing.
  assert(
    Math.abs(entries[0].cost_usd - 15) < 1e-9,
    `attributed row is still token-priced (got ${entries[0].cost_usd})`,
  );

  // An explicit null stays null (the DB column's real "no campaign" value).
  entries.length = 0;
  await complete({ system: 'sys', user: 'u', purpose: 'qualify.screen', campaign_id: null });
  assert(entries[0].campaign_id === null, 'explicit null campaign_id stays null');

  // Schema mode is the shape every discovery/draft/negotiation caller uses,
  // and the row is written BEFORE the JSON parse — so a provider that answers
  // with unparseable content still leaves its attributed cost on the books.
  entries.length = 0;
  let parseThrew = false;
  try {
    await complete({
      system: 'sys',
      user: 'u',
      schema: { subject: 'string' },
      purpose: 'outreach.initial_draft',
      campaign_id: CAMPAIGN_ID,
    });
  } catch {
    parseThrew = true;
  }
  assert(parseThrew, 'schema mode still rejects non-JSON provider output');
  assert(entries.length === 1, 'a call billed but unparseable is still ledgered');
  assert(
    entries[0].campaign_id === CAMPAIGN_ID && entries[0].endpoint === 'outreach.initial_draft',
    'unparseable-output row keeps campaign attribution and the purpose label',
  );

  // Failover: attribution survives the hop to another vendor.
  process.env.MODEL_PROVIDER = 'mock-down';
  process.env.MODEL_FALLBACK_CHAIN = 'mock-backup';
  entries.length = 0;
  await complete({
    system: 'sys',
    user: 'u',
    purpose: 'negotiation.counter_copy',
    campaign_id: CAMPAIGN_ID,
  });
  assert(entries[0].source === 'mock-backup', 'failover row names the serving provider');
  assert(
    entries[0].campaign_id === CAMPAIGN_ID,
    'campaign attribution survives a failover hop',
  );
  process.env.MODEL_FALLBACK_CHAIN = '';
  setLedgerWriter(null);

  console.log(`model-ledger test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
