// tests/inbound-sender-auth.test.ts
//
// Hermetic tests for the THIRD lock on inbound reply trust:
//   src/lib/channels/inbound-authentication.ts — RFC 8601 verdict evaluation
//                                                 + the policy that consumes it
//   src/lib/channels/resend-inbound.ts         — what Resend does (not) expose
//   src/lib/channels/email-inbound.ts          — the `<`-density CPU guard
//
// No network, no env dependency beyond what each case sets and restores.
//
// ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
//
// An inbound reply can advance a lead to `responded` and be handed to the
// autonomous negotiator, which can counter, accept and close a deal. Every
// signal the first two locks read — the correlation tag, the `From` header — is
// carried BY the message. Resend performs no SPF/DKIM/DMARC check we can see
// and publishes no verdict field, so a plain `From: jane@creator.example`
// spoof satisfies both.
//
// The rule these cases defend: an inbound reply may only advance state
// AUTONOMOUSLY when the sender is authenticated. Everything else is ingested,
// visible, and queued for a human.
//
// Run: npx tsx tests/inbound-sender-auth.test.ts

import {
  GMAIL_AUTHSERV_ID,
  evaluateSenderAuthentication,
  parseAuthenticationResults,
  resolveInboundAuthPolicy,
  type InboundAuthPolicy,
} from '../src/lib/channels/inbound-authentication';
import { authenticationResultsValue, toInboundEmailMessage } from '../src/lib/channels/resend-inbound';
import { MAX_BODY_CHARS, htmlToPlainText } from '../src/lib/channels/email-inbound';

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

const TRUSTED: InboundAuthPolicy = {
  requireAuthentication: true,
  trustedAuthservIds: [GMAIL_AUTHSERV_ID],
};

const JANE = 'jane@creator.example';

function verdict(headerValue: string | null, fromMailbox: string | null = JANE, policy = TRUSTED) {
  return evaluateSenderAuthentication({ headerValue, fromMailbox, policy });
}

