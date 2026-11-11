// src/lib/channels/inbound-attribution.ts
//
// The SENDER half of inbound reply trust, shared by every email transport.
//
// email-inbound.ts answers "does the envelope claim this belongs to lead X?".
// That question is not sufficient on its own, because the campaign_influencer_id
// travels inside the Reply-To of every outreach email we send. It therefore
// leaks through forwarding, bounces, out-of-office auto-replies and anyone the
// creator CCs. Possession of a valid id is evidence the message is related to a
// real thread — it is NOT evidence of who wrote it.
//
// This module answers the second question: "is the sender actually that
// creator?". Only when both answers are yes may a message advance a lead into
// `responded` and be handed to the autonomous negotiator, which can counter,
// accept, and close a deal. A mismatch is not discarded — it is queued
// unattributed for a human, because a creator legitimately mailing from a
// second address looks identical to an attacker at this layer.
//
// Known contacts for a creator, in the order outbound itself trusts them:
//   1. influencers.contact_email   — the address sendOutreach actually mails
//   2. creator_contacts.address    — discovered candidates (channel like email)
//
// Comparison is on the bare, lowercased, plus-tag-stripped address, so
// `Jane Doe <JANE+promo@x.com>` matches a stored `jane@x.com`.

import type { SupabaseClient } from '@supabase/supabase-js';
import { baseAddress, parseEmailAddresses, parseFromMailbox } from './email-inbound';

/**
 * Every comparable form of the ONE mailbox a From header identifies.
 *
 * ── SEC (H1): why this is parseFromMailbox and not parseEmailAddresses ──────
 *
 * This used to take every address-shaped token in the whole From value. A
 * display name is free text, so `From: "jane@creator.example"
 * <attacker@evil.example>` put the victim's address in this set and the sender
 * check passed — producing DB writes indistinguishable from an honest reply.
 *
 * A From header names ONE author. Parse it as one, and refuse the value
 * entirely when it names zero or several. A refusal here does not drop the
 * message; it demotes it to unattributed, which is the safe direction.
 */
function candidateAddresses(from: string | null | undefined): Set<string> {
  const out = new Set<string>();
  const mailbox = parseFromMailbox(from);
  if (!mailbox) return out;
  out.add(mailbox);
  const base = baseAddress(mailbox);
  if (base) out.add(base);
  return out;
}

/** Normalize a stored contact into the same comparable forms. */
function storedForms(address: string | null | undefined): string[] {
  if (!address) return [];
  const out: string[] = [];
  for (const addr of parseEmailAddresses(address)) {
    out.push(addr);
    const base = baseAddress(addr);
    if (base) out.push(base);
  }
  return out;
}

function intersects(candidates: Set<string>, stored: string[]): boolean {
  return stored.some((s) => candidates.has(s));
}

/**
 * Does `from` match a known contact of the creator behind this lead?
 *
 * Fails CLOSED: an unreadable lead, a creator with no contact on file, or a
 * database error all return false, which demotes the message to unattributed.
 * Refusing to advance a deal on unverifiable identity is the safe direction.
 */
