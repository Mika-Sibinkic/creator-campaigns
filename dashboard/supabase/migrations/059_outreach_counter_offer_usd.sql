-- 059_outreach_counter_offer_usd.sql
--
-- Record, on each outbound counter, the price it quotes.
--
-- The code works with or without it. Apply with
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/059_outreach_counter_offer_usd.sql
--
-- WHY
--   When a creator writes again while our counter
--   is still queued, the negotiation tick withdraws that counter and takes one
--   new turn. The new turn has to start from the LAST PRICE THE CREATOR WAS
--   ACTUALLY SENT, not from the withdrawn draft's number: conceding from the
--   draft paid more ($188 where the unfolded thread ends at $175), told the
--   creator "moves the number from $150" when they had only seen $100, and
--   recorded "$100 works" as agreed at $150. creator_offers.current_offer_usd
--   is overwritten when a counter is DRAFTED, so it cannot say what was sent.
--   This column can: it is the price on the row that actually went out.
--
-- HOW THE CODE USES IT
--   scheduleCounter (src/lib/negotiation-tick.ts) writes it on every counter.
--   lastSentOffer reads the latest SENT counter's value back during a fold.
--   Before this is applied the insert is refused (PGRST204) and retried
--   without it, and the read falls back to the columns that exist. With no
--   counter sent yet the opening offer is exact, so a first-round fold is
--   unaffected. A fold after a counter whose price is unknown (pre-059, or
--   sent before this shipped) is handed to a human
--   (negotiation.sent_price_unknown) instead of guessing. Pinned by
--   tests/fold-sent-price.test.ts (pre-059).
--
-- Additive only. Nullable, no default, no backfill: a NULL means "not
-- recorded", which the code treats as unknown, never as zero.

alter table public.outreach_messages
  add column if not exists offer_usd numeric;

-- This column is the ONLY source
-- of "the last price we sent". Message text is never parsed for a price. Any
-- outbound row may carry it when a price is explicitly quoted: AI counters,
-- edited counters (confirmed price field), an operator's manual send with
-- "Price quoted" filled in, and Resume price records. Until this is applied,
-- every last-sent price is unknown, so every acceptance goes to a human.

comment on column public.outreach_messages.offer_usd is
  'The price (USD) this outbound message explicitly quotes: AI and edited counters, an operator''s "Price quoted" on a manual send, a Resume price record. The only source of the last price a creator was sent (message text is never parsed). NULL = quotes no price on record.';
