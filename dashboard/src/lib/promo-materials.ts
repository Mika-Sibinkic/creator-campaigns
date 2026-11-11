// src/lib/promo-materials.ts
//
// After payment: the system sends the creator the promo materials once they
// collect payment. Fired from the Stripe webhook on the
// deal's null→paid transition (so it runs exactly once per deal). Never throws
// — a failure here must not fail the webhook ack.
//
// Legal wording: when the deal carries a frozen contract
// (contract_text, delivered inline with the acceptance email), this email
// references those terms and the date they were sent. When it doesn't, it
// asserts no binding obligation and states that the agreement terms follow —
// never a bracketed placeholder, never a claim about a contract nobody
// authored. The sentence lives in src/lib/payment-copy.ts (pure, tested).

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendOutreach } from './resend';
import { normalizeDeliverables, describeDeliverables } from './deliverables';
import { agreementTermsSentence, contractSentAt } from './payment-copy';
import { appendOptOut } from './channels/outbound-envelope';
import { checkDoNotContact } from './firm-blocks';
import { audit, type AuditEntry } from './audit';
import { PROMO_HELD_ACTION, PROMO_WITHHELD_ACTION } from './statuses';

const MATERIALS_BUCKET = 'campaign-materials';

/**
 * Which uploads are promo material by default.
 *
 * The materials card is the ONLY file input in the product, and every row it
 * holds used to be attached to the post-payment email unconditionally. So a
 * label that reasonably read "upload your materials" as "upload your contract"
 * would have mailed that contract to every creator it paid.
 *
 * Audio, video and images are what the feature is for. Documents are not
 * attached unless the label says so per file (`share_with_creators`, migration
 * 051) — and while that column does not exist yet, they are simply never
 * attached. Fail closed: the cost of a missing one-sheet is an email; the cost
 * of a leaked contract is a contract.
 */
function isPromoMediaByDefault(contentType: string | null): boolean {
  if (!contentType) return false;
  const t = contentType.toLowerCase();
  return t.startsWith('audio/') || t.startsWith('video/') || t.startsWith('image/');
}
// Resend caps total message size ~40MB. Stay well under so a large WAV doesn't
// bounce the whole email — skip oversized files (they're logged, not attached).
const MAX_TOTAL_ATTACH_BYTES = 20 * 1024 * 1024;

/**
 * Load a campaign's uploaded promo materials as base64 email attachments
 * (the track to promote + any images/video). Never throws — attachment
 * failures degrade to a materials email with no files rather than blocking it.
 */
