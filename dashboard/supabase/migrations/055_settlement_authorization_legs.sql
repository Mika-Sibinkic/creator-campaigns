-- 055_settlement_authorization_legs.sql
--
-- Let one deal carry TWO payment authorizations, so the split settlement 052
-- describes can actually be executed.
--
-- WHY THIS IS NEEDED AT ALL
--   052 shipped the split as data: `firms.require_delivery_before_balance`,
--   `firms.deposit_pct`, and `creator_offers.deposit_paid_usd` /
--   `balance_paid_usd` / `deliver_by` / `undelivered_at`. What it could not ship
--   was an executor, and the reason is in this table:
--
--     009_onboarding_negotiation_payments.sql:141
--       creator_offer_id UUID NOT NULL UNIQUE REFERENCES creator_offers(id)
--
--   ONE authorization per offer, enforced by the database. A deposit leg and a
--   balance leg cannot both exist as rows, so `authorize-payment.ts` had no
--   choice but to mint the full agreed amount and `settlementLegs()` had no
--   caller. Flipping `require_delivery_before_balance = true` on a firm today
--   changes nothing whatsoever: no code path writes status 'deposit_paid', so
--   `deposit_paid_usd`, `balance_paid_usd`, `deliver_by` and `undelivered_at`
--   stay unset.
--
--   So the split is not half-wired. It has no writers. This migration removes
--   the structural reason for that.
--
-- WHY NOT JUST MUTATE amount_usd FOR LEG 2
--   Because of `human_approval_required_for_execute` (009:174-181): a row may
--   only execute while `status='approved' AND human_approved_at IS NOT NULL`.
--   Reusing the single row for the balance means the balance is paid under the
--   DEPOSIT's human approval — the one guarantee this table exists to provide.
--   Two rows means two approvals, which is the correct shape: a human sees the
--   deposit before the post exists, and sees the balance after it does.
--
-- WHAT amount_usd MEANS NOW
--   Per leg, this is the RESERVED amount. 052's `deposit_paid_usd` /
--   `balance_paid_usd` on creator_offers stay what was actually PAID. Keeping
--   those duties separate is why no new amount column is needed here.
--
-- BACKWARD COMPATIBILITY
--   `leg` defaults to 'full', so every existing row keeps today's
--   exact semantics and the single-authorization path is untouched. A firm with
--   `require_delivery_before_balance = false` continues to mint one 'full' leg
--   forever. Nothing changes for anyone until that flag is turned on.
--
-- `executing_at` exists for a different defect in the same table: the claim to
--   'executing' (execute-payment.ts) is atomic and correct, but if the function
--   dies during the up-to-four provider calls that follow, the row is stranded
--   in 'executing' with NO writer that can move it — and `spend-caps.ts`
--   counts 'executing' as spent, so it burns campaign and monthly budget
--   permanently. Recovery was hand SQL. A timestamp makes a stale claim
--   findable, so a reclaimer can return it to 'approved' (never 'failed' — the
--   human approval already happened and every cap re-runs on retry).
--
-- Additive only. Apply with:
--   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/055_settlement_authorization_legs.sql
--
-- Re-runnable: every statement is IF NOT EXISTS / DROP IF EXISTS guarded.
--
-- Rollback: restores one-authorization-per-offer. Only safe while no offer has
-- two legs — check first with
--   select creator_offer_id, count(*) from payment_authorizations group by 1 having count(*) > 1;
--   drop index if exists payment_authorizations_offer_leg_uq;
--   alter table payment_authorizations
--     add constraint payment_authorizations_creator_offer_id_key unique (creator_offer_id);
--   alter table payment_authorizations drop column if exists leg;
--   alter table payment_authorizations drop column if exists executing_at;

alter table public.payment_authorizations
  add column if not exists leg text not null default 'full';

alter table public.payment_authorizations
  add column if not exists executing_at timestamptz;

comment on column public.payment_authorizations.leg is
  'Which settlement leg this authorization reserves. full = the whole agreed amount (pre-split behaviour, and what a firm with require_delivery_before_balance=false always gets). deposit = paid at agreement. balance = paid after a verified post, on its own human approval. amount_usd is the reserved amount FOR THIS LEG.';

comment on column public.payment_authorizations.executing_at is
  'When this row was claimed for execution. Set with the atomic claim to status=executing so a stale claim (process died mid-provider-call) is findable and reclaimable; spend-caps counts executing as spent, so an unreclaimed row burns budget forever.';

alter table public.payment_authorizations
  drop constraint if exists payment_authorizations_leg_check;

alter table public.payment_authorizations
  add constraint payment_authorizations_leg_check
  check (leg in ('full', 'deposit', 'balance'));

-- Replace one-row-per-offer with one-row-per-(offer, leg). Dropping the
-- constraint drops its backing index, which is intended — the new unique index
-- below supersedes it, and `authorize-payment.ts` upserts on (creator_offer_id,
-- leg) against it.
alter table public.payment_authorizations
  drop constraint if exists payment_authorizations_creator_offer_id_key;

create unique index if not exists payment_authorizations_offer_leg_uq
  on public.payment_authorizations (creator_offer_id, leg);

-- The reclaimer's scan predicate. Partial, because only 'executing' rows are
-- ever candidates and there should never be many.
create index if not exists payment_authorizations_stale_executing_idx
  on public.payment_authorizations (executing_at)
  where status = 'executing';

-- Report, do not abort: name any offer that already carries more than one
-- authorization. There should be none (the UNIQUE made it impossible), so this
-- is here to prove the drop above did not silently admit duplicates on a
-- re-run.
do $$
declare
  dup record;
  n int := 0;
begin
  for dup in
    select creator_offer_id, count(*) as c
    from public.payment_authorizations
    group by creator_offer_id
    having count(*) > 1
  loop
    raise notice '055: offer % already carries % authorizations', dup.creator_offer_id, dup.c;
    n := n + 1;
  end loop;
  if n = 0 then
    raise notice '055: no offer carries duplicate authorizations (expected)';
  end if;
end $$;
