// tests/no-em-dash.test.ts
//
// House rule: no em dashes in anything a creator reads.
// Creators read them as AI-written. Three layers are pinned here:
//
//   1. stripEmDashes(), the post-processing every model-written outbound
//      text passes through before it is validated and stored.
//   2. The real generator paths: a first-touch draft and a contract template
//      whose model output carries an em dash come back without one, and clean
//      copy is kept rather than degraded to the fallback.
//   3. A source scan: no string literal in the outbound-copy and prompt
//      modules contains U+2014, so neither a hardcoded template nor a prompt
//      (which models imitate) can reintroduce one.
//
// Hermetic: registered mock provider, no network, no DB.
//
// Run: npx tsx tests/no-em-dash.test.ts

process.env.MODEL_PROVIDER = 'mock-em-dash';
process.env.MODEL_FALLBACK_CHAIN = '';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { registerProvider } from '../src/lib/model-provider';
import { stripEmDashes } from '../src/lib/no-em-dash';
import { generateOutreachDraft, type DraftPersonalizationInput } from '../src/lib/openai';
import { DRAFT_TEMPLATE_HEADER, looksLikeDraftHeader } from '../src/lib/contracts';
import { BASE_CONTRACT_TEMPLATE, normalizeGeneratedTemplate } from '../src/lib/contract-generator';

const EM = '—';

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

// ── 1. stripEmDashes ────────────────────────────────────────────────────────
function unit() {
  const cases: Array<[string, string, string]> = [
    [`Loved the clip ${EM} it fits the song.`, 'Loved the clip, it fits the song.', 'spaced dash → comma'],
    [`word${EM}word`, 'word, word', 'unspaced dash → comma'],
    [`${EM} Example Records`, 'Example Records', 'leading sign-off dash dropped'],
    [`Thanks,\n${EM} Alex`, 'Thanks,\nAlex', 'sign-off dash on its own line dropped'],
    [`Talk soon ${EM}\nOwen`, 'Talk soon\nOwen', 'trailing dash at line end dropped'],
    [`We pay $150 ${EM}.`, 'We pay $150.', 'dash before a full stop collapses'],
    [`Great, ${EM} thanks`, 'Great, thanks', 'no double comma'],
    [`You're all set ${EM} Ada Sample promo pack on its way`, "You're all set, Ada Sample promo pack on its way", 'promo subject shape'],
    ['A 2–3 week window, no dash here.', 'A 2–3 week window, no dash here.', 'en dash in a range untouched'],
    ['Plain copy.\n\nSecond paragraph.', 'Plain copy.\n\nSecond paragraph.', 'clean text is returned unchanged'],
    ['', '', 'empty stays empty'],
  ];
  for (const [input, want, label] of cases) {
    const got = stripEmDashes(input);
    assert(got === want, `stripEmDashes: ${label} (got ${JSON.stringify(got)})`);
  }
}

// ── 2a. First-touch draft through the real generator ───────────────────────
async function draftPath() {
  let calls = 0;
  registerProvider('mock-em-dash', async () => {
    calls++;
    return JSON.stringify({
      subject: `Paid post for Glass Harbor ${EM} Ada Sample`,
      body:
        `Hi @demo.beats_example,\n\nYour sync breakdowns are sharp ${EM} we're putting Glass Harbor from Ada Sample out and think your audience would take to it.\n\nOpen to a paid post? Happy to talk details.\n\nOwen`,
    });
  });
  const input: DraftPersonalizationInput = {
    firmVoice: 'Warm, specific, no buzzwords.',
    artistName: 'Ada Sample',
    trackName: 'Glass Harbor',
    personality: 'direct',
    creator: { handle: 'demo.beats_example', bio: 'sync licensing nerd', recentPosts: [] },
  };
  const d = await generateOutreachDraft(input);
  assert(d.source === 'model', `draft: clean copy with a stray dash is kept (got ${d.source}, ${d.degradedReason ?? ''})`);
  assert(calls === 1, `draft: no retry spent on a dash (got ${calls} calls)`);
  assert(!d.subject.includes(EM) && !d.body.includes(EM), 'draft: no em dash in subject or body');
  assert(d.subject === 'Paid post for Glass Harbor, Ada Sample', `draft: subject rewritten (got ${JSON.stringify(d.subject)})`);
  assert(
    d.body.includes("Your sync breakdowns are sharp, we're putting Glass Harbor"),
    'draft: body dash rewritten as a comma, wording otherwise unchanged',
  );
}

