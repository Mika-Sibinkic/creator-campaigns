// src/lib/delivery-expiry.ts
//
// The sweeper that closes a deal nobody delivered, so no human ever has to
// chase a creator who took a deposit and went quiet.
//
// WHY THIS IS THE LOAD-BEARING HALF OF THE SPLIT
//   Paying half up front halves the loss. On its own it also hands the label a
//   collections problem: a pile of deals in limbo, each needing someone to
//   decide whether to nudge, wait, or write off. That work is worse than the
//   money at these deal sizes. So the deadline enforces itself: when the window
//   the creator agreed to passes with no post, the deal closes, the balance is
//   never sent, and the non-delivery is recorded so the roster stops offering
//   that creator work. Nothing lands in anyone's queue.
//
//   The consequence for the creator is not a debt collector — it is not being
//   invited to the next deal. That costs the label nothing to enforce, which is
//   exactly why it works unattended.
//
// SAFETY POSTURE, and it is deliberately lopsided
//   The failure mode of a sweeper that is too eager is refusing to pay a creator
//   who DID the work. That is much worse than missing an expiry, so every
//   ambiguity resolves to "wait": no stated deadline, a post URL whose
//   verification is still open or already verified, any status other than
//   deposit_paid, an unreadable row — all wait. The ONE case a URL no longer
//   protects is a delivery the measurement tick has positively marked 'missing'
//   after bounded retries; that is a non-delivery with a URL attached, and it
//   still has to pass the agreed outside date before it closes. The decision
//   itself lives in evaluateExpiry (src/lib/split-settlement.ts) and is pure;
//   this module is only the I/O around it.
//
//   Idempotent: the status transition is the guard. A second pass sees
//   `undelivered` and evaluateExpiry refuses it, and the failure-record insert is
//   protected by a unique index on creator_offer_id.

import type { SupabaseClient } from '@supabase/supabase-js';
import { evaluateExpiry } from './split-settlement';
import { createLogger } from './logger';

const log = createLogger('delivery-expiry');

/** Deals examined per pass. Generous — the query is cheap and indexed. */
export const EXPIRY_BATCH_SIZE = 100;

export interface ExpiryTally {
  considered: number;
  expired: number;
  waited: number;
  errors: number;
}

interface ExpiryRow {
  id: string;
  firm_id: string | null;
  campaign_influencer_id: string | null;
  status: string;
  deliver_by: string | null;
  post_url: string | null;
  deposit_paid_usd: number | null;
  agreed_amount_usd: number | null;
  /**
   * The measurement tick's verdict, joined in. Embedded as an array because
   * PostgREST returns a to-many shape even when there is at most one row per
   * offer; `deliveryStatusOf` collapses it.
   */
  deal_deliveries: { status: string | null }[] | null;
}

/**
 * The delivery verdict for an offer, or null when nothing has looked yet.
 *
 * 'missing' is the one that matters: the measurement tick scraped the creator's
 * profile, repeatedly, and did not find the post at the recorded URL. Without
 * this the sweeper treated any non-empty post_url as delivery and parked the
 * deal forever — safe for the money, but it recreated the operator queue the
 * split exists to remove.
 */
function deliveryStatusOf(row: ExpiryRow): string | null {
  const rows = row.deal_deliveries ?? [];
  if (rows.length === 0) return null;
  // If any row says verified, the deal delivered. Only treat it as missing when
  // that is the sole verdict — never let one stale row override a good one.
  if (rows.some((d) => d.status === 'verified')) return 'verified';
  if (rows.every((d) => d.status === 'missing')) return 'missing';
  return rows[0]?.status ?? null;
}

/**
 * One expiry pass. Never throws — a scheduled sweeper that throws is
 * indistinguishable from a dead scheduler.
 */
