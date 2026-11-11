// tests/message-status.test.ts
//
// Hermetic unit test for src/lib/message-status.ts — the vocabulary of
// `outreach_messages.status`.
//
// This module exists because a review found `window_closed` was an ORPHAN
// status: written in one place, read in none. The application therefore
// treated a closed message as an ordinary unsent draft — the Send button
// stayed live, clicking it re-sent the message and overwrote the status, and
// two screens rendered the literal string `Window_closed` at the user.
//
// The property under test is narrow and absolute: nothing terminal is
// sendable, and no status ever reaches a human as a raw column value.
//
// Run: npx tsx tests/message-status.test.ts

import {
  MESSAGE_STATUS_VALUES,
  MESSAGE_STATUS_LABELS,
  TERMINAL_MESSAGE_STATUSES,
  TERMINAL_UNSENT_MESSAGE_STATUSES,
  isSendableMessageStatus,
  isWindowClosed,
  messageStatusLabel,
} from '../src/lib/message-status';

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

function main() {
  // ── Sendability — the rule that stops a human undoing the window ─────────
  {
    assert(
      isSendableMessageStatus('draft'),
      'a draft is sendable — the ordinary case must keep working',
    );
    assert(isSendableMessageStatus('queued'), 'a queued message is still sendable');
    assert(
      isSendableMessageStatus(null) && isSendableMessageStatus(undefined),
      'a null status is sendable — the column default predates most writers, and treating legacy rows as terminal would silently freeze the outreach queue',
    );

    for (const s of TERMINAL_MESSAGE_STATUSES) {
      assert(
        !isSendableMessageStatus(s),
        `'${s}' is terminal and must never be offered for sending`,
      );
    }
    assert(
      !isSendableMessageStatus('window_closed'),
      'window_closed specifically is not sendable — this is the predicate the Send button and the send route both gate on',
    );
  }

  // ── window_closed identification ─────────────────────────────────────────
  {
    assert(isWindowClosed('window_closed'), 'window_closed is recognised');
    for (const s of ['sent', 'draft', 'queued', 'failed', null, undefined, '']) {
      assert(!isWindowClosed(s), `'${s}' is not window_closed`);
    }
  }

  // ── Labels — no raw snake_case ever reaches a human ──────────────────────
  {
    assert(
      messageStatusLabel('window_closed') === 'window closed',
      'window_closed renders as words, not as Window_closed (CSS capitalize does not break on an underscore)',
    );
    for (const s of MESSAGE_STATUS_VALUES) {
      const label = messageStatusLabel(s);
      assert(
        !label.includes('_'),
        `the label for '${s}' contains no underscore, so it can be shown to a user as-is`,
      );
      assert(
        typeof MESSAGE_STATUS_LABELS[s] === 'string' && MESSAGE_STATUS_LABELS[s].length > 0,
        `'${s}' has an explicit label rather than relying on the fallback`,
      );
    }
    assert(
      messageStatusLabel(null) === 'draft',
      'a null status labels as draft, matching the column default',
    );
    // The fallback is what keeps a future value from leaking raw.
    assert(
      messageStatusLabel('some_future_state') === 'some future state',
      'an unknown status still renders as words — the fallback de-underscores rather than passing the token through',
    );
  }

  // ── Vocabulary shape ─────────────────────────────────────────────────────
  {
    assert(
      MESSAGE_STATUS_VALUES.includes('window_closed'),
      'window_closed is a declared member of the vocabulary, not an ad-hoc string',
    );
    for (const s of TERMINAL_UNSENT_MESSAGE_STATUSES) {
      assert(
        (TERMINAL_MESSAGE_STATUSES as readonly string[]).includes(s),
        `'${s}' is terminal-unsent, so it must also be terminal`,
      );
      assert(
        (s as string) !== 'sent',
        `'${s}' is terminal-unsent and therefore must not be 'sent'`,
      );
    }
    assert(
      !(TERMINAL_UNSENT_MESSAGE_STATUSES as readonly string[]).includes('sent'),
      "'sent' is terminal but NOT terminal-unsent — the analytics readers use status='sent' as their denominator and window_closed must never join it",
    );
  }

  console.log(`message-status test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main();
