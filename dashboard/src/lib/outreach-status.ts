// src/lib/outreach-status.ts
//
// The vocabulary of campaign_influencers.outreach_status, in one place.
//
// This column is the spine of the /outreach screen — the draft pool, all seven
// tabs and the stat counters read it — but it had no single definition. The
// checked-in reference schema (supabase/migrations/003_base_schema.sql) documents it as
// `none | drafted | sent | replied`; an older database defaulted it to
// 'pending'; the code writes 'draft_ready', 'responded' and 'rejected'. Three
// vocabularies, no overlap, no CHECK constraint. Each reader picked a spelling
// and the ones that guessed wrong returned nothing:
//
//   - /api/outreach/generate-bulk queried `.in('outreach_status', ['pending'])`,
//     which is correct against live and empty against the repo's own schema.
//   - /api/outreach/list used `.eq()` for the "No Message" tab, a state with
//     four legal spellings.
//   - Nothing at all wrote 'sent', so the Sent tab could never fill.
//
// Rules for anything touching this column:
//   1. Import the vocabulary from here. Do not inline a status string.
//   2. Reading the no-message-yet state means noMessageYetFilter(), never
//      `.eq('outreach_status', 'pending')` — legacy rows are 'none' or NULL.
//   3. Advancing a creator is a write to THIS column. `campaign_influencers.status`
//      is a separate, older funnel column that the discovery upsert resets to
//      'queued' on every re-run (api/campaigns/[id]/run/route.ts:757), so it
//      cannot carry send state.
//
// Migration 039 converges the database onto this vocabulary. The code does not
// depend on it having run: every reader here tolerates the pre-migration
// spellings, which is the point.

/**
 * The canonical state machine.
 *
 *   pending ──▶ draft_ready ──▶ sent ──┬─▶ responded ──▶ negotiating ──▶ deal_closed
 *                                      └─▶ rejected
 *
 * Writers, one per transition:
 *   pending      DB column default. Discovery never writes the column
 *                (api/campaigns/[id]/run/route.ts:743-757) — it relies on this.
 *   draft_ready  saveOutreachMessage (lib/outreach.ts) and
 *                api/campaigns/[id]/draft-all.
 *   sent         api/outreach/[id]/send (email) and
 *                lib/channel-priors.markHumanQueueSent (DM queue, human-sent).
 *   responded /  lib/ingest-inbound and api/outreach/respond, from the reply
 *   rejected     classification.
 *
 * negotiating and deal_closed are declared and read (the tabs, the deals
 * funnel) but no writer advances a creator into them yet — the negotiation
 * chain tracks its own state on `offers`. They stay in the vocabulary so the
 * tabs render and the filters are total.
 */
export const OUTREACH_STATUS_VALUES = [
  'pending',
  'draft_ready',
  'sent',
  'responded',
  'negotiating',
  'rejected',
  'deal_closed',
] as const;

export type OutreachStatus = (typeof OUTREACH_STATUS_VALUES)[number];

/**
 * Every spelling of "no message has gone out yet" that older rows carry
 * or that can be produced by a database built from the checked-in schema.
 *
 *   'pending'  canonical, and the live column default
 *   'none'     the default in supabase/migrations/003_base_schema.sql
 *   ''         defensive; a hand-edited row
 *   NULL       pre-default legacy rows (handled separately — SQL IN never
 *              matches NULL, which is exactly why this needs an or-filter)
 */
export const NO_MESSAGE_YET_VALUES = ['pending', 'none', ''] as const;

/** The state a creator is in when the draft pool should pick them up. */
export const DRAFT_POOL_STATUSES = NO_MESSAGE_YET_VALUES;

/**
 * The PostgREST logic tree for "no message yet", including NULL.
 *
 * `.in()` alone cannot express this: SQL `IN` never matches NULL, so a legacy
 * row is invisible to it. Verified against the live PostgREST instance on
 * 2026-09-15 — this exact clause returns 200, a malformed one returns 400
 * (PGRST100) and an unknown column returns 400 (42703), so the 200 is a real
 * parse. tests/outreach-status.test.ts pins the literal.
 */
export const NO_MESSAGE_YET_OR_FILTER =
  'outreach_status.is.null,outreach_status.in.("pending","none","")';

/** True when no outbound message has gone to this creator yet. */
export function isNoMessageYet(status: string | null | undefined): boolean {
  if (status === null || status === undefined) return true;
  return (NO_MESSAGE_YET_VALUES as readonly string[]).includes(status);
}

/** Minimal shape of the PostgREST builder methods these filters use. */
interface OrFilterable {
  or(clause: string): OrFilterable;
}
interface InFilterable {
  in(column: string, values: readonly unknown[]): InFilterable;
}

/**
 * Narrow a campaign_influencers query to creators who have had no message yet.
 *
 * Compose with eligibleDraftFilter (src/lib/outreach.ts) to get the draft pool
 * — that one carries the bot_flagged / qualification_status guarantees and
 * this one must never be used as a substitute for it.
 */
export function noMessageYetFilter<Q>(query: Q): Q {
  return (query as unknown as OrFilterable).or(NO_MESSAGE_YET_OR_FILTER) as unknown as Q;
}

/**
 * The /outreach tab a user clicked, mapped to the outreach_status values it
 * covers. `null` means "apply no status filter".
 *
 * 'all'      every creator
 * 'dm_queue' not an outreach_status at all — the page filters it client-side on
 *            outreach_messages.send_mode, so the server must not narrow here
 * 'pending'  the No Message tab: every spelling, plus NULL
 * 'responded' both responded and negotiating, matching the tab badge count in
 *            src/app/outreach/page.tsx — the server used to return only
 *            'responded' while the badge counted both
 */
export function outreachStatusValuesForTab(tab: string): string[] | null {
  if (!tab || tab === 'all' || tab === 'dm_queue') return null;
  if (tab === 'pending') return [...NO_MESSAGE_YET_VALUES];
  if (tab === 'responded') return ['responded', 'negotiating'];
  return [tab];
}

/**
 * Apply a tab's status filter to a campaign_influencers query.
 *
 * The No Message tab needs the or-filter because of NULL; everything else is a
 * plain `.in()`, which also covers the single-value tabs without a special case.
 */
export function applyOutreachStatusTabFilter<Q>(query: Q, tab: string): Q {
  const values = outreachStatusValuesForTab(tab);
  if (values === null) return query;
  if (tab === 'pending') return noMessageYetFilter(query);
  return (query as unknown as InFilterable).in('outreach_status', values) as unknown as Q;
}

/** Operator-facing words. Keys cover the legacy spellings too. */
export const OUTREACH_STATUS_LABELS: Record<string, string> = {
  none: 'No message yet',
  pending: 'No message yet',
  '': 'No message yet',
  draft_ready: 'Draft ready',
  sent: 'Sent',
  responded: 'Responded',
  follow_up: 'Follow-up',
  negotiating: 'Negotiating',
  deal_closed: 'Deal closed',
  rejected: 'Rejected',
};

export function outreachStatusLabel(status: string | null | undefined): string {
  if (status === null || status === undefined) return OUTREACH_STATUS_LABELS.pending;
  return OUTREACH_STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}
