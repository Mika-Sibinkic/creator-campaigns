// src/lib/model-provider.ts
//
// Provider-agnostic completion layer. ONE entry point — `complete()` — that
// every negotiation/discovery/classification path calls instead of talking to
// a vendor SDK directly.
//
//   complete({ system, user })           → Promise<string>            (raw text)
//   complete({ system, user, schema })   → Promise<Record<string,…>>  (parsed JSON object)
//
// Default provider = OpenAI GPT-4o (reuses the lazy-client pattern from
// src/lib/openai.ts). A built-in 'ollama' provider (local models via the
// native /api/chat endpoint) is opt-in via MODEL_PROVIDER=ollama for $0 local
// verification. Further free/OSS/HF providers slot in behind the same
// `RawCompleter` signature via registerProvider(); the active provider is
// chosen by the MODEL_PROVIDER env var (default 'openai'). No caller changes
// when the provider swaps — that is the whole point of this seam.
//
// ── Ordered failover ───────────────────────────────────────────────────────
// A free-tier 429 storm can fail nearly every draft in a run if `complete()`
// resolves exactly ONE provider with no try/catch: a single vendor's rate
// limit takes the whole campaign down. `complete()` now
// walks an ordered chain — the active provider first, then the others that
// have credentials present in env — and only on RETRYABLE failures (429, 408,
// 5xx, connection/timeout). A 4xx auth or validation error is NOT retryable
// and surfaces immediately: re-sending a malformed or unauthorized request to
// a second vendor just bills a second vendor for the same mistake.
//
// Chain order is deterministic and documented (DEFAULT_FALLBACK_ORDER):
//   openai → gemini → groq → ollama
//   - openai first: paid tier, no free-tier per-minute quota to storm.
//   - gemini second: cheap and fast.
//   - groq third: cheap and very fast, but free tier has the same quota shape
//     as Gemini, so it is a poor primary.
//   - ollama last: it only ever resolves on a machine running the daemon, so
//     it is worthless from Vercel and must never displace a cloud provider.
// Override with MODEL_FALLBACK_CHAIN (comma-separated provider names). An
// empty MODEL_FALLBACK_CHAIN disables failover entirely (single-provider
// mode). The active provider always leads the chain and is never tried twice.

import OpenAI from 'openai';
import { getEnv } from './env';
// Type-only: api-ledger pulls in ./supabase, which evaluates env at module
// load. The real writer is resolved lazily in ledgerModelCall() so hermetic
// tests importing this module never touch Supabase (same pattern as
// measurement-tick.ts).
import type { LedgerEntry } from './api-ledger';

const DEFAULT_MODEL = 'gpt-4o-2024-08-06';
const DEFAULT_TEMPERATURE = 0.4;

export interface CompleteParams {
  system: string;
  user: string;
  /**
   * When present, the model is asked for a single JSON object and the parsed
   * object is returned (instead of raw text). The schema is passed to the
   * model as a directive; keep it small — it is a hint, not a hard validator.
   */
  schema?: Record<string, unknown>;
  temperature?: number;
  model?: string;
  /**
   * What this call is FOR — becomes api_ledger.endpoint on the cost row every
   * complete() writes (e.g. 'negotiation.classify'). Callers that don't say
   * are ledgered as 'unlabeled', so the spend is still on the books even when
   * the label is missing.
   */
  purpose?: string;
  /**
   * The campaign this call is spent ON — becomes api_ledger.campaign_id.
   * Without it the row is orphaned: the spend is on the books but cannot be
   * grouped by campaign, so "what did this deal cost to negotiate" (the
   * CPM-first question this ledgering exists to answer) stays unanswerable.
   * Every other recordApiCall site in the app stamps one; pass it from the
   * id already in scope at the call site. null only when the call genuinely
   * belongs to no campaign (e.g. a firm-level bio extraction).
   */
  campaign_id?: string | null;
}

/**
 * What a provider hands back. Plain string is still accepted (registered test
 * providers, legacy custom providers); the object form additionally carries
 * token usage + the concrete model id so the ledger row can price the call.
 */
