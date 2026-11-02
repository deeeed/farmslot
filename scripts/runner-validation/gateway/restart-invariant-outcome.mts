// What restart-invariant.mts compares: a run's end state against its no-restart baseline.
import type { Run } from '../../../packages/protocol/src/index.js';

export interface RunOutcome {
  status: string;
  /** `name:status` for every step, in pipeline order. */
  steps: string[];
  /** `type:resolution` for every decision presented, oldest first (`open` while unresolved). */
  decisions: string[];
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
  return {
    status: run.status,
    steps: run.steps.map((step) => `${step.name}:${step.status}`),
    decisions: [...(run.decisions ?? [])]
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(
        (decision) =>
          `${decision.type}:${decision.resolvedAt ? (decision.resolvedAction ?? 'resolved') : 'open'}`,
      ),
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

/** A note when REVIEW's verdicts differ from the baseline's, so a difference may be the model's. */
export function verdictDrift(baseline: RunOutcome, observed: RunOutcome): string | undefined {
  const verdicts = (outcome: RunOutcome) =>
    outcome.reviews.map((entry) => entry.replace(/ \(\d+\)$/, ''));
  if (verdicts(baseline).join() === verdicts(observed).join()) return undefined;
  return `reviewer verdicts differ from the baseline's ([${baseline.reviews.join(', ')}] vs [${observed.reviews.join(', ')}]): the difference may be the model's, not the restart's`;
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
  if (baseline.slot !== observed.slot)
    differences.push(
      `slot: baseline ${baseline.slot ?? '(none)'}, observed ${observed.slot ?? '(none)'}`,
    );
  return differences;
}
