-- Migration 017 — Reply-template testing suite
--
-- Synthetic creator-reply fixtures for negotiation testing. Each row carries:
--   * archetype       — slug used by /api/outreach/simulate-reply
--   * signal jsonb    — hardcoded ground-truth intent the classifier MUST
--                       extract. Includes intent + numeric counter multiplier
--                       + tone. Lets us measure classifier accuracy across
--                       many simulated runs because the signal doesn't drift
--                       even when the text is AI-rewored.
--   * base_text       — seed copy. GPT-4o lightly rewords each simulation so
--                       inbound text looks unique while the signal stays put.
--   * voice_tag       — purely descriptive ('creator', 'manager', 'rambler', …)
--
-- Insert/update/delete restricted to service-role (no policies = implicit
-- deny). SELECT open to authed users (firm-agnostic — these are global
-- fixtures, not per-firm).
--
-- Seeded with 8 archetypes covering accept / aggressive-nego (high & low) /
-- polite-decline / clarification / ghoster-then-late / silent / garbled.

CREATE TABLE IF NOT EXISTS public.reply_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  archetype text NOT NULL UNIQUE,
  signal jsonb NOT NULL,
  base_text text NOT NULL,
  voice_tag text NOT NULL DEFAULT 'creator',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.reply_templates IS
  'Synthetic creator-reply fixtures. AI rewords each on simulation; signal stays fixed for classifier accuracy measurement.';

ALTER TABLE public.reply_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reply_templates_select_all ON public.reply_templates;
CREATE POLICY reply_templates_select_all ON public.reply_templates
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- ──────────────────────────────────────────────────────────────────────────
-- Seed 8 archetypes.
-- signal.intent ∈ { accept, counter, decline, clarify, ghost, silent, garble }
-- signal.counter_multiplier  — applied to initial_offer_usd to derive the
--                              numeric counter (counter intents only).
-- signal.tone                — descriptive only; classifier may use as feature.
-- signal.delay_hours         — for ghosters; simulator can backdate
--                              inbound_at to mimic the gap.
-- ──────────────────────────────────────────────────────────────────────────

INSERT INTO public.reply_templates (archetype, signal, base_text, voice_tag) VALUES
('spot_on_yes',
  '{"intent":"accept","tone":"warm"}'::jsonb,
  'Hey — yes, I''m in. Send the track and I''ll line up a post for next week. What handles do you want me to tag?',
  'creator'),
('aggressive_nego_high',
  '{"intent":"counter","counter_multiplier":3.0,"tone":"aggressive"}'::jsonb,
  'I appreciate the reach-out but my rate is significantly higher than your offer. I''d need at least 3x what you proposed for an in-feed post. My audience is dialed and I don''t lowball. Match it or I''ll pass.',
  'creator'),
('aggressive_nego_low',
  '{"intent":"counter","counter_multiplier":0.5,"tone":"curt"}'::jsonb,
  'Honestly your offer is too high for what I''d be doing — it''s just a quick mention. I''d feel better doing it for about half what you said. Let me know.',
  'creator'),
('polite_decline',
  '{"intent":"decline","tone":"warm"}'::jsonb,
  'Thanks so much for thinking of me! This one isn''t quite the right fit for my page right now, but I''d love to stay in touch for future drops. Best of luck with the release.',
  'creator'),
('asks_clarification',
  '{"intent":"clarify","tone":"warm"}'::jsonb,
  'Interesting — can you send me the track? And what kind of post are you thinking, in-feed video or just a story? Also, what''s the rough timeline you''re working with?',
  'creator'),
('ghoster_then_late_yes',
  '{"intent":"accept","tone":"curt","delay_hours":168}'::jsonb,
  'Hey, sorry for the late reply — got buried. If the offer''s still open I''m down. Send the track.',
  'creator'),
('silent_treatment',
  '{"intent":"silent","tone":"none"}'::jsonb,
  '',
  'creator'),
('garbled',
  '{"intent":"garble","tone":"rambling"}'::jsonb,
  'omg hi yes love this!! so I just got off tour and I''m kinda in this weird headspace?? but yeah maybe?? send me deets? also do you have other artists I''d love to know vibes lol',
  'creator')
ON CONFLICT (archetype) DO UPDATE
  SET signal = EXCLUDED.signal,
      base_text = EXCLUDED.base_text,
      voice_tag = EXCLUDED.voice_tag;