async function main() {
  // ── 1. RFC 8601 parsing ───────────────────────────────────────────────────

  {
    const p = parseAuthenticationResults(
      'mx.google.com; dkim=pass header.d=creator.example; spf=pass smtp.mailfrom=jane@creator.example; dmarc=pass header.from=creator.example',
    );
    assert(p?.authservId === 'mx.google.com', 'case1: the authserv-id is the first segment');
    assert(p?.methods.dkim?.result === 'pass', 'case2: dkim result parses');
    assert(
      p?.methods.dkim?.props['header.d'] === 'creator.example',
      'case3: ptype.property pairs parse alongside the result',
    );
    assert(p?.methods.dmarc?.result === 'pass', 'case4: dmarc result parses');
  }

  {
    // Real Gmail wraps the value across lines and embeds comments.
    const p = parseAuthenticationResults(
      'mx.google.com;\r\n       dkim=pass header.i=@creator.example header.s=s1 header.b=AbCd;\r\n       spf=pass (google.com: domain of jane@creator.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=jane@creator.example;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=creator.example',
    );
    assert(p?.authservId === 'mx.google.com', 'case5: folded whitespace does not break the parse');
    assert(
      p?.methods.spf?.props['smtp.mailfrom'] === 'jane@creator.example',
      'case6: a parenthesised comment before the property is stripped, not parsed',
    );
    assert(p?.methods.dmarc?.result === 'pass', 'case7: a comment between result and property is stripped');
  }

  {
    assert(
      parseAuthenticationResults('authserv.example; none') === null,
      'case8: a `none` result carries no method and parses to null',
    );
    assert(parseAuthenticationResults('') === null, 'case9: an empty value parses to null');
    assert(parseAuthenticationResults(null) === null, 'case10: a missing value parses to null');
    assert(
      parseAuthenticationResults('dkim=pass header.d=evil.example') === null,
      'case11-sec: a value with no authserv-id is refused, not read as a method',
    );
  }

  {
    // First occurrence of a method wins — a trailing duplicate cannot upgrade a
    // fail into a pass inside one header value.
    const p = parseAuthenticationResults('mx.google.com; dmarc=fail header.from=creator.example; dmarc=pass');
    assert(
      p?.methods.dmarc?.result === 'fail',
      'case12-sec: a duplicated method cannot be upgraded by a later copy',
    );
  }

  // ── 2. The verdict: trust, then alignment ─────────────────────────────────

  {
    const v = verdict('mx.google.com; dmarc=pass header.from=creator.example');
    assert(v.authenticated && v.outcome === 'dmarc_pass', 'case13: an aligned DMARC pass authenticates');
  }

  {
    const v = verdict('mx.google.com; dkim=pass header.d=creator.example');
    assert(v.authenticated && v.outcome === 'dkim_aligned', 'case14: an aligned DKIM pass authenticates');
    const sub = verdict('mx.google.com; dkim=pass header.d=mail.creator.example');
    assert(sub.authenticated, 'case15: relaxed alignment accepts a subdomain signer');
  }

  {
    // The classic near-miss: a domain that merely ENDS with the real one.
    const v = verdict('mx.google.com; dkim=pass header.d=evilcreator.example');
    assert(
      !v.authenticated && v.outcome === 'unaligned',
      'case16-sec: `evilcreator.example` does not align with `creator.example`',
    );
  }

  {
    // SPF pass proves the envelope sender's domain, which the attacker chooses
    // independently of the From header they wrote.
    const v = verdict('mx.google.com; spf=pass smtp.mailfrom=bounce@evil.example');
    assert(
      !v.authenticated && v.outcome === 'unaligned',
      'case17-sec: an UNALIGNED spf=pass proves nothing about the From identity',
    );
    const aligned = verdict('mx.google.com; spf=pass smtp.mailfrom=jane@creator.example');
    assert(aligned.authenticated && aligned.outcome === 'spf_aligned', 'case18: an aligned SPF pass authenticates');
  }

  {
    assert(!verdict('mx.google.com; dmarc=fail header.from=creator.example').authenticated,
      'case19-sec: dmarc=fail never authenticates');
    assert(
      verdict('mx.google.com; dmarc=fail header.from=creator.example').outcome === 'explicit_fail',
      'case20: an explicit failure is reported as such',
    );
    assert(
      !verdict('mx.google.com; dkim=fail header.d=creator.example; spf=pass smtp.mailfrom=jane@creator.example')
        .authenticated,
      'case21-sec: a dkim failure is not rescued by an SPF pass beneath it',
    );
    assert(
      !verdict('mx.google.com; dmarc=fail header.from=creator.example; dkim=pass header.d=creator.example')
        .authenticated,
      'case22-sec: a DMARC failure outranks a DKIM pass',
    );
  }

  {
    // THE FORGERY THIS LOCK EXISTS FOR: the attacker writes their own verdict.
    const forged = verdict(
      'evil.example; dmarc=pass header.from=creator.example; dkim=pass header.d=creator.example',
    );
    assert(
      !forged.authenticated && forged.outcome === 'untrusted_authserv',
      'case23-sec: a verdict stamped by an untrusted authserv-id is worthless',
    );
    assert(forged.authservId === 'evil.example', 'case24: the untrusted authserv-id is reported for the log');
  }

  {
    assert(
      verdict(null).outcome === 'no_verdict_header' && !verdict(null).authenticated,
      'case25-sec: no Authentication-Results means NOT authenticated',
    );
    assert(
      !verdict('mx.google.com; dmarc=pass header.from=creator.example', null).authenticated,
      'case26-sec: a verdict with no single From mailbox cannot be aligned, so it fails',
    );
    assert(
      !verdict('mx.google.com; dmarc=pass header.from=other.example').authenticated,
      'case27-sec: a DMARC pass about a DIFFERENT header.from does not authenticate',
    );
  }

  {
    // An empty trust list is the default for Resend, and must be decisive.
    const none: InboundAuthPolicy = { requireAuthentication: true, trustedAuthservIds: [] };
    const v = verdict('mx.google.com; dmarc=pass header.from=creator.example', JANE, none);
    assert(
      !v.authenticated && v.outcome === 'no_trusted_authserv_configured',
      'case28-sec: with NO configured authserv-id, even a perfect verdict is not believed',
    );
  }

  // ── 3. Policy resolution from the environment ─────────────────────────────

  {
    const prevMode = process.env.INBOUND_SENDER_AUTH_MODE;
    const prevIds = process.env.INBOUND_TRUSTED_AUTHSERV_IDS;
    delete process.env.INBOUND_SENDER_AUTH_MODE;
    delete process.env.INBOUND_TRUSTED_AUTHSERV_IDS;

    const bare = resolveInboundAuthPolicy();
    assert(
      bare.requireAuthentication === true,
      'case29-sec: authentication is REQUIRED by default — the safe side',
    );
    assert(
      bare.trustedAuthservIds.length === 0,
      'case30-sec: no authserv-id is trusted by default; the Resend transport adds none',
    );

    const gmail = resolveInboundAuthPolicy([GMAIL_AUTHSERV_ID]);
    assert(
      gmail.trustedAuthservIds.includes('mx.google.com'),
      'case31: the Gmail transport contributes its own MX as a built-in trust',
    );

    process.env.INBOUND_SENDER_AUTH_MODE = 'permissive';
    assert(
      resolveInboundAuthPolicy().requireAuthentication === false,
      'case32: `permissive` is the explicit, findable opt-out',
    );

    for (const typo of ['REQUIRE', 'permisive', 'true', 'off', '']) {
      process.env.INBOUND_SENDER_AUTH_MODE = typo;
      assert(
        resolveInboundAuthPolicy().requireAuthentication === true,
        `case33-sec: '${typo}' does not silently disable the gate`,
      );
    }

    delete process.env.INBOUND_SENDER_AUTH_MODE;
    process.env.INBOUND_TRUSTED_AUTHSERV_IDS = ' MX.Example.Com , second.example ';
    const configured = resolveInboundAuthPolicy([GMAIL_AUTHSERV_ID]);
    assert(
      configured.trustedAuthservIds.includes('mx.example.com') &&
        configured.trustedAuthservIds.includes('second.example'),
      'case34: the env list is parsed, trimmed and lowercased',
    );
    assert(
      configured.trustedAuthservIds.includes('mx.google.com'),
      'case35-sec: the env list is ADDITIVE — it cannot silently drop a built-in trust',
    );

    if (prevMode === undefined) delete process.env.INBOUND_SENDER_AUTH_MODE;
    else process.env.INBOUND_SENDER_AUTH_MODE = prevMode;
    if (prevIds === undefined) delete process.env.INBOUND_TRUSTED_AUTHSERV_IDS;
    else process.env.INBOUND_TRUSTED_AUTHSERV_IDS = prevIds;
  }

  // ── 4. H4/H5: what Resend actually hands us ───────────────────────────────
  //
  // Verified 2026-09-18 against Resend's full published docs corpus: the
  // `email.received` webhook documents ten `data` fields and none is an auth
  // verdict; the retrieve response does not document `headers` at all, showing
  // it only in an example with `from`, `return-path` and `mime-version`.

  {
    // The documented example shape — no verdict anywhere in it.
    const documented = {
      id: '56761188-7520-42d8-8898-ff6fc54ce618',
      headers: {
        from: 'Acme <onboarding@resend.dev>',
        'return-path': 'bounces@resend.example',
        'mime-version': '1.0',
      },
      text: 'Sounds great.',
    };
    assert(
      authenticationResultsValue(documented) === null,
      'case36: the documented Resend retrieve shape exposes NO authentication verdict',
    );
    assert(authenticationResultsValue(null) === null, 'case37: a missing retrieve result exposes none either');
    assert(authenticationResultsValue({ id: 'x' }) === null, 'case38: absent headers expose none either');
  }

  {
    // If Resend ever DOES pass it through, we read it case-insensitively — but
    // reading is not believing: the trust list still has to name the authserv-id.
    const withHeader = {
      id: 'x',
      headers: { 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=creator.example' },
    };
    assert(
      authenticationResultsValue(withHeader)?.startsWith('mx.google.com') === true,
      'case39: the header is read case-insensitively when present',
    );
    const resendPolicy: InboundAuthPolicy = { requireAuthentication: true, trustedAuthservIds: [] };
    assert(
      !evaluateSenderAuthentication({
        headerValue: authenticationResultsValue(withHeader),
        fromMailbox: JANE,
        policy: resendPolicy,
      }).authenticated,
      'case40-sec: ...and it still does not authenticate under the Resend default (empty trust list)',
    );
  }

  {
    // H5: `data.to` is not documented as envelope-derived, and the same payload
    // carries cc/bcc — which an SMTP envelope has no concept of. The
    // containment is that a FORGED `data.to` gets an unauthenticated message
    // queued for a human, which is what the message shape must make possible.
    const msg = toInboundEmailMessage(
      {
        type: 'email.received',
        data: {
          email_id: 'evt-1',
          to: ['operator+lead-11111111-2222-4333-8444-555555555555@operator.example'],
          from: JANE,
          created_at: '2026-09-18T12:00:00.000Z',
        },
      },
      { id: 'evt-1', headers: { from: `Jane <${JANE}>` }, text: 'yes, $2000 works' },
    );
    assert(
      msg.authenticationResults === null,
      'case41-sec-H5: a Resend message carries NO verdict, so a forged data.to cannot be authenticated',
    );
    assert(
      msg.envelopeRecipients.length === 1,
      'case42: the recipient values still reach correlation (admission is unchanged)',
    );
  }

  // ── 5. Residual: the `<`-density CPU guard ───────────────────────────────
  //
  // The 64KB ceiling bounds the worst case but does not make it cheap. The true
  // worst case AT the cap is 64,000 bare `<` — every one an opening delimiter
  // that never closes. Measured before the guard: 1556 ms, versus 0.4 ms for a
  // real HTML reply. Not an outage lever under maxDuration=15, but real cost on
  // a rate-limit bucket shared across Resend's egress IPs.

  {
    const flood = '<'.repeat(MAX_BODY_CHARS);
    const started = Date.now();
    const out = htmlToPlainText(flood);
    const elapsed = Date.now() - started;
    assert(
      elapsed < 100,
      `case43-sec: 64,000 bare '<' is cheap now (took ${elapsed}ms; was ~1556ms)`,
    );
    assert(out.length <= MAX_BODY_CHARS, 'case44-sec: the flood output is still bounded by the ceiling');
    assert(!out.includes('<'), 'case45: the delimiters are dropped rather than left in the body');

    // Past the cap, the guard must still hold.
    const overCap = '<'.repeat(MAX_BODY_CHARS * 4);
    const started2 = Date.now();
    htmlToPlainText(overCap);
    const elapsed2 = Date.now() - started2;
    assert(elapsed2 < 100, `case46-sec: an over-cap flood is truncated first, then cheap (${elapsed2}ms)`);
  }

  {
    // The guard must not change what a REAL html reply turns into — that is the
    // regression it would be easy to cause.
    const real = '<p>Hi Owen, $400 works for me.</p><br/><div>Jane</div>';
    assert(
      htmlToPlainText(real) === 'Hi Owen, $400 works for me.\n\nJane',
      'case47: ordinary HTML is unaffected by the density guard',
    );
    // Balanced markup at flood LENGTH is still parsed as markup, not shortcut.
    const bigReal = '<p>ok</p>'.repeat(8_000);
    assert(
      !htmlToPlainText(bigReal).includes('<p>'),
      'case48: a large but BALANCED document is still tag-stripped, not passed through',
    );
    // Entities survive the fast path.
    assert(
      htmlToPlainText(`${'<'.repeat(2_000)}&amp;`).endsWith('&'),
      'case49: entity decoding still runs on the fast path',
    );
  }

  console.log(`inbound-sender-auth test: ${passed} passed, ${failed} failed`);
  if (failures.length) console.error('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL: unexpected error', e);
  process.exit(1);
});