export interface RawCompletion {
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

/**
 * A provider turns a normalized request into raw output. Swapping
 * OpenAI for an OSS/HF endpoint means registering another RawCompleter — the
 * public `complete()` API and all callers stay identical.
 */
export type RawCompleter = (input: {
  system: string;
  user: string;
  json: boolean;
  schema?: Record<string, unknown>;
  temperature?: number;
  model?: string;
}) => Promise<string | RawCompletion>;

// ── OpenAI provider (default) ──────────────────────────────────────────────
let _openai: OpenAI | null = null;
function openaiClient(): OpenAI {
  if (_openai) return _openai;
  _openai = new OpenAI({ apiKey: getEnv('OPENAI_API_KEY') });
  return _openai;
}

const openaiCompleter: RawCompleter = async ({ system, user, json, temperature, model }) => {
  const resolvedModel = model ?? DEFAULT_MODEL;
  const res = await openaiClient().chat.completions.create({
    model: resolvedModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: temperature ?? DEFAULT_TEMPERATURE,
    ...(json ? { response_format: { type: 'json_object' as const } } : {}),
  });
  return {
    text: res.choices[0]?.message?.content ?? '',
    usage: {
      prompt_tokens: res.usage?.prompt_tokens,
      completion_tokens: res.usage?.completion_tokens,
    },
    model: resolvedModel,
  };
};

// ── Ollama provider (local, opt-in via MODEL_PROVIDER=ollama) ──────────────
// Talks to a local Ollama daemon over its native /api/chat endpoint with plain
// fetch — no SDK dependency. Config: OLLAMA_BASE_URL (default
// http://localhost:11434) and OLLAMA_MODEL (default gemma3:4b). Never the
// default provider: production can't reach a laptop-local daemon.
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';
const OLLAMA_DEFAULT_MODEL = 'gemma3:4b';
// First request after a cold start pays the model-load cost — small local
// models can take tens of seconds, so the timeout is generous.
const OLLAMA_TIMEOUT_MS = 60_000;

const ollamaCompleter: RawCompleter = async ({ system, user, json, temperature, model }) => {
  const base = (process.env.OLLAMA_BASE_URL?.trim() || OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const resolvedModel = model ?? (process.env.OLLAMA_MODEL?.trim() || OLLAMA_DEFAULT_MODEL);
  const url = `${base}/api/chat`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: resolvedModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        options: { temperature: temperature ?? DEFAULT_TEMPERATURE },
        ...(json ? { format: 'json' as const } : {}),
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(
        `ollama: request to ${url} timed out after ${OLLAMA_TIMEOUT_MS}ms ` +
          `(model "${resolvedModel}" may still be loading; check \`ollama ps\`)`,
      );
    }
    throw new Error(`ollama: request to ${url} failed: ${err.message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ollama: HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json().catch(() => null)) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  } | null;
  const content = data?.message?.content ?? '';
  return {
    text: json ? stripToJsonObject(content) : content,
    usage: {
      prompt_tokens: data?.prompt_eval_count,
      completion_tokens: data?.eval_count,
    },
    model: resolvedModel,
  };
};

/**
 * Provider-local cleanup for small local models: gemma3:4b sometimes wraps the
 * object in ```json fences or adds leading/trailing prose even with
 * format:'json'. Prefer a fenced block's contents, then slice from the first
 * '{' to the last '}'. The shared parseJsonObject() stays strict for every
 * other provider.
 */
function stripToJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : text;
}

// ── OpenAI-compatible cloud providers (opt-in, always-on fallbacks) ─────────
// Groq and Google Gemini both expose an OpenAI-compatible /chat/completions
// endpoint, so they reuse the OpenAI SDK with a different baseURL + key. These
// are the always-on fallbacks for when a local Ollama host is unreachable. Inert unless MODEL_PROVIDER selects
// them — no caller changes, same RawCompleter contract.
function openAiCompatibleCompleter(cfg: {
  baseURL: string;
  apiKeyEnv: string;
  modelEnv: string;
  defaultModel: string;
}): RawCompleter {
  let client: OpenAI | null = null;
  const getClient = () => {
    if (client) return client;
    const apiKey = process.env[cfg.apiKeyEnv]?.trim();
    if (!apiKey) throw new Error(`Missing required env var: ${cfg.apiKeyEnv}`);
    // maxRetries 6 (SDK exponential backoff): free-tier Gemini enforces a
    // low per-minute quota, and burst work (bulk drafting) drains it — the
    // default 2 quick retries can't outlive a rate window, so whole batches
    // failed with 429s. timeout 60s per attempt, like Ollama: the SDK default
    // is 10 minutes, longer than any route's maxDuration.
    client = new OpenAI({ apiKey, baseURL: cfg.baseURL, maxRetries: 6, timeout: 60_000 });
    return client;
  };
  return async ({ system, user, json, temperature, model }) => {
    const resolvedModel = model ?? (process.env[cfg.modelEnv]?.trim() || cfg.defaultModel);
    const res = await getClient().chat.completions.create({
      model: resolvedModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: temperature ?? DEFAULT_TEMPERATURE,
      ...(json ? { response_format: { type: 'json_object' as const } } : {}),
    });
    return {
      text: res.choices[0]?.message?.content ?? '',
      usage: {
        prompt_tokens: res.usage?.prompt_tokens,
        completion_tokens: res.usage?.completion_tokens,
      },
      model: resolvedModel,
    };
  };
}

// Groq shut `llama-3.3-70b-versatile` down for free and developer tier on
// 2026-08-16 — it survives in the catalog only as an Enterprise/committed-spend
// SKU, so a normal pay-as-you-go key now errors on it. Groq's own named
// replacement is `openai/gpt-oss-120b` (131k context, JSON object + JSON schema
// mode). Evidence: console.groq.com/docs/deprecations §"August 16, 2026" and
// the Enterprise/ContactSales badge on that row of console.groq.com/docs/models
// (both read 2026-09-15). Do NOT "restore" the llama id without re-checking.
// Note: /docs/deprecations also suggests `qwen/qwen3.6-27b`, which no longer
// exists; the live Qwen (`qwen/qwen3.8-27b`) is Preview-tier and therefore
// disqualified for a client-facing path.
const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
// gemini-2.0-flash was SHUT DOWN by Google on 2026-06-01
// (https://ai.google.dev/gemini-api/docs/deprecations) and returns HTTP 404,
// while gemini-2.5-flash answers 200. A deployment that sets GEMINI_MODEL
// explicitly never reaches this default, so it only matters for a fresh
// environment, a typo, or an env migration: exactly the moments you least
// want a dead fallback.
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';

const groqCompleter = openAiCompatibleCompleter({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKeyEnv: 'GROQ_API_KEY',
  modelEnv: 'GROQ_MODEL',
  defaultModel: GROQ_DEFAULT_MODEL,
});

const geminiCompleter = openAiCompatibleCompleter({
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  apiKeyEnv: 'GEMINI_API_KEY',
  modelEnv: 'GEMINI_MODEL',
  defaultModel: GEMINI_DEFAULT_MODEL,
});

// ── Provider registry ──────────────────────────────────────────────────────
const providers: Record<string, RawCompleter> = {
  openai: openaiCompleter,
  ollama: ollamaCompleter,
  groq: groqCompleter,
  gemini: geminiCompleter,
};

/**
 * Register (or override) a provider under `name`. This is the extension seam
 * for a future OSS/HF provider AND the injection point unit tests use to run
 * `complete()` without a network call.
 */
export function registerProvider(name: string, fn: RawCompleter): void {
  providers[name] = fn;
}

export function activeProviderName(): string {
  return process.env.MODEL_PROVIDER?.trim() || 'openai';
}

// ── Failover chain ─────────────────────────────────────────────────────────

/** Deterministic default fallback order. See the header for the rationale. */
export const DEFAULT_FALLBACK_ORDER: readonly string[] = [
  'openai',
  'gemini',
  'groq',
  'ollama',
] as const;

/**
 * The env var that must be present for a built-in provider to be worth
 * attempting. Ollama has no API key — its "credential" is an explicitly
 * configured base URL, which is what distinguishes "there is a daemon here"
 * from "this is Vercel and localhost:11434 is nothing".
 *
 * A provider NOT listed here (i.e. one added via registerProvider) is always
 * eligible: it carries its own configuration and the test seam depends on it.
 */
const PROVIDER_CREDENTIAL_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  ollama: 'OLLAMA_BASE_URL',
};

/** Per-provider model resolution, shared by the completers and activeModelLabel(). */
const PROVIDER_MODEL: Record<string, { env?: string; default: string }> = {
  openai: { default: DEFAULT_MODEL },
  gemini: { env: 'GEMINI_MODEL', default: GEMINI_DEFAULT_MODEL },
  groq: { env: 'GROQ_MODEL', default: GROQ_DEFAULT_MODEL },
  ollama: { env: 'OLLAMA_MODEL', default: OLLAMA_DEFAULT_MODEL },
};

function hasCredentials(name: string): boolean {
  const key = PROVIDER_CREDENTIAL_ENV[name];
  if (!key) return true;
  return (process.env[key]?.trim().length ?? 0) > 0;
}

/**
 * `provider:model` for the configured provider — written to
 * outreach_messages.generation_model so an operator can tell what produced a
 * row. This reports the CONFIGURED provider; if a request actually failed over
 * mid-flight, that hop is in the logs (`[model-provider] failover`), not here.
 */
export function activeModelLabel(): string {
  const name = activeProviderName();
  const spec = PROVIDER_MODEL[name];
  if (!spec) return name;
  const model = (spec.env ? process.env[spec.env]?.trim() : '') || spec.default;
  return `${name}:${model}`;
}

/**
 * The ordered list of providers `complete()` will try, active provider first.
 * Unregistered names in MODEL_FALLBACK_CHAIN are ignored (a stale name in a
 * deploy env must not take the app down); an unregistered MODEL_PROVIDER is
 * fatal (a typo in the primary provider must be loud).
 */
export function resolveFallbackChain(): string[] {
  const head = activeProviderName();
  if (!providers[head]) {
    throw new Error(
      `Unknown MODEL_PROVIDER "${head}". Registered providers: ${Object.keys(providers).join(', ')}.`,
    );
  }
  const override = process.env.MODEL_FALLBACK_CHAIN;
  const tail =
    override !== undefined
      ? override
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [...DEFAULT_FALLBACK_ORDER];

  const seen = new Set<string>();
  const chain: string[] = [];
  for (const name of [head, ...tail]) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!providers[name]) continue;
    if (!hasCredentials(name)) continue;
    chain.push(name);
  }
  return chain;
}

