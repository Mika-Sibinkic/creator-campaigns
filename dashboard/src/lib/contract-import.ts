// src/lib/contract-import.ts
//
// Contract IMPORT — the other half of contract handling.
//
// The generator (contract-generator.ts) exists for labels with no contract of
// their own. This exists for the labels who already have one, sitting in a
// .docx their lawyer wrote. Until now the only way to get that text into
// Creator Campaigns was to open Word, select all, and paste — and the only file input
// in the whole app pointed at the campaign promo-asset bucket.
//
// TWO RULES, and they are the entire design.
//
//   1. WE DO NOT WRITE INTO LEGAL TEXT. extractContractText returns the
//      document's own words. suggestBlanks returns SUGGESTIONS — offsets and a
//      placeholder name — and nothing in this module will apply one. There is
//      deliberately no applyBlank / fillBlanks / autoPlaceholder export: a
//      human clicks each marker in the editor, or nothing happens. An imported
//      contract is the firm's operative agreement with a third party; a regex
//      that "helpfully" replaced a party name with {{creator_name}} in the
//      wrong clause would be indistinguishable from a correct one until it had
//      already gone out to a creator.
//
//   2. AN UPLOADED FILE IS UNTRUSTED INPUT FROM A THIRD PARTY. It is treated
//      as TEXT, never as instructions, and it never reaches a model — there is
//      no import from model-provider here or in the route, and there must
//      never be one. (The generator's own prompt already has to defend against
//      this for typed clauses; a whole uploaded document is a far better
//      injection carrier, so the answer here is not a better prompt, it is no
//      prompt at all.) The parsers run on bytes we size-cap and sniff first.
//
// Deterministic and pure apart from the two parser calls: same file in, same
// text and same suggestions out. No network, no database, no env.
//
// Extraction is LOSSY and says so. mammoth reads the main document body of a
// .docx; unpdf reads a PDF's text layer. Tables, headers, footers, footnotes
// and any layout that carried meaning do not survive, and a scanned PDF has no
// text layer at all. Every one of those degrades to a WARNING with the text we
// did get, never to a silent partial contract — contract-generator.ts learned
// that lesson the expensive way (a model deleted the FTC section and the
// structural check passed).

// mammoth is CJS with `export =`, so it is a default import; unpdf is ESM.
import mammoth from 'mammoth';
import { extractText } from 'unpdf';
import {
  DEAL_FILLABLE_PLACEHOLDERS,
  MAX_TEMPLATE_CHARS,
  type KnownPlaceholder,
} from './contracts';

/* ────────────────────────────── accepted input ───────────────────────────── */

/**
 * Upload ceiling. A contract is text: a typical case is a 6-page .docx,
 * about 40KB. 2MB is roughly two orders of magnitude of headroom and it is
 * also what keeps parse CPU bounded, which is why this route can sit on the
 * same 'auth' rate-limit tier as its siblings instead of needing 'expensive'.
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** Which parser handles a file. Extension decides; MIME only has to agree. */
export type ImportFormat = 'docx' | 'pdf' | 'text';

/**
 * The allowlist, by extension. Extension-first is deliberate: browsers supply
 * the MIME from an OS registry that regularly reports '' or
 * application/octet-stream for .md, and on Windows .docx has been seen as
 * application/zip. An extension the user can see beats a header we can't.
 */
export const ACCEPTED_EXTENSIONS: Readonly<Record<string, ImportFormat>> = {
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
};

/** MIME types each format may legitimately arrive as. */
const ACCEPTED_MIME: Readonly<Record<ImportFormat, readonly string[]>> = {
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
  ],
  pdf: ['application/pdf', 'application/x-pdf'],
  text: ['text/plain', 'text/markdown', 'text/x-markdown', 'text/md'],
};

