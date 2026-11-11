// src/lib/enrichment-tick.ts
//
// Contact enrichment, off the request path.
//
// THE PROBLEM THIS SOLVES
//   discoverContacts() is good code that almost never runs. Its only caller is
//   the campaign discovery route, where it is capped at the top 25 creators
//   inside a 60s slice of a 300s request — because one bio-link fetch per
//   creator worst-cases at 125s and the pipeline still has scoring and
//   qualification to do.
//
//   Far more bios carry a plainly regex-matchable address than creators have a
//   contact email on record, and those unharvested addresses sit in data
//   already paid for. The regex pass is pure CPU — the cap was never about cost, only about latency.
//
//   So: same function, no cap, on a schedule. Batched, resumable via
//   influencers.contact_scanned_at (migration 050), and bounded per invocation
//   rather than per campaign.
//
// COST POSTURE
//   - Bio regex: free. Always on.
//   - LLM extraction: only for bios that show contact intent at all. On this
//     obfuscated forms ("name (at) domain dot com") are rare in scraped bios,
//     so running the model over every bio would cost money for nothing.
//     `hasContactIntent` is the gate; ENRICHMENT_LLM_CAP is the ceiling.
//   - Bio-link fetch: network, so it is capped per tick and skipped for hosts
//     that are known to refuse fetchers.
//   - No scraping. This tick never calls Apify and cannot spend scraper credit.
//
// SAFETY
//   - Never clobbers an existing contact_email (`.is('contact_email', null)`
//     on the write, same as the discovery route).
//   - Synthetic creators are excluded — enrichment must not manufacture a
//     contact for a fixture.
//   - Every creator is marked scanned whether or not it yielded, so a pool with
//     no more addresses in it costs one query per tick and then stops.

import type { SupabaseClient } from '@supabase/supabase-js';
import { discoverContacts } from './contact-discovery';
import { createLogger } from './logger';

const log = createLogger('enrichment-tick');

/** Creators examined per invocation. Bounded so the tick stays well inside its route budget. */
export const ENRICHMENT_BATCH_SIZE = 60;
/** Model calls per invocation. The LLM pass only fires on bios that look like they hold a contact. */
export const ENRICHMENT_LLM_CAP = 10;
/** Network bio-link fetches per invocation. */
export const ENRICHMENT_BIOLINK_CAP = 20;
/** Give up on a creator after this many empty scans. Bios rarely gain an email later. */
export const CONTACT_SCAN_MAX_ATTEMPTS = 3;
/** Wall-clock ceiling for the whole batch. */
export const ENRICHMENT_TIME_BUDGET_MS = 120_000;

export interface EnrichmentTally {
  scanned: number;
  emails_found: number;
  llm_calls: number;
  biolink_fetches: number;
  exhausted: number;
  errors: number;
}

interface CandidateRow {
  id: string;
  username: string | null;
  platform: string | null;
  bio: string | null;
  raw_data: Record<string, unknown> | null;
  contact_scan_attempts: number | null;
}

/**
 * Does this bio look like it is trying to give out a contact at all?
 *
 * The deterministic regex pass has already run and found nothing by the time
 * this is consulted, so the only thing left for a model to find is an address
 * written in a form the regex misses. Firing a model at a bio with no contact
 * signal whatsoever is the single easiest way to spend money on zero yield.
 */
export function hasContactIntent(bio: string | null | undefined): boolean {
  if (!bio) return false;
  const b = bio.toLowerCase();
  return (
    b.includes('@') ||
    b.includes('mail') ||
    b.includes('dot com') ||
    b.includes('(at)') ||
    b.includes('[at]') ||
    b.includes('inquiries') ||
    b.includes('inquiry') ||
    b.includes('booking') ||
    b.includes('business') ||
    b.includes('collab') ||
    b.includes('contact') ||
    b.includes('management') ||
    b.includes('manager') ||
    b.includes('press') ||
    b.includes('pr:') ||
    b.includes('work with')
  );
}

/**
 * One enrichment pass. Resolves a tally; never throws — a scheduled tick that
 * throws looks identical to a dead scheduler.
 */
export async function runEnrichmentTick(
  sb: SupabaseClient,
  opts: { batchSize?: number; now?: () => number } = {},
): Promise<EnrichmentTally> {
  const batchSize = opts.batchSize ?? ENRICHMENT_BATCH_SIZE;
  const now = opts.now ?? Date.now;
  const started = now();
  const tally: EnrichmentTally = {
    scanned: 0,
    emails_found: 0,
    llm_calls: 0,
    biolink_fetches: 0,
    exhausted: 0,
    errors: 0,
  };

  // Least-recently-scanned first, never-scanned before that. Matches the
  // partial index in migration 050.
  const { data, error } = await sb
    .from('influencers')
    .select('id, username, platform, bio, raw_data, contact_scan_attempts')
    .is('contact_email', null)
    .eq('synthetic', false)
    .lt('contact_scan_attempts', CONTACT_SCAN_MAX_ATTEMPTS)
    .order('contact_scanned_at', { ascending: true, nullsFirst: true })
    .limit(batchSize);

  if (error) {
    log.error('candidate query failed', { error: error.message });
    tally.errors += 1;
    return tally;
  }

  const rows = (data ?? []) as unknown as CandidateRow[];
  if (rows.length === 0) return tally;

  for (const row of rows) {
    if (now() - started > ENRICHMENT_TIME_BUDGET_MS) break;

    const attempts = row.contact_scan_attempts ?? 0;
    // The LLM pass is gated twice: a per-tick ceiling, and whether this
    // particular bio shows any contact intent for a model to work on.
    const enableLlm = tally.llm_calls < ENRICHMENT_LLM_CAP && hasContactIntent(row.bio);
    const enableBioLink = tally.biolink_fetches < ENRICHMENT_BIOLINK_CAP;

    let foundEmail: string | null = null;
    try {
      const { candidates } = await discoverContacts(
        {
          username: row.username,
          platform: row.platform,
          bio: row.bio,
          raw_data: row.raw_data,
          contact_email: null,
        },
        {
          supabase: sb,
          influencerId: row.id,
          enableLlm,
          enableBioLink,
          maxBioLinks: 1,
          onLlmCall: () => {
            tally.llm_calls += 1;
          },
        },
      );
      if (enableBioLink) tally.biolink_fetches += 1;
      foundEmail = candidates.find((c) => c.channel === 'email')?.address ?? null;
    } catch (e) {
      // One bad creator must not end the batch.
      tally.errors += 1;
      log.error('enrichment failed for creator', {
        influencer_id: row.id,
        error: (e as Error).message,
      });
    }

    tally.scanned += 1;

    if (foundEmail) {
      tally.emails_found += 1;
      // Never clobber a real contact: the .is() makes the write a no-op if
      // another path filled it in between the select and here.
      await sb
        .from('influencers')
        .update({
          contact_email: foundEmail,
          contact_scanned_at: new Date(now()).toISOString(),
          contact_scan_attempts: 0,
        } as never)
        .eq('id', row.id)
        .is('contact_email', null);
    } else {
      const next = attempts + 1;
      if (next >= CONTACT_SCAN_MAX_ATTEMPTS) tally.exhausted += 1;
      await sb
        .from('influencers')
        .update({
          contact_scanned_at: new Date(now()).toISOString(),
          contact_scan_attempts: next,
        } as never)
        .eq('id', row.id);
    }
  }

  return tally;
}
