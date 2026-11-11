// src/lib/firm-blocks.ts
//
// Per-label "do not contact" — migration 056's `firm_influencer_blocks`.
//
// A creator row is shared across firms by design; a block is not. A STOP sent
// to label A's email is an opt-out from label A (the copy says "we'll take you
// off OUR list"), and a label clicking Block is that label's decision. Both
// used to set `influencers.blocklisted`, which every firm reads, so one label's
// opt-out silently removed the creator from every other label's pool.
//
// THE RULE every contact path applies:
//
//   do-not-contact for firm F  =  influencers.blocklisted  OR  a row (F, creator)
//
// The global column is NOT retired. Its existing true rows are a platform-level
// block (migration 056 deliberately does not migrate them), and it stays the
// fallback write when the per-firm table cannot be written.
//
// PRE-056. This code ships before the migration is applied to the shared
// project. A missing table (PGRST205 / 42P01) is therefore an expected state,
// not an error: reads degrade to "no per-firm blocks" (today's behaviour, the
// global column still gates), and writes report `table_missing` so the caller
// can fall back to the global column. An opt-out is never dropped for schema
// skew.
//
// UNREADABLE is different from missing. A read that fails for any other reason
// is reported as `unreadable`, and each caller picks its direction:
//   * send boundary + dispatch: HOLD (fail closed). The row stays queued and the
//     next minute retries — the cost is a minute, the alternative is emailing
//     someone who said stop.
//   * the human DM queue (listing hides + counts; Mark sent refuses 409/503,
//     src/lib/dm-mark-sent.ts) and the post-payment promo email
//     (src/lib/promo-materials.ts): HOLD too, via checkDoNotContact /
//     doNotContactVerdict below. The promo hold is NOT retried — its callers
//     fire once per paid deal.
//   * pool builders (run / draft-all / qualify / draft): proceed on the global
//     flag alone and log. They persist exclusions, so failing closed there would
//     permanently exclude a whole pool on one blip — and the send boundary
//     re-checks anyway.
//
// SECURITY: callers inject the Supabase client (service-role in every path
// today). Every read and write here carries an explicit firm predicate; RLS on
// the table is defense-in-depth only (see 056's header).

import type { SupabaseClient } from '@supabase/supabase-js';

export const FIRM_BLOCKS_TABLE = 'firm_influencer_blocks';

/** Mirrors the 056 CHECK constraint. */
export type FirmBlockSource = 'creator_opt_out' | 'label_user';

/**
 * Held-not-refused reason for the send paths when a firm's blocks cannot be
 * read. Label-readable; says what happens next.
 */
export const FIRM_BLOCK_UNREADABLE_REASON =
  "Couldn't confirm this label's do-not-contact list. Held, not sent; it retries automatically";

/** PostgREST `.in()` goes in the URL; keep each request well under proxy limits. */
const ID_CHUNK = 200;

/**
 * True only when the database is telling us the TABLE does not exist:
 * PostgREST's schema cache has no such relation (PGRST205), or Postgres
 * undefined_table (42P01). Anything else is a real failure.
 */
export function isMissingTableError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'PGRST205' || code === '42P01') return true;
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  if (!msg.includes(FIRM_BLOCKS_TABLE)) return false;
  return (
    msg.includes('could not find the table') ||
    (msg.includes('relation') && msg.includes('does not exist'))
  );
}

export type FirmBlockReadState = 'ok' | 'table_missing' | 'unreadable';

export interface FirmBlockRead {
  state: FirmBlockReadState;
  /** Influencer ids this firm has blocked. Always empty unless state is 'ok'. */
  ids: Set<string>;
  message?: string;
}

