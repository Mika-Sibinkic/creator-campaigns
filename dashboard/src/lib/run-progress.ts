// src/lib/run-progress.ts
//
// Pure state machine behind <CampaignProgress>: SSE frame parsing plus the
// reducer that turns the discovery run's event stream into what goes on
// screen. Extracted from the component so it can be tested without a browser
// (the repo has no browser harness) — see tests/run-progress.test.ts.
//
// The vocabulary here is the route's actual vocabulary, verified against
// src/app/api/campaigns/[id]/run/route.ts:
//
//   event: progress       {step, status:"running"|"done", message, data?}
//                         steps, in order: spotify → queries → apify →
//                         normalize → qualify
//   event: filtered       {total_apify, kept, filtered_total, filtered_by_reason}
//   event: contacts       {processed, emails_found, llm_calls}
//   event: qualification  {processed, excluded, llm_calls}
//   event: done           {campaign_id, total}
//   event: error          {message, code?, after?}
//
// Three route-side behaviours this module absorbs rather than fixes (the route
// handler is owned elsewhere):
//
//   1. `qualify` emits status:"running" and NEVER a terminal "done". The
//      `qualification` event is its completion signal.
//   2. The cost-cap and timeout paths emit a detailed `error` frame and then
//      throw, producing a SECOND terse frame whose `message` is just the code.
//      The first error wins.
//   3. A run that finds ZERO creators emits `done` with `total: 0` — the same
//      shape as a successful run. Without inspecting `total`, the UI renders a
//      full green bar next to an empty creator list. It is inspected here.

export type DiscoveryStep =
  | 'spotify'
  | 'queries'
  | 'apify'
  | 'normalize'
  | 'qualify';

/**
 * `incomplete` is the honest fifth state: the run ended while this step was
 * still running, and the step never reported back either way.
 *
 * It exists because the alternatives all lie. Sweeping such a step to `done`
 * (what this module used to do) claims a success nobody observed — and the
 * route swallows a qualify-step crash and emits `done` regardless, so that
 * sweep reliably turned a crash into a green check at 100%. Sweeping it to
 * `error` claims a failure nobody observed either: the stream can end for
 * reasons that have nothing to do with the step. Leaving it `running` forever
 * is the third lie, a spinner that never resolves.
 *
 * `incomplete` says the only true thing: we stopped hearing about it.
 */
export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'incomplete';

export const DISCOVERY_STEPS: DiscoveryStep[] = [
  'spotify',
  'queries',
  'apify',
  'normalize',
  'qualify',
];

/**
 * What each step is called on screen. A label executive does not know what
 * "apify" or "normalize" is, and a vendor name has no business on a client
 * screen. Step ids are unchanged on the wire.
 */
export const STEP_LABELS: Record<DiscoveryStep, string> = {
  spotify: 'Artist context',
  queries: 'Search plan',
  apify: 'Creator search',
  normalize: 'Scoring',
  qualify: 'Qualifying',
};

/** Human wording for the reason codes carried on the `filtered` event. */
export const FILTER_REASONS: Record<string, string> = {
  mass_follow: 'follow-for-follow accounts',
  dead_account: 'inactive accounts',
  no_content: 'no recent posts',
  below_engagement_floor: 'engagement below the floor',
  // Only ever fires on a platform whose scraper cannot bound followers at
  // scrape time (Instagram). TikTok's actor takes the floor as an input, so
  // its results arrive already inside the window.
  below_follower_floor: 'under your follower minimum',
};

const CAP_COPY =
  'Discovery stopped at its spending cap before finishing. The cap is there on purpose. Raise it in Settings or narrow the campaign, then run again.';

/**
 * Error codes the route can send. A raw code is developer-facing; every code a
 * user can actually trigger gets a sentence instead.
 */
export const ERROR_COPY: Record<string, string> = {
  apify_cost_cap: CAP_COPY,
  openai_cost_cap: CAP_COPY,
  pipeline_timeout:
    'Discovery ran longer than its time limit and stopped. Nothing was charged past that point. Try running it again.',
  campaign_not_found:
    'This campaign could not be found. It may have been deleted in another tab.',
  // Returned as a 429 before the stream even opens. "Try again" is the wrong
  // advice here — retrying cannot succeed until the cap resets.
  daily_apify_cap_exceeded:
    'You have used up today’s creator-search budget. It resets at midnight UTC, or raise the daily cap in Settings if you need to keep going now.',
  // Client-side only: the reader finished without a `done` or `error` frame,
  // so the run's real outcome is genuinely unknown to this screen. Saying so
  // beats a bar frozen at 60% with no explanation, which is what happened
  // before. Deliberately does not claim the run failed — it may have finished.
  stream_truncated:
    'The connection to the discovery run ended early, so we can’t say how it finished. Reload the campaign to see what actually landed before starting another run.',
};