/** HTTP status off an SDK error, a plain error, or a message like "HTTP 503". */
function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const v of [e?.status, e?.statusCode, e?.response?.status]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  const m = /\bHTTP (\d{3})\b/.exec(err instanceof Error ? err.message : '');
  return m ? Number(m[1]) : undefined;
}

/** Connection-level failures, which carry no HTTP status at all. */
const NETWORK_ERROR = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|timed out|Connection error/i;

/**
 * Is this failure worth handing to a DIFFERENT vendor?
 *
 * Yes: 429 (rate limit / quota), 408 (request timeout), any 5xx, and
 * connection-level failures. These say "this vendor can't serve you right now".
 *
 * No: every other 4xx. A 400/401/403/404/422 says "this REQUEST is wrong" —
 * replaying it against another vendor cannot succeed, hides a real
 * misconfiguration, and bills a second vendor for the same mistake. Also no
 * for post-response parse failures, which are not provider faults.
 */
export function isRetryableProviderError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  return err instanceof Error && NETWORK_ERROR.test(err.message);
}

/**
 * Defence in depth for the failover log. Provider SDKs do not echo keys in
 * error messages today, but this layer is the one place every provider error
 * funnels through, and a logged key is unrecoverable.
 */
function redact(text: string): string {
  return text.replace(/\b(sk-|gsk_|AIza|xoxb-)[A-Za-z0-9_\-]{6,}/g, '$1[redacted]');
}

