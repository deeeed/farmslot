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
  };
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
