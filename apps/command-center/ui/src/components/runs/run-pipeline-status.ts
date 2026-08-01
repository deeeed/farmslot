// Shared pipeline visual tones for canvas + mini-pipeline.
// Contract:
// - red (fail) = terminal failure — no automatic rework loop expected
// - orange (warn) = recoverable: review issues / package refresh / re-publish rework
// - green (ok) / blue (running) / muted = success / in-flight / idle

import type { Run, RunStep, RunStepStatus } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

export type PipelineDisplayTone = 'ok' | 'running' | 'warn' | 'fail' | 'muted';

/** Map independent-review verdict → step status (structure for layout / filters). */
export function publicationReviewVerdictStatus(verdict: string | null | undefined): RunStepStatus {
  const v = (verdict ?? '').trim().toLowerCase();
  if (v === 'pass' || v === 'skipped') return 'done';
  if (v === 'pending') return 'running';
  // issues = reworkable findings; failed = terminal review failure — both non-success.
  if (v === 'issues' || v === 'failed') return 'failed';
  if (!v) return 'done';
  return 'done';
}

/**
 * Map independent-review verdict → visual tone.
 * issues → warn (orange, another review/fix loop is expected)
 * failed → fail (red, terminal)
 */
export function publicationReviewVerdictTone(
  verdict: string | null | undefined,
): PipelineDisplayTone {
  const v = (verdict ?? '').trim().toLowerCase();
  if (v === 'pass' || v === 'skipped') return 'ok';
  if (v === 'pending') return 'running';
  if (v === 'issues') return 'warn';
  if (v === 'failed') return 'fail';
  return 'muted';
}

export function stepStatusTone(status: RunStepStatus): PipelineDisplayTone {
  switch (status) {
    case 'done':
      return 'ok';
    case 'running':
      return 'running';
    case 'failed':
      return 'fail';
    case 'skipped':
    case 'pending':
    default:
      return 'muted';
  }
}

/** True when a finalize/publish failure is reworkable (package refresh / re-review path). */
export function isRecoverablePublishFailure(
  detail: string | null | undefined,
  error?: string | null,
): boolean {
  const text = `${detail ?? ''} ${error ?? ''}`;
  // Match gateway finalize-step / ready-gate package copy — keep tight to avoid
  // painting unrelated finalize crashes as rework orange.
  return /package changed|refresh package and re-review|publication.*mismatch/i.test(text);
}

/** Agent statuses that mean a review/fix context is still live (matches gate UI helpers). */
const ACTIVE_REVIEW_AGENT_STATUSES = new Set(['launching', 'working', 'waiting']);

/**
 * True while a post-gate review or worker fix loop is still in flight.
 * Used so the synthetic package-refresh node stays **pending** (not failed/red)
 * even when earlier review loops ended in issues/failed.
 *
 * Prefer structured signals only (pending plan + live agents). Do **not** treat
 * sticky human-gate progress detail alone as in-flight — gateway often leaves
 * "running … re-review" on the step after the review completes.
 */
export function isPostGateReviewOrFixInFlight(
  run: Pick<Run, 'steps' | 'agentContexts' | 'engineState'> | null | undefined,
): boolean {
  if (!run) return false;

  const plan = run.engineState?.publishGate?.pendingReviewPlan;
  if (Array.isArray(plan) && plan.length > 0) return true;

  for (const agent of run.agentContexts ?? []) {
    if (!ACTIVE_REVIEW_AGENT_STATUSES.has(String(agent.status ?? ''))) continue;
    const id = String(agent.id ?? '');
    const role = String(agent.role ?? '');
    if (role === 'self-review' || role === 'self-review-fix') return true;
    if (/^rev/i.test(id) || /review/i.test(id)) return true;
  }

  return false;
}

/**
 * Synthetic package-refresh step status for canvas + mini.
 * Prefer pending while any review/fix is in flight; only then mirror last review.
 */
export function computePackageRefreshStatus(
  reviewStepStatuses: readonly RunStepStatus[],
  run?: Pick<Run, 'steps' | 'agentContexts' | 'engineState'> | null,
): RunStepStatus {
  if (reviewStepStatuses.some((status) => status === 'running' || status === 'pending')) {
    return 'pending';
  }
  if (isPostGateReviewOrFixInFlight(run)) return 'pending';
  const last = reviewStepStatuses.at(-1);
  return last === 'failed' ? 'failed' : 'done';
}

/**
 * Visual tone for any pipeline step/node (canvas + mini).
 * Prefer explicit verdict on outputs when present (publication reviews), but
 * self-review must honor maxRetriesExhausted before treating issues as orange.
 */
export function pipelineStepTone(
  step: Pick<RunStep, 'name' | 'status' | 'detail'> & {
    outputs?: Record<string, unknown> | null;
  },
  opts?: { runError?: string | null },
): PipelineDisplayTone {
  const outputs = step.outputs ?? undefined;
  const verdict =
    typeof outputs?.verdict === 'string'
      ? outputs.verdict
      : typeof outputs?.reviewVerdict === 'string'
        ? outputs.reviewVerdict
        : null;
  const verdictLower = (verdict ?? '').trim().toLowerCase();

  // Self-review first: terminal exhaustion is red even when verdict is still "issues".
  if (step.name === 'self-review' && step.status === 'failed') {
    if (outputs?.maxRetriesExhausted === true) return 'fail';
    if (verdictLower === 'issues' || /issues/i.test(step.detail ?? '')) return 'warn';
    return 'fail';
  }

  if (verdict) return publicationReviewVerdictTone(verdict);

  // package-refresh after issues/review rework is recoverable, not terminal red
  if (step.name === 'package-refresh' || step.name === 'package refresh') {
    if (step.status === 'failed') {
      const lastVerdict =
        typeof outputs?.lastReviewVerdict === 'string' ? outputs.lastReviewVerdict : null;
      if (lastVerdict === 'failed') return 'fail';
      return 'warn';
    }
    return stepStatusTone(step.status);
  }

  // finalize/publish: package-change failures can re-loop via refresh + re-approve
  if (step.name === 'finalize' || step.name === 'publish') {
    if (step.status === 'failed') {
      return isRecoverablePublishFailure(step.detail, opts?.runError) ? 'warn' : 'fail';
    }
    return stepStatusTone(step.status);
  }

  return stepStatusTone(step.status);
}

export function pipelineToneColor(tone: PipelineDisplayTone): string {
  switch (tone) {
    case 'ok':
      return colors.statusOk;
    case 'running':
      return '#3b82f6';
    case 'warn':
      return colors.statusWarn;
    case 'fail':
      return colors.statusFail;
    case 'muted':
    default:
      return colors.textMuted;
  }
}

/** Fill/stroke pair for canvas nodes from tone. */
export function pipelineToneFillStroke(tone: PipelineDisplayTone): {
  fill: string;
  stroke: string;
} {
  const c = pipelineToneColor(tone);
  switch (tone) {
    case 'ok':
      return { fill: `${c}12`, stroke: `${c}66` };
    case 'running':
      return { fill: `${c}1f`, stroke: c };
    case 'warn':
      return { fill: `${c}18`, stroke: c };
    case 'fail':
      return { fill: `${c}12`, stroke: c };
    case 'muted':
    default:
      return { fill: 'transparent', stroke: `${c}33` };
  }
}
