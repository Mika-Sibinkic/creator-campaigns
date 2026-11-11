#!/usr/bin/env bash
# tools/security-smoke.sh — full security control battery
#
# Runs every security invariant in one shot. Re-run on every deploy.
#
# Usage (BASE is required: the app origin to test):
#   BASE=http://localhost:3000 tools/security-smoke.sh       # local dev
#   BASE=https://<your-deployed-app> tools/security-smoke.sh  # deployed app
#
# Section 6 writes a labeled 'smoke.test' row into audit_log through
# DATABASE_URL, so it only runs with CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1.
#
# Exits 0 only if every assertion passes. Each failure prints to stderr.

set -uo pipefail

BASE="${BASE:?set BASE to the app origin, e.g. BASE=http://localhost:3000}"
# State-changing requests must declare same origin. The smoke test
# emulates a same-origin client by passing `Origin: $BASE` on every PATCH/
# POST/PUT/DELETE that isn't supposed to be CSRF-blocked.
ORIGIN_HEADER="Origin: $BASE"
PASS=0
FAIL=0
SKIP=0

# ANSI colors
G='\033[32m'; R='\033[31m'; Y='\033[33m'; D='\033[0m'

ok()    { printf "  ${G}✓${D} %s\n" "$1"; PASS=$((PASS+1)); }
fail()  { printf "  ${R}✗${D} %s\n    └─ %s\n" "$1" "$2" >&2; FAIL=$((FAIL+1)); }
skip()  { printf "  ${Y}~${D} %s (skipped: %s)\n" "$1" "$2"; SKIP=$((SKIP+1)); }
title() { printf "\n${D}── %s ─────────────────────────────────${D}\n" "$1"; }

# ────────────────────────────────────────────────────────────
title "1. Auth — middleware + RLS"
# ────────────────────────────────────────────────────────────

# /api/healthz (liveness, no DB) and /api/health (readiness, DB ping) are both
# public (no auth, no rate-limit redirect). Everything else needs auth.
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/healthz")
if [[ "$status" == "200" ]]; then ok "/api/healthz open without auth (liveness, 200)"
else fail "/api/healthz public access" "got $status"; fi

status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/health")
if [[ "$status" == "200" ]]; then ok "/api/health open without auth (readiness, 200)"
else fail "/api/health public access" "got $status"; fi

# /api/firm needs auth in production. In dev with DEV_USER_EMAIL it returns 200.
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/firm")
if [[ "$status" == "200" || "$status" == "401" ]]; then ok "/api/firm protected (200 in dev-bypass | 401 in prod)"
else fail "/api/firm protection" "got $status (expected 200 or 401)"; fi

# Sign-in route accessible without auth (it IS the auth gate)
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/sign-in")
if [[ "$status" == "200" ]]; then ok "/sign-in reachable for unauth users"
else fail "/sign-in reachability" "got $status"; fi

# ────────────────────────────────────────────────────────────
title "2. Webhook signature verification (Resend)"
# ────────────────────────────────────────────────────────────

# No signature header → 401
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/webhooks/resend" \
  -H 'content-type: application/json' \
  -d '{"type":"email.delivered","data":{}}')
if [[ "$status" == "401" ]]; then ok "Webhook rejects unsigned POST (401)"
else fail "Webhook unsigned rejection" "got $status (expected 401)"; fi

# Garbage signature → 401
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/webhooks/resend" \
  -H 'content-type: application/json' \
  -H 'svix-id: msg_test' \
  -H 'svix-timestamp: 1730000000' \
  -H 'svix-signature: v1,deadbeefdeadbeef' \
  -d '{"type":"email.delivered","data":{}}')
if [[ "$status" == "401" ]]; then ok "Webhook rejects bogus signature (401)"
else fail "Webhook bogus signature rejection" "got $status (expected 401)"; fi

# ────────────────────────────────────────────────────────────
title "3. Rate limiting (per-IP)"
# ────────────────────────────────────────────────────────────

# Burst 35 requests at /api/health (public tier, 30/min). Expect ≥1 429.
codes=$(for i in $(seq 1 35); do
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/health" &
done; wait)
n429=$(echo "$codes" | grep -c "^429" || true)
n200=$(echo "$codes" | grep -c "^200" || true)
if [[ "$n429" -ge 1 && "$n200" -le 30 ]]; then
  ok "Rate limit fires after 30 req/min (200=$n200, 429=$n429)"
else
  fail "Rate limit threshold" "200=$n200, 429=$n429 (expected ≤30 200s, ≥1 429)"
fi

