// src/lib/payout-email.ts
//
// The creator payout-onboarding email: one plain-text body (stored on the
// outreach_messages row, always sent) and an HTML alternative derived from it
// at send time.
//
// Why derive instead of store: outreach_messages has no column for HTML or for
// structured fields, and adding one means a migration against the shared live
// project. More importantly, the row body is the thing an operator can read
// and edit, and the HTML must never say something the text does not. So the
// HTML is built ONLY when the stored body parses back into the exact fields
// that would have produced it (parse → rebuild → byte-equal). Any edit that
// changes the structure, and every row queued before this template existed,
// fails that check and goes out text-only, as every email did before.
//
// Deliverability choices (the goal is a trustworthy button that does not get
// spam-filtered):
//   - Single column, max 600px, white background, dark text, inline CSS only.
//   - System font stack; no web fonts, no images, no background images, no
//     tracking pixels, no URL shorteners, no script.
//   - Exactly ONE link: the button. Its href is the stable onboard redirect on
//     the app's own domain. The fallback URL under it is plain text (mail
//     clients auto-link it), so the link count and text-to-link ratio stay low.
//   - Bulletproof button: a table cell with bgcolor plus a border-padded <a>
//     (the Litmus border technique), which keeps its shape in Outlook desktop,
//     where padding on an inline <a> is ignored.
//   - No hidden preheader text: display:none content is itself a filter signal.
//   - No new List-Unsubscribe: this is a transactional message about money the
//     creator is owed. sendOutreach already stamps every email with the
//     existing mailto List-Unsubscribe header; that behaviour is unchanged.

export const PAYOUT_ONBOARDING_MESSAGE_TYPE = 'payout_onboarding';

export interface PayoutEmailFields {
  /** Creator handle without the leading @; null greets "Hi there,". */
  handle: string | null;
  /** Whole dollars, already rounded by the caller. */
  amountUsd: number;
  artistName: string;
  /** The stable `/api/payout/onboard/<id>` redirect, never a raw AccountLink. */
  onboardUrl: string;
  /** agreementTermsSentence(...) — one sentence, no newline. */
  termsSentence: string;
  /** Who signs the email; capitalised at the start, null → "The team". */
  signoff: string | null;
}

/**
 * The only href the button may carry: http(s), no whitespace or markup
 * characters, path ending in /api/payout/onboard/<id>.
 */
