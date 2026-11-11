// tools/run-all-tests.mjs
//
// `npm test`, locally and in CI: run every tests/*.test.ts plus the negotiation
// harness, one tsx process each, and report which failed. A new suite is picked
// up by its file name; nothing else lists them.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// tsx is a devDependency; this throws "Cannot find module" until `npm ci` ran.
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const suites = [
  ...readdirSync(new URL('../tests', import.meta.url))
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map((f) => `tests/${f}`),
  'tests/negotiation-harness/run.ts',
];

const failed = [];
for (const file of suites) {
  const name = file.replace(/^tests\//, '').replace(/\.test\.ts$/, '');
  try {
    const out = execFileSync(process.execPath, [tsxCli, file], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`PASS  ${name.padEnd(36)} ${out.trim().split('\n').pop() ?? ''}`);
  } catch (err) {
    failed.push(name);
    console.log(`FAIL  ${name}`);
    const body = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message;
    console.log(body.split('\n').slice(-14).join('\n'));
  }
}

console.log(`\n${suites.length} suites, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
