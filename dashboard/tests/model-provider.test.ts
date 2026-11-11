// tests/model-provider.test.ts
//
// Unit test for src/lib/model-provider.ts. Mocks the provider via
// registerProvider() so NO network call is made — asserts the dispatch,
// schema-directive, JSON-parse, and unknown-provider behaviors. The built-in
// ollama, groq and gemini providers are exercised against a stubbed
// globalThis.fetch (request shape, baseURL, format:json, fence-stripping,
// error legibility) — no live daemon, no live API key, no network.
//
// Also covers the ordered provider failover, which exists because a
// free-tier 429 storm can fail nearly every draft in a run: retryable (429/5xx/
// network) errors walk the chain, 4xx auth/validation errors surface
// immediately, and an all-providers-down run throws the LAST error with every
// attempt summarised.
//
// Run: npx tsx tests/model-provider.test.ts

import {
  complete,
  registerProvider,
  activeProviderName,
  activeModelLabel,
  resolveFallbackChain,
  isRetryableProviderError,
  DEFAULT_FALLBACK_ORDER,
} from '../src/lib/model-provider';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

interface Call {
  system: string;
  user: string;
  json: boolean;
  schema?: Record<string, unknown>;
}

async function main() {
  // Hermeticity guard. A developer shell may legitimately export
  // OPENAI_API_KEY / GEMINI_API_KEY / GROQ_API_KEY; without this, a failover
  // test would walk the default chain into a REAL provider and make a REAL
  // network call. Empty MODEL_FALLBACK_CHAIN = "no fallbacks"; every failover
  // test below sets the chain it wants explicitly.
  process.env.MODEL_FALLBACK_CHAIN = '';

  const calls: Call[] = [];

  // Mock provider records what it was asked for and returns canned output.
  registerProvider('mock', async ({ system, user, json, schema }) => {
    calls.push({ system, user, json, schema });
    return json
      ? '{"intent":"counter","counter_usd":120,"sentiment":"positive","confidence":0.82}'
      : 'plain text reply';
  });
  process.env.MODEL_PROVIDER = 'mock';

  assert(activeProviderName() === 'mock', 'MODEL_PROVIDER env selects active provider');

  // 1. No schema → raw string passthrough, json=false.
  const s = await complete({ system: 'sys', user: 'hello' });
  assert(typeof s === 'string' && s === 'plain text reply', 'no-schema returns raw string');
  assert(calls[0].json === false, 'no-schema → json=false');
  assert(calls[0].system === 'sys', 'no-schema leaves system prompt untouched');

  // 2. Schema → parsed JSON object, json=true, schema directive appended.
  const o = await complete({
    system: 'You negotiate.',
    user: 'their reply',
    schema: { type: 'object', properties: { intent: { type: 'string' } } },
  });
  assert(typeof o === 'object' && o !== null, 'schema returns an object');
  assert((o as { intent: string }).intent === 'counter', 'schema object parsed from provider JSON');
  assert((o as { counter_usd: number }).counter_usd === 120, 'schema object numeric field parsed');
  assert(calls[1].json === true, 'schema → json=true');
  assert(
    calls[1].system.includes('JSON object') && calls[1].system.includes('JSON schema'),
    'schema directive appended to system prompt',
  );
  assert(calls[1].system.startsWith('You negotiate.'), 'original system prompt preserved as prefix');

  // 3. Fenced ```json ... ``` output is tolerated.
  registerProvider('mockfence', async () => '```json\n{"ok":true}\n```');
  process.env.MODEL_PROVIDER = 'mockfence';
  const f = await complete({ system: 's', user: 'u', schema: { type: 'object' } });
  assert((f as { ok: boolean }).ok === true, 'code-fenced JSON is stripped and parsed');

  // 4. Non-object JSON under a schema → throws.
  registerProvider('mockarray', async () => '[1,2,3]');
  process.env.MODEL_PROVIDER = 'mockarray';
  let arrThrew = false;
  try {
    await complete({ system: 's', user: 'u', schema: { type: 'object' } });
  } catch {
    arrThrew = true;
  }
  assert(arrThrew, 'array JSON rejected when an object schema is requested');

  // 5. Unknown provider → throws a clear error.
  process.env.MODEL_PROVIDER = 'does-not-exist';
  let unknownThrew = false;
  try {
    await complete({ system: 's', user: 'u' });
  } catch (e) {
    unknownThrew = /Unknown MODEL_PROVIDER/.test((e as Error).message);
  }
  assert(unknownThrew, 'unknown MODEL_PROVIDER throws a clear error');

  // 6. Unset MODEL_PROVIDER defaults to 'openai'.
  delete process.env.MODEL_PROVIDER;
  assert(activeProviderName() === 'openai', 'default provider is openai when env unset');

  // ── Built-in ollama provider (stubbed fetch — NO live Ollama calls) ──────
  const realFetch = globalThis.fetch;
  interface FetchCall {
    url: string;
    body: Record<string, unknown>;
  }
  const fetchCalls: FetchCall[] = [];
  const lastCall = () => fetchCalls[fetchCalls.length - 1];

  function stubFetch(handler: (url: string, body: Record<string, unknown>) => Response) {
    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      fetchCalls.push({ url, body });
      return handler(url, body);
    }) as typeof fetch;
  }

  function ollamaResponse(content: string): Response {
    return new Response(JSON.stringify({ message: { role: 'assistant', content } }), {
      status: 200,
    });
  }

  process.env.MODEL_PROVIDER = 'ollama';
  process.env.OLLAMA_BASE_URL = 'http://stub-ollama:9999/';
  delete process.env.OLLAMA_MODEL;

  assert(activeProviderName() === 'ollama', 'MODEL_PROVIDER=ollama selects the ollama provider');

  try {
    // 7. No schema → raw text; endpoint, default model, stream:false, no format.
    stubFetch(() => ollamaResponse('sure, sounds good'));
    const r7 = await complete({ system: 'sys', user: 'usr' });
    assert(r7 === 'sure, sounds good', 'ollama no-schema returns raw message content');
    assert(
      lastCall().url === 'http://stub-ollama:9999/api/chat',
      'ollama posts to <OLLAMA_BASE_URL>/api/chat (trailing slash stripped)',
    );
    assert(
      lastCall().body.model === 'gemma3:4b',
      'ollama defaults to gemma3:4b when OLLAMA_MODEL unset',
    );
    assert(lastCall().body.stream === false, 'ollama requests stream:false');
    assert(!('format' in lastCall().body), 'ollama omits format when no schema requested');

    // 8. Schema → format:'json', OLLAMA_MODEL env respected, messages mapped.
    process.env.OLLAMA_MODEL = 'qwen2.5:7b-instruct';
    stubFetch(() =>
      ollamaResponse(
        '{"intent":"accept","counter_usd":null,"sentiment":"positive","confidence":0.9}',
      ),
    );
    const r8 = await complete({
      system: 'You negotiate.',
      user: 'deal!',
      schema: { type: 'object' },
    });
    assert((r8 as { intent: string }).intent === 'accept', 'ollama schema mode parses JSON object');
    assert(lastCall().body.format === 'json', 'ollama sends format:"json" when schema requested');
    assert(
      lastCall().body.model === 'qwen2.5:7b-instruct',
      'OLLAMA_MODEL env overrides the default model',
    );
    const msgs = lastCall().body.messages as { role: string; content: string }[];
    assert(
      msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user',
      'ollama maps system+user messages in order',
    );
    assert(
      msgs[0].content.startsWith('You negotiate.') && msgs[0].content.includes('JSON schema'),
      'ollama system message carries the schema directive',
    );
    assert(msgs[1].content === 'deal!', 'ollama user message passed through untouched');
    delete process.env.OLLAMA_MODEL;

    // 9. Small-model robustness: fences + surrounding prose stripped.
    stubFetch(() =>
      ollamaResponse('Here is the classification:\n```json\n{"ok":true}\n```\nLet me know!'),
    );
    const r9 = await complete({ system: 's', user: 'u', schema: { type: 'object' } });
    assert(
      (r9 as { ok: boolean }).ok === true,
      'ollama strips markdown fences and surrounding prose',
    );

    // 9b. Leading/trailing junk without a fence.
    stubFetch(() => ollamaResponse('Sure! {"counter_usd":150} hope that helps'));
    const r9b = await complete({ system: 's', user: 'u', schema: { type: 'object' } });
    assert(
      (r9b as { counter_usd: number }).counter_usd === 150,
      'ollama strips unfenced leading/trailing prose',
    );

    // 10. HTTP error → legible, provider-named error.
    stubFetch(() => new Response('model "nope" not found', { status: 404 }));
    let httpErr = '';
    try {
      await complete({ system: 's', user: 'u' });
    } catch (e) {
      httpErr = (e as Error).message;
    }
    assert(
      httpErr.startsWith('ollama: HTTP 404') && httpErr.includes('not found'),
      `ollama HTTP error is legible and provider-named (got: ${httpErr})`,
    );

    // 11. Timeout → legible, provider-named error.
    stubFetch(() => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });
    let timeoutErr = '';
    try {
      await complete({ system: 's', user: 'u' });
    } catch (e) {
      timeoutErr = (e as Error).message;
    }
    assert(
      timeoutErr.startsWith('ollama:') && timeoutErr.includes('timed out'),
      `ollama timeout error is legible and provider-named (got: ${timeoutErr})`,
    );
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.MODEL_PROVIDER;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_MODEL;
  }

  // ── groq + gemini dispatch (stubbed fetch — NO live API call, NO real key) ─
  // Both are OpenAI-SDK clients pointed at a vendor baseURL. The SDK captures
  // globalThis.fetch when the client is CONSTRUCTED, and each completer
  // memoizes its client on first use, so the stub must be installed before the
  // first call to either provider. Dummy key values only.
  {
    const realFetch2 = globalThis.fetch;
    const seen: { url: string; body: Record<string, unknown>; authScheme: string }[] = [];
    const last = () => seen[seen.length - 1];

    globalThis.fetch = (async (input: unknown, init?: { body?: unknown; headers?: unknown }) => {
      const url =
        typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const h = init?.headers;
      const auth =
        h instanceof Headers
          ? (h.get('authorization') ?? '')
          : String(
              (h as Record<string, string> | undefined)?.Authorization ??
                (h as Record<string, string> | undefined)?.authorization ??
                '',
            );
      // Record only the auth SCHEME. The credential itself never enters the
      // test record, the assertion messages, or the log.
      seen.push({ url, body, authScheme: auth.split(' ')[0] ?? '' });
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'provider says hi' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      // 12. groq dispatch — endpoint, bearer scheme, live default model.
      process.env.GROQ_API_KEY = 'test-groq-key-not-real';
      delete process.env.GROQ_MODEL;
      process.env.MODEL_PROVIDER = 'groq';
      const g = await complete({ system: 'sys', user: 'usr' });
      assert(g === 'provider says hi', 'groq provider returns the message content');
      assert(
        last().url === 'https://api.groq.com/openai/v1/chat/completions',
        `groq posts to the Groq OpenAI-compatible endpoint (got: ${last().url})`,
      );
      assert(last().authScheme === 'Bearer', 'groq sends a Bearer credential');
      // llama-3.3-70b-versatile was shut down for free/developer tier on
      // 2026-08-16 (console.groq.com/docs/deprecations). The default must be a
      // model Groq still serves outside an enterprise contract.
      assert(
        last().body.model === 'openai/gpt-oss-120b',
        `groq default model is a live Groq production id (got: ${String(last().body.model)})`,
      );
      assert(
        last().body.model !== 'llama-3.3-70b-versatile',
        'groq default is NOT the decommissioned llama-3.3-70b-versatile',
      );
      const gmsgs = last().body.messages as { role: string; content: string }[];
      assert(
        gmsgs.length === 2 && gmsgs[0].role === 'system' && gmsgs[1].content === 'usr',
        'groq maps system+user messages in order',
      );
      assert(!('response_format' in last().body), 'groq omits response_format with no schema');

      // 13. groq schema mode + GROQ_MODEL override.
      process.env.GROQ_MODEL = 'openai/gpt-oss-20b';
      await complete({ system: 's', user: 'u', schema: { type: 'object' } }).catch(() => undefined);
      assert(last().body.model === 'openai/gpt-oss-20b', 'GROQ_MODEL env overrides the default');
      assert(
        JSON.stringify(last().body.response_format) === '{"type":"json_object"}',
        'groq requests response_format json_object under a schema',
      );
      delete process.env.GROQ_MODEL;

      // 14. gemini dispatch — Google's OpenAI-compatible endpoint + default.
      process.env.GEMINI_API_KEY = 'test-gemini-key-not-real';
      delete process.env.GEMINI_MODEL;
      process.env.MODEL_PROVIDER = 'gemini';
      const gm = await complete({ system: 'sys', user: 'usr' });
      assert(gm === 'provider says hi', 'gemini provider returns the message content');
      assert(
        last().url === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        `gemini posts to the Google OpenAI-compatible endpoint (got: ${last().url})`,
      );
      assert(last().authScheme === 'Bearer', 'gemini sends a Bearer credential');
      // The default must be a model that actually ANSWERS. It used to be
      // gemini-2.0-flash, which Google shut down on 2026-06-01 and which
      // returns HTTP 404. With GEMINI_MODEL set explicitly nothing breaks;
      // the default was a landmine for a fresh environment.
      assert(
        last().body.model === 'gemini-2.5-flash',
        `gemini default model id (got: ${String(last().body.model)})`,
      );
      assert(
        last().body.model !== 'gemini-2.0-flash',
        'the retired gemini-2.0-flash is never the default again',
      );

      // 15. activeModelLabel() reports provider:model for the audit trail.
      assert(
        activeModelLabel() === 'gemini:gemini-2.5-flash',
        `activeModelLabel reflects provider + resolved model (got: ${activeModelLabel()})`,
      );
      // Override with a model that differs from the default, so this proves
      // the env var is actually read rather than passing by coincidence.
      process.env.GEMINI_MODEL = 'gemini-2.5-pro';
      assert(
        activeModelLabel() === 'gemini:gemini-2.5-pro',
        'activeModelLabel honors the per-provider model env override',
      );
      delete process.env.GEMINI_MODEL;
    } finally {
      globalThis.fetch = realFetch2;
      delete process.env.MODEL_PROVIDER;
      delete process.env.GROQ_API_KEY;
      delete process.env.GROQ_MODEL;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_MODEL;
    }
  }

  // ── Ordered provider failover ────────────────────────────────────────────
  {
    const realWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => {
      warnings.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    };

    function httpError(status: number, message: string): Error & { status: number } {
      const e = new Error(message) as Error & { status: number };
      e.status = status;
      return e;
    }

    try {
      // 16. 429 on the active provider walks to the next provider in the chain.
      const hits: string[] = [];
      registerProvider('p429', async () => {
        hits.push('p429');
        throw httpError(429, 'Rate limit reached for gemini-2.0-flash');
      });
      registerProvider('pok', async () => {
        hits.push('pok');
        return 'second provider answered';
      });
      process.env.MODEL_PROVIDER = 'p429';
      process.env.MODEL_FALLBACK_CHAIN = 'pok';
      warnings.length = 0;
      const r16 = await complete({ system: 's', user: 'u' });
      assert(r16 === 'second provider answered', 'a 429 fails over to the next provider');
      assert(
        hits.join(',') === 'p429,pok',
        `failover walks the chain in order (got: ${hits.join(',')})`,
      );
      assert(
        warnings.some((w) => w.includes('model-provider') && w.includes('p429') && w.includes('pok')),
        'each failover hop is logged with from/to provider names',
      );
      assert(
        warnings.some((w) => w.includes('429')),
        'the failover log carries the HTTP status',
      );
      assert(
        !warnings.some((w) => /sk-|gsk_|AIza|not-real/.test(w)),
        'the failover log contains no credential material',
      );

      // 17. 5xx is retryable too.
      hits.length = 0;
      registerProvider('p503', async () => {
        hits.push('p503');
        throw httpError(503, 'Service Unavailable');
      });
      process.env.MODEL_PROVIDER = 'p503';
      process.env.MODEL_FALLBACK_CHAIN = 'pok';
      const r17 = await complete({ system: 's', user: 'u' });
      assert(r17 === 'second provider answered', 'a 5xx fails over to the next provider');
      assert(hits.join(',') === 'p503,pok', '5xx failover walks the chain in order');

      // 18. A 4xx auth/validation error must SURFACE, never fail over —
      //     silently re-billing a second vendor for a malformed request is
      //     worse than a loud failure.
      hits.length = 0;
      registerProvider('p401', async () => {
        hits.push('p401');
        throw httpError(401, 'Incorrect API key provided');
      });
      process.env.MODEL_PROVIDER = 'p401';
      process.env.MODEL_FALLBACK_CHAIN = 'pok';
      let authErr: (Error & { status?: number }) | null = null;
      try {
        await complete({ system: 's', user: 'u' });
      } catch (e) {
        authErr = e as Error & { status?: number };
      }
      assert(authErr !== null, '401 throws instead of falling over');
      assert(
        hits.join(',') === 'p401',
        `401 does NOT try the next provider (got hits: ${hits.join(',')})`,
      );
      assert(
        authErr?.status === 401,
        'the original error object (and its status) is preserved on a 4xx',
      );
      assert(
        /Incorrect API key/.test(authErr?.message ?? ''),
        'the 4xx error message surfaces untouched',
      );

      // 18b. 400 validation errors behave the same way.
      hits.length = 0;
      registerProvider('p400', async () => {
        hits.push('p400');
        throw httpError(400, 'Invalid schema');
      });
      process.env.MODEL_PROVIDER = 'p400';
      let badReqThrew = false;
      try {
        await complete({ system: 's', user: 'u' });
      } catch {
        badReqThrew = true;
      }
      assert(badReqThrew && hits.join(',') === 'p400', '400 surfaces without failover');

      // 19. Every provider down → throw the LAST error, with all attempts
      //     summarised so an operator can see the whole chain in one line.
      hits.length = 0;
      registerProvider('down1', async () => {
        hits.push('down1');
        throw httpError(429, 'quota exhausted');
      });
      registerProvider('down2', async () => {
        hits.push('down2');
        throw httpError(500, 'internal error');
      });
      registerProvider('down3', async () => {
        hits.push('down3');
        throw httpError(502, 'bad gateway from upstream');
      });
      process.env.MODEL_PROVIDER = 'down1';
      process.env.MODEL_FALLBACK_CHAIN = 'down2,down3';
      let allErr: (Error & { status?: number; providerAttempts?: string[] }) | null = null;
      try {
        await complete({ system: 's', user: 'u' });
      } catch (e) {
        allErr = e as Error & { status?: number; providerAttempts?: string[] };
      }
      assert(allErr !== null, 'all-providers-down throws');
      assert(
        hits.join(',') === 'down1,down2,down3',
        `all-providers-down tries every credentialed provider once (got: ${hits.join(',')})`,
      );
      assert(
        allErr?.status === 502,
        `the thrown error is the LAST provider's error (expected status 502, got ${String(allErr?.status)})`,
      );
      assert(
        /bad gateway from upstream/.test(allErr?.message ?? ''),
        'the last error message is preserved',
      );
      assert(
        ['down1', 'down2', 'down3'].every((n) => (allErr?.message ?? '').includes(n)),
        `every attempt is summarised in the final message (got: ${allErr?.message})`,
      );
      assert(
        (allErr?.message ?? '').includes('429') && (allErr?.message ?? '').includes('500'),
        'the summary carries each provider status',
      );
      assert(allErr?.providerAttempts?.length === 3, 'providerAttempts exposes the chain to callers');

      // 20. A non-HTTP network error is retryable (ECONNREFUSED to a dead
      //     local ollama must not strand a run).
      hits.length = 0;
      registerProvider('pnet', async () => {
        hits.push('pnet');
        throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
      });
      process.env.MODEL_PROVIDER = 'pnet';
      process.env.MODEL_FALLBACK_CHAIN = 'pok';
      const r20 = await complete({ system: 's', user: 'u' });
      assert(r20 === 'second provider answered', 'a connection error fails over');
      assert(hits.join(',') === 'pnet,pok', 'connection-error failover walks the chain');

      // 21. isRetryableProviderError classification, directly.
      assert(isRetryableProviderError(httpError(429, 'x')), '429 is retryable');
      assert(isRetryableProviderError(httpError(500, 'x')), '500 is retryable');
      assert(isRetryableProviderError(httpError(503, 'x')), '503 is retryable');
      assert(isRetryableProviderError(httpError(408, 'x')), '408 request timeout is retryable');
      assert(!isRetryableProviderError(httpError(400, 'x')), '400 is NOT retryable');
      assert(!isRetryableProviderError(httpError(401, 'x')), '401 is NOT retryable');
      assert(!isRetryableProviderError(httpError(403, 'x')), '403 is NOT retryable');
      assert(!isRetryableProviderError(httpError(404, 'x')), '404 is NOT retryable');
      assert(!isRetryableProviderError(httpError(422, 'x')), '422 is NOT retryable');
      assert(
        isRetryableProviderError(new Error('ollama: HTTP 502 from http://x — upstream')),
        'a status parsed out of the message text is classified',
      );
      assert(
        !isRetryableProviderError(new Error('ollama: HTTP 404 from http://x — no such model')),
        'a 404 parsed out of the message text is NOT retryable',
      );
      assert(
        isRetryableProviderError(new Error('request timed out after 60000ms')),
        'a timeout is retryable',
      );
      assert(
        !isRetryableProviderError(new Error('model-provider: parsed JSON was not an object')),
        'a parse failure is NOT a provider failover trigger',
      );

      // 22. Chain resolution: MODEL_FALLBACK_CHAIN overrides the default and
      //     the active provider always leads.
      process.env.MODEL_PROVIDER = 'pok';
      process.env.MODEL_FALLBACK_CHAIN = 'down1,down2';
      assert(
        resolveFallbackChain().join(',') === 'pok,down1,down2',
        `MODEL_FALLBACK_CHAIN sets the tail, active provider leads (got: ${resolveFallbackChain().join(',')})`,
      );
      process.env.MODEL_FALLBACK_CHAIN = 'down2,pok,down1';
      assert(
        resolveFallbackChain().join(',') === 'pok,down2,down1',
        'the active provider is never tried twice (deduped, stays at the head)',
      );
      process.env.MODEL_FALLBACK_CHAIN = '';
      assert(
        resolveFallbackChain().join(',') === 'pok',
        'an empty MODEL_FALLBACK_CHAIN disables failover',
      );

      // 23. Providers whose credential env var is absent are skipped, and
      //     unregistered names in the chain are ignored rather than fatal.
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GROQ_API_KEY;
      delete process.env.OLLAMA_BASE_URL;
      process.env.MODEL_FALLBACK_CHAIN = 'openai,gemini,groq,ollama,pok';
      assert(
        resolveFallbackChain().join(',') === 'pok',
        `providers without credentials are skipped (got: ${resolveFallbackChain().join(',')})`,
      );
      process.env.GROQ_API_KEY = 'test-groq-key-not-real';
      assert(
        resolveFallbackChain().join(',') === 'pok,groq',
        `a provider becomes eligible once its key is present (got: ${resolveFallbackChain().join(',')})`,
      );
      delete process.env.GROQ_API_KEY;
      process.env.MODEL_FALLBACK_CHAIN = 'not-a-provider,pok';
      assert(
        resolveFallbackChain().join(',') === 'pok',
        'an unknown name inside MODEL_FALLBACK_CHAIN is ignored, not fatal',
      );

      // 24. An unknown MODEL_PROVIDER is still fatal — a typo in the primary
      //     provider must be loud, not silently routed elsewhere.
      process.env.MODEL_PROVIDER = 'typoed-provider';
      process.env.MODEL_FALLBACK_CHAIN = 'pok';
      let chainThrew = '';
      try {
        resolveFallbackChain();
      } catch (e) {
        chainThrew = (e as Error).message;
      }
      assert(
        /Unknown MODEL_PROVIDER/.test(chainThrew),
        `an unknown active provider throws (got: ${chainThrew})`,
      );

      // 25. The documented default order, when no override is set.
      assert(
        DEFAULT_FALLBACK_ORDER.join(',') === 'openai,gemini,groq,ollama',
        `default chain order is documented and stable (got: ${DEFAULT_FALLBACK_ORDER.join(',')})`,
      );
      process.env.MODEL_PROVIDER = 'pok';
      delete process.env.MODEL_FALLBACK_CHAIN;
      process.env.OPENAI_API_KEY = 'test-openai-key-not-real';
      process.env.GEMINI_API_KEY = 'test-gemini-key-not-real';
      assert(
        resolveFallbackChain().join(',') === 'pok,openai,gemini',
        `with no override the default order is used, credential-filtered (got: ${resolveFallbackChain().join(',')})`,
      );
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      // 26. No eligible provider at all → a clear configuration error that
      //     names what to set, not an opaque SDK failure.
      process.env.MODEL_PROVIDER = 'openai';
      process.env.MODEL_FALLBACK_CHAIN = '';
      let cfgErr = '';
      try {
        await complete({ system: 's', user: 'u' });
      } catch (e) {
        cfgErr = (e as Error).message;
      }
      assert(
        /OPENAI_API_KEY/.test(cfgErr) && /no .*provider/i.test(cfgErr),
        `an unconfigured chain fails with an actionable message (got: ${cfgErr})`,
      );
    } finally {
      console.warn = realWarn;
      delete process.env.MODEL_PROVIDER;
      delete process.env.MODEL_FALLBACK_CHAIN;
      delete process.env.GROQ_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  }

  console.log(`model-provider test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
