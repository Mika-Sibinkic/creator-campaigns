-- 040_deal_scope_spec.sql — the label sets the deal scope,
-- and the negotiator cannot trade it away. Additive only.
--
-- The application code does NOT depend on it having run:
-- deliverables-store.resolveCampaignSpec selects the new columns in a separate
-- query and degrades to the spec DERIVED from the standing package if that
-- select errors, which is the conservative direction (bounded by what the
-- creator was already told, just not label-authored).
--
-- ─── Why ──────────────────────────────────────────────────────────────────
--
-- evaluateTermTrade priced any package a creator proposed and let the ceiling
-- bound the dollars. Measured against the real modules:
--
--   3 reels for the same money            → accept, value_ratio 2.29
--   10 x dance_trend @ 600s, asked $150,
--     per-creator ceiling $200            → accept, value_ratio 21.18,
--                                           fair price $3494
--
-- Both are inside every money guard we have, which is why nothing caught them.
-- Money was guarded; SCOPE was not. The acceptance email would then tell a
-- creator they were locked in for ten 600-second dance videos, a format that
-- does not exist on Instagram (90s cap), and in auto + paper mode no human
-- would see it.
--
-- The root cause is that the label's intent was not represented as data.
-- promo_deliverables (migration 025) already models a package correctly and
-- had ZERO writers; every deal therefore negotiated against a
-- hardcoded constant in deliverables-store.ts. This migration turns that table
-- into the campaign's deal SCOPE by adding the three bounds it was missing,
-- and makes the frozen package on creator_offers tamper-evident.
--
-- ─── Effect on existing rows ─────────────────────────────────────────────
--
-- Section 1 adds three nullable columns. It rewrites nothing and cannot fail
-- on data.
--
-- Section 2 adds an IMMUTABLE validator function and a NOT VALID CHECK on
-- creator_offers.agreed_deliverables. NULL and arrays of valid promo_type
-- lines both satisfy the predicate, so the VALIDATE in section 3 succeeds on
-- them. Expected rows changed: ZERO.
--
-- NOT VALID + a separate VALIDATE wrapped in an exception handler that raises
-- a NOTICE naming the offending rows follows migration 037's precedent: it
-- avoids a long ACCESS EXCLUSIVE lock and cannot abort the migration on a
-- surprise row.
--
-- No column is dropped, no data is deleted, nothing here is destructive.
--
-- Rollback:
--   alter table public.creator_offers
--     drop constraint if exists creator_offers_agreed_deliverables_shape;
--   drop function if exists public.deliverables_jsonb_ok(jsonb);
--   alter table public.promo_deliverables
--     drop column if exists min_quantity,
--     drop column if exists max_quantity,
--     drop column if exists max_seconds;

begin;

-- ─── 1. The bounds a deal scope needs ──────────────────────────────────────
--
-- A campaign-parent promo_deliverables row already said WHAT the label wants
-- (promo_type), HOW MANY (quantity), HOW LONG (min_seconds) and BY WHEN
-- (delivery_window_days). As a scope it was missing the far edge of each.
--
-- The existing columns keep their meaning and gain a second one:
--   quantity              the ask, and the default quantity ceiling
--   min_seconds           the target length, and on a label-authored row the
--                         shortest video that will be accepted
--   delivery_window_days  the ask, and the outside date — a package claiming
--                         longer is out of scope, so no max_* twin is needed
--
-- and the new columns are the ceilings:
--   min_quantity   fewest pieces acceptable. NULL → 1, which is what keeps a
--                  creator NARROWING the package (the most common and most
--                  useful negotiation move) on the normal repricing path
--                  instead of waking a human up.
--   max_quantity   most pieces acceptable. NULL → quantity. This is the bound
--                  that stops "3 reels for the same money".
--   max_seconds    longest video acceptable. NULL → the platform cap in
--                  deliverables.PROMO_MAX_SECONDS (reel 90, dance_trend 180,
--                  story 60, post n/a). This is the bound that stops a
--                  600-second reel.
--
-- All three are NULLABLE on purpose. A label that has set up a campaign
-- without touching the scope editor must not end up with a scope that is
-- WIDER than the one they would have got from the defaults, and nullable +
-- resolved-in-code gives the same answer whether or not this migration ran.

alter table public.promo_deliverables
  add column if not exists min_quantity int
    check (min_quantity is null or min_quantity > 0),
  add column if not exists max_quantity int
    check (max_quantity is null or max_quantity > 0),
  add column if not exists max_seconds int
    check (max_seconds is null or max_seconds > 0);

comment on column public.promo_deliverables.min_quantity is
  'Deal scope: fewest pieces of this promo_type the negotiator may agree to. NULL means 1 — a creator narrowing the package is repriced by the value model, not escalated. Read through deliverables-store.resolveCampaignSpec, never directly.';
