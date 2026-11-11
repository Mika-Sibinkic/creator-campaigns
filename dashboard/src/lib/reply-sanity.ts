// src/lib/reply-sanity.ts
//
// Fishy-reply guard. Runs on inbound creator replies AFTER
// the prompt-injection guard and BEFORE the negotiator model. It routes two
// kinds of reply to the human-review (flagged) lane so the auto-negotiator never
// answers them:
//
//   ai_speculation  — the creator suspects they're talking to a bot / AI
//                     ("are you a bot?", "is this automated?", "this feels AI").
//   out_of_context  — a coherent reply with nothing to do with the collab
//                     negotiation (wrong-thread / confused / spam-adjacent).
//
// Deterministic by design (no LLM, no network): cheap, hermetic, and — crucially
// — conservative. out_of_context only fires when the reply shows NO negotiation
// signal AND hits a clearly-unrelated topic marker, so ordinary money / decline /
// garbled replies are never misfiled (they stay in the normal loop, where the
// negotiator safely treats a garble as `unclear`).

export type FishyFlag = 'ai_speculation' | 'out_of_context';

export interface ReplySanityResult {
  /** Fishy-pattern labels tripped by the reply. Empty = looks like a real reply. */
  fishy_flags: string[];
}

export interface ReplySanityContext {
  /** Extra terms to treat as on-topic (e.g. the artist / track names). */
  domainTerms?: string[];
}

// ── (a) "Am I talking to a bot?" speculation ────────────────────────────────
const AI_SPECULATION: RegExp[] = [
  /\bare\s+(you|u)\s+(a\s+|an\s+)?(bot|robot|ai|a\.i\.|chat\s?bot|chatgpt|gpt|human|real(\s+person)?|machine|automated)\b/i,
  /\bis\s+(this|that|it)\s+(an?\s+)?(bot|ai|a\.i\.|automated|auto[-\s]?generated|ai[-\s]?generated|chatgpt|gpt|a\s+real\s+person|a\s+human|a\s+robot|a\s+script)\b/i,
  /\b(am|are)\s+i\s+(talking|speaking|chatting|texting|dm(?:ing|ming)?)\s+(to|with)\s+(a\s+)?(bot|robot|ai|human|real\s+person|machine|person|computer)\b/i,
  /\bthis\s+(feels|sounds|seems|reads|looks)\s+(like\s+)?(ai|a\.i\.|automated|a\s+bot|bot|generated|ai[-\s]?generated|auto[-\s]?generated|robotic|scripted|copy[-\s]?paste[d]?)\b/i,
  /\bai[-\s]?generated\b/i,
  /\b(you('?re|\s+are)|u\s+r)\s+(just\s+)?(a\s+)?(bot|robot|ai|not\s+(a\s+)?real|not\s+human|automated)\b/i,
  /\b(chatgpt|language\s+model|an\s+llm)\b/i,
  /\bis\s+(anyone|anybody|someone|a\s+human|a\s+person|a\s+real\s+person)\s+(actually\s+)?(there|real|reading|writing|typing|responding)\b/i,
  /\bautomated\s+(message|reply|response|system|email)\b/i,
];

// ── (b) out-of-context detection ────────────────────────────────────────────
// Any negotiation / collab / decision signal → treat as on-topic, never fishy.
const DOMAIN_SIGNAL: RegExp[] = [
  /\$\s?\d/,
  /\b\d{2,6}\s?(usd|dollars?|bucks|k)\b/i,
  /\b(rate|price|pricing|pay|paid|payment|budget|deal|offer|fee|cost|quote|invoice|venmo|paypal|cashapp|comp|compensation)\b/i,
  /\b(post|posts|promo|promote|collab|collaboration|sponsor|sponsored|song|track|music|release|campaign|reel|reels|video|videos|tiktok|instagram|ig|brand|partnership|feature|sound|audio|artist|content|creator)\b/i,
  /\b(interested|not\s+interested|no\s+thanks|i'?m\s+in|count\s+me\s+in|sounds\s+good|works\s+for\s+me|let'?s\s+do\s+it|down\s+for|decline|pass|not\s+for\s+me|maybe|depends)\b/i,
  /\b(manager|agent|media\s+kit|rate\s?card|timeline|deadline|how\s+much|what\s+genre|link|details)\b/i,
];

// A clearly-unrelated topic marker. Required for out_of_context so ordinary
// garble (which hits none of these) is never flagged.
const UNRELATED_TOPIC: RegExp[] = [
  /\b(netflix|hulu|disney\+?|spotify\s+password|password|verification\s+code|otp|reset\s+my|reset\s+the)\b/i,
  /\b(crypto|bitcoin|btc|ethereum|nft|forex|trading\s+signals|loan|mortgage|insurance|warranty|refund|chargeback)\b/i,
  /\b(amazon\s+order|my\s+order|order\s+#|tracking\s+number|shipped|shipping|delivery|package)\b/i,
  /\b(plumber|landlord|rent|electrician|mechanic|doctor|dentist|appointment|prescription|pharmacy)\b/i,
  /\b(wrong\s+(number|person|chat|thread)|who\s+(is|are)\s+(this|you)|do\s+i\s+know\s+you|how\s+did\s+you\s+get\s+my|why\s+are\s+you\s+(texting|emailing|messaging|contacting)\s+me|i\s+never\s+signed\s+up|i\s+didn'?t\s+sign\s+up|you\s+have\s+the\s+wrong)\b/i,
  /\b(uber|lyft|grocery|groceries|homework|essay|virus|malware)\b/i,
];

/** Minimum word count before out_of_context can fire (skip one-word noise). */
const MIN_OOC_WORDS = 4;

/**
 * Classify an inbound reply for the two fishy lanes. Pure + deterministic.
 * `ctx.domainTerms` (e.g. the artist/track names) widen the on-topic allowlist.
 */
export function checkReplySanity(
  raw: unknown,
  ctx: ReplySanityContext = {},
): ReplySanityResult {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const flags = new Set<string>();

  if (AI_SPECULATION.some((p) => p.test(text))) flags.add('ai_speculation');

  const words = text.trim().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  const extra = (ctx.domainTerms ?? [])
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length >= 2);
  const hasDomain =
    DOMAIN_SIGNAL.some((p) => p.test(text)) || extra.some((t) => lower.includes(t));
  const hasUnrelated = UNRELATED_TOPIC.some((p) => p.test(text));

  if (!hasDomain && hasUnrelated && words.length >= MIN_OOC_WORDS) {
    flags.add('out_of_context');
  }

  return { fishy_flags: Array.from(flags) };
}