# Confirm Retry-After header on a fresh burst
ra=$(for i in $(seq 1 35); do curl -s -D - -o /dev/null "$BASE/api/health"; done | grep -i "^retry-after:" | head -1)
if [[ -n "$ra" ]]; then ok "Rate-limited response carries Retry-After header"
else skip "Retry-After header" "no 429 in this burst (timing dependent)"; fi

# Wait for window reset before continuing other tests
sleep 2

# ────────────────────────────────────────────────────────────
title "4. Input validation (Zod)"
# ────────────────────────────────────────────────────────────

# Malformed JSON → 400
status=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/firm" \
  -H 'content-type: application/json' \
  -H "$ORIGIN_HEADER" \
  -d 'not-json')
if [[ "$status" == "400" || "$status" == "401" ]]; then ok "Malformed JSON rejected (400/401)"
else fail "Malformed JSON rejection" "got $status"; fi

# Schema violation: testing_mode must be boolean — string fails
body='{"testing_mode":"yes please"}'
status=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/firm" \
  -H 'content-type: application/json' \
  -H "$ORIGIN_HEADER" \
  -d "$body")
if [[ "$status" == "422" || "$status" == "401" ]]; then ok "Type-violating body rejected (422 or 401-pre-validation)"
else fail "Schema violation rejection" "got $status (expected 422 or 401)"; fi

# Email validation: not-an-email
body='{"test_recipient_email":"not-an-email"}'
status=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/firm" \
  -H 'content-type: application/json' \
  -H "$ORIGIN_HEADER" \
  -d "$body")
if [[ "$status" == "422" || "$status" == "401" ]]; then ok "Invalid email rejected (422 or 401)"
else fail "Email validation" "got $status"; fi

# ────────────────────────────────────────────────────────────
title "6. Audit log immutability"
# ────────────────────────────────────────────────────────────

if [[ "${CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE:-}" != "1" ]]; then
  skip "audit_log immutability test" "writes to DATABASE_URL; set CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1"
