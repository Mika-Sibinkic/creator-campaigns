-- Clerk migration follow-through: approver identity columns must hold Clerk ids.
--
-- payment_authorizations.human_approved_by_user_id and
-- creator_offers.approved_by_user_id were created as UUID (migration 009) for
-- Supabase-auth ids. Clerk session ids are `user_...` strings, so every
-- approve since the Clerk migration failed with
-- "invalid input syntax for type uuid", so the Approve button could not
-- work. Same bug class already fixed in code for audit_log;
-- here we widen the columns instead, because approver identity on the money
-- path must be persisted, not dropped.
--
-- Type widening only (uuid -> text), no data change; existing uuid values
-- cast losslessly. The human_approval_required_for_execute CHECK only tests
-- NULLness of these columns, so it is unaffected.

alter table public.payment_authorizations
  alter column human_approved_by_user_id type text
  using human_approved_by_user_id::text;

alter table public.creator_offers
  alter column approved_by_user_id type text
  using approved_by_user_id::text;

comment on column public.payment_authorizations.human_approved_by_user_id is
  'Auth-provider user id of the human approver (Clerk `user_...` string; pre-Clerk rows hold uuid text).';
comment on column public.creator_offers.approved_by_user_id is
  'Auth-provider user id of the human approver (Clerk `user_...` string; pre-Clerk rows hold uuid text).';