export const GENERIC_ERROR =
  'Discovery stopped before it finished. Try running it again.';

export interface Step {
  step: DiscoveryStep;
  status: StepStatus;
  message?: string;
}

export interface FilterSummary {
  scraped: number;
  kept: number;
  removed: number;
  reasons: Record<string, number>;
  /**
   * Creators KEPT per platform, after the pre-filter.
   *
   * The whole point of scraping a second platform is knowing whether it
   * produced anything, and a run can pay Apify for an Instagram scrape and
   * keep zero of it. Without this the screen said "Found N creators on
   * tiktok, instagram" using the count from BEFORE the filter, which is the
   * same "we offer it but it does nothing" failure one stage downstream.
   */
  keptByPlatform: Record<string, number>;
}

export interface RunOutcome {
  /** `empty` is a COMPLETED run that added nothing — not a failure, not a success. */
  kind: 'found' | 'empty';
  total: number;
}

export interface RunState {
  steps: Record<DiscoveryStep, Step>;
  running: boolean;
  error: string;
  outcome: RunOutcome | null;
  filters: FilterSummary | null;
}

/** One decoded SSE frame. */
export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

export function initialRunState(running = true): RunState {
  return {
    steps: Object.fromEntries(
      DISCOVERY_STEPS.map((s) => [s, { step: s, status: 'pending' as StepStatus }]),
    ) as Record<DiscoveryStep, Step>,
    running,
    error: '',
    outcome: null,
    filters: null,
  };
}

/**
 * Split a raw stream buffer into complete SSE frames, returning the trailing
 * partial frame so the caller can prepend it to the next chunk. Frames that
 * are missing an `event:`/`data:` line, or whose data is not JSON, are
 * dropped — a malformed frame must never take down the run display.
 */
export function parseSseFrames(buffer: string): {
  frames: SseFrame[];
  rest: string;
} {
  const chunks = buffer.split('\n\n');
  const rest = chunks.pop() ?? '';
  const frames: SseFrame[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const event = lines
      .find((l) => l.startsWith('event:'))
      ?.slice(6)
      .trim();
    const data = lines
      .find((l) => l.startsWith('data:'))
      ?.slice(5)
      .trim();
    if (!event || !data) continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === 'object') {
        frames.push({ event, data: parsed as Record<string, unknown> });
      }
    } catch {
      // not JSON — drop the frame, keep the run alive
    }
  }
  return { frames, rest };
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function sweepRunning(
  steps: Record<DiscoveryStep, Step>,
  to: StepStatus,
  message?: string,
): Record<DiscoveryStep, Step> {
  return Object.fromEntries(
    DISCOVERY_STEPS.map((k) => [
      k,
      steps[k].status === 'running'
        ? { ...steps[k], status: to, ...(message ? { message } : {}) }
        : steps[k],
    ]),
  ) as Record<DiscoveryStep, Step>;
}

/** What the screen says next to a step the run simply stopped reporting on. */
export const INCOMPLETE_STEP_MESSAGE = 'Did not finish: the run ended without reporting on this step.';

/**
 * Steps the run abandoned. Non-empty means the run ended in a partial state:
 * whatever it produced is real, but it is not the whole job. Callers use this
 * to caveat the outcome line rather than print an unqualified success.
 */
export function incompleteSteps(steps: Record<DiscoveryStep, Step>): DiscoveryStep[] {
  return DISCOVERY_STEPS.filter((k) => steps[k].status === 'incomplete');
}

/**
 * Fold one SSE frame into the run state. Pure: same input, same output, no
 * mutation of `state`.
 */