/** MIMEs that carry no information and must not be used to refuse a file. */
const UNINFORMATIVE_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** The `accept` attribute for the file input, and the words in every refusal. */
export const ACCEPT_ATTRIBUTE = Object.keys(ACCEPTED_EXTENSIONS).join(',');
export const ACCEPTED_DESCRIPTION =
  'Word (.docx), PDF (.pdf), or plain text (.txt, .md)';

/** Refusal codes. Each maps to one sentence the user can act on. */
export type ImportErrorCode =
  | 'unsupported_type'
  | 'legacy_doc'
  | 'file_too_large'
  | 'not_a_docx'
  | 'not_a_pdf'
  | 'unreadable_docx'
  | 'unreadable_pdf';

/**
 * A refusal with a code AND the sentence to show. Routes must not invent copy
 * for these — a record label reading "unreadable_pdf" learns nothing, and the
 * settings card's failureMessage() passes server sentences through verbatim.
 */
export class ContractImportError extends Error {
  readonly code: ImportErrorCode;
  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ContractImportError';
    this.code = code;
  }
}

/**
 * Which parser to run, or a refusal. Legacy .doc gets its own code because
 * "unsupported file type" is useless advice when the fix is one Save As.
 */
export function detectFormat(mime: string, filename: string): ImportFormat {
  const lower = (filename || '').toLowerCase().trim();
  const dot = lower.lastIndexOf('.');
  const ext = dot === -1 ? '' : lower.slice(dot);

  if (ext === '.doc') {
    throw new ContractImportError(
      'legacy_doc',
      'Word 97–2003 files (.doc) can’t be read. Open it in Word and use File → Save As → Word Document (.docx), then import that.',
    );
  }

  const format = ACCEPTED_EXTENSIONS[ext];
  if (!format) {
    throw new ContractImportError(
      'unsupported_type',
      `That file type can’t be imported. Accepted: ${ACCEPTED_DESCRIPTION}.`,
    );
  }

  // The MIME only has to not CONTRADICT the extension. A missing or generic
  // type is normal and is not a reason to refuse; a .pdf announcing itself as
  // image/png is a renamed file and is.
  const declared = (mime || '').toLowerCase().split(';')[0].trim();
  if (!UNINFORMATIVE_MIME.has(declared) && !ACCEPTED_MIME[format].includes(declared)) {
    throw new ContractImportError(
      'unsupported_type',
      `That file says it is "${declared}", which doesn’t match its ${ext} extension. Accepted: ${ACCEPTED_DESCRIPTION}.`,
    );
  }
  return format;
}

/* ─────────────────────────────── warnings ────────────────────────────────── */

/**
 * Every warning, as the exact sentence the label reads. Exported as builders
 * so the tests pin the real copy rather than a code that could drift away from
 * it — the sentences ARE the contract with the user here, since each one is
 * telling them what Creator Campaigns could not see in their agreement.
 */
export const IMPORT_WARNING = {
  lossyConversion: (what: string) =>
    `Only the text of your ${what} was read. Tables, headers, footers, footnotes and layout are not preserved, and columns may be flattened into single lines. Read this against your original before you save it.`,
  emptyExtraction: () =>
    'No text could be read out of that file. Nothing was put in the editor. If the contract is a scan or an image, paste the text in by hand.',
  pdfNoTextLayer: (pages: number) =>
    `That PDF has ${pages} ${pages === 1 ? 'page' : 'pages'} but almost no readable text, which is what a scanned or photographed document looks like. Creator Campaigns cannot read a scan — paste the text in by hand, or export a text-based PDF from the original.`,
  tooLong: (chars: number) =>
    `The imported text is ${chars.toLocaleString('en-US')} characters, over the ${MAX_TEMPLATE_CHARS.toLocaleString('en-US')}-character limit for a saved contract. Trim it before saving or the save will be refused.`,
  controlCharacters: () =>
    'Some unreadable characters were removed from the text. Check the wording carefully — this usually means the file was damaged or was not really a text document.',
  docxMessages: (n: number) =>
    `Word reported ${n} ${n === 1 ? 'part' : 'parts'} of that document it could not convert to plain text. Anything in those parts is missing from the text below.`,
} as const;

