-- 054_budget_guard_split_states.sql
--
-- Teach the campaign-budget guard about the split-settlement states.
--
-- WHY THIS IS URGENT AND NOT COSMETIC
--   Migration 045 enforces `campaigns.total_budget_usd` in a trigger, over a
--   hardcoded list of committed statuses. Migration 052 added `deposit_paid`,
--   `balance_paid` and `undelivered` to the app's state machine and did NOT
--   update that list — so a deal sitting in any of them dropped out of the
--   committed sum, the campaign looked cheaper than it was, and the ceiling
--   would have admitted deals it could not afford. The structural guard is the
--   one that is supposed to be impossible to get around, so silently falling out
--   of it is the worst shape this bug could take.
--
--   Caught by tests/campaign-budget-migration.test.ts, which asserts the SQL
--   list is byte-identical to COMMITTED_STATES in src/lib/negotiation.ts. That
--   test earned its keep.
--
-- THE AMOUNT FOLD CHANGES TOO, and this is the substantive decision
--   An `undelivered` deal contributes only the DEPOSIT that actually left, not
--   the agreed amount. The balance was never sent; counting it would hold budget
--   the label never spent, permanently, against a ceiling that would then refuse
--   deals they can genuinely afford. Reclaiming that headroom is part of what the
--   split is for. Mirrored exactly by `committedContribution()` in
--   src/lib/negotiation.ts.
--
-- SELF-CONTAINED ON PURPOSE. It re-attaches the trigger rather than relying on
-- 045's binding: a function-only patch applied to a database where 045 never
-- landed would leave the guard defined and bound to nothing, i.e. no budget
-- ceiling at all, silently. Re-runnable throughout (CREATE OR REPLACE on the
-- function, DROP TRIGGER IF EXISTS before CREATE TRIGGER).
--
-- Additive only. Apply with:
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/054_budget_guard_split_states.sql
--
-- Rollback: restore 045's narrower list by re-applying it:
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/045_campaign_budget_structural.sql
-- Or remove the guard entirely:
--   drop trigger if exists trg_creator_offers_campaign_budget on public.creator_offers;
--   drop function if exists public.creator_offers_campaign_budget_guard();

create or replace function public.creator_offers_campaign_budget_guard()
returns trigger as $$
declare
  committed_states text[] := array[
    'agreed','human_approval_required','approved','paid',
    'deposit_paid','posted','balance_paid','measured','undelivered'
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
    new_contrib := case
      when NEW.status = 'undelivered' then coalesce(NEW.deposit_paid_usd, 0)
      else coalesce(NEW.agreed_amount_usd, NEW.current_offer_usd, 0)
    end;
  end if;

  if TG_OP = 'UPDATE' and OLD.status = any(committed_states) then
    old_contrib := case
      when OLD.status = 'undelivered' then coalesce(OLD.deposit_paid_usd, 0)
      else coalesce(OLD.agreed_amount_usd, OLD.current_offer_usd, 0)
    end;
  end if;

  -- Never block a write that does not increase committed spend: leaving a
  -- committed state, lowering an amount, or any unrelated column update. This is
  -- also why the expiry sweeper can always write `undelivered` — it lowers the
  -- contribution from the agreed amount to the deposit, so it can never be
  -- refused by this guard even on a campaign that is already over budget.
  if new_contrib <= old_contrib then
    return NEW;
  end if;

  -- Serialize writers for this campaign. Without this the check below is still a
  -- read-then-write and the race stays open.
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

  select coalesce(sum(
           case
             when o.status = 'undelivered' then coalesce(o.deposit_paid_usd, 0)
             else coalesce(o.agreed_amount_usd, o.current_offer_usd, 0)
           end
         ), 0)
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
  'Rejects any creator_offers write that would push a campaign''s committed spend past campaigns.total_budget_usd. Committed states and the amount fold match COMMITTED_STATES / committedContribution in src/lib/negotiation.ts — an undelivered deal contributes only the deposit that actually left. Takes a per-campaign advisory lock so concurrent negotiation ticks serialize.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Re-attach it. Same name and shape as 045, so applying this file is
--    sufficient on its own.
-- ─────────────────────────────────────────────────────────────────────
drop trigger if exists trg_creator_offers_campaign_budget on public.creator_offers;
create trigger trg_creator_offers_campaign_budget
  before insert or update on public.creator_offers
  for each row execute function public.creator_offers_campaign_budget_guard();

-- ─────────────────────────────────────────────────────────────────────
-- 3. Report, never abort. Re-run under the NEW fold, because widening the
--    committed-state list can surface campaigns that were already over budget
--    and invisible — which is the whole reason this migration exists. A human
--    should see them; failing the migration on legacy data should not happen.
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
             sum(
               case
                 when o.status = 'undelivered' then coalesce(o.deposit_paid_usd, 0)
                 else coalesce(o.agreed_amount_usd, o.current_offer_usd, 0)
               end
             ) as committed,
             c.total_budget_usd
        from public.creator_offers o
        join public.campaigns c on c.id = o.campaign_id
       where o.status = any(array[
               'agreed','human_approval_required','approved','paid',
               'deposit_paid','posted','balance_paid','measured','undelivered'
             ])
         and c.total_budget_usd is not null
         and c.total_budget_usd > 0
       group by o.campaign_id, c.total_budget_usd
      having sum(
               case
                 when o.status = 'undelivered' then coalesce(o.deposit_paid_usd, 0)
                 else coalesce(o.agreed_amount_usd, o.current_offer_usd, 0)
               end
             ) > c.total_budget_usd
    ) t;

  if bad is not null then
    raise notice 'trg_creator_offers_campaign_budget re-installed with the split-settlement states. ALREADY over budget (not blocked, reductions still allowed): %', bad;
  else
    raise notice 'trg_creator_offers_campaign_budget re-installed with the split-settlement states. No campaign is over budget.';
  end if;
end $$;