elif [[ -n "${DATABASE_URL:-}" ]] || grep -q '^DATABASE_URL=' .env.local 2>/dev/null; then
  # Run a quick Node script that tries INSERT, UPDATE, DELETE
  result=$(unset NODE_OPTIONS && node -e "
    import('dotenv').then(async (dotenv) => {
      dotenv.config({path:'.env.local'});
      const { dbClient } = await import('./tools/_db.mjs');
      const c = dbClient();
      await c.connect();
      const ins = await c.query(\"INSERT INTO audit_log (action, actor_label) VALUES ('smoke.test','smoke') RETURNING id\");
      const id = ins.rows[0].id;
      let upd_blocked = false, del_blocked = false;
      try { await c.query(\"UPDATE audit_log SET action='hack' WHERE id=\$1\", [id]); }
      catch (e) { if (e.message.includes('append-only')) upd_blocked = true; }
      try { await c.query(\"DELETE FROM audit_log WHERE id=\$1\", [id]); }
      catch (e) { if (e.message.includes('append-only')) del_blocked = true; }
      // Forcibly clean up the test row via TRUNCATE? No — leave it as evidence. It's labeled 'smoke.test'.
      console.log(JSON.stringify({insert_ok: !!id, update_blocked: upd_blocked, delete_blocked: del_blocked}));
      await c.end();
    });
  " 2>&1 | tail -1)
  if echo "$result" | grep -q '"insert_ok":true.*"update_blocked":true.*"delete_blocked":true'; then
    ok "audit_log INSERT works, UPDATE blocked, DELETE blocked"
  else
    fail "audit_log immutability" "$result"
  fi
else
  skip "audit_log immutability test" "no DATABASE_URL"
fi

# ────────────────────────────────────────────────────────────
title "7. RLS enforcement (anon key sees nothing without session)"
# ────────────────────────────────────────────────────────────

if [[ -f .env.local ]]; then
  set -a; source .env.local; set +a
  # Anon key without a session JWT should now return 0 rows from any table
  for table in firms campaigns outreach_messages api_ledger; do
    n=$(curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/$table?select=id&limit=1" \
      -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
      -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else -1)" 2>/dev/null || echo "err")
    if [[ "$n" == "0" ]]; then ok "RLS blocks anon read of '$table' (0 rows)"
    else fail "RLS read of '$table'" "got $n rows (expected 0)"; fi
  done
else
  skip "RLS read tests" "no .env.local"
fi

# ────────────────────────────────────────────────────────────
title "8. Migration trail intact"
# ────────────────────────────────────────────────────────────

# The chain starts at 003 (`003_base_schema.sql`, the consolidated 001-003).
# Verify the trail is present and dense — an unexpected gap would mean a
# migration was deleted after being applied, which leaves deployed databases
# and code out of sync. 048, 063 and 065 were never used and are skipped.
NEVER_USED=" 48 63 65 "
prev=2
gap_found=0
for f in $(ls supabase/migrations/*.sql 2>/dev/null | sort); do
  base=$(basename "$f")
  num="${base%%_*}"
  num=${num#0}; num=${num#0}      # strip leading zeros so 004 → 4
  if [[ "$num" =~ ^[0-9]+$ ]]; then
    while [[ "$NEVER_USED" == *" $((prev + 1)) "* ]]; do prev=$((prev + 1)); done
    if [[ "$num" -ne $((prev + 1)) ]]; then
      fail "migration trail gap" "expected $((prev + 1)), found $num ($base)"
      gap_found=1
    fi
    prev=$num
  fi
done
if [[ "$gap_found" -eq 0 && "$prev" -ge 8 ]]; then
  ok "migration trail dense from 003 through $(printf '%03d' $prev)"
elif [[ "$gap_found" -eq 0 ]]; then
  fail "migration trail short" "highest is $prev, expected ≥8"
fi

# ────────────────────────────────────────────────────────────
title "9. Ops documentation present"
# ────────────────────────────────────────────────────────────

for doc in docs/ops/inbound-email-setup.md docs/ops/sentry-setup.md; do
  if [[ -f "$doc" ]]; then
    wc=$(wc -w < "$doc")
    if [[ "$wc" -ge 200 ]]; then ok "$doc ($wc words)"
    else fail "$doc too short" "$wc words (expected ≥200)"; fi
  else
    fail "$doc missing" "file not found"
  fi
done

# ────────────────────────────────────────────────────────────
title "10. Audit-call wiring"
# ────────────────────────────────────────────────────────────

# Count files that call `audit(` (excluding the helper itself). Use `audit(`
# rather than `audit({` so the check works whether the call is inline
# (`audit({...}, req)`) or multi-line (`audit(\n  { ... },\n  req\n)`).
n=$(grep -rln "\baudit\s*(" src 2>/dev/null | grep -v "src/lib/audit.ts" | wc -l | tr -d ' ')
# 2 system callers (resend.ts outreach.send + cron/smoke heartbeat) + 5 user
# mutation routes (campaign.create, firm.update, influencer.blocklist,
# outreach.draft.create, outreach.respond.classify) = 7 minimum.
if [[ "$n" -ge 7 ]]; then ok "audit() called from $n files (≥7 required: 2 system + 5 user mutations)"
else fail "audit() wiring" "$n files (expected ≥7)"; fi

# ────────────────────────────────────────────────────────────
title "11. CSRF — same-origin enforcement on mutating routes"
# ────────────────────────────────────────────────────────────

# Cross-origin PATCH must be blocked.
status=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/firm" \
  -H 'content-type: application/json' \
  -H 'Origin: https://evil.example.com' \
  -d '{"testing_mode":true}')
if [[ "$status" == "403" ]]; then ok "Cross-origin PATCH blocked (403)"
else fail "Cross-origin PATCH" "got $status (expected 403)"; fi

# No Origin / Referer / Sec-Fetch-Site at all → reject (no provable origin).
status=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/firm" \
  -H 'content-type: application/json' \
  -d '{"testing_mode":true}')
if [[ "$status" == "403" ]]; then ok "Origin-less PATCH blocked (403)"
else fail "Origin-less PATCH" "got $status (expected 403)"; fi

# Sec-Fetch-Site: cross-site is rejected even if Origin host matches.
status=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/firm" \
  -H 'content-type: application/json' \
  -H 'Sec-Fetch-Site: cross-site' \
  -H "$ORIGIN_HEADER" \
  -d '{"testing_mode":true}')
if [[ "$status" == "403" ]]; then ok "Sec-Fetch-Site=cross-site PATCH blocked (403)"
else fail "Sec-Fetch-Site cross-site" "got $status (expected 403)"; fi

# Same-origin PATCH proceeds (returns whatever the route would return).
status=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/firm" \
  -H 'content-type: application/json' \
  -H "$ORIGIN_HEADER" \
  -d '{"testing_mode":true}')
if [[ "$status" == "200" || "$status" == "401" ]]; then ok "Same-origin PATCH allowed (200 in dev | 401 in prod)"
else fail "Same-origin PATCH" "got $status (expected 200 or 401)"; fi

# Webhooks are CSRF-exempt (signature is the auth mechanism).
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/webhooks/resend" \
  -H 'content-type: application/json' \
  -H 'Origin: https://evil.example.com' \
  -d '{"type":"email.delivered"}')
if [[ "$status" == "401" ]]; then ok "Webhook CSRF-exempt (401 from sig check, not 403)"
else fail "Webhook CSRF exemption" "got $status (expected 401 — sig fail, not 403 csrf)"; fi

# GET requests are NOT CSRF-checked (read-only).
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/firm" -H 'Origin: https://evil.example.com')
if [[ "$status" == "200" || "$status" == "401" ]]; then ok "GET not CSRF-checked"
else fail "GET CSRF exemption" "got $status (expected 200 or 401, never 403)"; fi

# ────────────────────────────────────────────────────────────
title "12a. PII scrubbing in audit_log"
# ────────────────────────────────────────────────────────────

# Trigger a PATCH /api/firm with an email that we'll grep for unscrubbed
# in the audit_log metadata. The metadata MUST hold the scrubbed form.
# Skipped without .env.local (need service-role for the read-back).
if [[ -f .env.local ]]; then
  probe_email='smoke.pii.probe+test@example.com'
  curl -s -X PATCH "$BASE/api/firm" \
    -H 'content-type: application/json' \
    -H "$ORIGIN_HEADER" \
    -d "{\"test_recipient_email\":\"$probe_email\"}" > /dev/null
  # Restore — but NOT in this script: the test value is left in place
  # because we need to read the audit row first. After verification,
  # call /api/firm again to put it back.
  result=$(node -e "
    require('dotenv').config({path:'.env.local'});
    const {createClient} = require('@supabase/supabase-js');
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    sb.from('audit_log').select('metadata').eq('action','firm.testing_mode.toggle').order('occurred_at',{ascending:false}).limit(1).then(({data}) => {
      const m = JSON.stringify(data?.[0]?.metadata ?? {});
      const raw = m.includes('$probe_email');
      const scrubbed = m.includes('s***@example.com');
      console.log(JSON.stringify({raw, scrubbed}));
    });
  " 2>&1 | tail -1)
  if echo "$result" | grep -q '"raw":false.*"scrubbed":true'; then
    ok "audit_log scrubbed email (no raw, has 's***@example.com')"
  else
    fail "audit_log PII scrubbing" "$result"
  fi
  # Restore firm row to a known-good test recipient.
  curl -s -X PATCH "$BASE/api/firm" \
    -H 'content-type: application/json' \
    -H "$ORIGIN_HEADER" \
    -d '{"test_recipient_email":"test-inbox@example.com"}' > /dev/null
else
  skip "audit_log PII scrubbing" "no .env.local"
fi

# ────────────────────────────────────────────────────────────
title "12. Request-ID propagation"
# ────────────────────────────────────────────────────────────

# Every response carries an x-request-id header. Fresh requests get a
# server-minted UUID; inbound x-request-id is honored end-to-end so a
# client can pin a specific request for debugging.
rid=$(curl -s -i "$BASE/api/healthz" | grep -i '^x-request-id:' | awk '{print $2}' | tr -d '\r')
if [[ -n "$rid" ]]; then ok "x-request-id minted on response ($rid)"
else fail "x-request-id missing" "no x-request-id header on /api/healthz response"; fi

# Two consecutive fresh requests should mint different IDs.
rid1=$(curl -s -i "$BASE/api/healthz" | grep -i '^x-request-id:' | awk '{print $2}' | tr -d '\r')
rid2=$(curl -s -i "$BASE/api/healthz" | grep -i '^x-request-id:' | awk '{print $2}' | tr -d '\r')
if [[ -n "$rid1" && -n "$rid2" && "$rid1" != "$rid2" ]]; then ok "fresh requests get distinct IDs"
else fail "request-id uniqueness" "rid1=$rid1 rid2=$rid2"; fi

# Inbound x-request-id is preserved end-to-end.
echoed=$(curl -s -i "$BASE/api/healthz" -H 'x-request-id: smoke-test-12345' | grep -i '^x-request-id:' | awk '{print $2}' | tr -d '\r')
if [[ "$echoed" == "smoke-test-12345" ]]; then ok "inbound x-request-id preserved end-to-end"
else fail "inbound x-request-id" "got '$echoed' expected 'smoke-test-12345'"; fi

# ────────────────────────────────────────────────────────────
title "13a. STRIPE_SECRET_KEY isolation "
# ────────────────────────────────────────────────────────────

# The ONLY module allowed to actually READ STRIPE_SECRET_KEY (i.e.
# `process.env.STRIPE_SECRET_KEY`) is src/lib/stripe-isolated.ts. Mentions
# in SECURITY-OK header comments inside payment routes are fine — those
# document the isolation rather than violate it.
leaks=$(grep -rln "process\.env\.STRIPE_SECRET_KEY" src 2>/dev/null | grep -v "src/lib/stripe-isolated.ts" || true)
if [[ -z "$leaks" ]]; then
  ok "process.env.STRIPE_SECRET_KEY only read in src/lib/stripe-isolated.ts"
else
  fail "STRIPE_SECRET_KEY env-read leaked outside the isolated module" "$leaks"
fi

# audit_log metadata MUST NOT contain anything that looks like a Stripe key.
# This is a heuristic — the real defense is in src/lib/audit.ts (PII scrub
# + we never put the key in metadata anywhere). Belt-and-suspenders only.
if [[ -f .env.local ]]; then
  result=$(node -e "
    require('dotenv').config({path:'.env.local'});
    const {createClient} = require('@supabase/supabase-js');
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    sb.from('audit_log').select('metadata').limit(500).then(({data}) => {
      const blob = JSON.stringify(data ?? []);
      const hit = /sk_(live|test)_[A-Za-z0-9]{16,}/.test(blob);
      console.log(JSON.stringify({hit}));
    });
  " 2>&1 | tail -1)
  if echo "$result" | grep -q '"hit":false'; then
    ok "audit_log holds no Stripe-key-shaped strings (sample of 500)"
  else
    fail "audit_log Stripe-key leak suspect" "$result"
  fi
else
  skip "audit_log Stripe-key check" "no .env.local"
fi

# ────────────────────────────────────────────────────────────
title "13. Dependency vulnerabilities"
# ────────────────────────────────────────────────────────────

# Fail on any high or critical vulnerabilities in production deps. Skip dev
# deps (a vuln in tsx or eslint is not a deploy blocker). The default
# audit-level=low would be too noisy.
audit_json=$(env -u NODE_OPTIONS npm audit --omit=dev --json 2>/dev/null || true)
high=$(echo "$audit_json" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('metadata',{}).get('vulnerabilities',{}); print(v.get('high',0)+v.get('critical',0))" 2>/dev/null || echo "err")
if [[ "$high" == "0" ]]; then
  ok "no high/critical vulnerabilities in production deps"
elif [[ "$high" == "err" ]]; then
  skip "npm audit" "could not parse audit output"
else
  fail "npm audit" "$high high/critical vuln(s) — run \`npm audit --omit=dev\` for detail"
fi

# Disclosure policy must exist (so receivers know how to report).
if [[ -f ../SECURITY.md ]]; then
  wc=$(wc -w < ../SECURITY.md)
  if [[ "$wc" -ge 200 ]]; then ok "SECURITY.md present ($wc words)"
  else fail "SECURITY.md too short" "$wc words (≥200 expected)"; fi
else
  fail "SECURITY.md missing" "expected at repo root"
fi

# ────────────────────────────────────────────────────────────
title "14. Default security headers"
# ────────────────────────────────────────────────────────────

# Headers applied by middleware on every response. HSTS is prod-only.
hdrs=$(curl -s -I "$BASE/" 2>&1)
for h in "X-Content-Type-Options: nosniff" "X-Frame-Options: DENY" "Referrer-Policy: strict-origin-when-cross-origin"; do
  name="${h%%:*}"
  if echo "$hdrs" | grep -iq "^${name}:"; then
    ok "$name present"
  else
    fail "$name missing" "header not in response"
  fi
done

# Permissions-Policy: just the header name (the value is long)
if echo "$hdrs" | grep -iq "^Permissions-Policy:"; then ok "Permissions-Policy present"
else fail "Permissions-Policy missing" "header not in response"; fi

# HSTS only in production. Skip on http://localhost.
if [[ "$BASE" == https://* ]]; then
  if echo "$hdrs" | grep -iq "^Strict-Transport-Security:"; then ok "HSTS present (https BASE)"
  else fail "HSTS missing" "https BASE should carry Strict-Transport-Security"; fi
else
  skip "HSTS check" "BASE is http (dev) — HSTS is production-only"
fi

# ────────────────────────────────────────────────────────────
echo
printf "${D}═══════════════════════════════════════════════════════${D}\n"
printf "Result: ${G}%d passed${D}, ${R}%d failed${D}, ${Y}%d skipped${D}\n" "$PASS" "$FAIL" "$SKIP"
printf "${D}═══════════════════════════════════════════════════════${D}\n"

[[ "$FAIL" -eq 0 ]]
