-- Local demo data, loaded by `supabase db reset` after the migrations.
-- One firm, so the DEV_USER_EMAIL local bypass has exactly one firm to resolve.
-- Testing mode is on, so every outbound message goes to the test inbox below.

INSERT INTO public.firms (id, name, testing_mode, test_recipient_email)
VALUES (
  '00000000-0000-4000-8000-0000000000f1',
  '[SAMPLE] Example Records',
  true,
  'test-inbox@example.com'
)
ON CONFLICT (id) DO NOTHING;
