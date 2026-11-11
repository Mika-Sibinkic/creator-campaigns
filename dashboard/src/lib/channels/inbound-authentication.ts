// src/lib/channels/inbound-authentication.ts
//
// The THIRD lock on inbound reply trust: was the sender AUTHENTICATED?
//
// ── WHY A THIRD LOCK EXISTS ─────────────────────────────────────────────────
//
// email-inbound.ts asks "does the envelope claim this belongs to lead X?".
// inbound-attribution.ts asks "is the From address that creator's?". Both
// questions are answered from the MESSAGE. Neither asks the only question that
// actually binds an identity to a sender: did the sending domain prove it?
//
// It does not, by default. `From` is free text. Once the display-name forgery
// (H1) is closed, a plain
//
//     From: jane@creator.example
//
// still sails through every check in this codebase, because nothing anywhere
// verifies SPF, DKIM or DMARC. Resend's own guidance names this exact mistake:
// "Trust email headers for authentication — headers are trivially spoofed"
// (resend/resend-skills, skills/agent-email-inbox/SKILL.md, "Never Do" table).
//
// ── WHAT RESEND ACTUALLY GIVES US: NOTHING ──────────────────────────────────
//
// Verified 2026-09-18 against Resend's complete published docs corpus
// (resend.com/docs/llms-full.txt, 363 pages):
//
//   - `email.received` documents ten `data` fields. None is an auth verdict,
//     and the webhook carries no headers at all by design.
//   - `GET /emails/receiving/:email_id` does not document `headers` AT ALL. It
//     appears only in the response example, with three keys: `from`,
//     `return-path`, `mime-version`.
//   - `Authentication-Results`, `ARC-Seal`, `ARC-Message-Signature`,
//     `ARC-Authentication-Results`, `Received-SPF` and `DKIM-Signature` occur
//     ZERO times across all 363 pages.
//   - No receiving page documents any SPF/DKIM/DMARC rejection upstream of the
//     webhook. `email.received` fires when Resend "successfully receives an
//     email"; "successfully" is never defined against authentication.
//
// And a structural fact that outlives any doc change: resend-node types the
// field `headers: Record<string, string> | null`. A flat string map CANNOT
// represent a repeated header name. `Authentication-Results` is legitimately
// repeated once per hop, and the ONLY trustworthy instance is the one the
// receiving MTA prepended. Collapsed into a map, an attacker's forged copy and
// the receiver's real one are indistinguishable — whichever the parser kept is
// what we would read. So even if Resend started passing the header through, the
// exposed SHAPE would still not let us trust it.
//
// ── THE POLICY ──────────────────────────────────────────────────────────────
//
// An inbound reply may only advance state AUTONOMOUSLY when the sender is
// authenticated. Where no trustworthy verdict exists, the message is still
// ingested and still visible — it is queued for a human instead of driving the
// negotiator. It cannot counter, cannot accept, cannot close.
//
// "Trustworthy" is deliberately narrow and deliberately CONFIGURED, never
// inferred: a verdict counts only when it was stamped by an authserv-id we were
// told to trust (RFC 8601 §5 — "the authserv-id … is used to determine whether
// the header field is trustworthy"). The trust list is empty by default, so the
// default answer is "no verdict", which is the safe side.
//
//   - Gmail transport: Google's own MX stamps `Authentication-Results:
//     mx.google.com; …` and PREPENDS it, and the Gmail API returns headers as an
//     ORDERED array, so taking the first occurrence genuinely yields the
//     receiver's verdict. `mx.google.com` is therefore trusted by default there.
//   - Resend transport: no default trust, for the reasons above. An operator who
//     later confirms Resend stamps and de-duplicates the header can opt in with
//     INBOUND_TRUSTED_AUTHSERV_IDS — an explicit, auditable act.
//
// Env:
//   INBOUND_SENDER_AUTH_MODE      `require` (default) | `permissive`
//   INBOUND_TRUSTED_AUTHSERV_IDS  comma-separated authserv-ids to trust
//
// `permissive` attributes on envelope correlation plus a From match, with no
// proof of sender. It exists so the
// policy is a switch someone can find and reason about rather than a fork in
// the code, and it is never the default.

/** Which authentication method produced the verdict, and how it landed. */
export type AuthOutcome =
  | 'dmarc_pass'
  | 'dkim_aligned'
  | 'spf_aligned'
  | 'explicit_fail'
  | 'unaligned'
  | 'no_verdict_header'
  | 'untrusted_authserv'
  | 'no_trusted_authserv_configured'
  | 'unparseable'
  | 'no_from_mailbox';

export interface AuthenticationVerdict {
  /** True ONLY on a trusted, aligned pass. Everything else is false. */
  authenticated: boolean;
  outcome: AuthOutcome;
  /** The authserv-id we read the verdict from, when there was one. */
  authservId: string | null;
  /** Human-readable, safe to log. Never contains the message body. */
  detail: string;
}

