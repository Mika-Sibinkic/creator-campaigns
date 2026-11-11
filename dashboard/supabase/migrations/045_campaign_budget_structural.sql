-- 045_campaign_budget_structural.sql — make the CAMPAIGN
-- TOTAL budget a structural invariant, not an application-code convention.
-- Additive only.
--
-- Apply with `CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/045_campaign_budget_structural.sql`
-- from dashboard/. The application code does NOT depend on it having run:
-- src/lib/negotiation.ts `computeEffectiveCeiling` keeps doing its read-then-
-- write check, and this trigger is the backstop underneath it. Nothing in the
-- app catches the exception by name today; it surfaces as a failed write with
-- SQLSTATE 23514, the same class the per-creator ceiling already raises.
--
-- ─────────────────────────────── Why ────────────────────────────────────────
-- The PER-CREATOR ceiling is already structural: migration 009 puts
-- `current_within_ceiling` and `agreed_within_ceiling` CHECKs on creator_offers,
-- and no path — creator reply, LLM counter_usd, poisoned history — can beat
-- them. The CAMPAIGN TOTAL budget had no such floor. It was enforced only by
-- `computeEffectiveCeiling` → `campaignCommittedUsd`, a read-then-write with no
-- transaction, no lock and no constraint, so two negotiation ticks overlapping
-- on one campaign each read the same `remaining` and both commit. The sum can
-- then exceed campaigns.total_budget_usd. Paper-money-safe until now; a hard
-- blocker for PAYMENTS_MODE=stripe_live.
--
-- Why a TRIGGER and not a CHECK: a CHECK constraint may not contain a subquery
-- and is only re-evaluated for the row being written, so it cannot see a
-- cross-row aggregate. The invariant is "the SUM over sibling rows", which is
-- a trigger's job.
--
-- Why the ADVISORY LOCK inside the trigger: this is the part that actually
-- closes the race. A BEFORE trigger that merely re-runs the sum reproduces the
-- original race one layer down — under READ COMMITTED both concurrent
-- transactions run the SELECT before either commits, both see the same prior
-- total, and both pass. `pg_advisory_xact_lock` serializes writers per
-- campaign so the second one sees the first one's row. It is transaction-
-- scoped (released on commit OR rollback), it is the only lock this function
-- takes (so it cannot deadlock against itself through lock ordering), and it
-- does not conflict with row locks taken by ordinary campaign updates.
-- The advisory lock and the trigger look like alternatives, but
-- only the lock serializes, so this does both — and it stays in the database,
-- leaving src/lib/negotiation.ts untouched.
--
-- ───────────────── Exact effect on existing rows ────────────────────────────
-- None. There is no constraint here to add NOT VALID, so the 037/040 pattern
-- is honoured by its equivalent for triggers:
--   1. A trigger only fires on FUTURE writes, exactly as `NOT VALID` skips the
--      existing-row scan while still enforcing every future INSERT/UPDATE.
--   2. The guard never blocks a write that does not INCREASE committed spend
--      (see `new_contrib <= old_contrib` below), so a campaign that is already
--      over budget can still be corrected downward, cancelled or paid out.
--      Without that clause this migration would brick existing rows.
--   3. The DO block at the end plays the part of `VALIDATE CONSTRAINT`: it
--      names any campaign already over budget as a NOTICE instead of aborting.
--
-- The summed set matches `COMMITTED_STATES` in src/lib/negotiation.ts exactly
-- ('agreed','human_approval_required','approved','paid','posted','measured').
-- 'offered' and 'counter_offered' are deliberately excluded, the same as the
-- app — a trigger that counted them would refuse deals the UI shows as
-- affordable. The per-row amount is COALESCE(agreed_amount_usd,
-- current_offer_usd, 0), matching the app's `agreed ?? current ?? 0` fold.
--
-- It sums creator_offers ONLY. A settled deal also has a row in
-- payment_authorizations; summing both would double-count. payment_authorizations
-- is the set src/lib/spend-caps.ts uses for its own caps, which are a separate
-- gate at payout time and unaffected by this file.
--
-- A NULL or <= 0 total_budget_usd means "no campaign cap; the per-creator
-- ceiling governs", matching computeEffectiveCeiling. (src/lib/spend-caps.ts
-- fails CLOSED on the same state, at payout time. That divergence predates
-- this migration and is left alone deliberately — changing it here would
-- retroactively block existing campaigns that still have no cap set.)
--
-- Not SECURITY DEFINER: triggers fire regardless of role (see the note in
-- migration 008), and every app write goes through the service role, which
-- bypasses RLS and therefore sees every sibling row when summing.
--
-- Rollback:
--   drop trigger if exists trg_creator_offers_campaign_budget on public.creator_offers;
--   drop function if exists public.creator_offers_campaign_budget_guard();

