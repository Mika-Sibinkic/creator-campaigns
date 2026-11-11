-- 041_contract_template_approval.sql — contract generator. Additive only.
--
-- Apply with `CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_apply-file.mjs supabase/migrations/041_contract_template_approval.sql`
-- from dashboard/.
--
-- Why: a contract template body can now originate from the template generator
-- rather than being pasted by the firm, so "has a human approved this exact
-- legal text for sending?" has to be a fact the send path can check.
--
-- It was briefly encoded in the body itself — a "DRAFT — ..." header line the
-- reviewer deleted to approve. That fails open. The header contains an em dash
-- (U+2014); a Word/Google Docs round-trip of counsel's redline, or a reviewer
-- retyping the line, rewrites it to a hyphen and the send path stops
-- recognising it. Prose is not a security boundary, so approval is a column
-- set by a deliberate action instead.
--
-- Both columns default to NULL, which is the point: EVERY existing row is
-- un-approved until someone approves it. That includes any tooling-seeded
-- body headed "SAMPLE AGREEMENT — REPLACE WITH YOUR OWN TERMS BEFORE LIVE
-- USE", which must never be shippable to creators.
--
-- UNTIL THIS IS APPLIED the send path fails CLOSED: generateOfferContract
-- cannot read approval state, so it blocks with 'template_not_approved' and
-- attaches no contract. Acceptance emails still send.
--
-- Rollback: alter table public.contract_templates
--             drop column if exists approved_at,
--             drop column if exists approved_by;
--           Both are nullable and additive; dropping rewrites no data. Note
--           that reverting re-opens the SAMPLE template for sending.

alter table public.contract_templates add column if not exists approved_at timestamptz;
alter table public.contract_templates add column if not exists approved_by text;

comment on column public.contract_templates.approved_at is
  'When a human approved this exact body_text for sending to creators. NULL = never approved, and the send path (generateOfferContract) attaches no contract. Cleared automatically on every edit to body_text, so approval always refers to the text as approved, not to the row.';
comment on column public.contract_templates.approved_by is
  'Who approved: ''user:<email>'' from the authenticated session, set server-side only. Never client-supplied.';
