// tests/contract-import.test.ts
//
// Hermetic tests for contract IMPORT (src/lib/contract-import.ts) — the path
// that reads a label's existing .docx/.pdf/.txt and proposes where the
// {{placeholder}} slots belong.
//
// NO COMMITTED BINARY FIXTURES. The .docx and .pdf are built here, in code: a
// .docx is a zip of three XML parts (a ~40-line STORED-entry zip writer, no
// dependency) and a .pdf is a handful of objects with a real xref table. A
// committed binary is a fixture nobody can read in a diff and nobody can
// adjust; these say exactly what they contain, and they are the same bytes
// mammoth and unpdf would get from Word and Acrobat.
//
// The centre of gravity is RESTRAINT. Extraction is the easy half; the half
// that can hurt someone is suggestBlanks, which points at spans inside a real
// operative agreement. So the assertions that matter most are the negative
// ones: never a placeholder the fill engine cannot fill, never a span that
// overlaps an existing {{slot}}, never a guess at an unlabelled blank, and
// never a mutation of the text itself. Plus a source-level pin that neither
// the library nor the route ever hands an uploaded document to a model.
//
// Hermetic: no DB, no network, no env, no model. The two parsers run on bytes
// this file creates.
//
// Run: npx tsx tests/contract-import.test.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCEPTED_DESCRIPTION,
  ACCEPTED_EXTENSIONS,
  ACCEPT_ATTRIBUTE,
  ContractImportError,
  IMPORT_WARNING,
  MAX_IMPORT_BYTES,
  detectFormat,
  extractContractText,
  normalizeContractText,
  suggestBlanks,
} from '../src/lib/contract-import';
import {
  DEAL_FILLABLE_PLACEHOLDERS,
  KNOWN_PLACEHOLDERS,
  detectPlaceholders,
  fillTemplate,
  buildContractVars,
} from '../src/lib/contracts';
import { BASE_CONTRACT_TEMPLATE } from '../src/lib/contract-generator';

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

async function assertRejects(
  fn: () => Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  try {
    await fn();
    assert(false, `${message} (nothing was thrown)`);
  } catch (e) {
    const err = e as ContractImportError;
    assert(
      err instanceof ContractImportError && err.code === code,
      `${message} (got ${err?.name ?? typeof e}:${(err as ContractImportError)?.code ?? '?'})`,
    );
    if (err instanceof ContractImportError) {
      assert(/\s/.test(err.message) && err.message.length > 20, `${message}: refusal is a sentence, not a code`);
    }
  }
}

/* ── fixture builders ─────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Minimal zip, STORED entries only — enough for a .docx mammoth will open. */
function makeZip(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('');
  return makeZip([
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', RELS],
    [
      'word/document.xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${body}</w:body></w:document>`,
    ],
  ]);
}

/** Minimal PDF with a real xref. `null` page content = a page with no text
 *  layer, which is what a scan looks like to any text extractor. */
