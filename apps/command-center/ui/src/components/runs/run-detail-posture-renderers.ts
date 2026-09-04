/**
 * Run Detail resource-posture summary (ADR-054, deliverable 7).
 *
 * Everything rendered here comes from `runtime.posture.status`. The Gateway owns
 * the policy: this module never decides what should be retained, warm, or
 * stopped, and never infers a posture from run status or step names. Its only
 * job is to show the Gateway's desired disposition next to the provider state
 * that was actually observed, so an operator can see when the two disagree.
 */
import { html, nothing } from 'lit';

import type {
  ResourcePosture,
  ResourcePostureCapabilityState,
  ResourcePostureDesiredDisposition,
  ResourcePostureGateChoice,
  ResourcePostureObservedState,
  ResourcePosturePolicySource,
  ResourcePostureRejection,
  ResourcePostureTransition,
  ResourcePostureTransitionOutcome,
  ResourcePostureWaitPolicy,
  RunResourcePostureState,
} from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';

/** Fetch state for `runtime.posture.status`, so a failure is never rendered as "no posture". */
export interface RunPostureStatusState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  slotId?: string | null;
  state?: RunResourcePostureState;
  message?: string;
}

export function postureLabel(posture: ResourcePosture): string {
  if (posture === 'operator-wait') return 'Operator wait';
  if (posture === 'terminal') return 'Terminal';
  if (posture === 'parked') return 'Parked';
  return 'Active';
}

export function policySourceLabel(source: ResourcePosturePolicySource): string {
  if (source === 'gate-choice') return 'operator gate choice';
  if (source === 'run-dispatch') return 'run dispatch config';
  if (source === 'project-default') return 'project default';
  return 'framework default';
}

export function dispositionLabel(disposition: ResourcePostureDesiredDisposition): string {
  if (disposition === 'acquired') return 'retained';
  if (disposition === 'warm') return 'warm';
  return 'stopped';
}

export function transitionOutcomeLabel(outcome: ResourcePostureTransitionOutcome): string {
  if (outcome === 'in-progress') return 'in progress';
  if (outcome === 'idempotent') return 'no change needed';
  if (outcome === 'partial') return 'partially applied';
  return outcome;
}

export function rejectionMessage(rejection: ResourcePostureRejection): string {
  if (rejection.kind === 'park-ineligible') {
    return `Rejected — the run cannot be parked (${rejection.code}): ${rejection.reason}`;
  }
  if (rejection.kind === 'capability-unavailable') {
    return `Rejected — ${rejection.capabilityId} is unavailable: ${rejection.reason}`;
  }
  return `Rejected — ${rejection.reason}`;
}

/**
 * How the observed provider state stands against what the Gateway wanted.
 *
 * `unproven` is deliberately not folded into `mismatch` or `matches`: an
 * `unknown` observation means the Gateway could not see the provider, and
 * claiming either outcome from it would be a guess.
 */
export type RunPostureRowStatus = 'matches' | 'pending' | 'mismatch' | 'unproven';

export function postureRowStatus(
  desired: ResourcePostureDesiredDisposition,
  observed: ResourcePostureObservedState,
): RunPostureRowStatus {
  if (observed === 'transitioning') return 'pending';
  if (observed === 'unknown') return 'unproven';
  if (desired === 'stopped') return observed === 'stopped' ? 'matches' : 'mismatch';
  // `acquired` and `warm` both want a live provider; the difference is ownership.
  return observed === 'running' ? 'matches' : 'mismatch';
}

export interface RunPostureCapabilityRow {
  capabilityId: string;
  desiredDisposition: ResourcePostureDesiredDisposition;
  desiredLabel: string;
  observedState: ResourcePostureObservedState;
  rowStatus: RunPostureRowStatus;
  reason: string;
  policySource: ResourcePosturePolicySource;
  warmUntil?: string;
  cleanupFailure?: string;
  releaseEffects: string[];
}

export function postureCapabilityRow(
  state: ResourcePostureCapabilityState,
): RunPostureCapabilityRow {
  return {
    capabilityId: state.capabilityId,
    desiredDisposition: state.desiredDisposition,
    desiredLabel: dispositionLabel(state.desiredDisposition),
    observedState: state.observedState,
    rowStatus: postureRowStatus(state.desiredDisposition, state.observedState),
    reason: state.reason,
    policySource: state.policySource,
    ...(state.warmUntil ? { warmUntil: state.warmUntil } : {}),
    ...(state.cleanupFailure ? { cleanupFailure: state.cleanupFailure } : {}),
    releaseEffects: state.releaseEffects,
  };
}

