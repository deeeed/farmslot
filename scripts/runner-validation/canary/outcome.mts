// What the canary compares: a run's end state against what it should be, step timings against
// budgets, and known failures. Every case ends as one CheckResult.
import type { Run } from '../../../packages/protocol/src/index.js';

export interface RunOutcome {
  status: string;
  /** `name:status` for every step, in pipeline order. */
  steps: string[];
  /**
   * `type:resolution` for every decision presented, oldest first (`open` while unresolved),
   * leaving out cards superseded by a newer copy of themselves: recovery re-captures a run's
   * output when it adopts a finished fix, which supersedes the open output card (#1724).
   */
  decisions: string[];
  /** Every decision type presented, superseded copies included, sorted. */
  decisionTypes: string[];
  /** Superseded cards per type. Not compared; reported when it differs. */
  superseded: string[];
  /** The run's slot after it settled, `lifecycle/phase` from fleet.status. */
  slot: string | null;
  /** REVIEW's verdict per loop it recorded. Not compared. */
  reviews: string[];
}

export interface SlotView {
  lifecycle: string;
  phase?: string | null;
}

export type CheckStatus = 'pass' | 'fail' | 'known' | 'xpass' | 'not-exercised' | 'unverified';

export interface CheckResult {
  /** The case: a pipeline step for restart checks, else `lifecycle`, `f324-replay-open-gate`… */
  case: string;
  /** `node-up`/`node-away` for restart checks, the node for live lifecycle checks, else `-`. */
  variant: string;
  target: 'isolated' | 'live';
  status: CheckStatus;
  hold?: string;
  /** The runner and model the case used. */
  model: string;
  modelCalls: number;
  runId?: string;
  durationS?: number;
  expected?: RunOutcome;
  observed?: RunOutcome;
  differences: string[];
  observations: string[];
  /** Seconds per step (and `release`: run terminal until its slot is ready). */
  timingsS?: Record<string, number>;
  overBudget?: string[];
  /** The run's own error and failed-step details, which known failures are matched against. */
  failureText?: string;
  ledger?: string;
  error?: string;
  evidence?: string;
  restarts?: unknown[];
}

export interface KnownFailure {
  case: string;
  /** A variant, or `*` for any. */
  variant: string;
  /** Only on this target (a fix in the checkout that the deployed gateway lacks); else both. */
  target?: 'live' | 'isolated';
  /** Regex the check's differences, error or failure text must match. */
  signature: string;
  /** Regexes for the differences this failure produces; any other difference is a new failure. */
  differences: string[];
  ledger: string;
}

export function runOutcome(run: Run, slot: SlotView | undefined): RunOutcome {
  const decisions = [...(run.decisions ?? [])].sort((a, b) =>
    String(a.createdAt).localeCompare(String(b.createdAt)),
  );
  const superseded = decisions.filter((decision) => decision.resolvedAction === 'superseded');
  return {
    status: run.status,
    steps: run.steps.map((step) => `${step.name}:${step.status}`),
    decisions: decisions
      .filter((decision) => decision.resolvedAction !== 'superseded')
      .map(
        (decision) =>
          `${decision.type}:${decision.resolvedAt ? (decision.resolvedAction ?? 'resolved') : 'open'}`,
      ),
    decisionTypes: [...new Set(decisions.map((decision) => decision.type))].sort(),
    superseded: [...new Set(superseded.map((decision) => decision.type))]
      .sort()
      .map((type) => `${type} x${superseded.filter((decision) => decision.type === type).length}`),
    slot: slot ? `${slot.lifecycle}/${slot.phase ?? '-'}` : null,
    reviews: reviewAttempts(run),
  };
}

function reviewAttempts(run: Run): string[] {
  const outputs = run.steps.find((step) => step.name === 'review')?.outputs as
    | { attempts?: Array<{ loopNumber?: number; verdict?: string; unresolvedCount?: number }> }
    | undefined;
  return (outputs?.attempts ?? []).map(
    (attempt) =>
      `loop ${attempt.loopNumber ?? '?'}: ${attempt.verdict ?? '?'}${attempt.unresolvedCount ? ` (${attempt.unresolvedCount})` : ''}`,
  );
}

