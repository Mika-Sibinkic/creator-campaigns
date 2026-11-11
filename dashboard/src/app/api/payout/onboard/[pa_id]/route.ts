// GET /api/payout/onboard/[pa_id] — the stable payout-setup link creators
// receive by email.
//
// Stripe AccountLinks are single-use and expire minutes after creation, but
// the onboarding email sits in a queue and then in an inbox — by the time a
// creator clicks, a raw AccountLink is dead. So the email carries THIS route,
// which mints a fresh AccountLink at click time and 302s into Stripe's hosted
// onboarding. Stripe's own refresh_url points back here too, so an expired
// session self-heals with another click.
//
// PUBLIC route (creators are not app users; middleware exempts it). The pa_id
// is a v4 uuid acting as the bearer capability — same trust class as a
// magic-link token. It exposes no data: the only outcomes are a redirect into
// Stripe onboarding for the already-linked account, or a generic bounce page.

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { isStripeMode, mintOnboardingLink, resolveActivePaymentMode, type PaymentMode } from '@/lib/stripe-isolated';
import { tieredLimit } from '@/lib/rate-limit';
import { audit } from '@/lib/audit';
import { appBaseUrl } from '@/lib/env';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bounce(base: string, status: string): NextResponse {
  return NextResponse.redirect(`${base}/payout/complete?status=${status}`, 302);
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ pa_id: string }> },
) {
  const base = appBaseUrl();
  const limit = tieredLimit(req, 'public');
  if (!limit.ok) return bounce(base, 'try-later');

  const { pa_id } = await ctx.params;
  if (!UUID_RE.test(pa_id)) return bounce(base, 'invalid');

  const sb = supabaseAdmin();
  // Migration 064: the link is minted with the key of the mode the payment was
  // APPROVED in, for a Connect account of that same mode. Pre-064 (unpinned)
  // there is one key, the active one.
  const active = await resolveActivePaymentMode(sb);
  const pinned = active.pinned;
  const { data: pa } = await sb
    .from('payment_authorizations')
    .select(`id, status, firm_id, creator_offer_id${pinned ? ', approved_mode' : ''}`)
    .eq('id', pa_id)
    .maybeSingle();
  if (!pa) return bounce(base, 'invalid');
  const paT = pa as { id: string; status: string; firm_id: string; creator_offer_id: string; approved_mode?: string | null };
  // 'approved' = waiting on onboarding; 'executing'/'completed' can race the
  // webhook — treat anything not awaiting money-out as already handled.
  if (paT.status !== 'approved') return bounce(base, 'done');
  const rowMode: PaymentMode | null = pinned
    ? isStripeMode(paT.approved_mode) ? paT.approved_mode : null
    : active.mode;
  if (!rowMode) return bounce(base, 'done');

  const { data: offer } = await sb
    .from('creator_offers')
    .select(
      `id, payout_status, campaign_influencers!inner(influencer:influencers!inner(stripe_connect_account_id${pinned ? ', stripe_connect_account_mode' : ''}))`
    )
    .eq('id', paT.creator_offer_id)
    .maybeSingle();
  const offerT = offer as
    | {
        payout_status: string | null;
        campaign_influencers: {
          influencer: { stripe_connect_account_id: string | null; stripe_connect_account_mode?: string | null };
        };
      }
    | null;
  const influencer = offerT?.campaign_influencers?.influencer;
  const acctId = influencer?.stripe_connect_account_id ?? null;
  // A Connect account from the other mode is never touched with this key.
  const acctMode = influencer?.stripe_connect_account_mode ?? 'stripe_test';
  if (!offerT || offerT.payout_status !== 'awaiting_onboarding' || !acctId || (pinned && acctMode !== rowMode)) {
    return bounce(base, 'done');
  }

  const link = await mintOnboardingLink(
    acctId,
    `${base}/api/payout/onboard/${paT.id}`,
    `${base}/payout/complete`,
    rowMode,
  );
  if (!link.ok) {
    console.error('[payout.onboard] account link mint failed', link.error);
    return bounce(base, 'try-later');
  }
  await audit({
    action: 'payment.onboarding_link_opened',
    actor_label: 'creator:onboarding-link',
    firm_id: paT.firm_id,
    target_type: 'payment_authorization',
    target_id: paT.id,
    metadata: { already_onboarded: link.payouts_enabled },
  }, req);
  if (link.payouts_enabled) return bounce(base, 'already-set-up');
  return NextResponse.redirect(link.url, 302);
}
