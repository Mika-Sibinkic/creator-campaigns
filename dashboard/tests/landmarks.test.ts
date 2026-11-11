// tests/landmarks.test.ts
//
// One <main> per page. AppShell owns it (id="main", the skip link's target);
// SidebarInset is a plain <div>, and pages rendered inside AppShell must not add
// their own. Nested or duplicate <main> landmarks confuse screen-reader
// navigation, and before this test every AppShell page had two.
//
// Run: npx tsx tests/landmarks.test.ts

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

const SRC = join(__dirname, '../src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const mains = (s: string) => s.match(/<main\b/g)?.length ?? 0;

const inset = read('components/ui/sidebar.tsx').match(/function SidebarInset[\s\S]*?\n}\n/)?.[0] ?? '';
assert(inset !== '' && mains(inset) === 0, 'SidebarInset renders a <div>, not a <main>');

const shell = read('components/AppShell.tsx');
const skip = shell.indexOf('href="#main"');
assert(mains(shell) === 1 && shell.includes('<main id="main"'), 'AppShell renders exactly one <main id="main">');
assert(skip > shell.indexOf('<SidebarProvider') && skip < shell.indexOf('<Sidebar '), 'AppShell: the skip link to #main comes before the sidebar, so it is the first tab stop');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : [],
  );
}
const shellPages = walk(join(SRC, 'app')).filter((f) => /import \{[^}]*\bAppShell\b[^}]*\} from/.test(readFileSync(f, 'utf8')));
assert(shellPages.length > 0, 'found the pages that render AppShell');
for (const f of shellPages) {
  assert(mains(readFileSync(f, 'utf8')) === 0, `${relative(SRC, f)}: no <main> of its own inside AppShell`);
}

// Pages outside AppShell (sign-in, onboarding, ...) must bring their own <main>,
// in page.tsx or a component next to it.
const dirTsx = (dir: string) => readdirSync(dir).filter((n) => n.endsWith('.tsx')).map((n) => readFileSync(join(dir, n), 'utf8')).join('\n');
const bareDirs = walk(join(SRC, 'app'))
  .filter((f) => f.endsWith('/page.tsx'))
  .map((f) => join(f, '..'))
  .filter((d) => !/import \{[^}]*\bAppShell\b[^}]*\} from/.test(dirTsx(d)));
for (const d of bareDirs) {
  assert(mains(dirTsx(d)) > 0, `${relative(SRC, d)}/page.tsx: renders a <main> (it has no AppShell)`);
}

console.log(`landmarks test: ${passed} passed, ${failed} failed (${shellPages.length} AppShell pages)`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
