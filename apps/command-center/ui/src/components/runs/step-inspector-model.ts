import type {
  FamilyObservabilityArtifact,
  Run,
  RunStep,
  SelfReviewIssue,
} from '@farmslot/protocol';

import { runArtifactUrl } from '../workspace/workspace-artifacts.js';

import { formatDuration } from './run-utils.js';

// Keys to render as command blocks with copy button
export const COMMAND_KEYS = new Set(['cliCommand', 'failedCommand', 'launchCommand']);
// Keys to render as log file paths with copy button
export const LOG_KEYS = new Set(['failedLogPath', 'relatedLogs']);
// Keys to render as cost (highlighted accent)
export const COST_KEYS = new Set(['costEstimate', 'costUsd', 'cost_usd']);
// Keys to render as formatted duration
export const DURATION_KEYS = new Set([
  'durationMs',
  'waitDurationMs',
  'readinessWaitMs',
  'totalDurationMs',
  'sessionDurationMs',
]);
// Keys that are arrays of objects → render as compact list
export const LIST_KEYS = new Set([
  'artifacts',
  'candidates',
  'subSteps',
  'violations',
  'checkTimeline',
  'snapshots',
  'issues',
]);
// Keys to render as preformatted output blocks
export const OUTPUT_KEYS = new Set(['lastOutput']);
// Keys to hide (too verbose, not useful in inspector)
export const HIDDEN_KEYS = new Set<string>(['attempts', 'timeline']);

export interface StepCostInfo {
  cost: string;
  tokens?: string;
  model?: string;
  extra?: string;
}

export interface ReviewLoopAttempt {
  loopNumber: number;
  verdict: string;
  unresolvedCount: number;
  issues: SelfReviewIssue[];
  completedAt: string;
  hasFixDelta: boolean;
  fixDeltaPath: string | null;
}

/**
 * Steps that emit a per-loop review convergence trace in their outputs. Both
 * the publication-review steps and the self-review loop write `attempts[]` /
 * `timeline[]` describing each review→fix→re-review iteration.
 */
export function stepHasReviewLoop(step: RunStep): boolean {
  if (!step.name.includes('publication-review-') && step.name !== 'self-review') return false;
  const out = (step.outputs ?? {}) as Record<string, unknown>;
  const attempts = Array.isArray(out.attempts) ? out.attempts : [];
  const timeline = Array.isArray(out.timeline) ? out.timeline : [];
  return attempts.length > 0 || timeline.length > 0;
}

/**
 * Normalize the free-form `outputs.attempts` blob into the per-loop rows the
 * inspector renders. self-review and publication-review share this shape
 * (`loopNumber`, `verdict`, `unresolvedCount`, `issues[]`, optional `fixDelta`).
 */
export function reviewLoopAttempts(step: RunStep): ReviewLoopAttempt[] {
  const out = (step.outputs ?? {}) as Record<string, unknown>;
  const attempts = Array.isArray(out.attempts) ? (out.attempts as Record<string, unknown>[]) : [];
  return attempts.map((attempt, index) => {
    const fixDelta =
      attempt.fixDelta && typeof attempt.fixDelta === 'object'
        ? (attempt.fixDelta as Record<string, unknown>)
        : null;
    const issues = Array.isArray(attempt.issues)
      ? (attempt.issues as Record<string, unknown>[]).map((issue) => ({
          file: String(issue.file ?? 'unknown'),
          line: typeof issue.line === 'number' ? issue.line : undefined,
          description: String(issue.description ?? ''),
        }))
      : [];
    return {
      loopNumber: typeof attempt.loopNumber === 'number' ? attempt.loopNumber : index + 1,
      verdict: typeof attempt.verdict === 'string' ? attempt.verdict : 'pending',
      unresolvedCount: typeof attempt.unresolvedCount === 'number' ? attempt.unresolvedCount : 0,
      issues,
      completedAt: typeof attempt.completedAt === 'string' ? attempt.completedAt : '',
      hasFixDelta: fixDelta !== null,
      fixDeltaPath: fixDelta && typeof fixDelta.diffPath === 'string' ? fixDelta.diffPath : null,
    };
  });
}

export function stepDurationLabel(step: RunStep, nowMs: number): string {
  if (step.durationMs) return formatDuration(step.durationMs);
  if (step.status === 'running' && step.startedAt) {
    return `elapsed ${formatDuration(Math.max(0, nowMs - new Date(step.startedAt).getTime()))}`;
  }
  return '';
}

export function extractStepCostInfo(step: RunStep, run?: Run): StepCostInfo | null {
  const outputs = step.outputs as Record<string, unknown> | undefined;
  if (!outputs) return null;

  // Direct cost fields
  const costVal = outputs.costEstimate ?? outputs.costUsd ?? outputs.cost_usd;
  if (costVal && typeof costVal === 'number') {
    const session = outputs.session as Record<string, unknown> | undefined;
    const tokens = session
      ? `${((session.inputTokens as number) ?? 0).toLocaleString()} in / ${((session.outputTokens as number) ?? 0).toLocaleString()} out`
      : undefined;
    const model = (outputs.model ?? session?.model) as string | undefined;
    const compactions = session?.numCompactions as number | undefined;
    const turns = session?.numTurns as number | undefined;
    const extra =
      compactions || turns
        ? [
            compactions ? `${compactions} compaction${compactions > 1 ? 's' : ''}` : '',
            turns ? `${turns} turns` : '',
          ]
            .filter(Boolean)
            .join(', ')
        : undefined;
    return { cost: `$${costVal.toFixed(2)}`, tokens, model, extra };
  }

  // LLM usage in grade step
  const llm = outputs.llm as Record<string, unknown> | undefined;
  if (llm?.costUsd) {
    return {
      cost: `$${(llm.costUsd as number).toFixed(4)}`,
      tokens: `${((llm.inputTokens as number) ?? 0).toLocaleString()} in / ${((llm.outputTokens as number) ?? 0).toLocaleString()} out`,
      model: llm.model as string | undefined,
    };
  }

  // Run-level cost from the run prop
  if (run?.metrics.costEstimate && (step.name === 'complete' || step.name === 'finalize')) {
    return {
      cost: `$${run.metrics.costEstimate.toFixed(2)}`,
      model: run.metrics.model ?? undefined,
    };
  }

  return null;
}

/**
 * Adapt the untyped `step.outputs.artifacts` array to the
 * FamilyObservabilityArtifact shape expected by the shared step-artifacts
 * component. RunStep doesn't carry artifacts as a typed field — they live
 * in the step's free-form outputs blob — so we normalize at render time.
 */
export function stepArtifactsForRunStep(
  step: RunStep | null,
  run?: Run,
): FamilyObservabilityArtifact[] {
  const raw = step?.outputs?.artifacts;
  if (!Array.isArray(raw) || !run) return [];
  return raw
    .filter(
      (row): row is { path: string; purpose?: string; sizeBytes?: number } =>
        row != null &&
        typeof row === 'object' &&
        typeof (row as { path?: unknown }).path === 'string',
    )
    .map((row) => ({
      runId: run.id,
      familyId: run.familyId,
      stepName: step?.name ?? null,
      path: row.path,
      purpose: row.purpose ?? 'other',
      sizeBytes: row.sizeBytes,
      source: 'step-output' as const,
    }));
}

export function stepArtifactUrl(artifact: FamilyObservabilityArtifact): string {
  return runArtifactUrl(artifact.runId, artifact);
}
