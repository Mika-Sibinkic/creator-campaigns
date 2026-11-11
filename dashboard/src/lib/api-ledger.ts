// src/lib/api-ledger.ts
// Cost-instrumentation helper. Every external API call (Spotify, OpenAI, Apify,
// ScrapeGraphAI, Resend) routes through `recordApiCall` so the demo can prove
// `api_ledger` accurately captures cost (acceptance criterion §6 last item).
// Failures here MUST NOT break the calling pipeline — they're logged, not thrown.
import { supabaseAdmin } from "./supabase";

export interface LedgerEntry {
  campaign_id: string | null;
  // `soundcharts` is metered in API CALLS against a shared plan quota, not in
  // dollars, so its rows carry cost_usd 0 and the quota signal is the row
  // count. The DB column is plain text with no CHECK, so widening this union
  // needs no migration. `gemini` / `groq` / `ollama` arrive via
  // model-provider.ts, which ledgers every complete() under the provider that
  // actually served it; the trailing `(string & {})` admits custom registered
  // providers while keeping autocomplete for the known ones.
  source:
    | "spotify"
    | "openai"
    | "gemini"
    | "groq"
    | "ollama"
    | "apify"
    | "scrapegraphai"
    | "resend"
    | "soundcharts"
    | (string & {});
  endpoint?: string;
  cost_usd: number;
  records_returned?: number;
  latency_ms?: number;
  request_meta?: Record<string, unknown>;
}

export async function recordApiCall(e: LedgerEntry): Promise<void> {
  try {
    // The supabase client is created without a generated Database generic
    // (see src/lib/supabase.ts), so .insert() infers the row type as `never`.
    // Object-literal callers elsewhere in the repo bypass this via inference;
    // we go through `unknown` to keep our typed LedgerEntry contract intact.
    const { error } = await supabaseAdmin()
      .from("api_ledger")
      .insert(e as unknown as never);
    if (error) {
      console.error("[api-ledger] insert failed", error);
    }
  } catch (err) {
    console.error("[api-ledger] insert threw", err);
  }
}

export async function campaignTotalCost(campaign_id: string): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("api_ledger")
      .select("cost_usd")
      .eq("campaign_id", campaign_id);
    if (error) {
      console.error("[api-ledger] sum query failed", error);
      return 0;
    }
    return (data ?? []).reduce(
      (a, r) => a + Number((r as { cost_usd: number }).cost_usd),
      0
    );
  } catch (err) {
    console.error("[api-ledger] sum query threw", err);
    return 0;
  }
}
