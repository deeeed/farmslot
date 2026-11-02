// What restart-invariant.mts compares: a run's end state against its no-restart baseline.
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
  /** REVIEW's verdict per loop. Not compared: it tells verdict drift from a restart bug. */
  reviews: string[];
}

export interface SlotView {
  lifecycle: string;
  phase?: string | null;
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

/** Every way `observed` differs from `baseline`; empty when they match. */
export function outcomeDifferences(baseline: RunOutcome, observed: RunOutcome): string[] {
  const differences: string[] = [];
  if (baseline.status !== observed.status)
    differences.push(`run status: baseline ${baseline.status}, observed ${observed.status}`);
  const steps = Math.max(baseline.steps.length, observed.steps.length);
  for (let index = 0; index < steps; index++)
    if (baseline.steps[index] !== observed.steps[index])
      differences.push(
        `step ${index + 1}: baseline ${baseline.steps[index] ?? '(none)'}, observed ${observed.steps[index] ?? '(none)'}`,
      );
  if (baseline.decisions.join('\n') !== observed.decisions.join('\n'))
    differences.push(
      `decisions: baseline [${baseline.decisions.join(', ')}], observed [${observed.decisions.join(', ')}]`,
    );
  if (baseline.decisionTypes.join() !== observed.decisionTypes.join())
    differences.push(
      `decision types: baseline [${baseline.decisionTypes.join(', ')}], observed [${observed.decisionTypes.join(', ')}]`,
    );
  if (baseline.slot !== observed.slot)
    differences.push(
      `slot: baseline ${baseline.slot ?? '(none)'}, observed ${observed.slot ?? '(none)'}`,
    );
  return differences;
}

/** What differs without failing the check: superseded copies, and REVIEW's verdicts. */
export function outcomeObservations(baseline: RunOutcome, observed: RunOutcome): string[] {
  const observations: string[] = [];
  if (baseline.superseded.join() !== observed.superseded.join())
    observations.push(
      `superseded cards: baseline [${baseline.superseded.join(', ')}], observed [${observed.superseded.join(', ')}]`,
    );
  // A recovered REVIEW keeps only the loops it ran after the restart: compare the loops both have.
  const verdicts = (outcome: RunOutcome) =>
    new Map(
      outcome.reviews.map((entry) => {
        const [loop = '', verdict = ''] = entry.replace(/ \(\d+\)$/, '').split(': ');
        return [loop, verdict];
      }),
    );
  const before = verdicts(baseline);
  const drift = [...verdicts(observed)].filter(
    ([loop, verdict]) => before.has(loop) && before.get(loop) !== verdict,
  );
  if (drift.length)
    observations.push(
      `reviewer verdicts differ from the baseline's ([${baseline.reviews.join(', ')}] vs [${observed.reviews.join(', ')}]): a difference may be the model's, not the restart's`,
    );
  return observations;
}