function errMessage(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err)).slice(0, 200);
}

interface ProviderChainError extends Error {
  status?: number;
  providerAttempts?: string[];
}

/** completeRaw's result: the text plus everything the ledger row needs. */
interface CompletedRaw {
  text: string;
  /** Provider that actually served the call (may differ from the configured one after failover). */
  provider: string;
  model: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** Latency of the SUCCESSFUL attempt only — failed hops are in the logs. */
  latency_ms: number;
  /** 1-based attempt index the success landed on (1 = no failover). */
  attempt: number;
}

/** The model a provider would use absent an explicit override — for the
 *  ledger row when a custom provider returns a bare string. */
function resolvedModelFor(name: string, override?: string): string | null {
  if (override) return override;
  const spec = PROVIDER_MODEL[name];
  if (!spec) return null;
  return (spec.env ? process.env[spec.env]?.trim() : '') || spec.default;
}

/**
 * Try each provider in the chain. Returns the first success; rethrows a
 * non-retryable error untouched; on total failure throws the LAST error with
 * every attempt summarised onto its message.
 */
async function completeRaw(input: Parameters<RawCompleter>[0]): Promise<CompletedRaw> {
  const chain = resolveFallbackChain();
  if (chain.length === 0) {
    const configured = activeProviderName();
    const needed = PROVIDER_CREDENTIAL_ENV[configured] ?? '(none)';
    throw new Error(
      `model-provider: no usable provider is configured. MODEL_PROVIDER="${configured}" ` +
        `requires ${needed}, and no provider in the fallback chain has credentials in env. ` +
        `Set one of: ${Object.values(PROVIDER_CREDENTIAL_ENV).join(', ')}.`,
    );
  }

  const attempts: string[] = [];
  let lastErr: unknown;

  for (let i = 0; i < chain.length; i++) {
    const name = chain[i];
    const t0 = Date.now();
    try {
      const out = await providers[name](input);
      const norm: RawCompletion = typeof out === 'string' ? { text: out } : out;
      return {
        text: norm.text,
        provider: name,
        model: norm.model ?? resolvedModelFor(name, input.model),
        usage: norm.usage ?? null,
        latency_ms: Date.now() - t0,
        attempt: i + 1,
      };
    } catch (e) {
      lastErr = e;
      const status = statusOf(e);
      const retryable = isRetryableProviderError(e);
      attempts.push(`${name}: ${status ?? 'no-status'} ${errMessage(e)}`);
      const next = retryable ? chain[i + 1] : undefined;
      // Structured, secret-free. `to: null` means the chain stopped here.
      console.warn(
        '[model-provider] failover ' +
          JSON.stringify({
            from: name,
            to: next ?? null,
            status: status ?? null,
            retryable,
            attempt: i + 1,
            of: chain.length,
            reason: errMessage(e),
          }),
      );
      if (!retryable) throw e;
    }
  }

  const err: ProviderChainError =
    lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  err.message =
    `${err.message} | model-provider: all ${chain.length} provider(s) failed ` +
    `[${attempts.join(' ; ')}]`;
  err.providerAttempts = attempts;
  throw err;
}