export async function runDeliveryExpiry(
  sb: SupabaseClient,
  opts: { now?: number; batchSize?: number } = {},
): Promise<ExpiryTally> {
  const nowMs = opts.now ?? Date.now();
  const tally: ExpiryTally = { considered: 0, expired: 0, waited: 0, errors: 0 };

  // Matches the partial index in migration 052. Only deposit_paid rows can
  // expire, so the predicate is the whole candidate set.
  const { data, error } = await sb
    .from('creator_offers')
    .select(
      'id, firm_id, campaign_influencer_id, status, deliver_by, post_url, deposit_paid_usd, agreed_amount_usd, deal_deliveries(status)',
    )
    .eq('status', 'deposit_paid')
    .not('deliver_by', 'is', null)
    .lte('deliver_by', new Date(nowMs).toISOString())
    .limit(opts.batchSize ?? EXPIRY_BATCH_SIZE);

  if (error) {
    // Expected until migration 052 is applied — visible, not fatal.
    log.warn('expiry candidate query failed', { error: error.message });
    tally.errors += 1;
    return tally;
  }

  const rows = (data ?? []) as unknown as ExpiryRow[];
  for (const row of rows) {
    tally.considered += 1;
    const decision = evaluateExpiry({
      status: row.status,
      deliverByMs: row.deliver_by ? Date.parse(row.deliver_by) : null,
      postUrl: row.post_url,
      deliveryStatus: deliveryStatusOf(row),
      nowMs,
    });
    if (decision.action === 'wait') {
      tally.waited += 1;
      continue;
    }

    try {
      // The transition is the idempotency guard: `.eq('status','deposit_paid')`
      // means a concurrent pass that already expired this row updates nothing.
      const { data: updated, error: updErr } = await sb
        .from('creator_offers')
        .update({
          status: 'undelivered',
          undelivered_at: new Date(nowMs).toISOString(),
        } as never)
        .eq('id', row.id)
        .eq('status', 'deposit_paid')
        .select('id')
        .maybeSingle();
      if (updErr) throw new Error(updErr.message);
      if (!updated) {
        // Someone else got there first, or the row moved on. Not an error.
        tally.waited += 1;
        continue;
      }

      // Record it against the creator for THIS firm, so the roster stops
      // offering them work. Best-effort: the deal is already correctly closed,
      // and losing the note must not undo that.
      if (row.firm_id && row.campaign_influencer_id) {
        const { data: ci } = await sb
          .from('campaign_influencers')
          .select('influencer_id')
          .eq('id', row.campaign_influencer_id)
          .maybeSingle();
        const influencerId = (ci as { influencer_id: string | null } | null)?.influencer_id ?? null;
        if (influencerId) {
          const { error: insErr } = await sb.from('creator_delivery_failures').insert({
            firm_id: row.firm_id,
            influencer_id: influencerId,
            creator_offer_id: row.id,
            deposit_lost_usd: row.deposit_paid_usd,
            deliver_by: row.deliver_by,
          } as never);
          // A duplicate means a prior pass already recorded it — expected.
          if (insErr && !/duplicate|unique/i.test(insErr.message)) {
            log.warn('could not record the delivery failure', {
              creator_offer_id: row.id,
              error: insErr.message,
            });
          }
        }
      }

      // Lazy import: ./audit builds a Supabase client at module load, which
      // makes this module unimportable anywhere env is absent — including the
      // measurement tick's hermetic tests, where it turned a working sweeper
      // into a caught-and-logged failure.
      const { audit } = await import('./audit');
      await audit({
        action: 'offer.undelivered',
        actor_label: 'system:cron',
        target_type: 'creator_offer',
        target_id: row.id,
        firm_id: row.firm_id ?? undefined,
        metadata: {
          reason: decision.reason,
          deliver_by: row.deliver_by,
          deposit_paid_usd: row.deposit_paid_usd,
          balance_withheld_usd:
            row.agreed_amount_usd != null && row.deposit_paid_usd != null
              ? Math.round((Number(row.agreed_amount_usd) - Number(row.deposit_paid_usd)) * 100) / 100
              : null,
        },
      });

      tally.expired += 1;
    } catch (e) {
      tally.errors += 1;
      log.error('expiry failed for one deal', {
        creator_offer_id: row.id,
        error: (e as Error).message,
      });
    }
  }

  return tally;
}