export interface InboundAuthPolicy {
  /**
   * When true (the default), an unauthenticated reply is ingested but NEVER
   * attributed — so it cannot drive the autonomous negotiator.
   */
  requireAuthentication: boolean;
  /** authserv-ids whose Authentication-Results we are willing to believe. */
  trustedAuthservIds: string[];
}

/** RFC 8601 `method=result` plus its `ptype.property=value` pairs. */
interface AuthMethodResult {
  result: string;
  props: Record<string, string>;
}

export interface ParsedAuthResults {
  authservId: string;
  methods: Record<string, AuthMethodResult>;
}

/** Strip RFC 5322 comments, which may appear anywhere in the header value. */
function stripComments(value: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && depth > 0) {
      i++;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/** Bound the work: a real Authentication-Results header is a few hundred bytes. */
const MAX_AUTH_HEADER_CHARS = 4_000;

/**
 * Parse one `Authentication-Results` value (RFC 8601).
 *
 *   mx.google.com;
 *     dkim=pass header.d=creator.example;
 *     spf=pass smtp.mailfrom=jane@creator.example;
 *     dmarc=pass header.from=creator.example
 *
 * Returns null when the value carries no authserv-id or no method at all.
 * A `none` result (`authserv.example; none`) parses to zero methods, which is
 * correctly NOT a pass.
 */
export function parseAuthenticationResults(
  value: string | null | undefined,
): ParsedAuthResults | null {
  if (!value) return null;
  const capped = value.length > MAX_AUTH_HEADER_CHARS ? value.slice(0, MAX_AUTH_HEADER_CHARS) : value;
  const cleaned = stripComments(capped).replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;

  const segments = cleaned.split(';').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  // Segment one is `authserv-id [authres-version]`.
  const authservId = segments[0].split(' ')[0].toLowerCase();
  if (!authservId || authservId.includes('=')) return null;

  const methods: Record<string, AuthMethodResult> = {};
  for (const segment of segments.slice(1)) {
    const tokens = segment.split(' ').filter(Boolean);
    if (tokens.length === 0) continue;
    const eq = tokens[0].indexOf('=');
    if (eq <= 0) continue; // e.g. the bare `none` result — not a method
    const method = tokens[0].slice(0, eq).toLowerCase();
    // `dkim/1` etc. — RFC 8601 allows a method version suffix.
    const methodName = method.split('/')[0];
    const result = tokens[0]
      .slice(eq + 1)
      .toLowerCase()
      .replace(/^"|"$/g, '');
    const props: Record<string, string> = {};
    for (const token of tokens.slice(1)) {
      const pEq = token.indexOf('=');
      if (pEq <= 0) continue;
      props[token.slice(0, pEq).toLowerCase()] = token
        .slice(pEq + 1)
        .toLowerCase()
        .replace(/^"|"$/g, '');
    }
    // First occurrence of a method wins; a later duplicate cannot upgrade it.
    if (!(methodName in methods)) methods[methodName] = { result, props };
  }

  return Object.keys(methods).length > 0 ? { authservId, methods } : null;
}

/** Domain part of an address, or of a bare domain. Lowercased. */
function domainOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/^<|>$/g, '');
  const at = v.lastIndexOf('@');
  const domain = at === -1 ? v : v.slice(at + 1);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/**
 * DMARC relaxed alignment: identical, or one is a subdomain of the other's
 * organisational domain. We do not ship a public-suffix list, so this is the
 * conservative half — a suffix match on a label boundary. `mail.creator.example`
 * aligns with `creator.example`; `evilcreator.example` does not.
 */