export async function senderMatchesLeadCreator(
  sb: SupabaseClient,
  campaignInfluencerId: string,
  from: string | null | undefined,
): Promise<boolean> {
  const candidates = candidateAddresses(from);
  if (candidates.size === 0) return false;

  const { data: ci, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('influencer_id')
    .eq('id', campaignInfluencerId)
    .maybeSingle();
  if (ciErr || !ci) return false;
  const influencerId = (ci as { influencer_id: string | null }).influencer_id;
  if (!influencerId) return false;

  const { data: inf } = await sb
    .from('influencers')
    .select('contact_email')
    .eq('id', influencerId)
    .maybeSingle();
  const primary = (inf as { contact_email: string | null } | null)?.contact_email ?? null;
  if (intersects(candidates, storedForms(primary))) return true;

  const { data: contacts } = await sb
    .from('creator_contacts')
    .select('address, channel')
    .eq('influencer_id', influencerId)
    .limit(100);
  for (const row of (contacts ?? []) as Array<{ address: string | null; channel: string | null }>) {
    // Only email-ish contact rows can vouch for an email sender.
    if (row.channel && !/mail/i.test(row.channel)) continue;
    if (intersects(candidates, storedForms(row.address))) return true;
  }
  return false;
}

// ── Testing-mode dry runs ───────────────────────────────────────────────────

export interface TestingModeMatch {
  /** The firm that owns the tagged lead, which is in testing mode. */
  firmId: string;
  /** The test inbox the From matched (lowercased addr-spec). */
  testRecipient: string;
}

export interface TestingModeScope {
  /**
   * The firm whose negotiation inbox this message was delivered to, when the
   * transport could resolve one. A resolved inbox that belongs to a DIFFERENT
   * firm than the lead's refuses the match (fail closed). Null skips the
   * check: the Gmail path reads an env-level mailbox and often resolves none.
   */
  inboxFirmId: string | null;
}

/**
 * Is this a TESTING-MODE dry-run reply from the operator playing the creator?
 *
 * In testing mode (`firms.testing_mode = true`) sendOutreach reroutes every
 * outbound email to the firm's test inbox (resend.ts), so the operator answers
 * FROM that inbox. That reply carries a valid `+lead-<id>` tag but can never
 * match the creator's contact on file, so the thread-hijack guard queued it
 * unattributed and no dry run ever reached the negotiator.
 *
 * Returns a match ONLY when ALL hold:
 *   - the envelope correlated to a lead (`campaignInfluencerId` non-null);
 *   - that lead's firm has `testing_mode === true` (strictly; null/absent is no);
 *   - the From parses to exactly ONE mailbox (parseFromMailbox, so the H1
 *     display-name forgery cannot smuggle the test address in);
 *   - that mailbox EXACTLY equals (case-insensitive, no plus-tag folding) the
 *     firm's `test_recipient_email` or a member's per-user override
 *     (`firm_members.test_recipient_email`) — the only addresses resend.ts
 *     ever mails in testing mode;
 *   - the delivered-to inbox, if resolved, belongs to the same firm.
 *
 * Why this may bypass the sender-match AND authentication locks: in testing
 * mode the `+lead-` tag is only ever mailed to these test inboxes, so it has not
 * leaked to third parties through the creator, and no real creator is in the
 * loop — the negotiator's answers go straight back to the same test inbox. The
 * residual risk is a lead first contacted LIVE and the firm later flipped back
 * to testing mode, combined with a forged From of the operator's own address.
 *
 * Fails CLOSED on every read error or missing row.
 */
export async function testingModeSenderMatch(
  sb: SupabaseClient,
  campaignInfluencerId: string | null,
  from: string | null | undefined,
  scope: TestingModeScope,
): Promise<TestingModeMatch | null> {
  if (!campaignInfluencerId) return null;
  const mailbox = parseFromMailbox(from);
  if (!mailbox) return null;

  const { data: ci, error: ciErr } = await sb
    .from('campaign_influencers')
    .select('campaign_id')
    .eq('id', campaignInfluencerId)
    .maybeSingle();
  const campaignId = ciErr ? null : (ci as { campaign_id?: string | null } | null)?.campaign_id;
  if (!campaignId) return null;

  const { data: campaign, error: cErr } = await sb
    .from('campaigns')
    .select('firm_id')
    .eq('id', campaignId)
    .maybeSingle();
  const firmId = cErr ? null : (campaign as { firm_id?: string | null } | null)?.firm_id;
  if (!firmId) return null;
  if (scope?.inboxFirmId && scope.inboxFirmId !== firmId) return null;

  const { data: firm, error: fErr } = await sb
    .from('firms')
    .select('testing_mode, test_recipient_email')
    .eq('id', firmId)
    .maybeSingle();
  if (fErr || !firm) return null;
  const f = firm as { testing_mode?: boolean | null; test_recipient_email?: string | null };
  if (f.testing_mode !== true) return null;

  const stored: Array<string | null | undefined> = [f.test_recipient_email];
  const { data: members, error: mErr } = await sb
    .from('firm_members')
    .select('test_recipient_email')
    .eq('firm_id', firmId)
    .not('test_recipient_email', 'is', null)
    .limit(100);
  if (!mErr) {
    for (const m of (members ?? []) as Array<{ test_recipient_email: string | null }>) {
      stored.push(m.test_recipient_email);
    }
  }

  for (const raw of stored) {
    for (const addr of parseEmailAddresses(raw)) {
      if (addr === mailbox) return { firmId, testRecipient: addr };
    }
  }
  return null;
}

export interface KnownContactScope {
  /**
   * The firm whose negotiation inbox this message was delivered to. REQUIRED.
   * Null means we could not establish a tenant, and admission then fails
   * closed — see the security note below.
   */
  firmId: string | null;
}

/**
 * Is `from` a known creator contact OF THIS FIRM?
 *
 * This is the ADMISSION path for a creator who replies from a fresh thread with
 * no correlation tag — without it, such a message is indistinguishable from
 * spam and would be refused. It admits to the queue only; attribution still
 * requires envelope correlation, senderMatchesLeadCreator, and an authenticated
 * sender.
 *
 * ── SEC (H2): why the firm scope is mandatory ───────────────────────────────
 *
 * `influencers` is a SHARED table — creators are not owned by a firm, only
 * campaigns are (`campaigns.firm_id`). So an unscoped "is this a known creator
 * address?" question is answered across every tenant at once: anyone who knew
 * ANY creator's email could write rows into another firm's reply queue, and
 * those unattributed rows are read with no firm filter by /api/anomalies. The
 * predicate had no firm in it at all, so there was nothing to get wrong — it
 * simply was not asked.
 *
 * The scope is the firm that owns the LEAD: the creator must already have a
 * campaign_influencers row under a campaign belonging to `firmId`. Knowing a
 * creator's address is not enough; you have to be a creator that firm is
 * actually working with.
 *
 * Fails CLOSED on a null firmId. A message we cannot even route to a tenant has
 * no business admitting itself on identity grounds — if it carries a valid
 * correlation tag it is admitted by that instead, which is the lock that
 * actually proves something.
 *
 * Cost: at most three capped lookups, all exact-match `in` filters. It must stay
 * cheap — this runs on an unauthenticated path.
 */
export async function isKnownCreatorContact(
  sb: SupabaseClient,
  from: string | null | undefined,
  scope: KnownContactScope,
): Promise<boolean> {
  const firmId = scope?.firmId ?? null;
  if (!firmId) return false;

  const candidates = Array.from(candidateAddresses(from));
  if (candidates.length === 0) return false;

  const influencerIds = new Set<string>();

  const { data: infs } = await sb
    .from('influencers')
    .select('id')
    .in('contact_email', candidates)
    .limit(50);
  for (const row of (infs ?? []) as Array<{ id: string | null }>) {
    if (row.id) influencerIds.add(row.id);
  }

  const { data: contacts } = await sb
    .from('creator_contacts')
    .select('influencer_id')
    .in('address', candidates)
    .limit(50);
  for (const row of (contacts ?? []) as Array<{ influencer_id: string | null }>) {
    if (row.influencer_id) influencerIds.add(row.influencer_id);
  }

  if (influencerIds.size === 0) return false;

  // The firm predicate: does this creator have a lead under a campaign this
  // firm owns? `campaigns!inner` makes it a join, so the filter cannot be
  // silently dropped the way a post-hoc filter on a nullable embed can.
  const { data: leads, error } = await sb
    .from('campaign_influencers')
    .select('id, campaigns!inner(firm_id)')
    .in('influencer_id', Array.from(influencerIds))
    .eq('campaigns.firm_id', firmId)
    .limit(1);
  if (error) return false;
  return (leads ?? []).length > 0;
}

// ── Tenant routing ──────────────────────────────────────────────────────────

export interface FirmMatch {
  firmId: string;
  /** The stored negotiation_inbox_email this message matched. */
  inbox: string;
}

/**
 * Map a delivered-to address onto a firm via `firms.negotiation_inbox_email`
 * (migration 023).
 *
 * Lives here rather than in resend-inbound.ts because BOTH transports need it
 * now: it is what supplies the firm scope isKnownCreatorContact requires, and
 * the Gmail path needs the same scope as the Resend path. It is re-exported
 * from resend-inbound.ts so existing imports keep working.
 *
 * Plus tags are stripped before comparison: outbound stamps
 * `<local>+lead-<ci_id>@<domain>` as the Reply-To, so the address a reply is
 * actually delivered to NEVER equals the stored inbox verbatim.
 *
 * Comparison happens in JS, lowercased, rather than as a SQL `in` filter —
 * addresses are case-insensitive by RFC but the column is plain `text`, so an
 * exact-match query silently misses a row stored as `Operator@…`. The firms
 * table is small; the read is capped regardless.
 */
export async function resolveFirmByInbox(
  sb: SupabaseClient,
  addresses: Array<string | null | undefined>,
): Promise<FirmMatch | null> {
  const candidates = new Set<string>();
  for (const raw of addresses) {
    for (const addr of parseEmailAddresses(raw)) {
      const base = baseAddress(addr);
      if (base) candidates.add(base);
    }
  }
  if (candidates.size === 0) return null;

  const { data, error } = await sb
    .from('firms')
    .select('id, negotiation_inbox_email')
    .not('negotiation_inbox_email', 'is', null)
    .limit(500);
  if (error || !data) return null;

  for (const row of data as Array<{ id: string; negotiation_inbox_email: string | null }>) {
    const stored = baseAddress(row.negotiation_inbox_email);
    if (stored && candidates.has(stored)) {
      return { firmId: row.id, inbox: stored };
    }
  }
  return null;
}