export interface ExtractedContract {
  /** The document's own words, normalized. Never edited, never annotated. */
  text: string;
  /** Plain sentences for the user. Non-empty does not mean failure. */
  warnings: string[];
}

/* ───────────────────────────── normalization ─────────────────────────────── */

// Invisible characters PDF and Word text layers routinely carry. They are not
// content, they break every regex downstream, and they survive a copy-paste
// into a legal document where nobody can see them.
const ZERO_WIDTH = /[​-‍⁠﻿]/g;
// Unicode spaces that render as a space but are not one (non-breaking space is
// the common one; PDFs also emit figure/narrow/en/em spaces between words).
const UNICODE_SPACE = /[   -   　]/g;
// C0/C1 controls minus tab and newline. A file full of these is not a text
// document, which is why their removal is warned about rather than silent.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Whitespace only. Paragraph breaks are preserved because in a contract they
 * separate clauses — a normalizer that collapsed them would merge two
 * obligations into one sentence. Nothing here changes a word.
 */
export function normalizeContractText(raw: string): { text: string; controlsRemoved: boolean } {
  let text = raw.replace(/^﻿/, '');
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(ZERO_WIDTH, '');
  text = text.replace(UNICODE_SPACE, ' ');
  const stripped = text.replace(CONTROL_CHARS, '');
  const controlsRemoved = stripped.length !== text.length;
  text = stripped;
  // Trailing spaces per line, then runs of blank lines down to one blank line
  // (i.e. a single paragraph break), then the document's own edges.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, controlsRemoved };
}

/* ─────────────────────────────── extraction ──────────────────────────────── */

/** First bytes, for the "is this actually what the extension claims" sniff. */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((b, i) => bytes[i] === b);
}
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

/**
 * Read a contract out of an uploaded file.
 *
 * Refuses (throws ContractImportError) only for things that make the file
 * unreadable: wrong type, oversized, not the format it claims, a parser that
 * could not open it at all. Everything degraded-but-readable comes back as
 * text plus warnings, because a label whose PDF lost its table headers is
 * better served by the text and a warning than by a refusal.
 *
 * The returned text is the document's, byte-for-byte apart from whitespace
 * normalization. No placeholder is inserted here or anywhere else in this
 * module.
 */
export async function extractContractText(
  buf: Buffer | ArrayBuffer,
  mime: string,
  filename: string,
): Promise<ExtractedContract> {
  const bytes =
    buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new ContractImportError(
      'file_too_large',
      `That file is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)}MB. A contract is text — the limit is ${MAX_IMPORT_BYTES / (1024 * 1024)}MB.`,
    );
  }

  const format = detectFormat(mime, filename);
  const warnings: string[] = [];
  let raw: string;

  if (format === 'docx') {
    if (!startsWith(bytes, ZIP_MAGIC)) {
      throw new ContractImportError(
        'not_a_docx',
        'That file is named .docx but isn’t a Word document. If you renamed it, import the original instead.',
      );
    }
    let result: { value: string; messages: unknown[] };
    try {
      result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    } catch (e) {
      throw new ContractImportError(
        'unreadable_docx',
        `That Word document couldn’t be opened (${(e as Error).message?.slice(0, 120) ?? 'unknown error'}). Try re-saving it from Word as .docx.`,
      );
    }
    raw = result.value;
    warnings.push(IMPORT_WARNING.lossyConversion('Word document'));
    if (result.messages.length > 0) {
      warnings.push(IMPORT_WARNING.docxMessages(result.messages.length));
    }
  } else if (format === 'pdf') {
    if (!startsWith(bytes, PDF_MAGIC)) {
      throw new ContractImportError(
        'not_a_pdf',
        'That file is named .pdf but isn’t a PDF. If you renamed it, import the original instead.',
      );
    }
    let pages: string[];
    let totalPages: number;
    try {
      const out = await extractText(bytes, { mergePages: false });
      totalPages = out.totalPages;
      pages = out.text;
    } catch (e) {
      throw new ContractImportError(
        'unreadable_pdf',
        `That PDF couldn’t be opened (${(e as Error).message?.slice(0, 120) ?? 'unknown error'}). If it is password-protected, remove the password and try again.`,
      );
    }
    // Page break → paragraph break. A PDF's text layer has no paragraph marks
    // of its own, so this is the only structural signal there is.
    raw = pages.join('\n\n');
    warnings.push(IMPORT_WARNING.lossyConversion('PDF'));
    // A scan is pages with no text layer. Distinguishing it from a genuinely
    // short contract is why this is per-page density and not a total.
    const density = totalPages > 0 ? raw.replace(/\s/g, '').length / totalPages : 0;
    if (totalPages > 0 && density < 40) {
      warnings.push(IMPORT_WARNING.pdfNoTextLayer(totalPages));
    }
  } else {
    raw = new TextDecoder('utf-8').decode(bytes);
  }

  const { text, controlsRemoved } = normalizeContractText(raw);
  if (controlsRemoved) warnings.push(IMPORT_WARNING.controlCharacters());
  if (text.length === 0) warnings.push(IMPORT_WARNING.emptyExtraction());
  if (text.length > MAX_TEMPLATE_CHARS) warnings.push(IMPORT_WARNING.tooLong(text.length));

  return { text, warnings };
}