comment on column public.promo_deliverables.max_quantity is
  'Deal scope: most pieces of this promo_type the negotiator may agree to. NULL falls back to the quantity column (the ask). A proposal above this is ESCALATED to a human, never repriced — see pricing-engine.evaluateTermTrade.';
comment on column public.promo_deliverables.max_seconds is
  'Deal scope: longest video of this promo_type the negotiator may agree to. NULL falls back to the platform cap in src/lib/deliverables.ts PROMO_MAX_SECONDS. A 600-second reel does not exist on Instagram; this is where that fact is enforced commercially.';

comment on table public.promo_deliverables is
  'Promo deliverable line-items for a deal. A CAMPAIGN-parent row is the deal SCOPE: which promo types this campaign buys, in what quantity and length range, inside what delivery window. A CREATOR_OFFER-parent row is the per-deal package. A promo_type with no campaign row is not on offer at all. Service-role access only (RLS denies anon).';

-- ─── 2. Make the frozen package tamper-evident ─────────────────────────────
--
-- creator_offers.agreed_deliverables is the audit-replayable record of what a
-- creator agreed to, and it fills the acceptance email and the generated
-- contract. It was bare jsonb with no constraint, and the reader
-- (normalizeDeliverables) is deliberately lenient: it DROPS malformed lines
-- rather than throwing, so a bad line never breaks the negotiation path.
--
-- Compose those two and a corrupted freeze does not fail, it LIES. A deal
-- frozen as three reels, corrupted, re-reads as the default bundle and the
-- creator receives an email confirming one reel and one story. Leniency is
-- right for parsing a creator's reply and wrong for reading back our own
-- contract state.
--
-- The CHECK below is the structural half (the app-side half is
-- deliverables-store.checkFrozenDeliverables, which reports corruption on rows
-- written before this ran). Same doctrine as the ceiling CHECKs in migration
-- 009: the guarantee belongs in the database, not only in app logic.
--
-- A CHECK constraint may not contain a subquery, so the array walk lives in an
-- IMMUTABLE SQL function. This is the first structurally-validated jsonb
-- column in this schema — there was no house idiom to follow, so it is kept as
-- narrow as it can be: shape only, no business rules. Quantities, windows and
-- lengths stay in application code where they are testable and where changing
-- them does not require a migration.

create or replace function public.deliverables_jsonb_ok(v jsonb)
returns boolean
language sql
immutable
parallel safe
as $$
  select
    v is null
    or (
      jsonb_typeof(v) = 'array'
      and jsonb_array_length(v) > 0
      and not exists (
        select 1
          from jsonb_array_elements(v) as e
         where jsonb_typeof(e) <> 'object'
            or e->>'promo_type' is null
            or e->>'promo_type' not in ('story', 'post', 'reel', 'dance_trend')
      )
    );
$$;

comment on function public.deliverables_jsonb_ok(jsonb) is
  'True when a jsonb value is NULL or a non-empty array of objects each carrying a recognised promo_type. Shape validation only — quantity/length/window bounds live in src/lib/deliverables.ts. Used by the creator_offers_agreed_deliverables_shape CHECK so a frozen deal package cannot be written in a state that reads back as something else.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.creator_offers'::regclass
       and conname = 'creator_offers_agreed_deliverables_shape'
  ) then
    alter table public.creator_offers
      add constraint creator_offers_agreed_deliverables_shape
      check (public.deliverables_jsonb_ok(agreed_deliverables)) not valid;
  end if;
end $$;

-- ─── 3. Validate against existing rows ─────────────────────────────────────
--
-- Expected to succeed outright when every populated row holds valid lines
-- such as [{"promo_type":"reel","quantity":1,...}]. Wrapped so an unexpected
-- row raises a NOTICE naming the offenders instead of aborting the migration
-- (migration 037's pattern).

do $$
declare
  bad text;
begin
  begin
    alter table public.creator_offers
      validate constraint creator_offers_agreed_deliverables_shape;
  exception when check_violation then
    select string_agg(id::text, ', ')
      into bad
      from public.creator_offers
     where not public.deliverables_jsonb_ok(agreed_deliverables);
    raise notice
      'agreed_deliverables constraint left NOT VALID — offers with an unreadable frozen package: %',
      bad;
  end;
end $$;

comment on column public.creator_offers.agreed_deliverables is
  'Immutable snapshot of the agreed promo package (jsonb array of {promo_type, quantity, delivery_window_days, min_seconds, unit_price_usd}) frozen on the agreed transition, and on any counter that changed the package. The audit-replayable contract of what the creator agreed to, and the source of the package named in the acceptance email and the generated contract. Shape is enforced by creator_offers_agreed_deliverables_shape (migration 040); a row that fails to read back cleanly is reported by deliverables-store.checkFrozenDeliverables and escalates the negotiation to a human rather than silently degrading to the default bundle.';

commit;