async function loadCampaignAttachments(
  sb: SupabaseClient,
  campaignId: string | null,
): Promise<{ filename: string; content: string; contentType?: string }[]> {
  if (!campaignId) return [];
  try {
    // Ask for the per-file share flag, and tolerate it not existing yet —
    // migration 051 may not be applied yet, so this code has to work on both
    // sides of it.
    let rows: unknown[] | null = null;
    const withFlag = await sb
      .from('campaign_materials')
      .select('storage_path, filename, content_type, size_bytes, share_with_creators')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: true });
    if (withFlag.error) {
      const fallback = await sb
        .from('campaign_materials')
        .select('storage_path, filename, content_type, size_bytes')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: true });
      rows = fallback.data;
    } else {
      rows = withFlag.data;
    }
    const materials = (rows ?? []) as Array<{
      storage_path: string;
      filename: string;
      content_type: string | null;
      size_bytes: number | null;
      share_with_creators?: boolean | null;
    }>;
    const out: { filename: string; content: string; contentType?: string }[] = [];
    let total = 0;
    for (const m of materials) {
      // An explicit per-file choice wins; otherwise only media is attached.
      const share =
        m.share_with_creators == null
          ? isPromoMediaByDefault(m.content_type)
          : m.share_with_creators === true;
      if (!share) continue;
      if (m.size_bytes && total + m.size_bytes > MAX_TOTAL_ATTACH_BYTES) {
        console.warn(`[promo-materials] skipping oversized attachment ${m.filename}`);
        continue;
      }
      const { data: blob, error } = await sb.storage.from(MATERIALS_BUCKET).download(m.storage_path);
      if (error || !blob) {
        console.warn(`[promo-materials] download failed for ${m.storage_path}:`, error?.message);
        continue;
      }
      const buf = Buffer.from(await blob.arrayBuffer());
      total += buf.length;
      if (total > MAX_TOTAL_ATTACH_BYTES) break;
      out.push({
        filename: m.filename,
        content: buf.toString('base64'),
        contentType: m.content_type ?? undefined,
      });
    }
    return out;
  } catch (e) {
    console.error('[promo-materials] loadCampaignAttachments failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

interface OfferRow {
  id: string;
  firm_id: string | null;
  campaign_id: string | null;
  campaign_influencer_id: string | null;
  agreed_deliverables: unknown;
  contract_text: string | null;
  contract_generated_at: string | null;
  /** Where the creator asked to be paid. First choice for a recipient. */
  payout_email: string | null;
}

/**
 * The creator's real email, for the live-mode `to_real`.
 *
 * WHY THIS FUNCTION EXISTS AT ALL
 *
 * This module used to pass `to_real: null`, hardcoded. In testing mode that is
 * invisible, because resend.ts ignores `to_real` entirely and routes to the test
 * recipient — so it looked fine for as long as nobody had turned testing mode
 * off. In LIVE mode `to_real: null` is an immediate
 * `{ ok:false, error:'no recipient' }` for EVERY creator, whether or not they
 * have an email address on file. The row is written `status:'failed'`, the
 * function returns void, and the Stripe webhook that called it acks happily.
 *
 * So the end of the money path was: the creator gets paid, and then hears
 * nothing, ever, by construction.
 *
 * Precedence follows execute-payment.ts: `creator_offers.payout_email` is what
 * the creator actually gave us for this deal, and it beats the scraped
 * `influencers.contact_email` when both exist.
 */
async function resolveCreatorEmail(
  sb: SupabaseClient,
  row: OfferRow,
): Promise<string | null> {
  const onOffer = (row.payout_email ?? '').trim();
  if (onOffer.includes('@')) return onOffer;
  if (!row.campaign_influencer_id) return null;
  try {
    const { data: ci } = await sb
      .from('campaign_influencers')
      .select('influencer_id')
      .eq('id', row.campaign_influencer_id)
      .maybeSingle();
    const influencerId = (ci as { influencer_id?: string | null } | null)?.influencer_id;
    if (!influencerId) return null;
    const { data: inf } = await sb
      .from('influencers')
      .select('contact_email')
      .eq('id', influencerId)
      .maybeSingle();
    const email = ((inf as { contact_email?: string | null } | null)?.contact_email ?? '').trim();
    return email.includes('@') ? email : null;
  } catch {
    // Never throw: this runs inside a webhook ack path.
    return null;
  }
}

/**
 * What happened. Callers (three payment paths) ignore it today; it exists so
 * the do-not-contact hold is observable in tests rather than inferred.
 */
export type PromoMaterialsOutcome = {
  outcome:
    | 'sent'
    | 'send_failed'
    | 'skipped'
    /** The creator is on this label's do-not-contact list. Nothing sent. */
    | 'held_do_not_contact'
    /** The list could not be read. Nothing sent — fail closed. */
    | 'held_unconfirmed'
    | 'error';
};

export interface PromoMaterialsDeps {
  sendOutreach?: typeof sendOutreach;
  audit?: (entry: AuditEntry) => Promise<void>;
}

export async function sendPromoMaterials(
  sb: SupabaseClient,
  opts: { creatorOfferId: string },
  deps: PromoMaterialsDeps = {},
): Promise<PromoMaterialsOutcome> {
  const send = deps.sendOutreach ?? sendOutreach;
  const writeAudit = deps.audit ?? audit;
  try {
    const { data: offer } = await sb
      .from('creator_offers')
      .select(
        'id, firm_id, campaign_id, campaign_influencer_id, agreed_deliverables, contract_text, contract_generated_at, payout_email',
      )
      .eq('id', opts.creatorOfferId)
      .maybeSingle();
    if (!offer) return { outcome: 'skipped' };
    const row = offer as OfferRow;
    if (!row.firm_id) return { outcome: 'skipped' };

    const { data: camp } = await sb
      .from('campaigns')
      .select('artist_name')
      .eq('id', row.campaign_id ?? '')
      .maybeSingle();
    const artist = (camp as { artist_name?: string } | null)?.artist_name || 'the artist';

    // Belt-and-suspenders idempotency: skip if a promo_materials message
    // already exists for this creator (the webhook's paid_at guard is the
    // primary once-only gate).
    const { data: existing } = await sb
      .from('outreach_messages')
      .select('id')
      .eq('campaign_influencer_id', row.campaign_influencer_id)
      .eq('message_type', 'promo_materials')
      .limit(1);
    if (existing && existing.length > 0) return { outcome: 'skipped' };

    // Per-label do-not-contact (src/lib/firm-blocks.ts), at the send boundary.
    // A creator can say STOP between agreeing a deal and being paid; the
    // payout is owed either way, but this email is still a message to someone
    // who asked not to get any. Checked independently of the recipient — a
    // payout_email on the offer is no reason to skip it. Fail closed: an
    // unreadable list sends nothing.
    //
    // Every caller fires this exactly once (the paid_at null→paid
    // transition), so nothing retries a hold on its own. A hold writes no
    // outreach row (the idempotency check above stays open) and IS audited as
    // PROMO_HELD_ACTION, which /anomalies shows in the operator's
    // payment_anomaly lane with a "Resend promo pack" action
    // (resendHeldPromo below, same check).
    const dnc = await checkDoNotContact(sb, {
      firmId: row.firm_id,
      campaignInfluencerId: row.campaign_influencer_id,
    });
    const holdAudit = (action: string, detail?: string) =>
      writeAudit({
        action,
        actor_label: 'system:promo-materials',
        firm_id: row.firm_id,
        target_type: 'creator_offer',
        target_id: row.id,
        metadata: {
          campaign_id: row.campaign_id,
          campaign_influencer_id: row.campaign_influencer_id,
          ...(detail ? { detail } : {}),
        },
      }).catch(() => undefined);
    if (dnc.verdict === 'blocked') {
      console.warn(
        `[promo-materials] not sent for offer ${row.id}: creator is on the label's do-not-contact list`,
      );
      await holdAudit(PROMO_WITHHELD_ACTION);
      return { outcome: 'held_do_not_contact' };
    }
    if (dnc.verdict === 'unknown') {
      console.error(
        `[promo-materials] HELD for offer ${row.id}: could not confirm the do-not-contact list ` +
          `(${dnc.detail ?? 'unknown'}): nothing sent; surfaced on /anomalies for a resend`,
      );
      await holdAudit(PROMO_HELD_ACTION, dnc.detail);
      return { outcome: 'held_unconfirmed' };
    }

    const ask = describeDeliverables(normalizeDeliverables(row.agreed_deliverables));
    // Load attachments BEFORE writing the body — a campaign with no uploaded
    // materials must not send an email claiming "attached is the track."
    const attachments = await loadCampaignAttachments(sb, row.campaign_id);
    const hasAttachments = attachments.length > 0;
    const subject = hasAttachments
      ? `You're all set, here's your ${artist} promo pack`
      : `You're all set, ${artist} promo pack on its way`;
    // Copy note: this used to open "we're thrilled to have you on board" and
    // close "we're genuinely excited to see what you create". BOTH of those
    // words are on the banned-hype list the first-touch validator enforces
    // (checkDraftCopy bans /thrilled|excited/), and generated copy leaked them
    // when they were only banned by prompt. They were
    // hardcoded here because fulfilment copy never passed through the validator
    // at all, so the one place the ban could not leak is the one place it was
    // written in by hand. Same information, said plainly.
    const body = [
      `Payment's gone through. You're in on the ${artist} campaign.`,
      ask ? `Here's what we're counting on from you: ${ask}.` : '',
      hasAttachments
        ? `Attached is the ${artist} track to promote (audio or video file, ready to drop into your content). Post it on Instagram, TikTok, and YouTube where it fits your style.`
        : `The ${artist} track and assets to promote will follow in a separate email shortly. Nothing you need to do in the meantime.`,
      '',
      agreementTermsSentence(contractSentAt(row), 'the deliverables above'),
      '',
      `Make it yours. If anything about the ask is unclear, reply here before you post.`,
    ]
      .filter(Boolean)
      .join('\n');
    const bodyWithOptOut = appendOptOut(body, { channel: 'email' });
    const toReal = await resolveCreatorEmail(sb, row);
    const res = await send({
      firm_id: row.firm_id,
      to_real: toReal,
      subject,
      body: bodyWithOptOut,
      attachments,
      campaign_influencer_id: row.campaign_influencer_id ?? undefined,
    });
    if (!res.ok) {
      // Loud, because the alternative is what this path did before: a paid
      // creator silently receives nothing and the webhook acks.
      console.error(
        `[promo-materials] send failed for offer ${row.id} (recipient ${
          toReal ? 'resolved' : 'UNRESOLVED'
        }): ${res.error ?? 'unknown'}`,
      );
    }

    await sb.from('outreach_messages').insert({
      campaign_influencer_id: row.campaign_influencer_id,
      message_type: 'promo_materials',
      direction: 'outbound',
      // Still 'email', and still wrong for a DM creator — but deliberately not
      // guessed here. outreach_messages.channel has a CHECK constraint
      // (migration 018: email | instagram_dm | tiktok_dm | linkedin_dm) and
      // `send_mode` has no default, so the correct value needs the lead's
      // primary_channel and resolveSendPlan(). What is needed is in the report;
      // writing a made-up channel would just move the invisibility.
      channel: 'email',
      subject,
      body: bodyWithOptOut,
      status: res.ok ? 'sent' : 'failed',
      sent_at: res.ok ? new Date().toISOString() : null,
      sent_to: res.ok ? res.resolved_to : null,
      provider_message_id: res.message_id ?? null,
    } as never);
    return { outcome: res.ok ? 'sent' : 'send_failed' };
  } catch (e) {
    console.error('[promo-materials] send failed:', e instanceof Error ? e.message : e);
    return { outcome: 'error' };
  }
}

export interface PromoResendResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The operator's "Resend promo pack" on a held deal (/anomalies,
 * payment_anomaly lane). Re-runs sendPromoMaterials, so the do-not-contact
 * check runs again and a pack is never sent twice (its promo_materials
 * idempotency check).
 *
 * Only for a deal of the caller's firm that actually has a PROMO_HELD_ACTION
 * audit row — this is a retry of a hold, not a general "email this creator"
 * button, and a deal that was never paid was never held.
 */
export async function resendHeldPromo(
  sb: SupabaseClient,
  input: { offerId: string; firmId: string | null | undefined },
  deps: PromoMaterialsDeps = {},
): Promise<PromoResendResult> {
  if (!input.firmId) return { status: 403, body: { error: 'forbidden' } };
  const { data: offer, error: offerErr } = await sb
    .from('creator_offers')
    .select('id, firm_id')
    .eq('id', input.offerId)
    .maybeSingle();
  if (offerErr) return { status: 500, body: { error: offerErr.message } };
  if (!offer || (offer as { firm_id?: string | null }).firm_id !== input.firmId) {
    return { status: 404, body: { error: 'not_found' } };
  }
  const { data: holds, error: holdErr } = await sb
    .from('audit_log')
    .select('id')
    .eq('firm_id', input.firmId)
    .eq('action', PROMO_HELD_ACTION)
    .eq('target_type', 'creator_offer')
    .eq('target_id', input.offerId)
    .limit(1);
  if (holdErr) return { status: 500, body: { error: holdErr.message } };
  if (!holds || holds.length === 0) {
    return {
      status: 409,
      body: { error: 'not_held', message: 'This deal has no held promo pack to resend.' },
    };
  }

  const r = await sendPromoMaterials(sb, { creatorOfferId: input.offerId }, deps);
  switch (r.outcome) {
    case 'sent':
      return { status: 200, body: { ok: true, outcome: 'sent' } };
    case 'skipped':
      return {
        status: 409,
        body: { error: 'already_sent', message: 'A promo pack is already on record for this deal. Nothing was sent.' },
      };
    case 'held_do_not_contact':
      return {
        status: 409,
        body: {
          error: 'do_not_contact',
          message: "The creator is on this label's do-not-contact list, so the promo pack was not sent.",
        },
      };
    case 'held_unconfirmed':
      return {
        status: 503,
        body: {
          error: 'block_list_unreadable',
          message: "Still couldn't read the label's do-not-contact list. Nothing was sent; try again in a minute.",
        },
      };
    case 'send_failed':
      return {
        status: 502,
        body: { error: 'send_failed', message: 'The email provider rejected the promo pack. It is recorded as failed.' },
      };
    default:
      return { status: 500, body: { error: 'error' } };
  }
}
