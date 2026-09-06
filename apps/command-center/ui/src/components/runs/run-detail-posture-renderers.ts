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

import {
  gateParkStateLabel,
  gateParkSummaryLine,
  type GateParkView,
  type ResourcePosture,
  type ResourcePostureCapabilityState,
  type ResourcePostureCounts,
  resourcePostureCounts,
  type ResourcePostureDesiredDisposition,
  type ResourcePostureGateChoice,
  type ResourcePostureObservedState,
  type ResourcePosturePolicySource,
  type ResourcePostureRejection,
  type ResourcePostureRowStatus,
  resourcePostureRowStatus,
  type ResourcePostureTransition,
  type ResourcePostureTransitionFailure,
  resourcePostureTransitionFailuresToShow,
  type ResourcePostureTransitionOutcome,
  type ResourcePostureWaitPolicy,
  type RunResourcePostureState,
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

export interface RunPostureCapabilityRow {
  capabilityId: string;
  desiredDisposition: ResourcePostureDesiredDisposition;
  desiredLabel: string;
  observedState: ResourcePostureObservedState;
  rowStatus: ResourcePostureRowStatus;
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
    rowStatus: resourcePostureRowStatus(state.desiredDisposition, state.observedState),
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
  /** Observed-state counts, derived by the shared protocol helper. */
  counts: ResourcePostureCounts;
  rows: RunPostureCapabilityRow[];
  lastTransition?: ResourcePostureTransition;
  updatedAt: string;
}

export function summarizeRunPosture(state: RunResourcePostureState): RunPostureSummary {
  const rows = state.capabilities.map(postureCapabilityRow);
  const counts = resourcePostureCounts(state.capabilities, state.lastTransition);
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

/**
 * Transition failures that are not already shown on a capability row. The
 * de-duplication rule is the shared protocol one; this only adapts the row view
 * back to the capability fields that rule reads.
 */
export function postureTransitionFailuresToShow(
  summary: RunPostureSummary,
): ResourcePostureTransitionFailure[] {
  return resourcePostureTransitionFailuresToShow(summary.rows, summary.lastTransition);
}

function rowStatusColor(rowStatus: ResourcePostureRowStatus): string {
  if (rowStatus === 'matches') return colors.statusOk;
  if (rowStatus === 'mismatch') return colors.statusFail;
  return colors.textMuted;
}

function rowStatusLabel(rowStatus: ResourcePostureRowStatus): string {
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
    .posture-park {
      margin-top: 8px;
      border-top: 1px solid ${colors.bgCard};
      padding-top: 8px;
      color: ${colors.textMuted};
      font-size: ${fonts.sizeXs};
    }
    .posture-park-headline {
      color: ${colors.textPrimary};
      font-family: ${fonts.mono};
    }
    .posture-park-line {
      font-family: ${fonts.mono};
      margin-top: 3px;
    }
  </style>
`;

/**
 * Posture summary for Run Detail. Rendered next to the pipeline so the operator
 * reads "what this run is holding" beside "where this run is".
 */
/**
 * What a just-resolved resolution produced, carried by the persistent summary.
 *
 * The gate panel disappears the moment the decision resolves, so a notice living
 * inside it is unreadable exactly when the operator wants it. The summary
 * otherwise renders only the run's latest transition, which is not necessarily
 * the correlated one, so the observation is passed in rather than re-derived.
 */
export interface RunPostureResolutionState {
  /** The transition correlated to the operator's resolution, once terminal. */
  appliedTransition?: ResourcePostureTransition;
  /**
   * The Gateway attributed that transition to the choice this client forwarded.
   * When false the match is positional — new, recent and unexcluded — which the
   * shared contract is explicit may belong to a concurrent reconciliation.
   */
  appliedTransitionAttributed?: boolean;
  /** The Gateway has not recorded a terminal outcome for it yet. */
  reconciliationPending?: boolean;
  /** A selection the operator made that will not be sent, and why. */
  withheldChoiceReason?: string | null;
}

export function renderRunPostureResolution(state: RunPostureResolutionState): unknown {
  const withheld = state.withheldChoiceReason
    ? html`<div class="posture-failure" role="alert" data-testid="run-posture-choice-withheld">
        ${state.withheldChoiceReason}
      </div>`
    : nothing;
  if (state.reconciliationPending) {
    return html`${withheld}
      <div class="posture-transition" data-testid="run-posture-reconciliation-pending">
        The Gateway has not finished reconciling your last resolution, so its outcome is not known
        yet.
      </div>`;
  }
  const transition = state.appliedTransition;
  if (!transition) return withheld;
  return html`
    ${withheld}
    <div class="posture-transition" data-testid="run-posture-resolution">
      ${state.appliedTransitionAttributed
        ? 'Your last resolution'
        : 'Run posture after resolution'}:
      ${postureLabel(transition.posture)} · ${transitionOutcomeLabel(transition.outcome)} ·
      ${transition.completedAt ?? transition.requestedAt}
    </div>
    ${transition.rejection
      ? html`<div
          class="posture-failure"
          role="alert"
          data-testid="run-posture-resolution-rejection"
        >
          ${rejectionMessage(transition.rejection)}
        </div>`
      : nothing}
    ${transition.failures.map(
      (failure) =>
        html`<div
          class="posture-failure"
          role="alert"
          data-testid="run-posture-resolution-failure-${failure.capabilityId}"
        >
          ${failure.capabilityId}: ${failure.reason}
        </div>`,
    )}
  `;
}

/**
 * The run's gate park, rendered from the shared protocol reading.
 *
 * The posture panel says what the run is HOLDING; this says where the run's
 * slot went. They are different questions and a parked run needs both answered:
 * the posture reports `parked`, and only this says which slot dispatch was
 * handed, which branch was taken out of its working tree, and which slot a
 * restore would use. Availability is whatever the Gateway said, or "not known"
 * — this never decides it.
 */
export function renderRunGatePark(view: GateParkView | null): unknown {
  if (!view) return nothing;
  const target = view.restoreTarget;
  return html`
    <div
      class="posture-park"
      data-testid="run-posture-gate-park"
      data-slot-state=${view.slotState}
      data-slot-disposition=${view.slotDisposition}
      data-freed-slot=${view.freedSlotId ?? ''}
      data-restore-first=${String(view.restoreBeforeGateAnswer)}
      data-restore-available=${target.available === null ? 'unknown' : String(target.available)}
      data-restore-stage=${view.restoreStage.state}
    >
      <div class="posture-park-headline" data-testid="run-posture-gate-park-state">
        ${gateParkStateLabel(view)}
      </div>
      <div class="posture-park-line" data-testid="run-posture-gate-park-summary">
        ${gateParkSummaryLine(view)}
      </div>
      ${view.freedSlotId
        ? html`<div class="posture-park-line" data-testid="run-posture-gate-park-freed">
            ${view.freedSlotId} is free for dispatch while this run stays parked.
          </div>`
        : nothing}
      <div class="posture-park-line" data-testid="run-posture-gate-park-target">
        Restore target ${target.slotId} —
        ${target.available === null
          ? 'availability not read; ask the Gateway with a restore preview'
          : target.available
            ? `available${target.reason ? `: ${target.reason}` : ''}`
            : `not available${target.reason ? `: ${target.reason}` : ''}`}
      </div>
      ${view.refusal
        ? html`<div
            class="posture-failure"
            role="alert"
            data-testid="run-posture-gate-park-refusal"
          >
            Last restore refused (${view.refusal.code}): ${view.refusal.reason}
          </div>`
        : nothing}
    </div>
  `;
}

export function renderRunPostureSummary(
  state: RunPostureStatusState,
  resolution: RunPostureResolutionState = {},
  gatePark: GateParkView | null = null,
): unknown {
  // A live park is worth a panel on its own: the posture read can be idle or
  // failed exactly when a run is parked, and hiding where its slot went because
  // a different request has not landed is the wrong thing to hide.
  if (state.status === 'idle' && !gatePark) return nothing;
  if (state.status === 'idle') {
    // An unread posture is not an unavailable one. Saying so keeps the park
    // visible without claiming the Gateway failed to answer a question that was
    // never asked.
    return html`${POSTURE_STYLES}
      <section class="posture-panel" aria-label="Resource posture" data-testid="run-posture">
        <div class="posture-title">Resource posture</div>
        ${renderRunPostureResolution(resolution)} ${renderRunGatePark(gatePark)}
        <div class="posture-empty" data-testid="run-posture-unread">
          Posture status has not been read for this run.
        </div>
      </section>`;
  }
  // The resolution and withheld notices render in every branch. A failed status
  // read is exactly when `reconciliationPending` is true and exactly when a
  // choice is withheld, so suppressing them here hid both in their likeliest
  // case — which is what moving them out of the gate was meant to prevent.
  if (state.status === 'loading' && !state.state) {
    return html`${POSTURE_STYLES}
      <section class="posture-panel" aria-label="Resource posture" data-testid="run-posture">
        <div class="posture-title">Resource posture</div>
        ${renderRunPostureResolution(resolution)} ${renderRunGatePark(gatePark)}
        <div class="posture-empty">Loading posture…</div>
      </section>`;
  }
  if (state.status === 'error' || !state.state) {
    return html`${POSTURE_STYLES}
      <section class="posture-panel" aria-label="Resource posture" data-testid="run-posture">
        <div class="posture-title">Resource posture</div>
        ${renderRunPostureResolution(resolution)} ${renderRunGatePark(gatePark)}
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
      data-unresolved-count=${String(summary.counts.unresolved)}
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
          ${summary.counts.stopped} stopped · ${summary.counts.failed}
          failed${summary.counts.unresolved
            ? ` · ${summary.counts.unresolved} unresolved`
            : ''}</span
        >
        <span class="posture-source" data-testid="run-posture-worker"
          >worker ${summary.workerRetained ? 'retained' : 'stopped'}</span
        >
      </div>
      ${renderRunPostureResolution(resolution)} ${renderRunGatePark(gatePark)}
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
            ${postureTransitionFailuresToShow(summary).map(
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
