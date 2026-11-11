// src/lib/contracts.ts
//
// Contract template fill engine.
//
// The firm uploads ONE plain-text/markdown contract template containing their
// own legal clauses with {{placeholder}} slots; the app fills it per deal when
// a negotiation closes and freezes the filled copy on the creator_offer.
//
// DETERMINISTIC BY DESIGN — no LLM anywhere in this file. Legal text must
// never be model-generated: the template body is the firm's own words, and the
// fill is pure string substitution of agreed facts (name, amount, deliverables,
// dates). Unknown placeholders are left intact and reported, never guessed.
//
// The fill engine (detectPlaceholders / fillTemplate) is pure and hermetically
// testable. generateOfferContract is the one DB-touching orchestrator the
// negotiation tick imports; it takes an injected Supabase client (same
// visible-blast-radius pattern as negotiation-tick.ts) and never throws — a
// contract failure must never block the acceptance email it rides on.

import type { SupabaseClient } from '@supabase/supabase-js';

/** The placeholders the app recognizes, in legend order. */
export const KNOWN_PLACEHOLDERS = [
  'creator_name',
  'creator_handle',
  'amount_usd',
  'deliverables',
  'schedule',
  'payment_method',
  'artist_name',
  'campaign_name',
  'date',
  'firm_name',
  'governing_law',
] as const;
export type KnownPlaceholder = (typeof KNOWN_PLACEHOLDERS)[number];

/**
 * Firm-level placeholders: facts about the LABEL, not the deal. The template
 * generator (src/lib/contract-generator.ts) substitutes these at
 * template-generation time from the firm's own input. At deal time,
 * {{firm_name}} is also fillable from firms.name; {{governing_law}} has no
 * per-deal source, so a template that still carries it hits the send gate —
 * by design, a jurisdiction is legal text the firm must supply, never a value
 * the app may guess.
 */
export const FIRM_PLACEHOLDERS = ['firm_name', 'governing_law'] as const;

/** The subset the app can fill from deal facts (send-gate guidance copy). */
export const DEAL_FILLABLE_PLACEHOLDERS = KNOWN_PLACEHOLDERS.filter(
  (p) => p !== 'governing_law',
);

/**
 * The mandatory first line of every machine-generated template draft — a
 * VISIBLE marker for whoever opens the editor.
 *
 * It is deliberately NOT what the send path gates on. Approval is STATE
 * (contract_templates.approved_at, migration 041), set by an explicit action.
 * An earlier version gated on this literal, and because it contains an em
 * dash (U+2014) a Word/Docs round-trip — or a reviewer simply retyping the
 * line — turned it into a hyphen and silently opened the gate on
 * still-unreviewed legal text. Prose is not a security boundary.
 */
export const DRAFT_TEMPLATE_HEADER =
  'DRAFT: generated template, requires legal review before use.';

/**
 * Fuzzy, ADVISORY detection of the draft header: dash variants, case and
 * whitespace normalized, looking only at the first few non-empty lines (where
 * a header lives).
 *
 * Used to REFUSE APPROVAL, and to warn in the editor, while a body still
 * reads as an un-reviewed draft. It is never consulted to PERMIT a send —
 * only approved_at does that — so a mangled header this function misses
 * cannot open any gate.
 */
export function looksLikeDraftHeader(body: string): boolean {
  const head = body
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 3)
    .join(' ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return head.includes('draft') && head.includes('requires legal review');
}

/** Template size ceiling (~50KB). Legal templates are text, not payloads. */
export const MAX_TEMPLATE_CHARS = 50_000;

/** Separator between the acceptance email copy and the appended contract. */
export const CONTRACT_SEPARATOR = '--- Agreement terms ---';

/** Matches {{placeholder_name}}, tolerating inner whitespace: {{ date }}. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Every distinct {{placeholder}} in the body, in order of first appearance.
 * Unknown names are included — the caller decides what "unknown" means.
 */
