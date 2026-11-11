// src/lib/personality.ts
//
// Small, firm-configurable "voice dial" for outreach + negotiation copy
//. One key selects a short voice directive that gets injected
// into the copy prompts so drafts read like a specific human, not a neutral bot.
// Deliberately tiny and dependency-free so both the OpenAI draft path and the
// deterministic negotiation-tick counter copy can share it.
//
// The directives themselves are written to steer AWAY from AI tells (no hype, no
// rule-of-three, no perfect-polish) per the humanizer principles — the dial only
// picks WHICH human voice, not whether the copy sounds human.

export type PersonalityKey = 'warm' | 'direct' | 'playful';

/** Fallback voice when nothing is configured. */
export const DEFAULT_PERSONALITY: PersonalityKey = 'warm';

export interface PersonalityVoice {
  key: PersonalityKey;
  label: string;
  /** One-line voice directive injected into a copy prompt's system message. */
  directive: string;
  /** Plain, human openers for a negotiation counter (no em-dash, no hype). */
  counterOpeners: string[];
}

export const PERSONALITY: Record<PersonalityKey, PersonalityVoice> = {
  warm: {
    key: 'warm',
    label: 'Warm',
    directive:
      'Sound like a friendly person who actually watches this creator. Relaxed, a little personal. Never gush or flatter.',
    counterOpeners: ['Thanks for getting back to me.', 'Appreciate you writing back.'],
  },
  direct: {
    key: 'direct',
    label: 'Direct',
    directive:
      'Get to the point fast. Short, plain sentences. Respectful, no hype, no filler.',
    counterOpeners: ['Thanks for the reply.', 'Got it, thanks.'],
  },
  playful: {
    key: 'playful',
    label: 'Playful',
    directive:
      'Keep it light with a bit of wit. One casual aside is fine. Never try-hard or salesy.',
    counterOpeners: ['Ha, thanks for circling back.', 'Appreciate the note.'],
  },
};

export function isPersonalityKey(v: unknown): v is PersonalityKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PERSONALITY, v);
}

/**
 * Resolve the active voice. Priority: an explicit firm setting, then the
 * CREATOR_CAMPAIGNS_PERSONALITY env dial, then DEFAULT_PERSONALITY. Anything
 * unrecognized falls back safely to the default.
 */
export function resolvePersonality(firmSetting?: string | null): PersonalityKey {
  if (isPersonalityKey(firmSetting)) return firmSetting;
  const env = process.env.CREATOR_CAMPAIGNS_PERSONALITY?.trim();
  if (isPersonalityKey(env)) return env;
  return DEFAULT_PERSONALITY;
}

/**
 * Resolve the active voice straight from a firms.outreach_prefs jsonb value
 * (the persisted home of the dial — `{ "personality": "warm" | ... }`).
 * Accepts unknown because jsonb columns are untyped; anything that isn't an
 * object with a valid `personality` key defers to the env/default chain.
 */
export function resolvePersonalityFromPrefs(prefs: unknown): PersonalityKey {
  const raw =
    prefs !== null && typeof prefs === 'object'
      ? (prefs as Record<string, unknown>).personality
      : undefined;
  return resolvePersonality(typeof raw === 'string' ? raw : undefined);
}

/** The voice directive string for a key (used inside copy prompts). */
export function personalityDirective(key: PersonalityKey): string {
  return PERSONALITY[key].directive;
}
