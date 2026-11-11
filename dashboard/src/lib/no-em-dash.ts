// src/lib/no-em-dash.ts
//
// Product rule: no em dashes in anything a creator reads.
// Creators read them as AI-written. Every prompt that writes outbound copy
// already says so; this is the post-processing for when a model ignores it.
//
// An em dash becomes a comma (the replacement negotiation-tick's scrubAiTells
// and sanitizeSignoff already use), a dash that opens or closes a line is
// dropped ("— Alex" is a sign-off marker, not punctuation), and the comma
// it would leave next to other punctuation is collapsed. En dashes are left
// alone: "2–3 weeks" is a range, not a tell.
//
// Applied where model output enters the outbound path, before validation and
// before storage, so what is stored is exactly what is sent. Deliberately NOT
// applied at the transport (resend.ts): the label's own text (a contract it
// pasted in) is its wording to keep.

const EM = '—';
const SP = '[ \\t\\u00a0]';
const LEADING = new RegExp(`^(${SP}*)${EM}${SP}*`);
const TRAILING = new RegExp(`${SP}*${EM}${SP}*$`);
const INTERNAL = new RegExp(`${SP}*${EM}${SP}*`, 'g');

export function stripEmDashes(text: string): string {
  if (!text || !text.includes(EM)) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes(EM)) return line;
      return line
        .replace(LEADING, '$1')
        .replace(TRAILING, '')
        .replace(INTERNAL, ', ')
        .replace(/,[ \t]*,/g, ',')
        .replace(/,[ \t]*([.!?;:])/g, '$1');
    })
    .join('\n');
}