export interface RunPostureSummary {
  posture: ResourcePosture;
  postureLabel: string;
  policySource: ResourcePosturePolicySource;
  policySourceLabel: string;
  gateChoice?: ResourcePostureGateChoice;
  waitPolicy?: ResourcePostureWaitPolicy;
  workerRetained: boolean;
  /**
   * Counts of the Gateway's desired disposition. `failed` is separate and counts
   * capabilities whose provider contradicts that intent — a cleanup failure, an
   * unhealthy provider, or anything else the row marks as a mismatch — so a
   * failed cleanup can never be presented inside the "stopped" total.
   */
  counts: { retained: number; warm: number; stopped: number; failed: number };
  rows: RunPostureCapabilityRow[];
  lastTransition?: ResourcePostureTransition;
  updatedAt: string;
}

export function summarizeRunPosture(state: RunResourcePostureState): RunPostureSummary {
  const rows = state.capabilities.map(postureCapabilityRow);
  const counts = { retained: 0, warm: 0, stopped: 0, failed: 0 };
  for (const row of rows) {
    if (row.desiredDisposition === 'acquired') counts.retained += 1;
    else if (row.desiredDisposition === 'warm') counts.warm += 1;
    else counts.stopped += 1;
    if (row.cleanupFailure || row.rowStatus === 'mismatch') counts.failed += 1;
  }
  return {
    posture: state.posture,
    postureLabel: postureLabel(state.posture),
    policySource: state.policySource,
    policySourceLabel: policySourceLabel(state.policySource),
    ...(state.gateChoice ? { gateChoice: state.gateChoice } : {}),
    ...(state.waitPolicy ? { waitPolicy: state.waitPolicy } : {}),
    workerRetained: state.workerRetained,
    counts,
    rows,
    ...(state.lastTransition ? { lastTransition: state.lastTransition } : {}),
    updatedAt: state.updatedAt,
  };
}

function rowStatusColor(rowStatus: RunPostureRowStatus): string {
  if (rowStatus === 'matches') return colors.statusOk;
  if (rowStatus === 'mismatch') return colors.statusFail;
  return colors.textMuted;
}

function rowStatusLabel(rowStatus: RunPostureRowStatus): string {
  if (rowStatus === 'matches') return 'as intended';
  if (rowStatus === 'mismatch') return 'does not match intent';
  if (rowStatus === 'pending') return 'transition in flight';
  return 'not observed';
}

const POSTURE_STYLES = html`
  <style>
    .posture-panel {
      margin-top: 16px;
      border: 1px solid ${colors.bgCard};
      border-radius: 4px;
      background: ${colors.bgSurface};
      padding: 10px 12px;
    }
    .posture-title {
      font-size: ${fonts.sizeXs};
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: ${colors.textMuted};
      margin-bottom: 8px;
    }
    .posture-headline {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 10px;
      font-size: ${fonts.sizeXs};
    }
    .posture-name {
      font-weight: 700;
      color: ${colors.textPrimary};
      font-size: ${fonts.sizeSm};
    }
    .posture-source,
    .posture-counts,
    .posture-transition {
      color: ${colors.textMuted};
      font-family: ${fonts.mono};
      font-size: ${fonts.sizeXs};
    }
    .posture-transition {
      margin-top: 6px;
    }
    .posture-failure {
      margin-top: 6px;
      color: ${colors.statusFail};
      font-size: ${fonts.sizeXs};
    }
    .posture-row {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 8px;
      padding: 6px 0;
      border-top: 1px solid ${colors.bgCard};
      font-size: ${fonts.sizeXs};
    }
    .posture-cap {
      font-family: ${fonts.mono};
      color: ${colors.textPrimary};
      min-width: 190px;
    }
    .posture-desired,
    .posture-observed {
      font-family: ${fonts.mono};
      color: ${colors.textMuted};
    }
    .posture-reason {
      flex-basis: 100%;
      color: ${colors.textMuted};
    }
    .posture-empty {
      color: ${colors.textMuted};
      font-size: ${fonts.sizeXs};
    }
  </style>
`;

/**
 * Posture summary for Run Detail. Rendered next to the pipeline so the operator
 * reads "what this run is holding" beside "where this run is".
 */
