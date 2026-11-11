// Installs pg_cron + pg_net and schedules the Creator Campaigns ticks from Postgres.
// The bearer token is stored in Supabase Vault and read back by the job at run
// time, so the secret never appears in a cron command, a shell argument, or a
// transcript.
//
// USAGE (from dashboard/, with DATABASE_URL, NEXT_PUBLIC_APP_URL and CRON_SECRET set):
//   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/_pgcron-setup.mjs
import { config } from 'dotenv';

import { dbClient } from './_db.mjs';

import { requireProdWriteConsent } from './_guard.mjs';
requireProdWriteConsent({
  tool: '_pgcron-setup',
  writes: ['cron.job', 'vault.secrets'],
  target: 'the pg_cron scheduler and Vault secrets in DATABASE_URL',
});
config({ path: '.env.local' });

const BASE = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(BASE) || /localhost|127\.0\.0\.1|example\.|your-|REPLACE|TODO/i.test(BASE)) {
  console.error(`NEXT_PUBLIC_APP_URL must be the deployed https origin of the app (got "${BASE}")`);
  process.exit(1);
}
if (!process.env.CRON_SECRET) {
  console.error('CRON_SECRET is required (the bearer token the tick endpoints check).');
  process.exit(1);
}
const c = dbClient();
const SECRET_NAME = 'creator_campaigns_cron_secret';

// pg_net defaults to a 5000 ms timeout. A tick with actual work to do makes
// LLM calls and routinely runs longer than that, and a timed-out request is
// abandoned mid-flight — so the default silently drops exactly the ticks that
// matter. 60 s covers a full inbound batch with headroom.
//
// GET, not POST: /api/measurement/tick is GET-only (POST returns 405), and
// /api/negotiation/tick's POST handler just delegates to its GET handler.
const job = (path) => `
  select net.http_get(
    url                  := '${BASE}${path}',
    headers              := jsonb_build_object(
                              'Authorization', 'Bearer ' || (select decrypted_secret
                                                               from vault.decrypted_secrets
                                                              where name = '${SECRET_NAME}')),
    timeout_milliseconds := 60000
  );`;

const step = async (label, sql, params) => {
  try {
    const r = await c.query(sql, params);
    console.log(`ok   ${label}` + (r.rows?.length ? ` -> ${JSON.stringify(r.rows[0])}` : ''));
    return r;
  } catch (e) {
    console.log(`FAIL ${label}: ${e.message}`);
    return null;
  }
};

await c.connect();
await step('create extension pg_net', 'create extension if not exists pg_net with schema extensions');
await step('create extension pg_cron', 'create extension if not exists pg_cron');

// Vault: replace any prior copy so re-runs are idempotent.
await step('drop old vault secret', `delete from vault.secrets where name = '${SECRET_NAME}'`);
await step('store cron secret in vault',
  'select vault.create_secret($1, $2, $3) as id',
  [process.env.CRON_SECRET, SECRET_NAME, 'Bearer token for Creator Campaigns tick endpoints']);

// pg_cron is the scheduler. Anything that must run belongs in THIS list (and in
// src/lib/cron-paths.ts).
for (const [name, sched, path] of [
  ['creator-campaigns-negotiation-tick', '*/5 * * * *', '/api/negotiation/tick'],
  ['creator-campaigns-measurement-tick', '17 * * * *', '/api/measurement/tick'],
  // EVERY MINUTE, deliberately. send_after is only honoured by the dispatch
  // pass, so while that pass rode the five-minute negotiation tick the
  // per-message reply delay was swallowed whole: actual latency was 0-5 min
  // regardless of what was computed, and every reply scheduled in one tick left
  // in the same batch on the beat. Four queries, no model calls.
  ['creator-campaigns-dispatch', '* * * * *', '/api/negotiation/dispatch'],
  // Contact enrichment: harvests creator addresses already sitting in scraped
  // bios. Never calls Apify, cannot spend scraper credit. Offset off the hour so
  // it does not contend with the measurement tick.
  ['creator-campaigns-enrichment-tick', '37 * * * *', '/api/enrichment/tick'],
]) {
  await step(`unschedule ${name}`, `select cron.unschedule('${name}')`);
  await step(`schedule ${name}`, `select cron.schedule($1, $2, $3) as jobid`, [name, sched, job(path)]);
}

const jobs = await step('list jobs', `select jobid, jobname, schedule, active from cron.job order by jobid`);
if (jobs) for (const r of jobs.rows) console.log('   ', r.jobid, r.jobname, r.schedule, 'active=' + r.active);
await c.end();