/* ────────────────────────────── blank detection ──────────────────────────── */

export interface BlankSuggestion {
  /** Index into the extracted text where the replacement would begin. */
  start: number;
  /** Exclusive end index. `text.slice(start, end)` is exactly what a
   *  {{placeholder}} would replace — nothing wider, nothing narrower. */
  end: number;
  /** Surrounding words, for the human deciding. DISPLAY ONLY — it is context,
   *  not the replaced span, and must never be used to locate the edit. */
  excerpt: string;
  /** Always one of DEAL_FILLABLE_PLACEHOLDERS. */
  placeholder: KnownPlaceholder;
  /** Why this spot, in the user's words. */
  reason: string;
}

/** The only names that may be proposed: the ones generateOfferContract can
 *  actually fill from deal facts. {{governing_law}} is excluded upstream in
 *  contracts.ts because no per-deal value exists for it — proposing it would
 *  build a template that always hits the send gate. */
const PROPOSABLE = new Set<string>(DEAL_FILLABLE_PLACEHOLDERS);

/**
 * Label keywords, most specific first. First rule that matches the words
 * immediately before a blank wins, so "payment method:" must be tried before
 * "payment", and "publication date:" before "date".
 */
const LABEL_RULES: readonly { placeholder: KnownPlaceholder; words: string }[] = [
  {
    placeholder: 'payment_method',
    words:
      'payment\\s+method|method\\s+of\\s+payment|paid\\s+(?:via|by|through)|payable\\s+(?:via|by|through)|remittance(?:\\s+method)?',
  },
  {
    placeholder: 'schedule',
    words:
      'schedule|deadline|due\\s+date|posting\\s+date|publication\\s+date|publish(?:ing)?\\s+(?:date|deadline|by)|go[-\\s]?live(?:\\s+date)?|live\\s+date|timeline|delivery\\s+date',
  },
  {
    placeholder: 'creator_handle',
    words:
      '(?:social\\s+)?handle|user\\s?name|social\\s+account|tiktok(?:\\s+(?:handle|username))?|instagram(?:\\s+(?:handle|username))?|ig\\s+(?:handle|username)',
  },
  {
    placeholder: 'amount_usd',
    words:
      'fee|amount|compensation|payment\\s+amount|total\\s+(?:fee|amount|compensation)|rate|price|consideration|payout',
  },
  {
    placeholder: 'creator_name',
    words:
      '(?:influencer|creator|talent|content\\s+creator)(?:\'s|’s)?(?:\\s+(?:full\\s+)?(?:legal\\s+)?name)?|name\\s+of\\s+(?:the\\s+)?(?:influencer|creator|talent)',
  },
  {
    placeholder: 'artist_name',
    words: '(?:recording\\s+)?artist(?:\'s|’s)?(?:\\s+name)?|performer(?:\'s|’s)?(?:\\s+name)?',
  },
  {
    placeholder: 'campaign_name',
    words:
      'campaign(?:\\s+name)?|track(?:\\s+(?:name|title))?|song(?:\\s+(?:name|title))?|single(?:\\s+(?:name|title))?|release(?:\\s+(?:name|title))?',
  },
  {
    placeholder: 'deliverables',
    words:
      // "deliver" covers "the Creator will deliver: ___"; "delivery date" is
      // claimed by the schedule rule above, which runs first.
      'deliverable(?:s)?|deliver|scope\\s+of\\s+work|services|content\\s+to\\s+be\\s+(?:created|delivered|published)|work\\s+product|post(?:s)?',
  },
  {
    placeholder: 'firm_name',
    words:
      'label(?:\'s|’s)?(?:\\s+name)?|company(?:\'s|’s)?(?:\\s+name)?|client(?:\'s|’s)?(?:\\s+name)?|firm(?:\\s+name)?|brand(?:\\s+name)?',
  },
  {
    placeholder: 'date',
    words: 'effective\\s+date|agreement\\s+date|executed\\s+on|entered\\s+into\\s+(?:on|this)|dated|date',
  },
];

