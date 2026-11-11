-- 051_campaign_material_sharing.sql
--
-- Per-file control over what gets emailed to a creator.
--
-- WHY
--   The campaign-materials card is the ONLY file input in the product, and the
--   post-payment promo mailer attached every row it held, unconditionally.
--   `application/pdf` is on the upload allowlist, so a label that read "upload
--   your materials" as "upload your contract" would have mailed that contract
--   to every creator it paid — one row at a time, silently, on the money path.
--
--   src/lib/promo-materials.ts already fails closed without this column:
--   audio/video/image are attached, everything else is not. This column lets a
--   label say otherwise per file — a PDF one-sheet IS legitimate promo material
--   and should be sendable, a PDF contract is not and must not be.
--
-- NULL means "use the content-type default", which is why there is no NOT NULL
-- and no backfill: every existing row keeps behaving the way the code now
-- decides, and only a deliberate choice overrides it.
ALTER TABLE public.campaign_materials
  ADD COLUMN IF NOT EXISTS share_with_creators boolean;

COMMENT ON COLUMN public.campaign_materials.share_with_creators IS
  'Attach this file to the post-payment email to creators. NULL = decide from content_type (audio/video/image yes, anything else no). Set false on a document you uploaded for your own reference.';
