// src/lib/zod-schemas.ts
//
// SEC-2: Centralized Zod request schemas for every route boundary that
// accepts a JSON body. One source of truth so the input shape is auditable
// and refactor-safe.
//
// Usage (in a route):
//   import { CreateCampaignBody } from '@/lib/zod-schemas';
//   import { readJson } from '@/lib/validate';
//
//   const body = await readJson(req, CreateCampaignBody);
//   if (body instanceof NextResponse) return body;
//   // body is now typed + validated
//
// Conventions:
//   - Be permissive about JSON shapes the existing UI/clients send (don't
//     break working flows). Tighten only where the field is actually
//     required, or where a malformed value would corrupt the DB.
//   - Use z.unknown() for jsonb columns we accept-as-is (voice_profile etc).
//   - Date-ish fields are kept as strings; the DB layer/Supabase coerces.
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────
// /api/campaigns           POST  — create campaign
// ────────────────────────────────────────────────────────────────────────
export const CreateCampaignBody = z.object({
  artist_name: z.string().min(1).max(200),
  track_name: z.string().max(200).optional(),
  // Migration 036 — Soundcharts artist UUID from the new-campaign confirmation
  // picker. Optional: skipping the picker keeps the free-text flow. Kept as a
  // permissive string (Soundcharts issues RFC-style UUIDs today, but we don't
  // bet the create path on their format).
  artist_soundcharts_uuid: z.string().min(8).max(128).optional().nullable(),
  // The confirmed Spotify artist (picked card or resolved link). Optional at
  // the schema so a missing one gets the specific `artist_unconfirmed` answer
  // from verifyCampaignArtist (src/lib/artist-lookup.ts) rather than a bare
  // `validation_failed`; the create route refuses without it either way.
  artist_spotify_id: z.string().max(64).optional().nullable(),
  release_date: z.string().max(64).optional().nullable(),
  // MONEY — both are REQUIRED and must be strictly positive.
  //
  // These two numbers are the campaign's only enforceable ceilings. They used
  // to be optional-nullable, and the create route wrote them to the LEGACY
  // `budget` / `per_influencer_cap` columns that no money path reads — so a
  // campaign could be created showing "$5,600" in the UI while
  // campaigns.total_budget_usd stayed NULL and the spend cap was disabled.
  // The route now writes the enforced `total_budget_usd` /
  // `per_creator_cap_usd` columns from these fields, and spend-caps.ts fails
  // closed on an unset budget, so accepting a blank one here would only move
  // the failure from create time to payout time. Refuse it up front.
  budget: z.number().positive(),
  per_influencer_cap: z.number().positive(),
  duration_days: z.number().int().positive().max(3650).optional(),
  urgency: z.string().max(32).optional(),
  target_platforms: z.array(z.string().max(64)).max(20).optional(),
  special_instructions: z.string().max(4000).optional().nullable(),
  // Migration 060 — most creators this campaign may contact. Optional; null or
  // absent = no limit. Written only when supplied, so pre-060 creation works.
  outreach_limit: z.number().int().positive().max(100_000).optional().nullable(),
  // Migration 066 — opt in to the comment-quality audit. Written only when
  // true, so pre-066 creation works unchanged.
  comment_audit_enabled: z.boolean().optional(),
});
export type CreateCampaignBody = z.infer<typeof CreateCampaignBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/firm                PATCH — update firm settings
// ────────────────────────────────────────────────────────────────────────
export const UpdateFirmBody = z.object({
  testing_mode: z.boolean().optional(),
  test_recipient_email: z.string().email().max(320).nullable().optional(),
  // Migration 023 — Gmail inbox the negotiation tick reads replies from.
  negotiation_inbox_email: z.string().email().max(320).nullable().optional(),
  sender_email: z.string().email().max(320).nullable().optional(),
  sender_name: z.string().max(200).nullable().optional(),
  // jsonb — accept any shape, store as-is
  voice_profile: z.unknown().optional(),
  // Onboarding additions (migration 009)
  label_type: z.enum(['label', 'manager', 'artist', 'agency']).optional(),
  scraping_prefs: z.unknown().optional(),
  outreach_prefs: z.unknown().optional(),
  campaign_defaults: z.unknown().optional(),
  onboarding_completed_at: z.string().datetime().nullable().optional(),
  // N5 monthly caps (migration 014). 0 disables either cap.
  monthly_spend_cap_usd: z.number().nonnegative().optional(),
  per_creator_monthly_cap_usd: z.number().nonnegative().optional(),
  // Migration 016 — per-firm daily Apify pipeline cap. 0 disables.
  daily_apify_cap_usd: z.number().nonnegative().optional(),
});
export type UpdateFirmBody = z.infer<typeof UpdateFirmBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/influencers/[id]    PATCH — toggle block
// ────────────────────────────────────────────────────────────────────────
// scope 'firm' (default): this label's own block (firm_influencer_blocks).
// scope 'global': the shared influencers.blocklisted — operator-only, enforced
// in the route (src/lib/firm-blocks.ts applyBlockToggle).
export const PatchInfluencerBody = z.object({
  blocklisted: z.boolean(),
  scope: z.enum(['firm', 'global']).optional(),
});
export type PatchInfluencerBody = z.infer<typeof PatchInfluencerBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/outreach/messages/[id]  PATCH — edit / mark-sent shim
// ────────────────────────────────────────────────────────────────────────
export const PatchOutreachMessageBody = z.object({
  body: z.string().max(20000).optional(),
  subject: z.string().max(998).optional(),
  mark_sent: z.boolean().optional(),
  // Counter edit: its required price. Other messages: optional "Price
  // quoted", null clears. See src/lib/counter-edit.ts.
  offer_usd: z.number().positive().max(1_000_000).nullable().optional(),
});
export type PatchOutreachMessageBody = z.infer<typeof PatchOutreachMessageBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/outreach/generate   POST — single-target draft
// ────────────────────────────────────────────────────────────────────────
// Narrow enums match the GenerateMessageInput types in src/lib/outreach.ts.
const MessageType = z.enum(['initial', 'follow_up', 'negotiation']);
const Channel = z.enum(['email', 'dm', 'comment']);