/** Human name for each slot, used in `reason`. */
const SLOT_LABEL: Readonly<Record<string, string>> = {
  creator_name: 'the creator’s name',
  creator_handle: 'their @handle',
  amount_usd: 'the agreed fee',
  deliverables: 'what they’re posting',
  schedule: 'when it goes live',
  payment_method: 'how they get paid',
  artist_name: 'your artist',
  campaign_name: 'the song or campaign',
  date: 'the date',
  firm_name: 'your label’s name',
};

// "Words immediately before the blank": a keyword, optional "(s)", an optional
// colon/dash, whitespace, end of window. Anchored at the end so only an
// adjacent label counts — a contract mentioning "fee" two clauses earlier must
// not claim an unrelated blank.
const BEFORE_RULES = LABEL_RULES.map((r) => ({
  placeholder: r.placeholder,
  re: new RegExp(`(?:^|[^A-Za-z0-9_])(?:${r.words})\\s*(?:\\(s\\))?\\s*[:\\-–—]?[ \\t]*$`, 'i'),
}));
// Same keywords, matched anywhere INSIDE a bracketed blank, because there the
// blank carries its own label: [ARTIST NAME], [Influencer Handle].
const INNER_RULES = LABEL_RULES.map((r) => ({
  placeholder: r.placeholder,
  re: new RegExp(`(?:^|[^A-Za-z0-9_])(?:${r.words})(?:[^A-Za-z0-9_]|$)`, 'i'),
}));

/** Underscore runs, dot leaders, and bracketed fill-ins — how a paper contract
 *  writes "someone types here". */
const BLANK_RE = /_{3,}|\.{5,}|\[[^[\]\n]{1,60}\]/g;
/** Occupied spans: anything already a {{slot}} is finished business. */
const EXISTING_SLOT_RE = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/g;

/** Words before the blank that a label could live in. Long enough for
 *  "Name of the Content Creator:", short enough not to reach the last clause. */
const LABEL_WINDOW = 64;
/** A pathological document must not produce a thousand-chip UI. */
const MAX_SUGGESTIONS = 120;

function excerptAround(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 45);
  const to = Math.min(text.length, end + 35);
  const lead = from > 0 ? '…' : '';
  const tail = to < text.length ? '…' : '';
  return `${lead}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${tail}`;
}