/** The run's error and every failed step's detail, for known-failure matching. */
export function failureText(run: Run): string {
  return [
    run.error ?? '',
    ...run.steps
      .filter((step) => step.status === 'failed')
      .map((step) => `${step.name}: ${step.detail ?? ''}`),
  ]
    .filter((text) => text.trim())
    .join('\n');
}

const DEV_STEPS = [
  'find-slot',
  'write-task',
  'prepare',
  'dispatch',
  'monitor',
  'review',
  'complete',
  'human-gate',
  'finalize',
  'ci-watch',
];

/**
 * The end state of a canary lifecycle run (interactive reviewed dev, scripted worker, no code
 * change): every step done, the gate closed as shipped, the slot back to ready.
 */
export const LIFECYCLE_OUTCOME: Omit<RunOutcome, 'superseded' | 'reviews'> = {
  status: 'done',
  steps: DEV_STEPS.map((name) => `${name}:done`),
  decisions: ['engine_human_gate:close-as-shipped'],
  decisionTypes: ['engine_human_gate'],
  slot: 'ready/-',
};

/**
 * What the reviewed run ends as, derived from the verdicts it recorded (no second model run).
 * loop 1 issues and loop 2 pass: the fix round ran and the run completes; loop 1 pass: no fix
 * round (review-fix not exercised), the run completes. Either way an artifact-only run ends with
 * every step done and its output card open.
 */
export const REVIEWED_OUTCOME: Omit<RunOutcome, 'superseded' | 'reviews'> = {
  status: 'done',
  steps: DEV_STEPS.map((name) => `${name}:done`),
  decisions: ['engine_output_review:open'],
  decisionTypes: ['engine_output_review'],
  slot: 'ready/-',
};

/** REVIEW's verdicts by loop, from its attempts and its reviewer contexts. */
export function reviewVerdicts(run: Run): { loop1?: string; loop2?: string; reviewers: number } {
  const attempts =
    (
      run.steps.find((step) => step.name === 'review')?.outputs as
        | { attempts?: Array<{ loopNumber?: number; verdict?: string }> }
        | undefined
    )?.attempts ?? [];
  const verdict = (loop: number) => attempts.filter((a) => a.loopNumber === loop).at(-1)?.verdict;
  const contexts = run.agentContexts ?? [];
  const reviewers = contexts.filter((context) => context.role === 'review').length;
  // A recovered REVIEW keeps only the loops it ran after the restart; a fix round means loop 1
  // returned issues.
  const fixRound = contexts.some((context) => context.role === 'review-fix');
  return {
    loop1: verdict(1) ?? (fixRound ? 'issues' : undefined),
    loop2: verdict(2),
    reviewers,
  };
}

/**
 * F324: the replay must have superseded the gate card it found open. The driver only closes a
 * card the replay presented, so the first card is the one that was open.
 */
export function replayedGateDifferences(run: Run): string[] {
  const first = run.decisions
    .filter((decision) => decision.type === 'engine_human_gate')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  return first?.resolvedAction === 'superseded'
    ? []
    : [
        `the gate card open at the replay ended ${first?.resolvedAction ?? (first ? 'open' : 'missing')}, not superseded`,
      ];
}

/**
 * Whether loop 2 returning issues excuses a failed reviewed run: the run then ends outside what
 * the comparison models. Only when the restarts did their part: the fix round's commit landed (a
 * re-review of a checkout missing it also returns issues), every hold was reached, nothing was
 * refused and no reviewer was re-launched.
 */
export function reviewDriftExcuses(options: {
  loop2?: string;
  fixLanded: boolean;
  /** Unreached holds and refused decisions. */
  procedural: string[];
  relaunched: boolean;
  /** A run that failed outright did more than return issues. */
  runFailed: boolean;
}): boolean {
  return (
    options.loop2 === 'issues' &&
    options.fixLanded &&
    !options.runFailed &&
    !options.procedural.length &&
    !options.relaunched
  );
}

