// src/lib/confirm-summary.ts
//
// Pure copy helpers for /campaigns/[id]/confirm.
//
// The confirm page used to render the firm's scraping and outreach prefs as two
// raw `<pre>{JSON}</pre>` blocks, each paired with a textarea pre-filled with
// literally `{}`. That asked a label manager to hand-write JSON to configure a
// run — and `campaigns.scraping_overrides`, the column one of those textareas
// wrote to, is READ BY NOTHING in the pipeline (the run route sources
// `firms.scraping_prefs` directly, see api/campaigns/[id]/run/route.ts §Step 3).
// So the control was both hostile and inert.
//
// These functions turn the prefs that DO drive a run into plain lines a manager
// can read. Anything unset is reported as unset with the default that will
// actually apply, never as a blank or a `null`.
//
// Defaults below are not invented — each is the literal fallback in the code
// path that consumes the pref:
//   follower_min  1,500   api/campaigns/[id]/run/route.ts (`: 1500`)
//   follower_max  none    same file (`: undefined` → no upper bound)
//   engagement_min none   same file (`: undefined` → floor not enforced there)
//
// Pure module: no env, no I/O, no React. Tested by tests/confirm-summary.test.ts.

import { regionGateActive, resolveRegionPref } from './creator-region';

export interface SummaryLine {
  label: string;
  value: string;
  /** True when the value is a fallback the user has not set, so the UI can
   *  render it muted rather than as a configured choice. */
  isDefault: boolean;
}

export interface ScrapingPrefsShape {
  genres?: unknown;
  follower_min?: unknown;
  follower_max?: unknown;
  engagement_min?: unknown;
  region?: unknown;
}

export interface OutreachPrefsShape {
  voice?: unknown;
  tone?: unknown;
  dos?: unknown;
  donts?: unknown;
  signoff?: unknown;
  follow_up_cadence_days?: unknown;
  max_follow_ups?: unknown;
}

/** A positive finite number, or null. PostgREST hands back NUMERIC as a string,
 *  so a numeric string counts. */
function posNum(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nonEmptyString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v !== '');
}

/**
 * The creator-search settings the discovery run will actually use, as readable
 * lines. Sourced from firms.scraping_prefs — changed on /onboarding, not here.
 */
export function describeScrapingPrefs(prefs: ScrapingPrefsShape | null | undefined): SummaryLine[] {
  const p = prefs ?? {};
  const lines: SummaryLine[] = [];

  const genres = stringList(p.genres);
  lines.push(
    genres.length > 0
      ? { label: 'Genres', value: genres.join(', '), isDefault: false }
      : { label: 'Genres', value: 'any genre', isDefault: true }
  );

  const min = posNum(p.follower_min);
  const max = posNum(p.follower_max);
  if (min !== null && max !== null) {
    lines.push({
      label: 'Follower range',
      value: `${min.toLocaleString()} to ${max.toLocaleString()}`,
      isDefault: false,
    });
  } else if (min !== null) {
    lines.push({
      label: 'Follower range',
      value: `${min.toLocaleString()} and up`,
      isDefault: false,
    });
  } else if (max !== null) {
    lines.push({
      label: 'Follower range',
      value: `1,500 to ${max.toLocaleString()}`,
      isDefault: true,
    });
  } else {
    lines.push({ label: 'Follower range', value: '1,500 and up', isDefault: true });
  }

  const eng = posNum(p.engagement_min);
  lines.push(
    eng !== null
      ? {
          label: 'Minimum engagement',
          value: `${(eng * 100).toFixed(1)}%`,
          isDefault: false,
        }
      : { label: 'Minimum engagement', value: 'no floor set', isDefault: true }
  );

  const region = nonEmptyString(p.region);
  lines.push(
    region !== null
      ? { label: 'Region', value: region, isDefault: false }
      : { label: 'Region', value: 'anywhere', isDefault: true }
  );

  // This line used to be the whole of the region feature: the word
  // the manager typed, echoed back on a confirmation screen, with nothing in
  // the pipeline reading it. It now does two specific things and neither is
  // "only find creators who live there", so the screen says which two. There
  // is no author-level geography in the scrape at all (see
  // src/lib/creator-region.ts), and a confirmation page that implies a
  // location check is the same broken promise in quieter type.
  if (region !== null) {
    const pref = resolveRegionPref(region);
    lines.push({
      label: 'How region is used',
      // "en-only posts" was the first wording and it overstated twice. It
      // reads as "only creators posting in en are kept", when the filter only
      // rules out creators whose posts are CLEARLY in another language and
      // keeps everyone it cannot read — under "US" it excludes almost no one,
      // and every Instagram creator is
      // unknown-and-kept by construction because Instagram has no language
      // field. "check" claims what it does: it looks, and it mostly keeps.
      //
      // It used to name the languages by their ISO 639-1 codes, so a label
      // manager read "search terms + en/es check" on a confirmation screen.
      // The codes are ours; the sentence is theirs.
      value: regionGateActive(pref)
        ? 'search terms + a language check'
        : 'search terms only',
      isDefault: false,
    });
  }

  return lines;
}