export function reduceRun(state: RunState, frame: SseFrame): RunState {
  const { event, data } = frame;

  if (event === 'progress') {
    const step = data.step as DiscoveryStep | undefined;
    const status = data.status as StepStatus | undefined;
    if (!step || !status || !DISCOVERY_STEPS.includes(step)) return state;
    return {
      ...state,
      steps: {
        ...state.steps,
        [step]: { step, status, message: str(data.message) },
      },
    };
  }

  if (event === 'filtered') {
    return {
      ...state,
      filters: {
        scraped: num(data.total_apify),
        kept: num(data.kept),
        removed: num(data.filtered_total),
        reasons:
          data.filtered_by_reason && typeof data.filtered_by_reason === 'object'
            ? (data.filtered_by_reason as Record<string, number>)
            : {},
        keptByPlatform:
          data.kept_by_platform && typeof data.kept_by_platform === 'object'
            ? (data.kept_by_platform as Record<string, number>)
            : {},
      },
    };
  }

  if (event === 'contacts') {
    const found = num(data.emails_found);
    const seen = num(data.processed);
    const prior = state.steps.normalize.message;
    const note = `Contact details found for ${found} of ${seen}`;
    return {
      ...state,
      steps: {
        ...state.steps,
        normalize: {
          ...state.steps.normalize,
          message: prior ? `${prior} · ${note}` : note,
        },
      },
    };
  }

  if (event === 'qualification') {
    // The route never sends qualify/done — this event is its close.
    const seen = num(data.processed);
    const cut = num(data.excluded);
    return {
      ...state,
      steps: {
        ...state.steps,
        qualify: {
          step: 'qualify',
          status: 'done',
          message: `Checked ${seen}, ruled out ${cut} as a poor fit`,
        },
      },
    };
  }

  if (event === 'done') {
    const total = num(data.total);
    return {
      ...state,
      // A zero-creator run is a completed run that added nothing. It must not
      // read as success.
      outcome: { kind: total > 0 ? 'found' : 'empty', total },
      // Anything still spinning when the stream ends never reported back — so
      // say that, rather than promote it to 'done'. The route reaches this
      // frame even when step 6 threw (run/route.ts:1025-1031 swallows it), and
      // every step that genuinely finishes sends its own done/close frame
      // first, so nothing honest is lost by refusing to assume.
      steps: sweepRunning(state.steps, 'incomplete', INCOMPLETE_STEP_MESSAGE),
      running: false,
    };
  }

  if (event === 'error') {
    const code = str(data.code);
    const copy = (code && ERROR_COPY[code]) || str(data.message) || GENERIC_ERROR;
    return {
      ...state,
      // First error wins — the route's second frame is the terse duplicate.
      error: state.error || copy,
      steps: sweepRunning(state.steps, 'error'),
      running: false,
    };
  }

  return state;
}

/** Fraction of the run complete, 0–100, clamped. */
export function runPercent(steps: Record<DiscoveryStep, Step>): number {
  const done = DISCOVERY_STEPS.filter((k) => steps[k].status === 'done').length;
  return Math.min(100, Math.round((done / DISCOVERY_STEPS.length) * 100));
}

/** Platform ids as a label manager should read them. */
export const PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube: 'YouTube',
};

export function platformLabel(id: string): string {
  return PLATFORM_LABELS[id] ?? id;
}

/**
 * Per-platform kept counts, or '' when only one platform ran.
 *
 * Reports EVERY platform in the map including the zeroes, because a zero is
 * the number worth seeing: "0 from Instagram" is the whole signal that a paid
 * scrape produced nothing usable, and omitting it would hide exactly the
 * failure this reporting exists to catch.
 */
export function describeKeptByPlatform(kept: Record<string, number>): string {
  const entries = Object.entries(kept);
  if (entries.length < 2) return '';
  return entries
    .sort((a, b) => num(b[1]) - num(a[1]) || a[0].localeCompare(b[0]))
    .map(([p, n]) => `${num(n)} from ${platformLabel(p)}`)
    .join(', ');
}

/** One sentence explaining what the bot pre-filter removed and why. */
export function describeFilters(f: FilterSummary): string {
  const named = Object.entries(f.reasons)
    .filter(([, n]) => num(n) > 0)
    .sort((a, b) => num(b[1]) - num(a[1]))
    .map(([reason, n]) => `${n} ${FILTER_REASONS[reason] ?? reason}`);
  const why = named.length ? `: ${named.join(', ')}` : '';
  const split = describeKeptByPlatform(f.keptByPlatform ?? {});
  const where = split ? ` (${split})` : '';
  return `Reviewed ${f.scraped} creator${f.scraped === 1 ? '' : 's'}, kept ${f.kept}${where}. Screened out ${f.removed}${why}.`;
}