function makePdf(pages: Array<string | null>): Buffer {
  const objs: string[] = ['', '']; // 1 = catalog, 2 = pages (backfilled below)
  const add = (body: string) => {
    objs.push(body);
    return objs.length;
  };
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contentIds = pages.map((p) => {
    const stream = p === null ? '' : `BT /F1 12 Tf 72 720 Td (${p}) Tj ET`;
    return add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const kids = contentIds.map((cid) =>
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${cid} 0 R ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    ),
  );
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/* ── 1. the allowlist ─────────────────────────────────────────────────────── */

function testDetectFormat() {
  assert(detectFormat(DOCX_MIME, 'Example Records Creator Agreement.docx') === 'docx', 'allowlist: .docx');
  assert(detectFormat('application/pdf', 'contract.pdf') === 'pdf', 'allowlist: .pdf');
  assert(detectFormat('text/plain', 'terms.txt') === 'text', 'allowlist: .txt');
  assert(detectFormat('text/markdown', 'terms.md') === 'text', 'allowlist: .md');
  assert(detectFormat('', 'terms.md') === 'text', 'allowlist: an empty MIME does not refuse a .md');
  assert(
    detectFormat('application/octet-stream', 'contract.docx') === 'docx',
    'allowlist: a generic MIME does not refuse a .docx (Windows sends this)',
  );
  assert(detectFormat('APPLICATION/PDF', 'CONTRACT.PDF') === 'pdf', 'allowlist: case-insensitive');
  assert(
    detectFormat('text/plain; charset=utf-8', 'terms.txt') === 'text',
    'allowlist: charset parameter ignored',
  );

  const refuse = (mime: string, name: string, code: string, what: string) => {
    try {
      detectFormat(mime, name);
      assert(false, `refused: ${what} (nothing thrown)`);
    } catch (e) {
      const err = e as ContractImportError;
      assert(err instanceof ContractImportError && err.code === code, `refused: ${what}`);
      assert(
        err instanceof ContractImportError && err.message.includes('.docx'),
        `refused: ${what} — the refusal names what IS accepted`,
      );
    }
  };
  // The brief's required case: a disallowed MIME is refused by name.
  refuse('image/png', 'contract.png', 'unsupported_type', 'image/png');
  refuse('application/x-msdownload', 'contract.exe', 'unsupported_type', 'an executable');
  refuse('application/pdf', 'contract', 'unsupported_type', 'no extension at all');
  refuse('text/html', 'contract.html', 'unsupported_type', 'html');
  // A MIME that actively contradicts an allowlisted extension.
  refuse('image/png', 'contract.pdf', 'unsupported_type', 'image/png wearing a .pdf name');
  // Legacy Word gets its own code because the fix is one Save As.
  refuse(DOCX_MIME, 'old contract.doc', 'legacy_doc', 'Word 97–2003 .doc');

  assert(
    ACCEPT_ATTRIBUTE.split(',').every((e) => e in ACCEPTED_EXTENSIONS),
    'allowlist: the file input accept attribute is built from the allowlist itself',
  );
  assert(!ACCEPT_ATTRIBUTE.includes('.doc,'), 'allowlist: .doc is not offered in the file picker');
}

/* ── 2. plain text ────────────────────────────────────────────────────────── */

async function testPlainTextExtraction() {
  const source =
    '﻿CREATOR AGREEMENT\r\n\r\nInfluencer: ______________\r\n\r\n\r\n\r\nFee: $______   \r\n';
  const { text, warnings } = await extractContractText(
    Buffer.from(source, 'utf8'),
    'text/plain',
    'terms.txt',
  );
  assert(!text.includes('﻿'), 'text: byte-order mark stripped');
  assert(!text.includes('\r'), 'text: CRLF normalized to LF');
  assert(text.startsWith('CREATOR AGREEMENT'), 'text: leading whitespace trimmed');
  assert(text.endsWith('Fee: $______'), 'text: trailing whitespace trimmed');
  assert(text.includes('AGREEMENT\n\nInfluencer'), 'text: paragraph breaks preserved');
  assert(!text.includes('\n\n\n'), 'text: runs of blank lines collapsed to one paragraph break');
  assert(
    warnings.length === 0,
    'text: a clean .txt produces no warnings (the lossy-conversion note is for docx/pdf only)',
  );

  // Word/PDF invisibles: normalized, and the word content is untouched.
  const dirty = normalizeContractText('Fee: $500​ per post');
  assert(dirty.text === 'Fee: $500 per post', 'text: NBSP/thin space → space, zero-width removed');
  assert(!dirty.controlsRemoved, 'text: normalizing invisible spaces is not a control-char event');

  // A real control character is the "this is not a text document" tell, and
  // contracts.templateBodyError() refuses a NUL at the save boundary anyway.
  const withControls = await extractContractText(
    Buffer.from('Fee: \u0000\u0007$500', 'utf8'),
    'text/plain',
    'terms.txt',
  );
  assert(!withControls.text.includes('\u0000'), 'text: control characters removed');
  assert(
    withControls.warnings.includes(IMPORT_WARNING.controlCharacters()),
    'text: removing control characters is warned about, not silent',
  );

  const empty = await extractContractText(Buffer.from('   \n\n  ', 'utf8'), 'text/plain', 'e.txt');
  assert(empty.text === '', 'text: a whitespace-only file extracts to nothing');
  assert(
    empty.warnings.includes(IMPORT_WARNING.emptyExtraction()),
    'text: an empty extraction warns rather than throwing',
  );

  const long = 'A'.repeat(60_000);
  const tooLong = await extractContractText(Buffer.from(long, 'utf8'), 'text/plain', 'long.txt');
  assert(tooLong.text.length === 60_000, 'text: an over-long contract is still returned in full');
  assert(
    tooLong.warnings.includes(IMPORT_WARNING.tooLong(60_000)),
    'text: over the save ceiling warns (and says the save will be refused)',
  );
}

/* ── 3. docx ──────────────────────────────────────────────────────────────── */

async function testDocxExtraction() {
  const docx = makeDocx([
    'CREATOR CONTENT LICENSING AGREEMENT',
    'Influencer: ______________',
    'Handle: @______________',
    'Fee: $________',
    'Artist: [ARTIST NAME]',
  ]);
  const { text, warnings } = await extractContractText(docx, DOCX_MIME, 'Example Records agreement.docx');
  assert(text.startsWith('CREATOR CONTENT LICENSING AGREEMENT'), 'docx: first paragraph read');
  assert(text.includes('Influencer: ______________'), 'docx: blanks survive extraction verbatim');
  assert(text.includes('Artist: [ARTIST NAME]'), 'docx: bracketed blanks survive extraction');
  assert(
    text.includes('AGREEMENT\n\nInfluencer'),
    'docx: one Word paragraph becomes one paragraph break',
  );
  assert(
    warnings.includes(IMPORT_WARNING.lossyConversion('Word document')),
    'docx: always warns that tables/headers/footers are not preserved',
  );

  // A .docx that isn't one. The extension allowlist alone would have run
  // mammoth over arbitrary bytes.
  await assertRejects(
    () => extractContractText(Buffer.from('%PDF-1.4 not a zip'), DOCX_MIME, 'renamed.docx'),
    'not_a_docx',
    'docx: magic-byte sniff refuses a renamed file',
  );
  // A real zip that is not a Word document: sniff passes, mammoth refuses.
  await assertRejects(
    () => extractContractText(makeZip([['notes.txt', 'hello']]), DOCX_MIME, 'plain.docx'),
    'unreadable_docx',
    'docx: a zip with no word/document.xml is refused with advice',
  );
}

/* ── 4. pdf ───────────────────────────────────────────────────────────────── */

async function testPdfExtraction() {
  const pdf = makePdf(['CREATOR AGREEMENT Influencer: ________ Fee: $______']);
  const { text, warnings } = await extractContractText(pdf, 'application/pdf', 'contract.pdf');
  assert(text.includes('CREATOR AGREEMENT'), 'pdf: text layer read');
  assert(text.includes('Fee: $______'), 'pdf: blanks survive extraction');
  assert(
    warnings.includes(IMPORT_WARNING.lossyConversion('PDF')),
    'pdf: always warns that layout is not preserved',
  );
  assert(
    !warnings.includes(IMPORT_WARNING.pdfNoTextLayer(1)),
    'pdf: a normal one-page contract is not called a scan',
  );

  // The required case: pages present, no text layer. This is the single most
  // likely real-world import — a contract someone printed, signed and scanned.
  const scanned = await extractContractText(makePdf([null, null]), 'application/pdf', 'scan.pdf');
  assert(scanned.text === '', 'pdf: a scan yields no text');
  assert(
    scanned.warnings.includes(IMPORT_WARNING.pdfNoTextLayer(2)),
    'pdf: a scan is named as a scan, with the page count',
  );
  assert(
    scanned.warnings.includes(IMPORT_WARNING.emptyExtraction()),
    'pdf: a scan also reports the empty extraction',
  );
  assert(
    scanned.warnings.some((w) => w.includes('paste the text in by hand')),
    'pdf: a scan tells the label what to do instead',
  );

  await assertRejects(
    () => extractContractText(Buffer.from('PK not a pdf'), 'application/pdf', 'x.pdf'),
    'not_a_pdf',
    'pdf: magic-byte sniff refuses a renamed file',
  );
}

/* ── 5. the size cap ──────────────────────────────────────────────────────── */

async function testSizeCap() {
  const oversize = Buffer.alloc(MAX_IMPORT_BYTES + 1, 0x41);
  await assertRejects(
    () => extractContractText(oversize, 'text/plain', 'huge.txt'),
    'file_too_large',
    'size: over the cap is refused',
  );
  assert(MAX_IMPORT_BYTES <= 4 * 1024 * 1024, 'size: the cap stays small enough to bound parse CPU');
  const atCap = await extractContractText(
    Buffer.alloc(MAX_IMPORT_BYTES, 0x41),
    'text/plain',
    'big.txt',
  );
  assert(atCap.text.length === MAX_IMPORT_BYTES, 'size: exactly at the cap is accepted');
}

/* ── 6. suggestBlanks — what it proposes ──────────────────────────────────── */

const SAMPLE = [
  'CREATOR CONTENT LICENSING AGREEMENT',
  '',
  'This agreement is dated ____________.',
  '',
  'Label: ______________________',
  'Influencer: ______________________',
  'Influencer handle: @______________',
  'Recording artist: [ARTIST NAME]',
  'Campaign: ______________________',
  '',
  '1. DELIVERABLES. The Creator will deliver: ______________________',
  '2. FEE. The Label will pay $__________ to the Creator.',
  '3. PAYMENT METHOD: ______________',
  '4. SCHEDULE. Publication deadline: ______________',
  '5. GOVERNING LAW. This agreement is governed by the laws of ______________.',
  '6. NOTICES. Address: ______________________',
].join('\n');

function testSuggestBlanksProposals() {
  const suggestions = suggestBlanks(SAMPLE);
  const byPlaceholder = new Map(suggestions.map((s) => [s.placeholder, s]));

  for (const want of [
    'date',
    'firm_name',
    'creator_name',
    'creator_handle',
    'artist_name',
    'campaign_name',
    'deliverables',
    'amount_usd',
    'payment_method',
    'schedule',
  ] as const) {
    assert(byPlaceholder.has(want), `suggest: proposes {{${want}}} from its label`);
  }

  // THE RULE. Only what generateOfferContract can actually fill.
  const fillable = new Set<string>(DEAL_FILLABLE_PLACEHOLDERS);
  assert(
    suggestions.every((s) => fillable.has(s.placeholder)),
    'suggest: every proposal is a DEAL_FILLABLE_PLACEHOLDERS member',
  );
  assert(
    suggestions.every((s) => (KNOWN_PLACEHOLDERS as readonly string[]).includes(s.placeholder)),
    'suggest: no invented placeholder names',
  );
  // {{governing_law}} has no per-deal source, so a template carrying it can
  // never send (contracts.ts blocks it at the send gate). The sample has a
  // governing-law blank precisely so this assertion means something.
  assert(
    !suggestions.some((s) => s.placeholder === 'governing_law'),
    'suggest: never proposes {{governing_law}}, which nothing fills per deal',
  );
  assert(
    SAMPLE.includes('governed by the laws of ______________'),
    'suggest: the sample really does contain a governing-law blank',
  );

  // An unlabelled blank is left alone rather than guessed at.
  assert(
    !suggestions.some((s) => SAMPLE.slice(Math.max(0, s.start - 12), s.start).includes('Address')),
    'suggest: an unrecognized label ("Address:") gets no proposal',
  );

  // Span arithmetic. {{amount_usd}} fills as "$1200" and {{creator_handle}} as
  // "@name", so the proposed spans must swallow the sigil or the filled
  // contract reads "$$1200".
  const amount = byPlaceholder.get('amount_usd')!;
  assert(SAMPLE.slice(amount.start, amount.end).startsWith('$'), 'suggest: the $ is inside the amount span');
  const handle = byPlaceholder.get('creator_handle')!;
  assert(SAMPLE.slice(handle.start, handle.end).startsWith('@'), 'suggest: the @ is inside the handle span');

  // Shape.
  assert(
    suggestions.every((s, i) => i === 0 || s.start >= suggestions[i - 1].end),
    'suggest: proposals are ordered and never overlap each other',
  );
  assert(
    suggestions.every((s) => s.end > s.start && s.end <= SAMPLE.length),
    'suggest: every span is a real slice of the text',
  );
  assert(
    suggestions.every((s) => s.excerpt.length > 0 && s.reason.length > 10),
    'suggest: every proposal carries context and a reason a human can judge',
  );
  assert(
    byPlaceholder.get('artist_name')!.reason.includes('[ARTIST NAME]'),
    'suggest: a bracketed blank labels itself, and the reason says so',
  );

  // Applying every proposal (which only a human does, in the editor) must
  // produce a template the existing fill engine can actually complete.
  let applied = SAMPLE;
  for (const s of [...suggestions].sort((a, b) => b.start - a.start)) {
    applied = applied.slice(0, s.start) + `{{${s.placeholder}}}` + applied.slice(s.end);
  }
  const { unknown } = fillTemplate(
    applied,
    buildContractVars({
      creatorName: 'Marlo Example',
      creatorHandle: '@marlo_example',
      agreedUsd: 1200,
      deliverablesText: '1 reel and 1 story',
      scheduleText: 'within 14 days',
      paymentMethod: 'Stripe payout',
      artistName: 'Alex Owner',
      campaignName: '"Nightdrive" by Alex Owner',
      nowMs: Date.parse('2026-09-21T12:00:00.000Z'),
      firmName: 'Example Records',
    }),
  );
  assert(unknown.length === 0, `suggest: the applied result fills cleanly (unfilled: ${unknown.join(', ')})`);
  assert(!applied.includes('$$'), 'suggest: no doubled currency sigil after the fill');
  assert(!applied.includes('@@'), 'suggest: no doubled at-sign after the fill');
}

/* ── 7. suggestBlanks — what it refuses to touch ──────────────────────────── */

function testSuggestBlanksNeverTouchesExistingSlots() {
  // A half-converted template: some slots already placed, some blanks left.
  const mixed = 'Creator: {{creator_name}}\nBackup contact: ______________\nArtist: [{{artist_name}}]';
  const suggestions = suggestBlanks(mixed);
  const occupied = [...mixed.matchAll(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g)].map(
    (m) => [m.index, m.index + m[0].length] as [number, number],
  );
  assert(occupied.length === 2, 'no-overlap: the fixture really has two existing slots');
  assert(
    suggestions.every((s) => !occupied.some(([os, oe]) => s.start < oe && s.end > os)),
    'no-overlap: nothing is proposed inside or across an existing {{slot}}',
  );
  // [{{artist_name}}] matches the bracketed-blank pattern and names an artist,
  // so without the guard it would be proposed and would destroy a real slot.
  assert(
    !suggestions.some((s) => s.placeholder === 'artist_name'),
    'no-overlap: a bracketed blank wrapping an existing slot is left alone',
  );
  assert(
    !suggestions.some((s) => mixed.slice(s.start, s.end).includes('{{')),
    'no-overlap: no proposed span contains placeholder syntax',
  );

  // The production template is entirely {{slots}} already: importing it back
  // must produce nothing to change.
  const baseSuggestions = suggestBlanks(BASE_CONTRACT_TEMPLATE);
  const baseOccupied = [...BASE_CONTRACT_TEMPLATE.matchAll(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g)].map(
    (m) => [m.index, m.index + m[0].length] as [number, number],
  );
  assert(
    detectPlaceholders(BASE_CONTRACT_TEMPLATE).length > 5,
    'no-overlap: the base template really is full of slots',
  );
  assert(
    baseSuggestions.every((s) => !baseOccupied.some(([os, oe]) => s.start < oe && s.end > os)),
    'no-overlap: re-importing the generated base template proposes nothing over its own slots',
  );
}

/* ── 8. the module cannot alter legal text ────────────────────────────────── */

function testNothingIsSubstituted() {
  const before = SAMPLE;
  const suggestions = suggestBlanks(SAMPLE);
  assert(SAMPLE === before, 'purity: suggestBlanks does not mutate its input');
  assert(suggestions.length > 0, 'purity: (and it did produce proposals, so that means something)');
  assert(
    JSON.stringify(suggestBlanks(SAMPLE)) === JSON.stringify(suggestions),
    'purity: deterministic — same text, same proposals',
  );

  const src = readFileSync(join(process.cwd(), 'src/lib/contract-import.ts'), 'utf8');
  const routeSrc = readFileSync(
    join(process.cwd(), 'src/app/api/firm/contract-template/import/route.ts'),
    'utf8',
  );

  // There is no way to apply a suggestion from this module. That absence IS
  // the "a human decides" guarantee — an exported applier would be reached for.
  assert(
    !/export\s+(async\s+)?function\s+(apply|fill|insert|substitute|autoPlaceholder)/i.test(src),
    'no-substitution: the module exports nothing that writes a placeholder into text',
  );

  // The uploaded document is a third party's text. It must never become a
  // prompt. contract-generator.ts needs a model; this path must not have one.
  for (const [name, source] of [
    ['contract-import.ts', src],
    ['import/route.ts', routeSrc],
  ] as const) {
    assert(!/from\s+['"].*model-provider['"]/.test(source), `no-model: ${name} does not import the model seam`);
    assert(!/\bcomplete\s*\(/.test(source), `no-model: ${name} never calls complete()`);
    assert(!/openai|anthropic|gemini/i.test(source), `no-model: ${name} names no model vendor`);
  }
}

/* ── 9. the settings card's copy of the allowlist ─────────────────────────── */

/**
 * ContractTemplateCard is a client component, and importing contract-import.ts
 * for value would ship mammoth and unpdf into the settings page's browser
 * bundle. So it carries its own copies of three constants. This is the thing
 * that stops them drifting — a file picker offering an extension the server
 * refuses is a dead end the user meets only after choosing a file.
 */
function testComponentConstantsMatchTheAllowlist() {
  const card = readFileSync(join(process.cwd(), 'src/components/ContractTemplateCard.tsx'), 'utf8');
  const literal = (name: string): string | null => {
    const m = card.match(new RegExp(`const ${name} = "([^"]*)"`));
    return m ? m[1] : null;
  };
  assert(literal('IMPORT_ACCEPT') === ACCEPT_ATTRIBUTE, 'card: the file picker offers exactly the accepted extensions');
  assert(
    literal('IMPORT_ACCEPTED_DESCRIPTION') === ACCEPTED_DESCRIPTION,
    'card: the "what we accept" copy matches the refusal copy',
  );
  const mb = card.match(/const IMPORT_MAX_MB = (\d+)/);
  assert(
    !!mb && Number(mb[1]) * 1024 * 1024 === MAX_IMPORT_BYTES,
    'card: the advertised size limit matches the enforced one',
  );
  assert(
    /import type \{[^}]*\} from "@\/lib\/contract-import"/.test(card),
    'card: contract-import is type-imported only, so the parsers stay server-side',
  );
}

/* ── run ──────────────────────────────────────────────────────────────────── */

async function main() {
  testDetectFormat();
  await testPlainTextExtraction();
  await testDocxExtraction();
  await testPdfExtraction();
  await testSizeCap();
  testSuggestBlanksProposals();
  testSuggestBlanksNeverTouchesExistingSlots();
  testNothingIsSubstituted();
  testComponentConstantsMatchTheAllowlist();

  console.log(`\ncontract-import: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
