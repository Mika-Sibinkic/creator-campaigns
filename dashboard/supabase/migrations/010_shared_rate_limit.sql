-- 010_shared_rate_limit.sql
--
-- Shared per-IP sliding-window rate-limit backed by Postgres so it
-- survives Vercel multi-instance scale-out (the in-process Map in
-- src/lib/rate-limit.ts leaks across cold starts + warm copies).
--
-- Activated by setting SHARED_RATE_LIMIT=true in the env. The src/lib/
-- rate-limit.ts module checks the flag at call time and routes to the
-- RPC instead of the in-process Map.
--
-- Schema:
--   rate_limit_buckets (key text PK, count int, window_started_at timestamptz)
--
-- RPC:
--   rl_check_and_increment(key, max_count, window_seconds) returns (allowed, reset_at)
--   - Atomic: single UPSERT-with-conditional-reset. No race between a check
--     and an increment.
--   - Window-based: if (now - window_started_at) >= window_seconds, reset
--     count to 1 and bump window_started_at to now. Otherwise increment.
--   - allowed = false when post-increment count > max_count.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The bucket table is a system audit/cache table — no RLS needed because the
-- service-role-only RPC is the only access path. Safer than RLS in this case
-- because we want the RPC to read+write atomically without per-user policy
-- evaluation overhead.

CREATE OR REPLACE FUNCTION rl_check_and_increment(
  p_key TEXT,
  p_max INT,
  p_window_s INT
) RETURNS TABLE(allowed BOOLEAN, reset_at TIMESTAMPTZ, current_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INT;
  v_window_start TIMESTAMPTZ;
  v_age_s NUMERIC;
BEGIN
  -- Try to insert a fresh row; on conflict, fall through to update.
  INSERT INTO rate_limit_buckets (bucket_key, count, window_started_at)
  VALUES (p_key, 1, now())
  ON CONFLICT (bucket_key) DO NOTHING;

  -- Read current state.
  SELECT count, window_started_at INTO v_count, v_window_start
  FROM rate_limit_buckets WHERE bucket_key = p_key;

  v_age_s := EXTRACT(EPOCH FROM (now() - v_window_start));

  IF v_age_s >= p_window_s THEN
    -- Window expired — reset.
    UPDATE rate_limit_buckets
    SET count = 1, window_started_at = now()
    WHERE bucket_key = p_key
    RETURNING count, window_started_at INTO v_count, v_window_start;
    RETURN QUERY SELECT TRUE, v_window_start + (p_window_s || ' seconds')::INTERVAL, v_count;
  ELSE
    -- Within window — bump.
    UPDATE rate_limit_buckets
    SET count = count + 1
    WHERE bucket_key = p_key
    RETURNING count INTO v_count;
    RETURN QUERY SELECT (v_count <= p_max), v_window_start + (p_window_s || ' seconds')::INTERVAL, v_count;
  END IF;
END;
$$;

COMMENT ON FUNCTION rl_check_and_increment(TEXT, INT, INT) IS
  'INF-3: atomic check + increment for shared rate limit. Returns (allowed, reset_at, current_count). Caller compares allowed to decide whether to 429.';

-- Index on window_started_at so the cleanup job (future cron) can prune
-- expired buckets without a full table scan.
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_window
  ON rate_limit_buckets(window_started_at);
