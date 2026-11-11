// tools/_db.mjs — the one Postgres connection the tools use: DATABASE_URL.
//
// DATABASE_URL is a plain Postgres connection string. `supabase status` prints
// the local one; a hosted project shows its own under Database settings.
import pg from 'pg';

/** @returns {import('pg').Client} */
export function dbClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required (a Postgres connection string; `supabase status` prints the local one).');
    process.exit(1);
  }
  // Local Postgres from `supabase start` has no TLS. Hosted Postgres keeps TLS
  // without CA pinning. An sslmode in the URL itself overrides both.
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
  return new pg.Client({ connectionString, ssl: local ? false : { rejectUnauthorized: false } });
}