// ── Cost ledgering ─────────────────────────────────────────────────────────
//
// Every complete() call writes one api_ledger row (source = the provider that
// served it, endpoint = the caller's `purpose` label, campaign_id = the
// caller's campaign). Before this, the only LLM spend on the books was the
// discovery/draft path's own recordApiCall sites — the negotiation loop's
// classify + counter-copy calls wrote NOTHING, so autonomous-negotiation model
// spend was invisible by construction.
//
// This row is now the ONLY ledger row for a model call. The two hand-rolled
// flat-cost rows that used to shadow it (run/route.ts 'query-gen' at $0.005,
// draft-all/route.ts 'draft-personalize' at $0.01) were removed: they
// double-counted the same call and hardcoded source 'openai' whatever
// MODEL_PROVIDER actually served it. In-process run caps still use their flat
// estimates — a cap has to decide before the call, when no row exists yet.

/**
 * USD per 1M tokens for the models this app actually configures.
 *
 * Checked 2026-09-18: every row below was read off the vendor's own pricing
 * page on that date. This column feeds api_ledger.cost_usd, which reads as
 * spend, so a remembered number is not good enough.
 *
 *   gpt-4o              https://developers.openai.com/api/docs/pricing
 *                       $2.50 / $10.00 — STANDARD tier. Cached input is $1.25
 *                       and Batch is $1.25/$5.00; this app calls
 *                       chat.completions.create with no batch path, so
 *                       Standard is the tier it actually hits.
 *   gemini-2.5-flash    https://ai.google.dev/gemini-api/docs/pricing
 *                       $0.30 / $2.50 — paid STANDARD. Batch/Flex is
 *                       $0.15/$1.25 and Priority $0.54/$4.50. Output is
 *                       inclusive of thinking tokens. NOTE: on the FREE tier
 *                       this model bills $0. If your key is on the free
 *                       tier, these rows OVER-report Gemini spend; check the
 *                       billing project to know which applies.
 *   openai/gpt-oss-120b https://console.groq.com/docs/model/openai/gpt-oss-120b
 *                       $0.15 / $0.60. Was $0.75 out here — wrong.
 *   gemma               Local inference via Ollama (OLLAMA_DEFAULT_MODEL =
 *                       'gemma3:4b', localhost:11434). No vendor bills it, so
 *                       a known-zero row beats pricing_known:false.
 *
 * DELIBERATELY ABSENT: gemini-2.0-flash. Google shut it down on 2026-06-01
 * (https://ai.google.dev/gemini-api/docs/deprecations), so no current price
 * exists to verify against. It is left out rather than re-priced from memory:
 * a call to it now records cost 0 with pricing_known:false and its token
 * counts intact, which is the honest outcome for a retired model.
 *
 * Unknown models record cost 0 with pricing_known:false — the token counts are
 * still on the row, so cost can be recomputed once a rate is confirmed.
 *
 * Re-verify before quoting any of this as billing. Prices move, and two of
 * these vendors publish dated cliffs.
 */
