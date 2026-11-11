// src/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";
import { getEnv } from "./env";

let _admin: ReturnType<typeof createClient> | null = null;
export function supabaseAdmin() {
  if (_admin) return _admin;
  _admin = createClient(
    getEnv("NEXT_PUBLIC_SUPABASE_URL"),
    getEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
  return _admin;
}

export type Firm = {
  id: string;
  name: string;
  primary_contact_email: string | null;
  genre_focus: string[];
  created_at: string;
};

export type Campaign = {
  id: string;
  firm_id: string;
  artist_name: string;
  artist_spotify_id: string | null;
  artist_data: Record<string, unknown>;
  /**
   * ENFORCED ceilings (migration 037). src/lib/spend-caps.ts refuses payouts
   * against total_budget_usd; the negotiation ceiling reads per_creator_cap_usd.
   * Read these, not the two mirrors below.
   */
  total_budget_usd: number | null;
  per_creator_cap_usd: number | null;
  /**
   * DEPRECATED display mirrors. Written only by campaign-create; confirm and
   * clone do not maintain them, so they go stale. Kept on the type because
   * `select("*")` still returns them and legacy rows may only have these.
   */
  budget: number | null;
  per_influencer_cap: number | null;
  release_date: string | null;
  duration_days: number;
  urgency: string;
  target_platforms: string[];
  geo_overrides: string[] | null;
  special_instructions: string | null;
  status: string;
  similar_artists: unknown[];
  ip_intelligence: Record<string, unknown>;
  /**
   * Seeded / fixture campaign. Normalized onto every /api/campaigns row so the
   * UI can badge a sample by column instead of sniffing `artist_name` for a
   * "[SAMPLE]" prefix — a convention that misses any fixture nobody remembered
   * to name that way.
   */
  synthetic: boolean;
  created_at: string;
  updated_at: string;
};

export type Influencer = {
  id: string;
  platform: string;
  username: string;
  display_name: string | null;
  profile_url: string | null;
  follower_count: number | null;
  engagement_rate: number | null;
  bio: string | null;
  verified: boolean;
  avatar_url: string | null;
  content_genres: string[] | null;
  contact_email: string | null;
  /** Contact-enrichment cursor (migration 050). NULL = never scanned. */
  contact_scanned_at: string | null;
  contact_scan_attempts: number;
  created_at: string;
};

export type CampaignInfluencer = {
  id: string;
  campaign_id: string;
  influencer_id: string;
  composite_score: number | null;
  tier: string | null;
  price_estimate_low: number | null;
  price_estimate_mid: number | null;
  price_estimate_high: number | null;
  outreach_priority: string;
  outreach_angle: string | null;
  source_artists: string[] | null;
  status: string;
  score_breakdown: Record<string, number> | null;
  bot_flagged: boolean;
  outreach_status: string;
  message_count: number;
  last_outreach_at: string | null;
  last_response_at: string | null;
  response_classification: string | null;
  influencer?: Influencer;
};

export type OutreachMessage = {
  id: string;
  campaign_influencer_id: string;
  message_type: string;
  direction: string;
  subject: string | null;
  body: string;
  channel: string;
  sent_at: string | null;
  delivered: boolean | null;
  opened: boolean | null;
  replied: boolean | null;
  classification: string | null;
  classification_confidence: number | null;
  ai_suggested_response: string | null;
  version: number;
  template_used: string | null;
  generation_model: string | null;
  edited_by_user: boolean;
  original_body: string | null;
  created_at: string;
};

export type Deal = {
  id: string;
  campaign_influencer_id: string;
  agreed_price: number;
  deliverable_type: string | null;
  deliverable_specs: Record<string, unknown>;
  deadline: string | null;
  payment_status: string;
  fulfillment_status: string;
  content_url: string | null;
  created_at: string;
};