/**
 * Propose where the fillable slots belong in an imported contract.
 *
 * SUGGESTIONS ONLY. Nothing here rewrites `text`; the caller renders each one
 * as a marker and a human decides. That is not a UI preference — it is the
 * reason this function can exist at all. Deciding that the blank after
 * "Influencer:" is the creator and the blank after "Label:" is the firm is a
 * guess about someone's operative agreement, and a wrong guess reads exactly
 * like a right one.
 *
 * Deterministic: a pure regex pass, no model, no scoring, no randomness.
 * Suggestions never overlap each other and never overlap an existing
 * {{slot}} — a document that already carries slots gets proposals only in the
 * gaps between them.
 *
 * Two spans are wider than they look, and both are correctness, not polish:
 * buildContractVars renders amount_usd as "$1200" and creator_handle as
 * "@name", so a suggestion over "$______" must swallow the "$" and one over
 * "@______" must swallow the "@". Replacing only the underscores yields
 * "$$1200" in a payment clause.
 */
export function suggestBlanks(text: string): BlankSuggestion[] {
  if (!text) return [];

  const occupied: Array<[number, number]> = [];
  for (const m of text.matchAll(EXISTING_SLOT_RE)) {
    occupied.push([m.index, m.index + m[0].length]);
  }
  const overlapsOccupied = (s: number, e: number) =>
    occupied.some(([os, oe]) => s < oe && e > os);

  const out: BlankSuggestion[] = [];
  let lastEnd = 0;

  for (const m of text.matchAll(BLANK_RE)) {
    if (out.length >= MAX_SUGGESTIONS) break;
    let start = m.index;
    const end = start + m[0].length;
    if (start < lastEnd) continue; // never overlap an earlier suggestion

    const bracketed = m[0].startsWith('[');
    let placeholder: KnownPlaceholder | null = null;
    let reason = '';

    // A currency or at-sign prefix is the strongest signal there is, and it
    // also has to be absorbed into the span.
    const prefix = text.slice(Math.max(0, start - 8), start);
    const sigil = prefix.match(/([$@])[ \t]*$/);
    if (sigil) {
      const sigilStart = start - (prefix.length - prefix.lastIndexOf(sigil[1]));
      if (sigil[1] === '$') {
        placeholder = 'amount_usd';
        reason = 'A blank after a dollar sign. The $ is replaced too — the filled amount already includes it.';
      } else {
        placeholder = 'creator_handle';
        reason = 'A blank after an @. The @ is replaced too — the filled handle already includes it.';
      }
      start = sigilStart;
    }

    // A bracketed blank labels itself: [ARTIST NAME].
    if (!placeholder && bracketed) {
      const inner = m[0].slice(1, -1);
      for (const rule of INNER_RULES) {
        if (rule.re.test(inner)) {
          placeholder = rule.placeholder;
          reason = `The blank “${m[0]}” names ${SLOT_LABEL[rule.placeholder] ?? rule.placeholder}.`;
          break;
        }
      }
    }

    // Otherwise the words immediately before it.
    if (!placeholder) {
      const window = text.slice(Math.max(0, start - LABEL_WINDOW), start);
      for (const rule of BEFORE_RULES) {
        const hit = window.match(rule.re);
        if (hit) {
          placeholder = rule.placeholder;
          reason = `Follows “${hit[0].trim().replace(/\s+/g, ' ')}”, which reads as ${SLOT_LABEL[rule.placeholder] ?? rule.placeholder}.`;
          break;
        }
      }
    }

    // An unlabelled blank stays a blank. Creator Campaigns does not get to decide
    // what an anonymous line in someone's contract was for.
    if (!placeholder) continue;
    // Belt and braces: the rule tables are built from DEAL_FILLABLE_PLACEHOLDERS'
    // own members, and this makes a future edit that adds an unfillable one
    // (a {{governing_law}} rule, say) produce nothing rather than a template
    // that always blocks at the send gate.
    if (!PROPOSABLE.has(placeholder)) continue;
    if (overlapsOccupied(start, end)) continue;

    out.push({ start, end, excerpt: excerptAround(text, start, end), placeholder, reason });
    lastEnd = end;
  }

  return out;
}