/** Every way `observed` differs from `expected`; empty when they match. */
export function outcomeDifferences(
  expected: Omit<RunOutcome, 'superseded' | 'reviews'>,
  observed: RunOutcome,
): string[] {
  const differences: string[] = [];
  if (expected.status !== observed.status)
    differences.push(`run status: expected ${expected.status}, observed ${observed.status}`);
  const steps = Math.max(expected.steps.length, observed.steps.length);
  for (let index = 0; index < steps; index++)
    if (expected.steps[index] !== observed.steps[index])
      differences.push(
        `step ${index + 1}: expected ${expected.steps[index] ?? '(none)'}, observed ${observed.steps[index] ?? '(none)'}`,
      );
  if (expected.decisions.join('\n') !== observed.decisions.join('\n'))
    differences.push(
      `decisions: expected [${expected.decisions.join(', ')}], observed [${observed.decisions.join(', ')}]`,
    );
  if (expected.decisionTypes.join() !== observed.decisionTypes.join())
    differences.push(
      `decision types: expected [${expected.decisionTypes.join(', ')}], observed [${observed.decisionTypes.join(', ')}]`,
    );
  if (expected.slot !== observed.slot)
    differences.push(
      `slot: expected ${expected.slot ?? '(none)'}, observed ${observed.slot ?? '(none)'}`,
    );
  return differences;
}

/** What differs from a same-night baseline without failing: superseded copies. */
export function outcomeObservations(baseline: RunOutcome, observed: RunOutcome): string[] {
  return baseline.superseded.join() === observed.superseded.join()
    ? []
    : [
        `superseded cards: baseline [${baseline.superseded.join(', ')}], observed [${observed.superseded.join(', ')}]`,
      ];
}

/** Seconds each step took, from the run's own step records. */
export function stepTimings(run: Run): Record<string, number> {
  const timings: Record<string, number> = {};
  for (const step of run.steps) {
    if (!step.startedAt || !step.completedAt) continue;
    timings[step.name] =
      Math.round((Date.parse(step.completedAt) - Date.parse(step.startedAt)) / 100) / 10;
  }
  return timings;
}

export function overBudget(
  timingsS: Record<string, number>,
  budgetsS: Record<string, number>,
): string[] {
  return Object.entries(budgetsS)
    .filter(([step, budget]) => timingsS[step] !== undefined && timingsS[step]! > budget)
    .map(([step, budget]) => `${step} took ${timingsS[step]} s (budget ${budget} s)`);
}

/**
 * Applies the known failures: a failing check that matches a known entry for its case and variant
 * becomes `known`, if its text has the entry's signature and it has no difference the entry does
 * not name. A passing check that has an entry becomes `xpass` (the entry is stale).
 */
export function applyKnownFailures(check: CheckResult, known: KnownFailure[]): CheckResult {
  const entries = known.filter(
    (entry) =>
      entry.case === check.case &&
      (entry.variant === '*' || entry.variant === check.variant) &&
      (!entry.target || entry.target === check.target),
  );
  if (!entries.length) return check;
  if (check.status === 'pass')
    return {
      ...check,
      status: 'xpass',
      ledger: entries[0]!.ledger,
      error: `passes now: remove the known entry ${entries[0]!.ledger}`,
    };
  if (check.status !== 'fail') return check;
  const text = [...check.differences, check.error ?? '', check.failureText ?? ''].join('\n');
  const entry = entries.find(
    (candidate) =>
      new RegExp(candidate.signature).test(text) &&
      check.differences.every((difference) =>
        candidate.differences.some((shape) => new RegExp(shape).test(difference)),
      ),
  );
  return entry
    ? { ...check, status: 'known', ledger: entry.ledger }
    : {
        ...check,
        observations: [
          ...check.observations,
          `fails differently from its known entry (${entries.map((e) => e.ledger).join(', ')})`,
        ],
      };
}
