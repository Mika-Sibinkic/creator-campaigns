// src/app/api/outreach/simulate-reply/route.ts
//
// SECURITY-OK: supabaseAdmin — needed to insert into reply_templates-driven
// inbound message rows + update campaign_influencers regardless of RLS path
// quirks (mirrors /api/outreach/respond's pattern).
//
// USER PATH — synthetic creator reply simulator for testing.
// Picks a reply_templates row (random or caller-specified archetype), AI-
// rewords the base_text so the inbound looks unique, inserts as an inbound
// outreach_messages row + classifies, updates campaign_influencers state.
//
// OPERATOR-GATED, and refused outright once real money is armed.
//
// The gate used to be `PAYMENTS_MODE === 'paper'`, which had the wrong shape:
// a staging deployment typically runs `stripe_test`, so the simulator was
// disabled exactly where it was needed, and that made it the one tool that
// could move the loop before inbound email is wired up. What actually matters
// is (a) only platform operators may fabricate a creator reply, and (b) nothing
// may fabricate
// one against a system that can move real money. So: operator-only always,
// and hard-refused in stripe_live / paypal_live.
//
// silent_treatment archetype intentionally writes NOTHING (the test is
// "what does Creator Campaigns do when a creator ghosts?").
//
// ghoster_then_late_yes backdates sent_at by signal.delay_hours so the
// dashboard timeline reads believably.
//
// For counter intents we compute the literal counter dollar amount as
// initial_offer * signal.counter_multiplier (or default $50 if no offer
// exists yet) and pass it to the reworder so the dollar value appears in
// the inbound body. The existing classifier picks up the negotiation
// signal from the keywords already in the rewored text.

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { requireOperator } from '@/lib/operator';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';
import { readJson } from '@/lib/validate';
import { rewordReplyTemplate } from '@/lib/openai';
import { ingestInboundReply } from '@/lib/ingest-inbound';
import { resolvePaymentMode } from '@/lib/stripe-isolated';
import { z } from 'zod';

export const runtime = 'nodejs';

const Body = z.object({
  outreach_message_id: z.string().uuid(),
  archetype: z.string().optional(), // if omitted, pick randomly per distribution
});

// Weighted random distribution for "?archetype unspecified" calls. Skews
// toward accept + counter to maximize downstream activity in the dashboard.
const DISTRIBUTION: Array<{ archetype: string; weight: number }> = [
  { archetype: 'spot_on_yes', weight: 25 },
  { archetype: 'aggressive_nego_high', weight: 15 },
  { archetype: 'aggressive_nego_low', weight: 15 },
  { archetype: 'polite_decline', weight: 15 },
  { archetype: 'asks_clarification', weight: 10 },
  { archetype: 'ghoster_then_late_yes', weight: 8 },
  { archetype: 'silent_treatment', weight: 7 },
  { archetype: 'garbled', weight: 5 },
];

function pickArchetype(): string {
  const total = DISTRIBUTION.reduce((s, d) => s + d.weight, 0);
  let r = Math.random() * total;
  for (const d of DISTRIBUTION) {
    r -= d.weight;
    if (r <= 0) return d.archetype;
  }
  return DISTRIBUTION[0].archetype;
}