let warnedMissing = false;
function warnMissingOnce(where: string): void {
  if (warnedMissing) return;
  warnedMissing = true;
  console.warn(
    `[firm-blocks] ${FIRM_BLOCKS_TABLE} does not exist — migration 056 is not applied. ` +
      `Gating on influencers.blocklisted only (first seen in ${where}).`,
  );
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Which of `influencerIds` has `firmId` blocked.
 *
 * Ids are required on purpose: reading a firm's whole block list would hit
 * PostgREST's row cap silently once a label has blocked enough creators, and
 * an under-read block list is a contact path that looks gated and is not.
 */
export async function readFirmBlocks(
  sb: SupabaseClient,
  firmId: string | null | undefined,
  influencerIds: readonly (string | null | undefined)[],
): Promise<FirmBlockRead> {
  const ids = [...new Set(influencerIds.filter((v): v is string => typeof v === 'string' && v.length > 0))];
  const out = new Set<string>();
  if (typeof firmId !== 'string' || firmId.length === 0 || ids.length === 0) {
    return { state: 'ok', ids: out };
  }
  try {
    for (const part of chunks(ids, ID_CHUNK)) {
      const { data, error } = await sb
        .from(FIRM_BLOCKS_TABLE)
        .select('influencer_id')
        .eq('firm_id', firmId)
        .in('influencer_id', part);
      if (error) {
        if (isMissingTableError(error)) {
          warnMissingOnce('readFirmBlocks');
          return { state: 'table_missing', ids: new Set() };
        }
        return { state: 'unreadable', ids: new Set(), message: error.message };
      }
      for (const row of (data ?? []) as Array<{ influencer_id?: unknown }>) {
        if (typeof row.influencer_id === 'string') out.add(row.influencer_id);
      }
    }
  } catch (e) {
    return { state: 'unreadable', ids: new Set(), message: (e as Error).message };
  }
  return { state: 'ok', ids: out };
}

export function firmBlockKey(firmId: string, influencerId: string): string {
  return `${firmId}:${influencerId}`;
}

export interface FirmBlockPairsRead {
  state: FirmBlockReadState;
  /** firmBlockKey(firm, influencer) for every block among the inputs. */
  keys: Set<string>;
  message?: string;
}

/**
 * Batch form for passes that span firms (dispatch, escalation): every block
 * whose firm is in `firmIds` AND whose creator is in `influencerIds`. The cross
 * product can over-select (firm A's block on a creator only firm B is
 * messaging), which is harmless — lookups are by exact (firm, creator) key.
 */
export async function readFirmBlocksForPairs(
  sb: SupabaseClient,
  firmIds: readonly (string | null | undefined)[],
  influencerIds: readonly (string | null | undefined)[],
): Promise<FirmBlockPairsRead> {
  const firms = [...new Set(firmIds.filter((v): v is string => typeof v === 'string' && v.length > 0))];
  const infs = [...new Set(influencerIds.filter((v): v is string => typeof v === 'string' && v.length > 0))];
  const keys = new Set<string>();
  if (firms.length === 0 || infs.length === 0) return { state: 'ok', keys };
  try {
    for (const part of chunks(infs, ID_CHUNK)) {
      const { data, error } = await sb
        .from(FIRM_BLOCKS_TABLE)
        .select('firm_id, influencer_id')
        .in('firm_id', firms)
        .in('influencer_id', part);
      if (error) {
        if (isMissingTableError(error)) {
          warnMissingOnce('readFirmBlocksForPairs');
          return { state: 'table_missing', keys: new Set() };
        }
        return { state: 'unreadable', keys: new Set(), message: error.message };
      }
      for (const row of (data ?? []) as Array<{ firm_id?: unknown; influencer_id?: unknown }>) {
        if (typeof row.firm_id === 'string' && typeof row.influencer_id === 'string') {
          keys.add(firmBlockKey(row.firm_id, row.influencer_id));
        }
      }
    }
  } catch (e) {
    return { state: 'unreadable', keys: new Set(), message: (e as Error).message };
  }
  return { state: 'ok', keys };
}

/**
 * THE RULE, as a verdict, for one creator:
 *
 *   'blocked' — influencers.blocklisted, or a (firm, creator) row.
 *   'clear'   — neither, and the per-firm list was read (or is pre-056 missing).
 *   'unknown' — the per-firm list could not be read, or there is no creator id
 *               to look up. Callers at a contact boundary treat this as HOLD.
 *
 * The global flag wins over an unreadable list: a platform block is known
 * without the table, so it is reported as 'blocked', not 'unknown'.
 */
export type DoNotContactVerdict = 'blocked' | 'clear' | 'unknown';

export function doNotContactVerdict(
  globalBlocklisted: boolean | null | undefined,
  influencerId: string | null | undefined,
  read: Pick<FirmBlockRead, 'state' | 'ids'>,
): DoNotContactVerdict {
  if (globalBlocklisted === true) return 'blocked';
  if (read.state === 'unreadable') return 'unknown';
  if (typeof influencerId !== 'string' || influencerId.length === 0) return 'unknown';
  if (read.ids.has(influencerId)) return 'blocked';
  return 'clear';
}

export interface DoNotContactCheck {
  verdict: DoNotContactVerdict;
  influencerId: string | null;
  /** Why the verdict is 'unknown', for the log. */
  detail?: string;
}

/**
 * The send-boundary check for ONE lead, for contact paths that start from a
 * campaign_influencers row (the DM queue's Mark sent, the post-payment promo
 * email). Resolves the creator, reads the global flag and this firm's row, and
 * returns the verdict. Never throws. Anything it cannot read is 'unknown' — the
 * caller holds; it never guesses 'clear'.
 */
export async function checkDoNotContact(
  sb: SupabaseClient,
  input: { firmId: string | null | undefined; campaignInfluencerId: string | null | undefined },
): Promise<DoNotContactCheck> {
  const { firmId, campaignInfluencerId } = input;
  if (typeof firmId !== 'string' || firmId.length === 0) {
    return { verdict: 'unknown', influencerId: null, detail: 'no firm to check against' };
  }
  if (typeof campaignInfluencerId !== 'string' || campaignInfluencerId.length === 0) {
    return { verdict: 'unknown', influencerId: null, detail: 'no lead to resolve a creator from' };
  }
  try {
    const { data: ci, error: ciErr } = await sb
      .from('campaign_influencers')
      .select('influencer_id')
      .eq('id', campaignInfluencerId)
      .maybeSingle();
    if (ciErr) return { verdict: 'unknown', influencerId: null, detail: ciErr.message };
    const influencerId = (ci as { influencer_id?: unknown } | null)?.influencer_id;
    if (typeof influencerId !== 'string' || influencerId.length === 0) {
      return { verdict: 'unknown', influencerId: null, detail: 'lead has no creator' };
    }
    const { data: inf, error: infErr } = await sb
      .from('influencers')
      .select('blocklisted')
      .eq('id', influencerId)
      .maybeSingle();
    if (infErr || !inf) {
      return { verdict: 'unknown', influencerId, detail: infErr?.message ?? 'creator row not found' };
    }
    const globalBlocked = (inf as { blocklisted?: unknown }).blocklisted === true;
    const read = await readFirmBlocks(sb, firmId, [influencerId]);
    const verdict = doNotContactVerdict(globalBlocked, influencerId, read);
    return verdict === 'unknown'
      ? { verdict, influencerId, detail: read.message ?? 'block list unreadable' }
      : { verdict, influencerId };
  } catch (e) {
    return { verdict: 'unknown', influencerId: null, detail: (e as Error).message };
  }
}

/**
 * WHY a creator is do-not-contact for a label, for surfaces that must SAY it
 * (the negotiation tick's skip reason, /approvals, the deal row). Most specific
 * first: the creator's own STOP, then this label's Block, then the platform flag.
 */
export type DoNotContactFlag = 'opted_out' | 'label_blocked' | 'platform_blocked';

export interface DoNotContactFlags {
  /** 'unreadable' when either list could not be read: absent ≠ clear. */
  state: 'ok' | 'unreadable';
  /** Only the blocked creators appear. */
  flags: Map<string, DoNotContactFlag>;
  message?: string;
}

/**
 * The same rule as doNotContactVerdict (global column OR this firm's row), for
 * many creators at once and with the reason kept. Read-only; never throws.
 * Pre-056 (table missing) reads as "no per-label rows", exactly as the send
 * paths read it. A flag already known is kept even when the other list is
 * unreadable, so an unreadable list never hides a block it did not need.
 */
export async function readDoNotContactFlags(
  sb: SupabaseClient,
  firmId: string | null | undefined,
  influencerIds: readonly (string | null | undefined)[],
): Promise<DoNotContactFlags> {
  const ids = [...new Set(influencerIds.filter((v): v is string => typeof v === 'string' && v.length > 0))];
  const flags = new Map<string, DoNotContactFlag>();
  if (ids.length === 0) return { state: 'ok', flags };
  const global = new Set<string>();
  const firmSource = new Map<string, string>();
  let unreadable: string | null = null;
  try {
    for (const part of chunks(ids, ID_CHUNK)) {
      const { data, error } = await sb.from('influencers').select('id, blocklisted').in('id', part);
      if (error) {
        unreadable = error.message;
        break;
      }
      for (const r of (data ?? []) as Array<{ id?: unknown; blocklisted?: unknown }>) {
        if (typeof r.id === 'string' && r.blocklisted === true) global.add(r.id);
      }
    }
    if (typeof firmId === 'string' && firmId.length > 0) {
      for (const part of chunks(ids, ID_CHUNK)) {
        const { data, error } = await sb
          .from(FIRM_BLOCKS_TABLE)
          .select('influencer_id, source')
          .eq('firm_id', firmId)
          .in('influencer_id', part);
        if (error) {
          if (isMissingTableError(error)) {
            warnMissingOnce('readDoNotContactFlags');
            break;
          }
          unreadable = error.message;
          break;
        }
        for (const r of (data ?? []) as Array<{ influencer_id?: unknown; source?: unknown }>) {
          if (typeof r.influencer_id === 'string') firmSource.set(r.influencer_id, String(r.source ?? ''));
        }
      }
    }
  } catch (e) {
    unreadable = (e as Error).message;
  }
  for (const id of ids) {
    const src = firmSource.get(id);
    if (src === 'creator_opt_out') flags.set(id, 'opted_out');
    else if (src !== undefined) flags.set(id, 'label_blocked');
    else if (global.has(id)) flags.set(id, 'platform_blocked');
  }
  return unreadable != null ? { state: 'unreadable', flags, message: unreadable } : { state: 'ok', flags };
}

export type FirmBlockWrite =
  | { state: 'ok' }
  | { state: 'table_missing'; message: string }
  | { state: 'failed'; message: string };

function writeFailure(error: { message?: string } | null | unknown): FirmBlockWrite {
  const message =
    typeof (error as { message?: unknown })?.message === 'string'
      ? (error as { message: string }).message
      : String(error);
  if (isMissingTableError(error)) return { state: 'table_missing', message };
  return { state: 'failed', message };
}

/**
 * Record (firm, creator) as do-not-contact. Idempotent: a second STOP, or a
 * second click, leaves the FIRST row — and its provenance — in place.
 */
export async function recordFirmBlock(
  sb: SupabaseClient,
  input: {
    firmId: string;
    influencerId: string;
    source: FirmBlockSource;
    reason?: string | null;
    createdByUserId?: string | null;
  },
): Promise<FirmBlockWrite> {
  try {
    const { error } = await sb.from(FIRM_BLOCKS_TABLE).upsert(
      {
        firm_id: input.firmId,
        influencer_id: input.influencerId,
        source: input.source,
        reason: input.reason ?? null,
        created_by_user_id: input.createdByUserId ?? null,
      } as never,
      { onConflict: 'firm_id,influencer_id', ignoreDuplicates: true },
    );
    if (error) return writeFailure(error);
    return { state: 'ok' };
  } catch (e) {
    return writeFailure(e);
  }
}

/** Remove THIS firm's block. Never touches another firm's row or the global flag. */
export async function removeFirmBlock(
  sb: SupabaseClient,
  firmId: string,
  influencerId: string,
): Promise<FirmBlockWrite> {
  try {
    const { error } = await sb
      .from(FIRM_BLOCKS_TABLE)
      .delete()
      .eq('firm_id', firmId)
      .eq('influencer_id', influencerId);
    if (error) return writeFailure(error);
    return { state: 'ok' };
  } catch (e) {
    return writeFailure(e);
  }
}

async function setGlobalBlocklisted(
  sb: SupabaseClient,
  influencerId: string,
  value: boolean,
): Promise<string | null> {
  try {
    const { error } = await sb
      .from('influencers')
      .update({ blocklisted: value } as never)
      .eq('id', influencerId);
    return error ? error.message : null;
  } catch (e) {
    return (e as Error).message;
  }
}

export type OptOutOutcome =
  | { scope: 'firm'; firm_id: string }
  | {
      scope: 'global_fallback';
      why: 'table_missing' | 'firm_unknown' | 'firm_write_failed';
      firm_id: string | null;
      detail?: string;
    }
  | { scope: 'not_honoured'; firm_id: string | null; error: string };

/**
 * Honour a creator's STOP for the label they said it to.
 *
 * Writes the per-firm row. If that is impossible — the table is not there yet,
 * the lead's firm cannot be resolved, or the write fails — it falls back to the
 * global column, because an over-broad block costs one lost lead and an
 * unhonoured opt-out is a promise the copy made and the system broke. Every
 * fallback is logged; a failure of the fallback too is logged loudly.
 */
export async function honourOptOut(
  sb: SupabaseClient,
  input: { influencerId: string; firmId: string | null },
): Promise<OptOutOutcome> {
  const { influencerId, firmId } = input;
  let why: 'table_missing' | 'firm_unknown' | 'firm_write_failed';
  let detail: string | undefined;

  if (firmId) {
    const w = await recordFirmBlock(sb, {
      firmId,
      influencerId,
      source: 'creator_opt_out',
      reason: 'Creator replied with an opt-out',
    });
    if (w.state === 'ok') return { scope: 'firm', firm_id: firmId };
    if (w.state === 'table_missing') {
      why = 'table_missing';
      console.warn(
        '[firm-blocks] opt-out: migration 056 not applied — falling back to the GLOBAL ' +
          'influencers.blocklisted so the opt-out is not lost (blocks this creator for every label)',
        influencerId,
      );
    } else {
      why = 'firm_write_failed';
      detail = w.message;
      console.error(
        '[firm-blocks] opt-out: per-firm block write FAILED — falling back to the GLOBAL ' +
          'influencers.blocklisted so the opt-out is not lost',
        { influencerId, firmId, error: w.message },
      );
    }
  } else {
    why = 'firm_unknown';
    console.warn(
      "[firm-blocks] opt-out: could not resolve the lead's firm — falling back to the GLOBAL " +
        'influencers.blocklisted so the opt-out is not lost',
      influencerId,
    );
  }

  const globalErr = await setGlobalBlocklisted(sb, influencerId, true);
  if (globalErr) {
    // The creator asked to be left alone and we may keep contacting them.
    // This is the one failure here worth shouting about.
    console.error(
      '[ingest-inbound] OPT-OUT NOT HONOURED — could not block influencer (per-firm or global)',
      influencerId,
      globalErr,
    );
    return { scope: 'not_honoured', firm_id: firmId, error: globalErr };
  }
  return { scope: 'global_fallback', why, firm_id: firmId, ...(detail ? { detail } : {}) };
}

/**
 * Status a queued outbound message is moved to when its creator opted out
 * before it went. Same terminal, unsent status a dropped holding note uses
 * (src/lib/message-status.ts), so every reader already refuses to send it.
 */
export const OPT_OUT_CANCELLED_STATUS = 'superseded' as const;

/**
 * Cancel every still-queued outbound message to a creator who just opted out.
 *
 * The dispatch gate (contactBlocksFor) already HOLDS these rows, but held is
 * not cancelled: the counter stays live in the dashboard with a Send button,
 * and lifting the block later would fire a stale offer at someone who said
 * STOP. Scope matches the block: the firm's own campaigns when the block is
 * per-label, every campaign when it fell back to the global flag (firmId null).
 * Best-effort — a failure here leaves the rows held by the gate, never sent.
 * Returns how many rows were cancelled.
 */
export async function cancelQueuedOutboundForOptOut(
  sb: SupabaseClient,
  input: { influencerId: string; firmId: string | null },
): Promise<number> {
  try {
    const { data: ciData, error: ciErr } = await sb
      .from('campaign_influencers')
      .select('id, campaign_id')
      .eq('influencer_id', input.influencerId);
    if (ciErr) return 0;
    let cis = (ciData ?? []) as Array<{ id: string; campaign_id: string | null }>;
    if (input.firmId) {
      const campIds = [...new Set(cis.map((c) => c.campaign_id).filter(Boolean))] as string[];
      if (campIds.length === 0) return 0;
      const { data: campData, error: campErr } = await sb
        .from('campaigns')
        .select('id, firm_id')
        .in('id', campIds);
      if (campErr) return 0;
      const ours = new Set(
        ((campData ?? []) as Array<{ id: string; firm_id: string | null }>)
          .filter((c) => c.firm_id === input.firmId)
          .map((c) => c.id),
      );
      cis = cis.filter((c) => c.campaign_id != null && ours.has(c.campaign_id));
    }
    if (cis.length === 0) return 0;
    const { data } = await sb
      .from('outreach_messages')
      .update({ status: OPT_OUT_CANCELLED_STATUS, send_after: null } as never)
      .in('campaign_influencer_id', cis.map((c) => c.id))
      .eq('direction', 'outbound')
      .eq('status', 'queued')
      .select('id');
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

export type BlockToggleResult =
  | { ok: true; applied: 'firm' | 'global' | 'global_fallback' }
  | { ok: false; httpStatus: 403 | 500; error: string; message?: string };

/**
 * The PATCH /api/influencers/[id] block toggle, extracted so it runs in tests.
 *
 *   scope 'firm'   (default) — any member of the caller's firm: writes or
 *                  removes THIS firm's row only.
 *   scope 'global' — platform operators only (src/lib/operator.ts): the shared
 *                  influencers.blocklisted column, which every firm honours.
 *
 * Pre-056 the firm scope falls back to the global column — exactly the
 * behaviour the route had before this table existed — so the Block button keeps
 * working until the migration is applied.
 *
 * The caller has already applied the creator-relationship gate
 * (creator-scope.ts); this function trusts `firmId`.
 */
export async function applyBlockToggle(
  sb: SupabaseClient,
  input: {
    firmId: string;
    influencerId: string;
    blocked: boolean;
    scope: 'firm' | 'global';
    isOperator: boolean;
    userId: string | null;
  },
): Promise<BlockToggleResult> {
  if (input.scope === 'global') {
    if (!input.isOperator) {
      return {
        ok: false,
        httpStatus: 403,
        error: 'operator_only',
        message: 'A platform-wide block can only be set or cleared by a platform operator.',
      };
    }
    const err = await setGlobalBlocklisted(sb, input.influencerId, input.blocked);
    if (err) return { ok: false, httpStatus: 500, error: err };
    return { ok: true, applied: 'global' };
  }

  const w = input.blocked
    ? await recordFirmBlock(sb, {
        firmId: input.firmId,
        influencerId: input.influencerId,
        source: 'label_user',
        reason: 'Blocked by a label user',
        createdByUserId: input.userId,
      })
    : await removeFirmBlock(sb, input.firmId, input.influencerId);
  if (w.state === 'ok') return { ok: true, applied: 'firm' };
  if (w.state === 'failed') return { ok: false, httpStatus: 500, error: w.message };

  console.warn(
    '[firm-blocks] block toggle: migration 056 not applied — writing the GLOBAL ' +
      'influencers.blocklisted (pre-056 behaviour)',
    { influencerId: input.influencerId, firmId: input.firmId, blocked: input.blocked },
  );
  const err = await setGlobalBlocklisted(sb, input.influencerId, input.blocked);
  if (err) return { ok: false, httpStatus: 500, error: err };
  return { ok: true, applied: 'global_fallback' };
}
