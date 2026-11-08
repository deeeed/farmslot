import type { NativeSessionEvent, Run } from '../../../packages/protocol/src/index.js';
import type { CheckResult } from './outcome.mjs';

type GateActions = Pick<Run['decisions'][number], 'type' | 'actions'>;

export function fullflowCloseAction(decision: GateActions): string | undefined {
  if (decision.type === 'engine_human_gate')
    return decision.actions.find((action) => action.id === 'hold')?.id;
  return decision.type === 'engine_output_review'
    ? decision.actions.find((action) => ['close-run', 'close', 'decline', 'abort', 'close-without-publishing', 'close-as-shipped'].includes(action.id))?.id
    : undefined;
}

export function fullflowGateFailure(decision: GateActions): string | undefined {
  return fullflowCloseAction(decision) ? undefined
    : `human-gate: no hold action offered; offered: ${decision.actions.map((action) => action.id).join(', ')}`;
}

export function fullflowFailure(run: Pick<Run, 'steps' | 'decisions' | 'error'>): string | undefined {
  const failed = run.steps.find((step) => step.status === 'failed');
  const decision = run.decisions.find((item) => !item.resolvedAt && !['engine_human_gate', 'engine_output_review', 'retrospective'].includes(item.type));
  const step = failed?.name ?? run.steps.find((item) => item.status === 'running')?.name;
  const message = failed?.detail || run.error || decision?.description || decision?.title;
  return message ? `${step ?? 'run'}: ${message}` : undefined;
}

/** Runner adapters own normalization; never infer provider failure from terminal text. */
export function fullflowNativeFailure(run: Pick<Run, 'steps'>, events: NativeSessionEvent[]): string | undefined {
  const error = events.find((event) => event.type === 'error' || (event.type === 'turn.completed' && ['failed', 'interrupted'].includes(event.status ?? '')));
  return error ? `${run.steps.find((step) => step.status === 'running')?.name ?? 'runner'}: ${error.text ?? `Native turn ${error.status ?? 'failed'}`}` : undefined;
}

export function fullflowTimings(run: Pick<Run, 'steps'>, endedAt: number): Record<string, number> {
  const timings: Record<string, number> = {};
  for (const step of run.steps) {
    if (!step.startedAt) continue;
    timings[step.name] = Math.round(((step.completedAt ? Date.parse(step.completedAt) : endedAt) - Date.parse(step.startedAt)) / 100) / 10;
  }
  return timings;
}

/** Hold is verified before public run.cancel cleanup; output close finishes normally. */
export function fullflowTerminal(action: string | undefined): string {
  return ['hold', 'abort', 'decline'].includes(action ?? '') ? 'cancelled' : 'done';
}

/** Keep the first engine/step message intact; the general canary summary truncates reasons. */
export function fullflowSummary(checks: CheckResult[], fallback: string): string {
  const first = checks.find((check) => check.status !== 'pass');
  const reason = first?.error ?? first?.differences[0] ?? first?.failureText;
  return `${checks.filter((check) => check.status === 'pass').length}/${checks.length} checks pass${first ? `; ${first.case} ${reason ?? fallback}` : !checks.length ? `; ${fallback}` : ''}`.replace(/\s*\n\s*/g, ' ');
}