/**
 * The outreach voice settings the drafting step will use. Sourced from
 * firms.outreach_prefs — tone, sign-off and follow-up cadence are edited on
 * /onboarding (/settings carries only the personality dial).
 */
export function describeOutreachPrefs(prefs: OutreachPrefsShape | null | undefined): SummaryLine[] {
  const p = prefs ?? {};
  const lines: SummaryLine[] = [];

  const tone = nonEmptyString(p.tone) ?? nonEmptyString(p.voice);
  lines.push(
    tone !== null
      ? { label: 'Tone', value: tone, isDefault: false }
      : { label: 'Tone', value: 'the default warm, specific tone', isDefault: true }
  );

  const dos = stringList(p.dos);
  const donts = stringList(p.donts);
  lines.push({
    label: 'Writing rules',
    value:
      dos.length + donts.length === 0
        ? 'none set'
        : `${dos.length} thing${dos.length === 1 ? '' : 's'} to do, ${donts.length} to avoid`,
    isDefault: dos.length + donts.length === 0,
  });

  const signoff = nonEmptyString(p.signoff);
  lines.push(
    signoff !== null
      ? { label: 'Sign-off', value: signoff, isDefault: false }
      : { label: 'Sign-off', value: 'none set', isDefault: true }
  );

  const cadence = posNum(p.follow_up_cadence_days);
  const maxFollowUps = p.max_follow_ups === 0 ? 0 : posNum(p.max_follow_ups);
  if (maxFollowUps === 0) {
    lines.push({ label: 'Follow-ups', value: 'none, one message only', isDefault: false });
  } else if (maxFollowUps !== null && cadence !== null) {
    lines.push({
      label: 'Follow-ups',
      value: `up to ${maxFollowUps}, every ${cadence} day${cadence === 1 ? '' : 's'}`,
      isDefault: false,
    });
  } else if (maxFollowUps !== null) {
    lines.push({
      label: 'Follow-ups',
      value: `up to ${maxFollowUps}`,
      isDefault: false,
    });
  } else {
    lines.push({ label: 'Follow-ups', value: 'not set', isDefault: true });
  }

  return lines;
}

// ── Cap gate copy ───────────────────────────────────────────────────────────
//
// Migration 037 added campaigns_confirmed_requires_caps, and
// api/campaigns/[id]/confirm/route.ts answers 412 `campaign_caps_required` with
// a `missing` array of raw column names. Those column names must never reach
// the screen.

export const CAP_FIELD_LABELS: Record<string, string> = {
  total_budget_usd: 'Total budget',
  per_creator_cap_usd: 'Per-creator cap',
};

/** Raw column name → the label used on this form. Unknown names pass through
 *  de-snaked rather than raw, so a future column is still readable. */
export function capFieldLabel(column: string): string {
  return CAP_FIELD_LABELS[column] ?? column.replace(/_usd$/, '').replace(/_/g, ' ');
}

/** The sentence shown when the server refuses the confirm for missing caps.
 *  Names the fields in the form's own words, never the columns. */
export function capsRequiredMessage(missing: readonly string[]): string {
  const labels = missing.map(capFieldLabel);
  const list =
    labels.length === 0
      ? 'a spending limit'
      : labels.length === 1
        ? labels[0]
        : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return (
    `Set ${list} above before you can confirm. ` +
    'These are the only limits that stop this campaign paying a creator, so a campaign without them cannot be armed.'
  );
}
