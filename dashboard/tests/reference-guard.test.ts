// tests/reference-guard.test.ts
//
// Unit tests for src/lib/reference-guard.ts. The
// misattribution case is exercised explicitly via the deterministic string gate
// (hermetic, no LLM). The provenance-LLM path is driven by a deterministic mock
// provider (same seam the negotiation harness uses).
//
// Run: npx tsx tests/reference-guard.test.ts

process.env.MODEL_PROVIDER = 'mock';

import { registerProvider } from '../src/lib/model-provider';
import {
  validateReference,
  referenceMentionsArtist,
  shouldUseReference,
  REFERENCE_MIN_CONFIDENCE,
} from '../src/lib/reference-guard';

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

// Deterministic provenance model. Keys off the post text embedded in the prompt.
registerProvider('mock', async ({ user }) => {
  if (user.includes('gym routine')) return JSON.stringify({ about_promoted_release: false, creator_is_author: false, confidence: 0.9 });
  if (user.includes('reacting to the hottest')) return JSON.stringify({ about_promoted_release: true, creator_is_author: false, confidence: 0.95 });
  if (user.includes('lipsync bit')) return JSON.stringify({ about_promoted_release: false, creator_is_author: false, confidence: 0.2 });
  // The flagship inverse case: a songwriter's OWN single.
  if (user.includes('LEAVING YOUR GRASS')) return JSON.stringify({ about_promoted_release: false, creator_is_author: true, confidence: 0.9 });
  // Commentary on someone else's work — "take on" framing is legitimate here.
  if (user.includes('Sandman finale score')) return JSON.stringify({ about_promoted_release: false, creator_is_author: false, confidence: 0.85 });
  // Malformed authorship field → must default to true (the safe framing).
  if (user.includes('mystery clip')) return JSON.stringify({ about_promoted_release: false, confidence: 0.8 });
  return JSON.stringify({ about_promoted_release: false, creator_is_author: false, confidence: 0.8 });
});

async function main() {
  // ── 1. referenceMentionsArtist (pure, deterministic) ──────────────────────
  assert(
    referenceMentionsArtist('my acoustic cover of Midnight City', 'The Midnight', 'Midnight City'),
    'mentions: track name present → true',
  );
  assert(
    referenceMentionsArtist('loved the new Alex Owner single tbh', 'Alex Owner'),
    'mentions: artist name present → true',
  );
  assert(
    !referenceMentionsArtist('my morning skincare routine', 'Alex Owner', 'Sunrise'),
    'mentions: unrelated own content → false',
  );
  assert(
    !referenceMentionsArtist('', 'Alex Owner'),
    'mentions: empty post → false',
  );

  // ── 2. Misattribution (THE case) → rejected via the string gate, hermetic ──
  {
    const v = await validateReference({
      influencer_post: 'my cover of Sunrise absolutely blew up this week',
      artist_name: 'Alex Owner',
      track_name: 'Sunrise',
    });
    assert(v.ok === false, 'misattribution: reference to the promoted track is rejected');
    assert(v.confidence >= 0.9, 'misattribution: rejection is high-confidence');
    assert(/misattribute|references the promoted/i.test(v.reason), 'misattribution: reason explains the misattribution');
    assert(shouldUseReference(v) === false, 'misattribution: draft-gen would DROP this reference');
  }

  // Artist-name misattribution (no track given).
  {
    const v = await validateReference({
      influencer_post: 'reaction vid to the new Alex Owner track, so good',
      artist_name: 'Alex Owner',
    });
    assert(v.ok === false, 'misattribution: reaction to the artist is rejected');
    assert(shouldUseReference(v) === false, 'misattribution: dropped');
  }

  // ── 3. Clean creator content → accepted (LLM says not-about, high conf) ────
  {
    const v = await validateReference({
      influencer_post: 'my 5am gym routine that actually stuck',
      artist_name: 'Alex Owner',
      track_name: 'Sunrise',
    });
    assert(v.ok === true, 'clean: creator\'s own content is accepted');
    assert(v.confidence >= REFERENCE_MIN_CONFIDENCE, 'clean: confident enough to use');
    assert(shouldUseReference(v) === true, 'clean: draft-gen would USE this reference');
  }

  // ── 4. Semantically-about-the-artist (string-clean) → rejected via LLM ─────
  {
    const v = await validateReference({
      influencer_post: 'reacting to the hottest new indie drop everyone is posting',
      artist_name: 'Alex Owner',
      track_name: 'Sunrise',
    });
    assert(v.ok === false, 'llm: model catches semantic misattribution the strings miss');
    assert(shouldUseReference(v) === false, 'llm: dropped');
  }

  // ── 5. Low-confidence read → dropped ("drop the reference if unsure") ──────
  {
    const v = await validateReference({
      influencer_post: 'my lipsync bit from tuesday',
      artist_name: 'Alex Owner',
    });
    assert(v.ok === true, 'low-conf: not-about, so ok is true');
    assert(v.confidence < REFERENCE_MIN_CONFIDENCE, 'low-conf: confidence below threshold');
    assert(shouldUseReference(v) === false, 'low-conf: draft-gen DROPS a low-confidence reference');
  }

  // ── 6. Empty post → rejected ──────────────────────────────────────────────
  {
    const v = await validateReference({ influencer_post: '   ', artist_name: 'Alex Owner' });
    assert(v.ok === false, 'empty: no post text → rejected');
  }

  // ── 7. Authorship verdict (the "Nice take on <their own song>" class) ─────
  {
    // A songwriter posting their OWN single: usable AND flagged as their
    // original, so draft-gen must never frame it as a take/cover.
    const own = await validateReference({
      influencer_post: '"LEAVING YOUR GRASS" out March 30th, presave below',
      artist_name: 'Ada Sample',
    });
    assert(own.ok === true && shouldUseReference(own), 'author: own single is a usable reference');
    assert(own.creator_is_author === true, 'author: own single → creator_is_author true');

    // Commentary on someone else's work: usable, and "take on" framing is fine.
    const commentary = await validateReference({
      influencer_post: 'deep dive into the Sandman finale score',
      artist_name: 'Ada Sample',
    });
    assert(commentary.ok === true, 'author: commentary is usable');
    assert(commentary.creator_is_author === false, 'author: commentary → creator_is_author false');

    // Model omits the field → default TRUE (praising an original as original
    // is safe; calling an original a "take" insults its author).
    const unknown = await validateReference({
      influencer_post: 'mystery clip from the studio',
      artist_name: 'Ada Sample',
    });
    assert(unknown.creator_is_author === true, 'author: missing field defaults to true (safe framing)');

    // Deterministic reject path also carries the field.
    const rejected = await validateReference({
      influencer_post: 'my cover of the new Ada Sample single',
      artist_name: 'Ada Sample',
    });
    assert(rejected.ok === false && rejected.creator_is_author === false, 'author: string-gate reject → not-author');
  }

  console.log(`reference-guard test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
