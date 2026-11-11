// tests/draft-copy.test.ts
//
// Unit tests for the deterministic post-generation draft validator
// (checkDraftCopy in src/lib/openai.ts). The failure classes pinned here:
// banned-phrase leaks,
// "take on" framing of a creator's own original, invented track titles when
// track_name is null, the creator's own single attributed to the promoted
// artist, "upcoming" for a released track, and "recent" on years-old posts.
//
// Run: npx tsx tests/draft-copy.test.ts

process.env.MODEL_PROVIDER = 'mock';

import { checkDraftCopy } from '../src/lib/openai';

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

const base = {
  subject: 'Collab with Ada Sample',
  artistName: 'Ada Sample',
  trackName: 'Sample Single' as string | null,
  creatorBio: 'Singer. New single "Paper Lanterns" out now',
  creatorIsAuthor: false,
  releasePast: false,
};

function violations(over: Partial<Parameters<typeof checkDraftCopy>[0]> & { body: string }): string[] {
  return checkDraftCopy({ ...base, ...over });
}

// ── clean copy passes ────────────────────────────────────────────────────────
assert(
  violations({ body: "Hi Rowan, your storytelling angle fits what we're doing with Ada Sample. Would a paid post for the new single interest you?" }).length === 0,
  'clean body → no violations',
);

// ── banned phrases ──────────────────────────────────────────────────────────
for (const bad of [
  "We're thrilled about this.",
  'Your journey really resonates with us.',
  'This aligns perfectly with the campaign.',
  "You'd be a great fit.",
  'Your passion shines through.',
  'Loved your recent post.',
  'Your content caught our attention.',
  'A song — and a story.',
]) {
  assert(violations({ body: bad }).length > 0, `banned: "${bad.slice(0, 30)}…" flagged`);
}

// ── derivative framing on an original (the flagship "Nice take on" case) ────
assert(
  violations({ body: "Loved your take on 'Leaving Your Grass'.", creatorIsAuthor: true }).length > 0,
  'author: "your take on" flagged when the work is their own original',
);
assert(
  violations({ body: "Your deep dive into that film score was sharp.", creatorIsAuthor: false }).length === 0,
  'non-author: commentary framing allowed',
);
assert(
  violations({ body: "Enjoyed your cover of that classic.", creatorIsAuthor: true }).length > 0,
  'author: "your cover of" flagged on an original',
);

// ── invented titles when no track supplied ──────────────────────────────────
assert(
  violations({ body: `Ada Sample's new single "Paper Lanterns" drops soon.`, trackName: null }).length > 0,
  'null track: quoted title attributed to the artist flagged',
);
assert(
  violations({ body: 'Ada Sample has a new release coming.', trackName: null }).length === 0,
  'null track: no title named → clean',
);

// ── creator's own bio title attributed to the artist (either direction) ─────
assert(
  violations({ body: `We're gearing up for Ada Sample's new single "Paper Lanterns".` }).length > 0,
  'bio title: creator\'s own single next to the artist flagged (artist-first)',
);
assert(
  violations({ body: `"Paper Lanterns" is the perfect lead-in to Ada Sample.` }).length > 0,
  'bio title: creator\'s own single next to the artist flagged (title-first)',
);

// ── release framing ─────────────────────────────────────────────────────────
assert(
  violations({ body: "Ada Sample's upcoming release could fit your audience.", releasePast: true }).length > 0,
  'released track called "upcoming" flagged',
);
assert(
  violations({ body: "Ada Sample's upcoming release could fit your audience.", releasePast: false }).length === 0,
  '"upcoming" fine when the release is actually upcoming',
);

console.log(`draft-copy test: ${passed} passed, ${failed} failed`);
if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
process.exit(failed === 0 ? 0 : 1);