const MODEL_PRICING_PER_MTOK: Array<{ prefix: string; in: number; out: number }> = [
  { prefix: 'gpt-4o', in: 2.5, out: 10 },
  { prefix: 'gemini-2.5-flash', in: 0.3, out: 2.5 },
  { prefix: 'openai/gpt-oss-120b', in: 0.15, out: 0.6 },
  // Local models bill nothing; a known-zero row beats pricing_known:false.
  { prefix: 'gemma', in: 0, out: 0 },
];

/** Exported for tests. */
export function estimateModelCostUsd(
  model: string | null,
  usage: { prompt_tokens?: number; completion_tokens?: number } | null,
): { cost_usd: number; pricing_known: boolean } {
  if (!model || !usage) return { cost_usd: 0, pricing_known: false };
  const row = MODEL_PRICING_PER_MTOK.find((p) => model.startsWith(p.prefix));
  if (!row) return { cost_usd: 0, pricing_known: false };
  const inTok = usage.prompt_tokens ?? 0;
  const outTok = usage.completion_tokens ?? 0;
  return { cost_usd: (inTok * row.in + outTok * row.out) / 1_000_000, pricing_known: true };
}

type LedgerWriter = (e: LedgerEntry) => Promise<void>;
let ledgerWriter: LedgerWriter | null = null;

/** Test seam / DI: override where model-call ledger rows go. null → default
 *  (lazy-imported recordApiCall, which requires Supabase env). */
export function setLedgerWriter(fn: LedgerWriter | null): void {
  ledgerWriter = fn;
}

/** Write-then-don't-throw, like audit(): cost visibility must never break the
 *  completion path — nor a hermetic test running without Supabase env (the
 *  dynamic import itself throws there, and is caught here). */
async function ledgerModelCall(e: LedgerEntry): Promise<void> {
  try {
    if (ledgerWriter) {
      await ledgerWriter(e);
      return;
    }
    const { recordApiCall } = await import('./api-ledger');
    await recordApiCall(e);
  } catch {
    // Swallowed by design — see docstring.
  }
}

// ── Public API ─────────────────────────────────────────────────────────────
export function complete(
  params: CompleteParams & { schema: Record<string, unknown> },
): Promise<Record<string, unknown>>;
export function complete(params: CompleteParams & { schema?: undefined }): Promise<string>;
export async function complete(params: CompleteParams): Promise<string | Record<string, unknown>> {
  const schema = params.schema;
  const wantJson = schema !== undefined;
  const system = wantJson ? withSchemaDirective(params.system, schema) : params.system;

  // Failover covers the PROVIDER CALL only. parseJsonObject() runs outside it
  // on purpose: malformed JSON from a provider that answered is a content
  // problem, not an availability one, and must not silently re-bill the chain.
  const done = await completeRaw({
    system,
    user: params.user,
    json: wantJson,
    schema,
    temperature: params.temperature,
    model: params.model,
  });

  const priced = estimateModelCostUsd(done.model, done.usage);
  await ledgerModelCall({
    campaign_id: params.campaign_id ?? null,
    source: done.provider as LedgerEntry['source'],
    endpoint: params.purpose ?? 'unlabeled',
    cost_usd: priced.cost_usd,
    latency_ms: done.latency_ms,
    request_meta: {
      model: done.model,
      prompt_tokens: done.usage?.prompt_tokens ?? null,
      completion_tokens: done.usage?.completion_tokens ?? null,
      pricing_known: priced.pricing_known,
      json: wantJson,
      attempt: done.attempt,
    },
  });

  return wantJson ? parseJsonObject(done.text) : done.text;
}

function withSchemaDirective(system: string, schema: Record<string, unknown>): string {
  return (
    `${system}\n\n` +
    'Respond with a single JSON object ONLY: no prose, no markdown, no code ' +
    'fences. The object must conform to this JSON schema:\n' +
    JSON.stringify(schema)
  );
}

function parseJsonObject(raw: string): Record<string, unknown> {
  // Tolerate an accidental ```json … ``` fence around the object.
  const text = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`model-provider: expected a JSON object, got: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('model-provider: parsed JSON was not an object');
  }
  return parsed as Record<string, unknown>;
}
