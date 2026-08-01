// Shared pipeline visual tones for canvas + mini-pipeline.
// Contract:
// - red (fail) = terminal failure — no automatic rework loop expected
// - orange (warn) = recoverable: review issues / package refresh / re-publish rework
// - green (ok) / blue (running) / muted = success / in-flight / idle

import type { RunStep, RunStepStatus } from '@farmslot/protocol';

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
  return /package changed|refresh package|re-review|rework|publication.*mismatch|package hash/i.test(
    text,
  );
}

/**
 * Visual tone for any pipeline step/node (canvas + mini).
 * Prefer explicit verdict on outputs when present (publication reviews).
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

  // self-review: issues without max-retries-exhausted is reworkable
  if (step.name === 'self-review' && step.status === 'failed') {
    const maxRetriesExhausted = outputs?.maxRetriesExhausted === true;
    if (!maxRetriesExhausted && (verdict === 'issues' || outputs?.verdict === 'issues')) {
      return 'warn';
    }
    if (
      !maxRetriesExhausted &&
      typeof outputs?.verdict === 'string' &&
      outputs.verdict === 'issues'
    ) {
      return 'warn';
    }
    // detail-only path: gateway sometimes leaves issues only in detail
    if (!maxRetriesExhausted && /issues/i.test(step.detail ?? '')) return 'warn';
    return 'fail';
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