// ── 2b. Contract template: header and model output ─────────────────────────
function contractPath() {
  assert(!DRAFT_TEMPLATE_HEADER.includes(EM), 'contract: DRAFT header carries no em dash');
  assert(looksLikeDraftHeader(DRAFT_TEMPLATE_HEADER), 'contract: the editor detector sees the new header');
  assert(
    looksLikeDraftHeader(`DRAFT ${EM} generated template, requires legal review before use.\n\nBody`),
    'contract: drafts already stored with the old em-dash header are still detected',
  );
  assert(!BASE_CONTRACT_TEMPLATE.includes(EM), 'contract: base template carries no em dash');
  const { body } = normalizeGeneratedTemplate(
    `${DRAFT_TEMPLATE_HEADER}\n\nCREATOR CONTENT LICENSING AGREEMENT ${EM} MUSIC PROMOTION\n\n1. DELIVERABLES. Content ${EM} as agreed.`,
  );
  assert(!body.includes(EM), 'contract: model-generated template text is stripped of em dashes');
  assert(body.startsWith(DRAFT_TEMPLATE_HEADER), 'contract: header still first after stripping');
}

// ── 3. Source scan: outbound copy and prompts ──────────────────────────────
// Whole files: every literal in them is outbound copy, a prompt, or text a
// model is shown (retry feedback). Scoped entries: only the named function or
// constant (the rest of the file is UI copy owned elsewhere).
const SCAN: Array<{ file: string; only?: string }> = [
  { file: 'src/lib/promo-materials.ts' },
  { file: 'src/lib/payout-email.ts' },
  { file: 'src/lib/payment-copy.ts' },
  { file: 'src/lib/holding-note.ts' },
  { file: 'src/lib/channels/outbound-envelope.ts' },
  { file: 'src/lib/personality.ts' },
  { file: 'src/lib/outreach.ts' },
  { file: 'src/lib/openai.ts' },
  { file: 'src/lib/negotiation.ts' },
  { file: 'src/lib/negotiation-tick.ts' },
  { file: 'src/lib/injection-guard.ts' },
  { file: 'src/lib/reference-guard.ts' },
  { file: 'src/lib/contact-discovery.ts' },
  { file: 'src/lib/model-provider.ts' },
  { file: 'src/lib/contract-generator.ts' },
  { file: 'src/lib/contract-builder.ts' },
  { file: 'src/lib/contracts.ts' },
  { file: 'src/lib/qualify.ts', only: 'qualifySystem' },
];

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

function declName(n: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name)) {
    return n.name.text;
  }
  return null;
}

function scan() {
  for (const { file, only } of SCAN) {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const hits: string[] = [];
    let foundScope = !only;
    const visit = (n: ts.Node, inScope: boolean) => {
      const nowIn = inScope || (only != null && declName(n) === only);
      if (only != null && declName(n) === only) foundScope = true;
      if (nowIn && LITERAL_KINDS.has(n.kind)) {
        // The cooked value, so an escaped — counts too.
        const text = (n as ts.LiteralLikeNode).text;
        if (text.includes(EM)) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          hits.push(`${file}:${line}`);
        }
      }
      ts.forEachChild(n, (c) => visit(c, nowIn));
    };
    visit(sf, !only);
    assert(foundScope, `scan: ${file} still declares ${only}`);
    assert(hits.length === 0, `scan: no em dash in outbound/prompt literals of ${file} (${hits.join(', ')})`);
  }
}

async function main() {
  unit();
  await draftPath();
  contractPath();
  scan();
  console.log(`no-em-dash test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
