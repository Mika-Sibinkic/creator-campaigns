-- Migration 020 — Cold-start seed for channel_conversion_priors
--
-- Migration 018 created channel_conversion_priors (per firm×channel
-- sent/replies/deals funnel counters) but inserted zero rows, so every
-- best_channel recommendation from src/lib/contact-discovery.ts fell through
-- to the hardcoded cold-start order (email > instagram_dm > tiktok_dm) — the
-- same guess for every creator. This migration seeds industry-prior rows so
-- ranking is data-driven from day one and the RL loop has counters to
-- increment.
--
-- Scope: per-firm. Both consumers (contact-discovery loadPriors() and the
-- campaign run route) query `WHERE firm_id = <firm>`, and the table has no
-- global-row concept (firm_id is NOT NULL → firms.id). So we seed every firm
-- present when the migration is applied — never a hardcoded UUID. On a fresh
-- database there are no firms yet, so the INSERT..SELECT inserts zero rows and
-- the migration still succeeds.
--
-- Native representation: the table stores counters, not rates, and the
-- selector scores them with Laplace smoothing:
--   priorScore = (deals + 0.25·(replies − deals) + 1) / (sent + 2)
-- so a rate is encoded as pseudo-counts. All three rows use a per-100-sends
-- scale, making replies/sent read directly as the reply-rate percentage.
--
-- Seeded priors (labeling lives HERE — the table has no notes/source column):
--
--   * email        7 / 100  (7.0%) — commonly cited cold-outreach baselines
--                  (recruiting 1-2%, "good" email ≈ 6-8% → midpoint 0.07).
--   * instagram_dm 3 / 100  (3.0%) — STARTING GUESS, not measured data. Cold
--                  DM to unmanaged creators is assumed to convert below a
--                  good email; replace-by-evidence via the RL counters.
--   * tiktok_dm    2 / 100  (2.0%) — STARTING GUESS, not measured data.
--                  TikTok DM inboxes are the least business-monitored of the
--                  three; seeded lowest; replace-by-evidence via RL counters.
--
-- deals = 0 everywhere: no closed-deal evidence is being fabricated.
--
-- The seed is deliberately overridable: a deal counts 4× a bare reply in
-- priorScore, so ~2 real closed deals on a DM channel outrank the seeded
-- email baseline (covered by tests/contact-discovery.test.ts case 12).
--
-- Idempotent + non-destructive: ON CONFLICT (firm_id, channel) DO NOTHING —
-- re-applying never resets counters the RL loop has since incremented.

INSERT INTO public.channel_conversion_priors (firm_id, channel, sent, replies, deals)
SELECT f.id, v.channel, v.sent, v.replies, v.deals
FROM public.firms f
CROSS JOIN (
  VALUES
    ('email'::text,        100, 7, 0),
    ('instagram_dm'::text, 100, 3, 0),
    ('tiktok_dm'::text,    100, 2, 0)
) AS v(channel, sent, replies, deals)
ON CONFLICT (firm_id, channel) DO NOTHING;