-- ─────────────────────────────────────────────────────────────────────
-- 1. The guard
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.creator_offers_campaign_budget_guard()
returns trigger as $$
declare
  committed_states text[] := array[
    'agreed','human_approval_required','approved','paid','posted','measured'
  ];
  new_contrib numeric(12,2) := 0;
  old_contrib numeric(12,2) := 0;
  budget      numeric(10,2);
  others      numeric(12,2);
begin
  if NEW.campaign_id is null then
    return NEW;
  end if;

  if NEW.status = any(committed_states) then
    new_contrib := coalesce(NEW.agreed_amount_usd, NEW.current_offer_usd, 0);
  end if;

  if TG_OP = 'UPDATE' and OLD.status = any(committed_states) then
    old_contrib := coalesce(OLD.agreed_amount_usd, OLD.current_offer_usd, 0);
  end if;

  -- Never block a write that does not increase committed spend: leaving a
  -- committed state, lowering an amount, or any unrelated column update. This
  -- is what makes the migration safe on rows that already exceed the budget.
  if new_contrib <= old_contrib then
    return NEW;
  end if;

  -- Serialize writers for this campaign. Without this the check below is
  -- still a read-then-write and the race stays open.
  perform pg_advisory_xact_lock(
    hashtext('creator_campaigns.campaign_budget'),
    hashtext(NEW.campaign_id::text)
  );

  select c.total_budget_usd
    into budget
    from public.campaigns c
   where c.id = NEW.campaign_id;

  -- No campaign cap configured → the per-creator ceiling governs.
  if budget is null or budget <= 0 then
    return NEW;
  end if;

  select coalesce(sum(coalesce(o.agreed_amount_usd, o.current_offer_usd, 0)), 0)
    into others
    from public.creator_offers o
   where o.campaign_id = NEW.campaign_id
     and o.id <> NEW.id
     and o.status = any(committed_states);

  if others + new_contrib > budget then
    raise exception
      using
        errcode = 'check_violation',
        message = format(
          'campaign_total_budget_exceeded: campaign %s already commits %s; adding %s would exceed total_budget_usd %s',
          NEW.campaign_id, others, new_contrib, budget
        ),
        hint = 'Raise the campaign total budget, or lower the agreed amount on this deal.';
  end if;

  return NEW;
end;
$$ language plpgsql;

comment on function public.creator_offers_campaign_budget_guard() is
  'Rejects any creator_offers write that would push a campaign''s committed spend past campaigns.total_budget_usd. Committed states and the amount fold match COMMITTED_STATES / campaignCommittedUsd in src/lib/negotiation.ts. Takes a per-campaign advisory lock so concurrent negotiation ticks serialize.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Attach it
-- ─────────────────────────────────────────────────────────────────────
drop trigger if exists trg_creator_offers_campaign_budget on public.creator_offers;
create trigger trg_creator_offers_campaign_budget
  before insert or update on public.creator_offers
  for each row execute function public.creator_offers_campaign_budget_guard();

-- ─────────────────────────────────────────────────────────────────────
-- 3. Report, never abort — the VALIDATE-equivalent for a trigger.
--    Names any campaign that is ALREADY over budget so a human can look,
--    without failing the migration on legacy data.
-- ─────────────────────────────────────────────────────────────────────
do $$
declare
  bad text;
begin
  select string_agg(
           format('%s (committed %s > budget %s)', t.campaign_id, t.committed, t.total_budget_usd),
           ', '
         )
    into bad
    from (
      select o.campaign_id,
             sum(coalesce(o.agreed_amount_usd, o.current_offer_usd, 0)) as committed,
             c.total_budget_usd
        from public.creator_offers o
        join public.campaigns c on c.id = o.campaign_id
       where o.status = any(array[
               'agreed','human_approval_required','approved','paid','posted','measured'
             ])
         and c.total_budget_usd is not null
         and c.total_budget_usd > 0
       group by o.campaign_id, c.total_budget_usd
      having sum(coalesce(o.agreed_amount_usd, o.current_offer_usd, 0)) > c.total_budget_usd
    ) t;

  if bad is not null then
    raise notice 'trg_creator_offers_campaign_budget installed. ALREADY over budget (not blocked, reductions still allowed): %', bad;
  else
    raise notice 'trg_creator_offers_campaign_budget installed. No existing campaign exceeds its total budget.';
  end if;
end $$;