export async function POST(req: NextRequest) {
  const limit = tieredLimit(req, 'auth');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }

  let session;
  try {
    session = await requireSession();
    requireOperator(session);
  } catch (r) {
    return r as Response;
  }

  // Never fabricate a creator reply into a system that can move real money.
  const mode = resolvePaymentMode();
  if (mode === 'stripe_live' || mode === 'paypal_live') {
    return NextResponse.json(
      {
        error: 'simulator_disabled',
        message: `Reply simulator is disabled in live payment mode (current: ${mode}).`,
      },
      { status: 403 }
    );
  }

  const body = await readJson(req, Body);
  if (body instanceof NextResponse) return body;

  const sb = supabaseAdmin();

  // 1. Load the sent outbound message + its CI + offer + campaign + artist.
  const { data: msg, error: msgErr } = await sb
    .from('outreach_messages')
    .select(`
      id, campaign_influencer_id, status, direction,
      campaign_influencer:campaign_influencers!inner (
        id, campaign_id,
        campaign:campaigns!inner ( id, firm_id, artist_name )
      )
    `)
    .eq('id', body.outreach_message_id)
    .single();
  if (msgErr || !msg) {
    return NextResponse.json({ error: 'outreach_message_not_found' }, { status: 404 });
  }
  // Supabase returns the join either as an array or object depending on
  // PostgREST version. Normalize.
  const ciRaw = (msg as { campaign_influencer: unknown }).campaign_influencer;
  const ci = Array.isArray(ciRaw) ? ciRaw[0] : ciRaw;
  if (!ci) return NextResponse.json({ error: 'ci_join_empty' }, { status: 500 });
  const campRaw = (ci as { campaign: unknown }).campaign;
  const camp = Array.isArray(campRaw) ? campRaw[0] : campRaw;
  if (!camp) return NextResponse.json({ error: 'campaign_join_empty' }, { status: 500 });

  const c = camp as { id: string; firm_id: string; artist_name: string };
  if (c.firm_id !== session.firm_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if ((msg as { direction: string }).direction !== 'outbound') {
    return NextResponse.json({ error: 'not_outbound' }, { status: 400 });
  }
  const ciId = (ci as { id: string }).id;

  // 1b. Idempotency — if this CI already has an inbound, return early
  // without re-simulating. Batch UI fires this route across all sent rows
  // and would otherwise stack inbound rows on every retry.
  const { data: prior } = await sb
    .from('outreach_messages')
    .select('id')
    .eq('campaign_influencer_id', ciId)
    .eq('direction', 'inbound')
    .limit(1)
    .maybeSingle();
  if (prior) {
    return NextResponse.json({
      ok: true,
      action: 'already_simulated',
      message_id: (prior as { id: string }).id,
    });
  }

  // 2. Pick archetype + load template.
  const archetype = body.archetype ?? pickArchetype();
  const { data: tmpl, error: tErr } = await sb
    .from('reply_templates')
    .select('archetype, signal, base_text, voice_tag')
    .eq('archetype', archetype)
    .single();
  if (tErr || !tmpl) {
    return NextResponse.json(
      { error: 'archetype_not_found', archetype },
      { status: 404 }
    );
  }
  const sig = (tmpl as { signal: { intent: string; counter_multiplier?: number; tone?: string; delay_hours?: number } }).signal;

  // 3. silent_treatment short-circuit — no row inserted, just record audit.
  if (sig.intent === 'silent') {
    await audit(
      {
        action: 'simulator.silent_treatment',
        target_type: 'outreach_message',
        target_id: (msg as { id: string }).id,
        firm_id: c.firm_id,
        metadata: { archetype, campaign_id: c.id, campaign_influencer_id: ciId },
      },
      req
    );
    return NextResponse.json({ ok: true, archetype, action: 'silent', message_id: null });
  }

  // 4. Compute the counter dollar amount if applicable.
  let counterAmount: number | undefined;
  if (sig.intent === 'counter' && sig.counter_multiplier) {
    // Look up the existing offer for the CI to anchor the counter on the
    // initial. If there's no offer yet, anchor on a sensible default ($50)
    // so the reword still has a concrete dollar to work with.
    const { data: offer } = await sb
      .from('creator_offers')
      .select('initial_offer_usd')
      .eq('campaign_influencer_id', ciId)
      .maybeSingle();
    const initial = (offer as { initial_offer_usd: number } | null)?.initial_offer_usd ?? 50;
    counterAmount = Math.round(initial * sig.counter_multiplier);
  }

  // 5. Reword via GPT-4o.
  const reworded = await rewordReplyTemplate({
    base_text: (tmpl as { base_text: string }).base_text,
    intent: sig.intent,
    tone: sig.tone ?? 'warm',
    counter_amount_usd: counterAmount,
    artist_name: c.artist_name,
    campaign_id: c.id,
  });

  // 6. Backdate received time for ghosters so the timeline reads believably.
  const delayMs = (sig.delay_hours ?? 0) * 3600 * 1000;
  const inboundAt = new Date(Date.now() - delayMs).toISOString();

  // 7. Ingest through the shared seam: classify → inbound_messages queue →
  //    behavior-preserving inbound outreach_messages row → advance
  //    campaign_influencers. external_id is stable per outbound message so
  //    retries dedupe. This is the same path Resend/Unipile sources will use.
  let ingest;
  try {
    ingest = await ingestInboundReply(
      {
        channel: 'email',
        external_id: `sim:${(msg as { id: string }).id}`,
        from_identity: `simulator:${archetype}`,
        body: reworded,
        campaign_influencer_id: ciId,
        received_at: inboundAt,
      },
      sb
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  if (!ingest.outreach_message_id) {
    return NextResponse.json({ error: 'ingest_no_inbound_row' }, { status: 500 });
  }
  const inboundId = ingest.outreach_message_id;
  const { classification, confidence } = ingest;

  // 10. Audit.
  await audit(
    {
      action: 'simulator.reply_inserted',
      target_type: 'outreach_message',
      target_id: inboundId,
      firm_id: c.firm_id,
      metadata: {
        archetype,
        intent_signal: sig.intent,
        counter_amount_usd: counterAmount ?? null,
        classification,
        classification_confidence: confidence,
        classifier_matched_intent: classifierMatchedIntent(classification, sig.intent),
        campaign_id: c.id,
        campaign_influencer_id: ciId,
        outbound_message_id: (msg as { id: string }).id,
      },
    },
    req
  );

  return NextResponse.json({
    ok: true,
    archetype,
    message_id: inboundId,
    classification,
    classification_confidence: confidence,
    classifier_matched_intent: classifierMatchedIntent(classification, sig.intent),
    counter_amount_usd: counterAmount ?? null,
  });
}

/**
 * Compares the keyword-classifier's verdict against the template's
 * ground-truth intent. True/false for quick measurement; richer accuracy
 * analysis happens in /audit by querying simulator.reply_inserted rows.
 */
function classifierMatchedIntent(classification: string, intent: string): boolean {
  switch (intent) {
    case 'accept':
      return classification === 'interested';
    case 'counter':
      return classification === 'negotiating';
    case 'decline':
      return classification === 'not_interested';
    case 'clarify':
      return classification === 'question';
    case 'garble':
      return classification === 'unclear';
    default:
      return false;
  }
}