export function detectPlaceholders(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export interface FillResult {
  /** The template with every known placeholder substituted. */
  text: string;
  /** Distinct known placeholders that were actually replaced. */
  filled: string[];
  /** Distinct placeholders left intact because no value was supplied. */
  unknown: string[];
}

/**
 * Fill a template deterministically. Known placeholders (present in `vars`)
 * are replaced with their value VERBATIM — the template is the firm's own
 * text and values are agreed facts, so nothing is escaped, rewritten, or
 * interpreted. Placeholders with no supplied value are left intact and
 * reported in `unknown` so the UI/generator can surface them.
 *
 * Replacement uses a callback, so values containing `$&`-style sequences or
 * `{{...}}` text land literally and are never re-expanded.
 */
export function fillTemplate(
  body: string,
  vars: Partial<Record<string, string>>,
): FillResult {
  const filled = new Set<string>();
  const unknown = new Set<string>();
  const text = body.replace(PLACEHOLDER_RE, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      unknown.add(name);
      return whole; // left intact, byte-for-byte
    }
    filled.add(name);
    return value;
  });
  return { text, filled: [...filled], unknown: [...unknown] };
}

/**
 * Guard for template bodies at the save boundary (route + tests share it).
 * Plain text/markdown only: non-empty after trim, under the size ceiling, and
 * free of NUL bytes (the cheap "this is not a binary upload" tell).
 */
export function templateBodyError(body: string): string | null {
  if (body.trim().length === 0) return 'empty_template';
  if (body.length > MAX_TEMPLATE_CHARS) return 'template_too_large';
  if (body.includes('\u0000')) return 'not_plain_text';
  return null;
}