export function renderRunPostureSummary(state: RunPostureStatusState): unknown {
  if (state.status === 'idle') return nothing;
  if (state.status === 'loading' && !state.state) {
    return html`${POSTURE_STYLES}
      <section class="posture-panel" aria-label="Resource posture" data-testid="run-posture">
        <div class="posture-title">Resource posture</div>
        <div class="posture-empty">Loading posture…</div>
      </section>`;
  }
  if (state.status === 'error' || !state.state) {
    return html`${POSTURE_STYLES}
      <section class="posture-panel" aria-label="Resource posture" data-testid="run-posture">
        <div class="posture-title">Resource posture</div>
        <div class="posture-failure" role="alert" data-testid="run-posture-error">
          ${state.message ?? 'Posture status is unavailable.'}
        </div>
      </section>`;
  }
  const summary = summarizeRunPosture(state.state);
  const transition = summary.lastTransition;
  return html`
    ${POSTURE_STYLES}
    <section
      class="posture-panel"
      aria-label="Resource posture"
      data-testid="run-posture"
      data-posture=${summary.posture}
      data-policy-source=${summary.policySource}
      data-retained-count=${String(summary.counts.retained)}
      data-warm-count=${String(summary.counts.warm)}
      data-stopped-count=${String(summary.counts.stopped)}
      data-failed-count=${String(summary.counts.failed)}
    >
      <div class="posture-title">Resource posture</div>
      <div class="posture-headline">
        <span class="posture-name" data-testid="run-posture-name">${summary.postureLabel}</span>
        <span class="posture-source" data-testid="run-posture-source"
          >policy from
          ${summary.policySourceLabel}${summary.gateChoice
            ? ` · choice ${summary.gateChoice}`
            : ''}${summary.waitPolicy ? ` · dispatch preset ${summary.waitPolicy}` : ''}</span
        >
        <span class="posture-counts" data-testid="run-posture-counts"
          >${summary.counts.retained} retained · ${summary.counts.warm} warm ·
          ${summary.counts.stopped} stopped · ${summary.counts.failed} failed</span
        >
        <span class="posture-source" data-testid="run-posture-worker"
          >worker ${summary.workerRetained ? 'retained' : 'stopped'}</span
        >
      </div>
      ${transition
        ? html`
            <div class="posture-transition" data-testid="run-posture-transition">
              Last transition to ${postureLabel(transition.posture)}:
              ${transitionOutcomeLabel(transition.outcome)} ·
              ${transition.completedAt ?? transition.requestedAt} ·
              ${transition.progress.completed}/${transition.progress.total} steps
            </div>
            ${transition.effects.length
              ? html`<div class="posture-transition" data-testid="run-posture-effects">
                  Effects: ${transition.effects.join('; ')}
                </div>`
              : nothing}
            ${transition.rejection
              ? html`<div class="posture-failure" role="alert" data-testid="run-posture-rejection">
                  ${rejectionMessage(transition.rejection)}
                </div>`
              : nothing}
            ${transition.failures.map(
              (failure) =>
                html`<div
                  class="posture-failure"
                  role="alert"
                  data-testid="run-posture-failure-${failure.capabilityId}"
                >
                  ${failure.capabilityId}: ${failure.reason}
                </div>`,
            )}
          `
        : nothing}
      ${summary.rows.length === 0
        ? html`<div class="posture-empty" data-testid="run-posture-empty">
            This run holds no runtime capabilities.
          </div>`
        : summary.rows.map(
            (row) => html`
              <div
                class="posture-row"
                data-testid="run-posture-row-${row.capabilityId}"
                data-desired=${row.desiredDisposition}
                data-observed=${row.observedState}
                data-row-status=${row.rowStatus}
              >
                <span class="posture-cap">${row.capabilityId}</span>
                <span class="posture-desired">wants ${row.desiredLabel}</span>
                <span class="posture-observed" style="color:${rowStatusColor(row.rowStatus)}"
                  >observed ${row.observedState} (${rowStatusLabel(row.rowStatus)})</span
                >
                ${row.warmUntil
                  ? html`<span class="posture-desired">warm until ${row.warmUntil}</span>`
                  : nothing}
                <span class="posture-reason">${row.reason}</span>
                ${row.cleanupFailure
                  ? html`<span class="posture-failure" role="alert"
                      >Cleanup failed: ${row.cleanupFailure}</span
                    >`
                  : nothing}
              </div>
            `,
          )}
    </section>
  `;
}