function aligned(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export interface EvaluateAuthArgs {
  /** The single Authentication-Results value the RECEIVER stamped, if any. */
  headerValue: string | null | undefined;
  /** The parsed From mailbox — alignment is measured against its domain. */
  fromMailbox: string | null | undefined;
  policy: InboundAuthPolicy;
}

/**
 * Turn a receiver-stamped Authentication-Results value into a verdict.
 *
 * Fails closed at every branch: no header, an authserv-id we were not told to
 * trust, an unparseable value, a pass that does not ALIGN with the From domain,
 * or any explicit `fail` all return `authenticated: false`.
 *
 * Alignment is the part that is easy to get wrong. `spf=pass` on its own proves
 * the envelope sender's domain, which an attacker controls independently of the
 * `From` header they wrote — so an unaligned SPF pass proves nothing about the
 * identity we are about to act on. Only DMARC (aligned by definition), or a
 * DKIM/SPF pass whose domain aligns with the From domain, counts.
 */
export function evaluateSenderAuthentication(args: EvaluateAuthArgs): AuthenticationVerdict {
  const { headerValue, fromMailbox, policy } = args;

  if (policy.trustedAuthservIds.length === 0) {
    return {
      authenticated: false,
      outcome: 'no_trusted_authserv_configured',
      authservId: null,
      detail:
        'no authserv-id is configured as trustworthy for this transport, so no verdict can be believed',
    };
  }
  if (!headerValue) {
    return {
      authenticated: false,
      outcome: 'no_verdict_header',
      authservId: null,
      detail: 'the receiver stamped no Authentication-Results header',
    };
  }

  const parsed = parseAuthenticationResults(headerValue);
  if (!parsed) {
    return {
      authenticated: false,
      outcome: 'unparseable',
      authservId: null,
      detail: 'Authentication-Results carried no authserv-id or no method result',
    };
  }
  if (!policy.trustedAuthservIds.includes(parsed.authservId)) {
    return {
      authenticated: false,
      outcome: 'untrusted_authserv',
      authservId: parsed.authservId,
      detail: `verdict is stamped by '${parsed.authservId}', which is not a trusted authserv-id`,
    };
  }

  const fromDomain = domainOf(fromMailbox);
  if (!fromDomain) {
    return {
      authenticated: false,
      outcome: 'no_from_mailbox',
      authservId: parsed.authservId,
      detail: 'no single From mailbox to align a verdict against',
    };
  }

  const dmarc = parsed.methods.dmarc;
  const dkim = parsed.methods.dkim;
  const spf = parsed.methods.spf;

  // An explicit failure is decisive, whatever else passed.
  for (const [name, m] of [
    ['dmarc', dmarc],
    ['dkim', dkim],
    ['spf', spf],
  ] as const) {
    if (m && (m.result === 'fail' || m.result === 'softfail' || m.result === 'permerror')) {
      if (name === 'dmarc' || (name === 'dkim' && !dmarc) || (name === 'spf' && !dmarc && !dkim)) {
        return {
          authenticated: false,
          outcome: 'explicit_fail',
          authservId: parsed.authservId,
          detail: `${name}=${m.result}`,
        };
      }
    }
  }

  // DMARC pass is alignment by definition; still confirm header.from when the
  // receiver reported it, because a mismatch there means we are reading a
  // verdict about a different message.
  if (dmarc?.result === 'pass') {
    const reported = domainOf(dmarc.props['header.from']);
    if (!reported || aligned(reported, fromDomain)) {
      return {
        authenticated: true,
        outcome: 'dmarc_pass',
        authservId: parsed.authservId,
        detail: `dmarc=pass for ${fromDomain}`,
      };
    }
    return {
      authenticated: false,
      outcome: 'unaligned',
      authservId: parsed.authservId,
      detail: `dmarc=pass reports header.from=${reported}, which does not align with ${fromDomain}`,
    };
  }

  if (dkim?.result === 'pass') {
    const signing = domainOf(dkim.props['header.d'] ?? dkim.props['header.i']);
    if (aligned(signing, fromDomain)) {
      return {
        authenticated: true,
        outcome: 'dkim_aligned',
        authservId: parsed.authservId,
        detail: `dkim=pass header.d=${signing} aligns with ${fromDomain}`,
      };
    }
  }

  if (spf?.result === 'pass') {
    const mailfrom = domainOf(spf.props['smtp.mailfrom'] ?? spf.props['smtp.helo']);
    if (aligned(mailfrom, fromDomain)) {
      return {
        authenticated: true,
        outcome: 'spf_aligned',
        authservId: parsed.authservId,
        detail: `spf=pass smtp.mailfrom=${mailfrom} aligns with ${fromDomain}`,
      };
    }
  }

  return {
    authenticated: false,
    outcome: 'unaligned',
    authservId: parsed.authservId,
    detail: `no aligned pass for ${fromDomain}`,
  };
}

/**
 * Resolve the policy from the environment.
 *
 * `defaultTrustedAuthservIds` is the transport's own built-in trust — Gmail
 * passes `['mx.google.com']` because Google's MX stamps and prepends that
 * verdict and the Gmail API preserves header ORDER; Resend passes nothing.
 * INBOUND_TRUSTED_AUTHSERV_IDS is ADDITIVE, never subtractive, so an operator
 * cannot silently widen trust by clearing a default they never set.
 *
 * Reads process.env directly rather than via getEnv(): getEnv throws on a
 * missing key, and an unset optional policy var must not explode an
 * unauthenticated webhook handler.
 */
export function resolveInboundAuthPolicy(
  defaultTrustedAuthservIds: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): InboundAuthPolicy {
  const mode = env.INBOUND_SENDER_AUTH_MODE?.trim().toLowerCase();
  const configured = (env.INBOUND_TRUSTED_AUTHSERV_IDS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return {
    // Anything other than the explicit opt-out means require. A typo must not
    // silently disable the gate.
    requireAuthentication: mode !== 'permissive',
    trustedAuthservIds: Array.from(
      new Set([...defaultTrustedAuthservIds.map((s) => s.toLowerCase()), ...configured]),
    ),
  };
}

/** Gmail's receiving MX stamps this authserv-id and prepends its own copy. */
export const GMAIL_AUTHSERV_ID = 'mx.google.com';