export const GenerateOutreachBody = z.object({
  campaign_influencer_id: z.string().uuid(),
  message_type: MessageType.optional(),
  channel: Channel.optional(),
  custom_instructions: z.string().max(4000).optional(),
});
export type GenerateOutreachBody = z.infer<typeof GenerateOutreachBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/outreach/generate-bulk   POST — bulk drafts
// ────────────────────────────────────────────────────────────────────────
export const GenerateOutreachBulkBody = z.object({
  campaign_id: z.string().uuid(),
  tier_filter: z.string().max(64).optional(),
  message_type: MessageType.optional(),
  channel: Channel.optional(),
  custom_instructions: z.string().max(4000).optional(),
});
export type GenerateOutreachBulkBody = z.infer<typeof GenerateOutreachBulkBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/outreach/respond   POST — log inbound classification
// ────────────────────────────────────────────────────────────────────────
export const RespondClassifyBody = z.object({
  campaign_influencer_id: z.string().uuid(),
  response_text: z.string().min(1).max(20000),
  channel: z.string().max(64).optional(),
  // Generated once per form in the browser so a retried POST dedupes
  // (ingest keys on channel + `manual:<submission_id>`). Optional for old clients.
  submission_id: z.string().uuid().optional(),
});
export type RespondClassifyBody = z.infer<typeof RespondClassifyBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/outreach/dm-reply   POST — a creator's DM reply, pasted by an operator
// ────────────────────────────────────────────────────────────────────────
// DM channels only: this path feeds the negotiator, and the channel decides
// where its answer goes (src/lib/dm-reply.ts). submission_id is generated once
// per form in the browser so a retried POST dedupes instead of double-writing.
export const LogDmReplyBody = z.object({
  campaign_influencer_id: z.string().uuid(),
  channel: z.enum(['instagram_dm', 'tiktok_dm']),
  text: z.string().min(1).max(20000),
  submission_id: z.string().uuid(),
});
export type LogDmReplyBody = z.infer<typeof LogDmReplyBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/scoring/batch    POST — pure scoring compute
// ────────────────────────────────────────────────────────────────────────
// scoreInfluencers downstream tolerates loose shape; cap counts to keep
// payloads sane. Influencer profile fields are passthrough (z.unknown()).
export const ScoringBatchBody = z.object({
  profiles: z.array(z.record(z.string(), z.unknown())).max(500),
  campaign_context: z.record(z.string(), z.unknown()).optional(),
});
export type ScoringBatchBody = z.infer<typeof ScoringBatchBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/campaigns/[id]/run    POST — pipeline trigger (no body fields)
// ────────────────────────────────────────────────────────────────────────
// The route reads the campaign by URL param; the body (if any) is currently
// ignored. Schema kept here so future fields land in the right place.
export const RunCampaignBody = z.object({}).passthrough();
export type RunCampaignBody = z.infer<typeof RunCampaignBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/campaigns/[id]/draft-all    POST — bulk D1 draft (no body)
// ────────────────────────────────────────────────────────────────────────
export const DraftAllBody = z.object({}).passthrough();
export type DraftAllBody = z.infer<typeof DraftAllBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/firm-member         PATCH — per-user testing overrides (migration 013)
// ────────────────────────────────────────────────────────────────────────
// Empty string ('') is normalized to null at the route layer so blanking a
// field in the settings UI deletes the override and falls back to firm
// defaults. We accept '' here so the schema doesn't reject it.
export const UpdateFirmMemberBody = z.object({
  sender_email: z
    .union([z.literal(''), z.string().email().max(320)])
    .nullable()
    .optional(),
  sender_name: z.string().max(200).nullable().optional(),
  test_recipient_email: z
    .union([z.literal(''), z.string().email().max(320)])
    .nullable()
    .optional(),
  // Migration 023 — per-user override for the negotiation read-inbox.
  negotiation_inbox_email: z
    .union([z.literal(''), z.string().email().max(320)])
    .nullable()
    .optional(),
});
export type UpdateFirmMemberBody = z.infer<typeof UpdateFirmMemberBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/influencers/[id]    PATCH — contact_email backfill (manual today,
// ScrapeGraphAI enrichment land replaces this).
// ────────────────────────────────────────────────────────────────────────
// Re-uses the same PATCH endpoint as the blocklist toggle but with a
// disjoint field set, so the route handler dispatches on which key landed
// in the body.
export const PatchInfluencerContactBody = z.object({
  contact_email: z
    .union([z.literal(''), z.string().email().max(320)])
    .nullable(),
});
export type PatchInfluencerContactBody = z.infer<typeof PatchInfluencerContactBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/campaigns/[campaign_id]/deals/[offer_id]/post  PATCH
// — Log the creator's post URL once a paid offer goes live.
// Advances creator_offers.status: 'paid' → 'posted'.
// ────────────────────────────────────────────────────────────────────────
export const LogOfferPostBody = z.object({
  post_url: z.string().url().max(2000),
  posted_at: z.string().datetime().optional(),
});
export type LogOfferPostBody = z.infer<typeof LogOfferPostBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/firm/contract-template   PUT — save the firm's deal-contract template
// (migration 034; one active template per firm, v1). Plain text/markdown
// only; size + content guards live in src/lib/contracts.ts and are applied
// at the route on top of this shape check.
// ────────────────────────────────────────────────────────────────────────
export const PutContractTemplateBody = z.object({
  name: z.string().min(1).max(200).optional(),
  body_text: z.string().min(1).max(50_000),
});
export type PutContractTemplateBody = z.infer<typeof PutContractTemplateBody>;

// POST /api/firm/contract-template/generate — produce a starting template
// draft (deterministic base, optionally model-customized). Free-text fields
// are the firm's own words; caps keep the model prompt and the fallback body
// bounded well under the 50k template ceiling.
//
// governing_law is REQUIRED. It has no per-deal source, so generating without
// it produces a template carrying a permanently unfillable {{governing_law}} —
// one that looks saved and can never actually send.
export const GenerateContractTemplateBody = z.object({
  firm_name: z.string().max(200).optional(),
  governing_law: z.string().min(1).max(200),
  extra_clauses: z.string().max(4_000).optional(),
});
export type GenerateContractTemplateBody = z.infer<typeof GenerateContractTemplateBody>;

// POST /api/firm/contract-template/approve — mark the saved template approved
// for sending. body_text must match what is stored, so approval always refers
// to the exact text the reviewer had in front of them rather than to the row.
export const ApproveContractTemplateBody = z.object({
  body_text: z.string().min(1).max(50_000),
});
export type ApproveContractTemplateBody = z.infer<typeof ApproveContractTemplateBody>;

// /api/firm/contract-template/builder/{preview,apply} — the guided builder.
// `answers` is shape-checked loosely here and validated field by field in
// src/lib/contract-builder.ts validateAnswers (closed option sets, cleaned
// free text), which is the real gate.
export const ContractBuilderPreviewBody = z.object({
  answers: z.record(z.string(), z.unknown()),
  polish: z.boolean().optional(),
});
export type ContractBuilderPreviewBody = z.infer<typeof ContractBuilderPreviewBody>;

export const ContractBuilderApplyBody = z.object({
  answers: z.record(z.string(), z.unknown()),
  body_text: z.string().min(1).max(50_000),
});
export type ContractBuilderApplyBody = z.infer<typeof ContractBuilderApplyBody>;

// ────────────────────────────────────────────────────────────────────────
// /api/campaigns/[id]/deal-scope   PUT — set the campaign's deal scope
//. Writes campaign-parent promo_deliverables rows, which is what
// the auto-negotiator checks a creator's proposal against before it may agree
// to anything. An empty `lines` array is a legitimate body: it clears the
// scope back to the one derived from the standing package.
//
// Bounds are capped at the same numbers the reply parser uses
// (deliverables.TERMS_MAX_QUANTITY / TERMS_MAX_SECONDS) so a label cannot
// author a scope wider than anything the negotiator could ever parse into a
// package — a scope that permits what cannot be proposed just reads as
// broken. The cross-field checks (min ≤ max) are in the route, where they can
// return the field name.
// ────────────────────────────────────────────────────────────────────────
export const PutDealScopeBody = z.object({
  lines: z
    .array(
      z.object({
        promo_type: z.enum(['story', 'post', 'reel', 'dance_trend']),
        quantity: z.number().int().positive().max(10),
        min_quantity: z.number().int().positive().max(10).nullable().optional(),
        max_quantity: z.number().int().positive().max(10).nullable().optional(),
        min_seconds: z.number().int().positive().max(600).nullable().optional(),
        max_seconds: z.number().int().positive().max(600).nullable().optional(),
      }),
    )
    .max(4),
  delivery_window_days: z.number().int().positive().max(365),
});
export type PutDealScopeBody = z.infer<typeof PutDealScopeBody>;