/** Deterministic human-readable date for {{date}}, UTC (e.g. "September 14, 2026"). */
export function formatContractDate(nowMs: number): string {
  return new Date(nowMs).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Deal facts for the fill. EVERY text fact is optional and is simply OMITTED
 * when unknown.
 *
 * There used to be narrative stand-ins one layer up — "the Creator", "the
 * campaign", "as agreed in the message thread". Those were harmless when the
 * body was the firm's own prose, because the firm wrote around them. In a
 * real generated agreement they render as OPERATIVE TERMS: a parties clause
 * reading `between Example Records and the Creator (the Creator)`, or a deliverables
 * clause whose entire substance is "the promotional content agreed in the
 * message thread". An unknown fact must reach the send gate as an unfilled
 * slot so the contract is blocked, not silently weakened.
 */
export interface OfferContractFacts {
  creatorName?: string;
  creatorHandle?: string;
  agreedUsd: number;
  deliverablesText?: string;
  scheduleText?: string;
  paymentMethod?: string;
  artistName?: string;
  campaignName?: string;
  nowMs: number;
  /** The firm's name (firms.name). Absent ⇒ {{firm_name}} stays unfilled and
   *  the send gate blocks — never invent a contracting party. */
  firmName?: string;
  /** Deal-time governing law is only ever supplied by tests; production
   *  templates get it substituted at generation time. Absent ⇒ unfilled. */
  governingLaw?: string;
}

/** One optional slot: present and non-blank, or absent entirely. */
function opt(
  key: KnownPlaceholder,
  value: string | undefined,
): Partial<Record<KnownPlaceholder, string>> {
  const v = value?.trim();
  return v ? ({ [key]: v } as Partial<Record<KnownPlaceholder, string>>) : {};
}

/** Pure mapping from agreed deal facts to the placeholder variable set.
 *  Partial: a missing fact yields NO entry, so fillTemplate reports the slot
 *  unresolved and the send gate blocks rather than shipping a guess. */
export function buildContractVars(
  facts: OfferContractFacts,
): Partial<Record<KnownPlaceholder, string>> {
  return {
    ...opt('creator_name', facts.creatorName),
    ...opt('creator_handle', facts.creatorHandle),
    amount_usd: `$${Math.round(facts.agreedUsd)}`,
    ...opt('deliverables', facts.deliverablesText),
    ...opt('schedule', facts.scheduleText),
    ...opt('payment_method', facts.paymentMethod),
    ...opt('artist_name', facts.artistName),
    ...opt('campaign_name', facts.campaignName),
    date: formatContractDate(facts.nowMs),
    ...opt('firm_name', facts.firmName),
    ...opt('governing_law', facts.governingLaw),
  };
}

/** Why no contract shipped with an acceptance. `null` on the happy path. */
export type ContractBlockReason =
  | 'no_template'
  | 'template_not_approved'
  | 'unresolved_placeholders'
  | 'no_agreed_amount'
  | 'error';

export interface ContractOutcome {
  /** Filled copy to append to the acceptance email. Null whenever the contract
   *  must not ship — a half-filled legal document is worse than none. */
  text: string | null;
  /** Null when `text` shipped, else the reason the operator needs to act on. */
  blocked: ContractBlockReason | null;
  /** Placeholder names the app could not fill (only for
   *  'unresolved_placeholders'). */
  unresolved: string[];
  /** One actionable operator-facing line. Null when `text` shipped. */
  message: string | null;
}

/** A firm with no row in contract_templates ships every closed deal's
 *  acceptance email with nothing binding attached. That used to be silent. */
export const NO_TEMPLATE_MESSAGE =
  'No contract template saved for this firm, so the acceptance email went out with no agreement terms attached. ' +
  'Save one on the settings page to include terms on every deal.';

const ok = (text: string): ContractOutcome => ({
  text,
  blocked: null,
  unresolved: [],
  message: null,
});

const block = (
  blocked: ContractBlockReason,
  message: string,
  unresolved: string[] = [],
): ContractOutcome => ({ text: null, blocked, unresolved, message });

/**
 * Generate + persist the filled contract for an accepted offer.
 *
 * Looks up the firm's template, resolves creator/campaign facts, fills
 * deterministically, freezes the copy on creator_offers.contract_text /
 * contract_generated_at, and returns it for the caller to append to the
 * agreement-confirmation email.
 *
 * SEND GATE: a template slot the app cannot fill — a typo'd `{{governing_law}}`,
 * a clause the firm invented a name for — used to ride along to the creator
 * verbatim as literal `{{...}}` text. It is now a hard block: nothing ships,
 * nothing is frozen on the deal, and the reason comes back named so an operator
 * can fix the template. The save-time warning was never a gate; this is.
 *
 * Never throws: every failure path returns a blocked outcome so the acceptance
 * note still goes out (the deal is real even when the paperwork isn't). But no
 * failure is SILENT any more — every non-shipping path carries a reason, and
 * the statuses dashboard raises a `contract_missing` anomaly for any closed
 * deal with no frozen contract.
 *
 * v1 facts: payment_method is always "Stripe payout"; {{schedule}} derives
 * from the campaign's duration window when set.
 */
export async function generateOfferContract(
  sb: SupabaseClient,
  offer: {
    id: string;
    firm_id: string | null;
    campaign_id: string | null;
    campaign_influencer_id: string | null;
    agreed_amount_usd: number | null;
    current_offer_usd: number | null;
  },
  opts: { deliverablesText: string; nowMs: number },
): Promise<ContractOutcome> {
  try {
    if (!offer.firm_id) {
      return block('no_template', NO_TEMPLATE_MESSAGE);
    }
    const { data: tpl } = await sb
      .from('contract_templates')
      .select('body_text')
      .eq('firm_id', offer.firm_id)
      .maybeSingle();
    const bodyText = (tpl as { body_text?: string } | null)?.body_text;
    if (!bodyText || bodyText.trim().length === 0) {
      return block('no_template', NO_TEMPLATE_MESSAGE);
    }

    // APPROVAL GATE (additive to the unfilled-slot send gate below, which is
    // unchanged).
    //
    // Approval is STATE, not prose. contract_templates.approved_at is set only
    // by an explicit approve action (POST /api/firm/contract-template/approve)
    // and is cleared by ANY edit to the body. Nothing here parses the text: an
    // earlier version gated on the literal DRAFT header, and since that string
    // carries an em dash, a Word/Docs round-trip of a redline — or a reviewer
    // retyping the line — turned it into a hyphen and opened the gate on legal
    // text no one had approved.
    //
    // Separate query, so the main select still works while migration 041 is
    // unapplied. It FAILS CLOSED: if the column is unreadable we cannot prove
    // a human approved this text, so nothing ships. That is deliberate, and it
    // is also what gates a tooling-seeded template body headed "SAMPLE AGREEMENT — REPLACE WITH
    // YOUR OWN TERMS BEFORE LIVE USE", which predates any approval concept and
    // must never be treated as approved.
    {
      const { data: appr, error: apprErr } = await sb
        .from('contract_templates')
        .select('approved_at')
        .eq('firm_id', offer.firm_id)
        .maybeSingle();
      if (apprErr) {
        return block(
          'template_not_approved',
          'Contract not sent: the template approval state could not be read, so Creator Campaigns cannot ' +
            'confirm a human approved this agreement (is migration 041 applied?). ' +
            `The acceptance email went out with no terms attached. (${apprErr.message})`,
        );
      }
      if (!(appr as { approved_at?: string | null } | null)?.approved_at) {
        return block(
          'template_not_approved',
          'Contract not sent: the saved contract template has not been approved for sending. ' +
            'Open the settings page, review the wording, then use "Approve for sending". ' +
            'The acceptance email went out with no agreement terms attached.',
        );
      }
    }

    // Firm identity for {{firm_name}} — separate query, degrades to unfilled
    // (→ send gate) if the row is missing. Never invent a contracting party.
    let firmName: string | undefined;
    {
      const { data: firm } = await sb
        .from('firms')
        .select('name')
        .eq('id', offer.firm_id)
        .maybeSingle();
      const n = (firm as { name?: string | null } | null)?.name;
      if (n?.trim()) firmName = n.trim();
    }

    // Creator identity via campaign_influencer → influencer. NO narrative
    // fallback: an unknown creator reaches the send gate as an unfilled
    // {{creator_name}}, never as the literal words "the Creator" standing in
    // the parties clause of a real agreement.
    let creatorName: string | undefined;
    let creatorHandle: string | undefined;
    if (offer.campaign_influencer_id) {
      const { data: ci } = await sb
        .from('campaign_influencers')
        .select('influencer_id')
        .eq('id', offer.campaign_influencer_id)
        .maybeSingle();
      const influencerId = (ci as { influencer_id?: string } | null)?.influencer_id;
      if (influencerId) {
        const { data: inf } = await sb
          .from('influencers')
          .select('display_name, username')
          .eq('id', influencerId)
          .maybeSingle();
        const i = inf as { display_name?: string | null; username?: string | null } | null;
        if (i?.display_name?.trim()) creatorName = i.display_name.trim();
        else if (i?.username?.trim()) creatorName = i.username.trim();
        if (i?.username?.trim()) creatorHandle = `@${i.username.trim().replace(/^@/, '')}`;
      }
    }
    // A creator with no username has no handle. Echoing the display name into
    // {{creator_handle}} produced `Marlo Example (Marlo Example)` in the
    // parties clause; an unfilled slot and a blocked send is the honest result.

    // Campaign facts (artist, name, schedule window) — same rule, no prose
    // stand-ins. {{schedule}} in particular is a publication DEADLINE that
    // other clauses reference; "as agreed in the message thread" made those
    // cross-references unenforceable.
    let artistName: string | undefined;
    let campaignName: string | undefined;
    let scheduleText: string | undefined;
    if (offer.campaign_id) {
      const { data: camp } = await sb
        .from('campaigns')
        .select('artist_name, track_name, duration_days')
        .eq('id', offer.campaign_id)
        .maybeSingle();
      const c = camp as {
        artist_name?: string | null;
        track_name?: string | null;
        duration_days?: number | null;
      } | null;
      if (c?.artist_name?.trim()) artistName = c.artist_name.trim();
      if (artistName) {
        campaignName = c?.track_name?.trim()
          ? `"${c.track_name.trim()}" by ${artistName}`
          : `the ${artistName} campaign`;
      }
      if (c?.duration_days && c.duration_days > 0) {
        scheduleText = `within ${c.duration_days} days of receiving the promotional materials`;
      }
    }

    const agreed = Number(offer.agreed_amount_usd ?? offer.current_offer_usd ?? 0);
    if (!(agreed > 0)) {
      return block(
        'no_agreed_amount',
        'Contract not generated: the deal has no agreed amount, and a $0 legal document must never be sent.',
      );
    }

    const { text, unknown } = fillTemplate(
      bodyText,
      buildContractVars({
        creatorName,
        creatorHandle,
        agreedUsd: agreed,
        deliverablesText: opts.deliverablesText,
        scheduleText,
        paymentMethod: 'Stripe payout',
        artistName,
        campaignName,
        nowMs: opts.nowMs,
        firmName,
      }),
    );

    // SEND GATE. An unfilled slot is a literal "{{governing_law}}" in a legal
    // document going to a creator. Refuse the send, name every offending slot,
    // and freeze nothing — a blocked contract must not look like a delivered
    // one to anything downstream.
    if (unknown.length > 0) {
      // Two very different causes, so say which one this is. A recognized
      // name left unfilled is a DATA gap on this deal (no username on the
      // creator, no duration on the campaign) and the operator fixes the
      // record; an unrecognized name is a TEMPLATE typo and they fix the
      // wording. Telling someone to "rename {{creator_name}}" when the real
      // problem is a blank username sends them to the wrong screen.
      const recognized = new Set<string>(KNOWN_PLACEHOLDERS);
      const dataGaps = unknown.filter((u) => recognized.has(u));
      const typos = unknown.filter((u) => !recognized.has(u));
      const parts: string[] = ['Contract not sent:'];
      if (dataGaps.length > 0) {
        parts.push(
          `Creator Campaigns has no value for ${dataGaps.map((u) => `{{${u}}}`).join(', ')} on this deal, ` +
            'and a legal document must not go out with that term missing or guessed. ' +
            'Fill the underlying record (creator handle, campaign artist/track, campaign duration) and re-run,' +
            ' or replace the slot with fixed text in the template.',
        );
      }
      if (typos.length > 0) {
        parts.push(
          `The contract template uses ${typos.map((u) => `{{${u}}}`).join(', ')}, which Creator Campaigns does not recognize. ` +
            `Replace with fixed text, or rename to one of: ${DEAL_FILLABLE_PLACEHOLDERS.join(', ')}.`,
        );
      }
      if (unknown.includes('governing_law')) {
        parts.push(
          '({{governing_law}} is substituted when you generate a template on the settings page; ' +
            'in a hand-written template, state the jurisdiction as fixed text.)',
        );
      }
      return block('unresolved_placeholders', parts.join(' '), unknown);
    }

    // Freeze the delivered copy on the deal.
    await sb
      .from('creator_offers')
      .update({
        contract_text: text,
        contract_generated_at: new Date(opts.nowMs).toISOString(),
      } as never)
      .eq('id', offer.id);

    return ok(text);
  } catch (e) {
    console.warn('generateOfferContract failed (acceptance email unaffected)', e);
    return block(
      'error',
      `Contract not generated: ${(e as Error).message ?? 'unknown error'}. The acceptance email was sent without it.`,
    );
  }
}