const ONBOARD_URL_RE = /^https?:\/\/[^\s<>"'`]+\/api\/payout\/onboard\/[A-Za-z0-9-]+$/;

export function isOnboardUrl(url: string): boolean {
  return ONBOARD_URL_RE.test(url);
}

/** The stable redirect path for one payment leg; the email's link ends with it. */
export function onboardPathFor(paymentAuthorizationId: string): string {
  return `/api/payout/onboard/${paymentAuthorizationId}`;
}

/**
 * What to do with the payout-setup email for one payment leg.
 *   queued          queue one now
 *   already_queued  one is queued (or a draft) for this leg; it is about to go
 *   already_sent    one went out and this is not an explicit re-send
 */
export type OnboardingEmailDecision = 'queued' | 'already_queued' | 'already_sent';

/**
 * At most one live payout-setup email per payment leg (a Retry followed by a
 * "Re-send payout setup email" click would otherwise queue two). `existing` is
 * this lead's payout_onboarding rows; a
 * row belongs to this leg when its body carries this leg's onboard link, which
 * is the only per-leg key outreach_messages has. Rows that never went out
 * (failed, superseded, window_closed) do not count. Only an explicit re-send
 * may add a second email, and only once the previous one has been sent.
 */
export function decideOnboardingEmail(
  existing: ReadonlyArray<{ status: string | null; body: string | null }>,
  paymentAuthorizationId: string,
  explicitResend: boolean
): OnboardingEmailDecision {
  const path = onboardPathFor(paymentAuthorizationId);
  const forLeg = existing.filter((m) => {
    const body = m.body ?? '';
    let at = body.indexOf(path);
    while (at >= 0) {
      // The id must end here: pa-1 is not pa-10.
      if (!/[A-Za-z0-9-]/.test(body.charAt(at + path.length))) return true;
      at = body.indexOf(path, at + 1);
    }
    return false;
  });
  if (forLeg.some((m) => m.status === null || m.status === 'draft' || m.status === 'queued')) return 'already_queued';
  if (forLeg.some((m) => m.status === 'sent') && !explicitResend) return 'already_sent';
  return 'queued';
}

export function payoutOnboardingSubject(artistName: string): string {
  return `Set up your payout for the ${artistName} collab`;
}

function greetingName(handle: string | null): string {
  const h = handle?.trim().replace(/^@+/, '') ?? '';
  return h ? `@${h}` : 'there';
}

function signoffLine(signoff: string | null): string {
  const s = signoff?.trim() ?? '';
  if (!s) return 'The team';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function amountLabel(amountUsd: number): string {
  return `$${Math.round(amountUsd).toLocaleString('en-US')}`;
}

function headline(f: PayoutEmailFields): string {
  return `Your ${amountLabel(f.amountUsd)} payment for the ${f.artistName} collab is ready.`;
}

const STRIPE_LINE = 'Payouts are handled securely by Stripe. Takes about 2 minutes.';

function afterwardsSentence(artistName: string): string {
  return (
    `Once that's done, your payment goes out automatically and the promo pack ` +
    `(the ${artistName} track to promote) is emailed to you the moment it lands.`
  );
}

/** The stored body and the text/plain part. The URL sits on its own line. */
export function payoutOnboardingText(f: PayoutEmailFields): string {
  return [
    `Hi ${greetingName(f.handle)},`,
    '',
    headline(f),
    '',
    'Set up your payout here to receive it:',
    f.onboardUrl,
    '',
    STRIPE_LINE,
    '',
    `${afterwardsSentence(f.artistName)} ${f.termsSentence}`,
    '',
    'Thanks,',
    signoffLine(f.signoff),
  ].join('\n');
}

const TEXT_RE = new RegExp(
  [
    '^Hi (.+),',
    '',
    'Your \\$([0-9][0-9,]*) payment for the (.+) collab is ready\\.',
    '',
    'Set up your payout here to receive it:',
    '(\\S+)',
    '',
    'Payouts are handled securely by Stripe\\. Takes about 2 minutes\\.',
    '',
    "Once that's done, your payment goes out automatically and the promo pack \\(the .+ track to promote\\) is emailed to you the moment it lands\\. (.+)",
    '',
    'Thanks,',
    '(.+)$',
  ].join('\\n'),
);

/**
 * Recover the fields from a stored body, or null. Returns fields only when
 * rebuilding the text from them reproduces the body byte for byte, so an
 * HTML part rendered from the result says exactly what the text part says.
 */
export function parsePayoutOnboardingText(body: string): PayoutEmailFields | null {
  const m = TEXT_RE.exec(body);
  if (!m) return null;
  const [, greet, amount, artistName, onboardUrl, termsSentence, signoff] = m;
  if (!isOnboardUrl(onboardUrl)) return null;
  const amountUsd = Number(amount.replace(/,/g, ''));
  if (!Number.isFinite(amountUsd)) return null;
  const handle = greet === 'there' ? null : greet.startsWith('@') ? greet.slice(1) : null;
  if (handle === null && greet !== 'there') return null;
  const fields: PayoutEmailFields = { handle, amountUsd, artistName, onboardUrl, termsSentence, signoff };
  return payoutOnboardingText(fields) === body ? fields : null;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = '#1f2328';
const MUTED = '#57606a';
const BUTTON = '#111827';

/** The text/html part. Throws on a URL that is not the stable onboard redirect. */
export function payoutOnboardingHtml(f: PayoutEmailFields): string {
  if (!isOnboardUrl(f.onboardUrl)) {
    throw new Error('payoutOnboardingHtml: onboardUrl is not a stable onboard redirect');
  }
  const url = esc(f.onboardUrl);
  const p = (style: string, inner: string) => `<p style="margin:0;${style}">${inner}</p>`;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    `<title>${esc(payoutOnboardingSubject(f.artistName))}</title>`,
    '</head>',
    '<body style="margin:0;padding:0;background-color:#ffffff;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;">',
    '<tr><td align="center" style="padding:32px 16px;">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">',
    `<tr><td style="font-family:${FONT};font-size:16px;line-height:24px;color:${INK};text-align:left;">`,
    p('padding:0 0 16px 0;', `Hi ${esc(greetingName(f.handle))},`),
    p('padding:0 0 8px 0;font-size:20px;line-height:28px;font-weight:600;color:#111111;', esc(headline(f))),
    p('padding:0 0 24px 0;', 'Set up your payout to receive it.'),
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0">',
    `<tr><td align="center" bgcolor="${BUTTON}" style="border-radius:6px;background-color:${BUTTON};">`,
    `<a href="${url}" target="_blank" style="display:inline-block;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;background-color:${BUTTON};border-top:12px solid ${BUTTON};border-bottom:12px solid ${BUTTON};border-left:28px solid ${BUTTON};border-right:28px solid ${BUTTON};">Set up payout</a>`,
    '</td></tr>',
    '</table>',
    p(`padding:16px 0 0 0;font-size:14px;line-height:20px;color:${MUTED};`, esc(STRIPE_LINE)),
    p(
      `padding:16px 0 24px 0;font-size:12px;line-height:18px;color:${MUTED};`,
      `If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all;">${url}</span>`,
    ),
    p('padding:0 0 24px 0;', esc(`${afterwardsSentence(f.artistName)} ${f.termsSentence}`)),
    p('padding:0;', `Thanks,<br>${esc(signoffLine(f.signoff))}`),
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * The HTML alternative for an outbound email, or null for text-only. Only
 * message types that opt in get one; everything else is unchanged.
 */
export function outboundHtmlFor(messageType: string | null | undefined, body: string): string | null {
  if (messageType !== PAYOUT_ONBOARDING_MESSAGE_TYPE) return null;
  const fields = parsePayoutOnboardingText(body);
  return fields ? payoutOnboardingHtml(fields) : null;
}
