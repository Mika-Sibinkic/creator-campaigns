// tools/_guard.mjs — one gate in front of every script that writes to the database.
//
// WHY THIS EXISTS
//   The tools connect to whatever DATABASE_URL (or .env.local) points at, and
//   that is often a real deployment. So a script in tools/ is not a
//   development tool that happens to touch data — it is a database write with
//   a friendly filename. Fabricated outreach, offers or replies written into a
//   real (synthetic = false) campaign pass the RL history filter and feed real
//   pricing.
//
//   Tab-completing a filename must not be enough to do that.
//
// USAGE
//   import { requireProdWriteConsent } from './_guard.mjs';
//   requireProdWriteConsent({
//     tool: 'my-script',
//     writes: ['outreach_messages', 'creator_offers', 'inbound_messages'],
//     target: 'the campaign id you pass',
//   });
//
// The gate is a single env var, deliberately: it must be impossible to satisfy
// by accident, and obvious in shell history afterwards.
//
//   CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 node tools/<script>.mjs

/**
 * @param {{ tool: string, writes?: string[], target?: string }} opts
 * @returns {void}
 */
export function requireProdWriteConsent({ tool, writes = [], target = '' }) {
  if (process.env.CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE === '1') return;

  const lines = [
    '',
    `REFUSING TO RUN: ${tool}`,
    '',
    '  This script writes to the database in DATABASE_URL / .env.local.',
  ];
  if (writes.length > 0) {
    lines.push(`  Tables it writes: ${writes.join(', ')}`);
  }
  if (target) {
    lines.push(`  Target: ${target}`);
  }
  lines.push(
    '',
    '  If that is genuinely what you want:',
    `    CREATOR_CAMPAIGNS_ALLOW_PROD_WRITE=1 <the command you just ran>`,
    '',
  );
  console.error(lines.join('\n'));
  process.exit(1);
}
