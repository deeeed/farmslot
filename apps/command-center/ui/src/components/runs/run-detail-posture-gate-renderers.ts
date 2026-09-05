/**
 * Human-gate resource-posture choices (ADR-054, deliverable 7).
 *
 * The operator picks one of the four gate choices; the Gateway answers with the
 * exact plan through `runtime.posture.preview`, and that plan is what is shown
 * before the decision is resolved. Nothing here resolves policy: the choice is
 * sent to the Gateway as a typed `resourcePosture` param on
 * `run.resolveDecision`, and `free-slot` is offered exactly as the Gateway
 * defines it — including its rejection, which is reported honestly rather than
 * hidden or pre-empted by the client.
 */
import { html, nothing } from 'lit';

import {
  RESOURCE_POSTURE_GATE_CHOICES,
  type ResourcePosture,
  type ResourcePostureGateChoice,
  type ResourcePosturePlan,
  type ResourcePostureTransition,
  type Run,
} from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';

import {
  policySourceLabel,
  postureLabel,
  rejectionMessage,
} from './run-detail-posture-renderers.js';

/** Operator-facing copy for each choice. The posture each resolves to comes from the Gateway. */
const GATE_CHOICE_COPY: Record<ResourcePostureGateChoice, { label: string; help: string }> = {
  'keep-for-validation': {
    label: 'Keep for validation',
    help: 'Keep the capabilities the validation proof plan needs acquired and healthy.',
  },
  minimize: {
    label: 'Minimize',
    help: 'Shed expensive providers for the wait and keep the worker session.',
  },
  'free-slot': {
    label: 'Free the slot',
    help: 'Park this run through machine parking. Gate-held runs are not eligible yet.',
  },
  'project-default': {
    label: 'Project default',
    help: 'Use whatever the dispatch config, project, and framework defaults resolve to.',
  },
};

export function gateChoiceLabel(choice: ResourcePostureGateChoice): string {
  return GATE_CHOICE_COPY[choice].label;
}

export function gateChoiceHelp(choice: ResourcePostureGateChoice): string {
  return GATE_CHOICE_COPY[choice].help;
}

export const RUN_POSTURE_GATE_CHOICES: readonly ResourcePostureGateChoice[] =
  RESOURCE_POSTURE_GATE_CHOICES;

/** Preview fetch state for one gate choice. */
export interface RunPostureGateState {
  choice: ResourcePostureGateChoice | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  plan?: ResourcePosturePlan;
  message?: string;
  /** Apply outcome recorded after the decision resolved, so a rejection is visible. */
  appliedTransition?: ResourcePostureTransition;
  /**
   * The Gateway's persisted posture for this run, when its status has been read.
   * `undefined` means the status is not known yet — never that the run is
   * outside an operator wait.
   */
  runPosture?: ResourcePosture;
  /**
   * The Gateway has not yet recorded a terminal transition for the resolution
   * that was just sent. Reported rather than showing an outcome that belongs to
   * something else.
   */
  reconciliationPending?: boolean;
}

/** Delay between status reads while observing a resolution's transition. */
export const POSTURE_TRANSITION_POLL_INTERVAL_MS = 1000;

/**
 * Identity of the decisions currently waiting on this run, newest state first.
 *
 * A preview belongs to the gate it was requested for. When one decision is
 * resolved elsewhere and another opens on the same run, the run id is unchanged,
 * so the run-switch reset does not fire and a stale plan would render beside the
 * new decision.
 */
export function pendingDecisionKey(run: Pick<Run, 'id' | 'decisions'> | null | undefined): string {
  if (!run) return '';
  const pending = run.decisions
    .filter((decision) => !decision.resolvedAt)
    .map((decision) => decision.id)
    .sort();
  return `${run.id}:${pending.join(',')}`;
}

/**
 * Whether the Gateway would honour a gate choice for this run right now.
 *
 * The Gateway only resolves a gate choice into a posture while the run's
 * persisted posture is `operator-wait`; at any other posture the choice is
 * ignored and the plan comes back from the lifecycle boundary instead. Offering
 * the choices anyway would let an operator pick something that silently does
 * nothing. This reads the Gateway's own posture — it does not decide policy.
 */
export function postureChoicesApply(runPosture: ResourcePosture | undefined): boolean {
  return runPosture === 'operator-wait';
}

/**
 * Whether the Gateway actually honoured the operator's choice. A plan that came
 * back from somewhere else is reported as such rather than being presented as
 * the effect of the choice that was clicked.
 *
 * Every other choice is proved by the source alone: the Gateway sets
 * `gate-choice` only when it resolved the plan from an explicit choice at an
 * operator wait.
 *
 * `project-default` is the inverse — it asks the Gateway to defer to the lower
 * precedence levels, so a plan resolved from dispatch config, the project, or
 * the framework is exactly what was requested, and it can never come back as
 * `gate-choice`. The source alone is not enough for it, though. If the run
 * leaves `operator-wait` before the preview executes, the Gateway ignores the
 * choice and answers from the new lifecycle boundary, which also reports
 * `framework-default`. The plan's posture separates the two: a deferred choice
 * at an operator wait describes that wait, while an ignored one describes
 * whatever boundary the run moved to. This reads the plan only, so a stale
 * cached run posture cannot make an ignored choice look honoured.
 */
export function postureChoiceHonored(
  plan: ResourcePosturePlan,
  choice: ResourcePostureGateChoice,
): boolean {
  if (choice !== 'project-default') return plan.policySource === 'gate-choice';
  // Some other choice won, so this one was not what produced the plan.
  if (plan.policySource === 'gate-choice') return false;
  // The run's dispatch preset applied, which is precisely what deferring means.
  if (plan.policySource === 'run-dispatch') return true;
  return plan.posture === 'operator-wait';
}

/**
 * Whether a held gate choice must be dropped because the Gateway has moved the
 * run out of an operator wait.
 *
 * The choices stop rendering at that point, but the selection and its plan live
 * on the host component, not in the panel. A refused `free-slot` left behind
 * keeps blocking Resolve from behind a panel the operator can no longer see or
 * clear, which is a deadlock with no visible cause.
 *
 * An unread posture is not a reason to drop anything: `undefined` means the
 * status has not come back yet, never that the choice stopped applying.
 */
export function postureChoiceBecameInapplicable(state: RunPostureGateState): boolean {
  if (!state.runPosture) return false;
  if (postureChoicesApply(state.runPosture)) return false;
  return state.choice !== null || state.status !== 'idle';
}

/**
 * The correlation contract lives in `@farmslot/protocol` so Command Center and
 * Companion cannot drift. Re-exported here under the names this surface already
 * uses; the rules are documented once, on the protocol functions.
 */
export {
  correlateResourcePostureTransition as correlatedPostureTransition,
  isTerminalResourcePostureOutcome as isTerminalPostureOutcome,
  RESOURCE_POSTURE_TRANSITION_POLL_LIMIT as POSTURE_TRANSITION_POLL_LIMIT,
  resourcePostureTransitionBaseline as postureTransitionBaseline,
  type ResourcePostureTransitionBaseline as PostureTransitionObservation,
  resourcePostureTransitions as postureTransitionsOf,
} from '@farmslot/protocol';

/**
 * The gate choice to send with a resolution, or `undefined` to send none.
 *
 * A choice is only ever forwarded where the Gateway would honour it. Outside an
 * operator wait — including when the posture is unread after a failed status
 * refresh — the panel is not on screen, so the operator cannot see or clear the
 * selection, and sending it anyway consumes the decision with a refusal they
 * were never shown. The block lifting where the choices are hidden is correct;
 * it is the forwarding that must be gated too, and separately.
 */
export function postureChoiceForResolve(
  state: RunPostureGateStateWithAvailability,
): ResourcePostureGateChoice | undefined {
  if (!postureChoicesApply(state.runPosture)) return undefined;
  return state.choice ?? undefined;
}

/**
 * Why a held choice is not being forwarded, for the operator to read, or null
 * when there is nothing withheld. Silently dropping a selection the operator
 * made is its own dishonesty.
 */
export function postureChoiceWithheldReason(
  state: RunPostureGateStateWithAvailability,
): string | null {
  if (!state.choice) return null;
  if (postureChoicesApply(state.runPosture)) return null;
  if (state.runPosture === undefined) {
    return `Resource posture is unknown, so the ${gateChoiceLabel(state.choice)} choice is withheld. Resolving now applies the run's own policy.`;
  }
  return `This run is no longer at an operator wait, so the ${gateChoiceLabel(state.choice)} choice is withheld. Resolving now applies the run's own policy.`;
}

export interface RunPostureGatePreviewLine {
  action: 'acquire' | 'retain' | 'warm' | 'stop';
  capabilityId: string;
  reason: string;
}

/**
 * Flatten the Gateway plan into ordered display lines. Order is acquire, retain,
 * warm, stop — what starts, what stays, what loses ownership, what dies.
 */
export function postureGatePreviewLines(plan: ResourcePosturePlan): RunPostureGatePreviewLine[] {
  const groups: Array<[RunPostureGatePreviewLine['action'], ResourcePosturePlan['acquire']]> = [
    ['acquire', plan.acquire],
    ['retain', plan.retain],
    ['warm', plan.warm],
    ['stop', plan.stop],
  ];
  return groups.flatMap(([action, states]) =>
    states.map((state) => ({ action, capabilityId: state.capabilityId, reason: state.reason })),
  );
}

/**
 * One-line summary of what the plan does, for operators who will not read every
 * row. A plan that changes nothing says so instead of rendering an empty list
 * that reads as "unknown".
 */
export function postureGatePreviewSummary(plan: ResourcePosturePlan): string {
  const parts: string[] = [];
  if (plan.acquire.length) parts.push(`${plan.acquire.length} to acquire`);
  if (plan.retain.length) parts.push(`${plan.retain.length} retained`);
  if (plan.warm.length) parts.push(`${plan.warm.length} left warm`);
  if (plan.stop.length) parts.push(`${plan.stop.length} stopped`);
  // A rejected plan and an empty plan both have no groups, but they are not the
  // same answer: one is a safe no-op, the other is a refusal. Summarising a
  // refusal as "no capability changes" reads as "this is fine to resolve".
  // Companion uses this same wording, so the two clients say one thing.
  const body = plan.rejection
    ? 'nothing applied'
    : parts.length
      ? parts.join(' · ')
      : 'no capability changes';
  return `${postureLabel(plan.posture)} via ${policySourceLabel(plan.policySource)} — ${body}`;
}

/**
 * Why resolving the gate with the current choice is blocked, or null when it is
 * not blocked.
 *
 * A failed preview request and a Gateway rejection are different problems with
 * different fixes — retry the request versus pick another choice — so they get
 * different copy rather than one "the Gateway rejected this" message that is
 * wrong half the time.
 */
/**
 * A gate state whose availability has been resolved from the Gateway's posture.
 *
 * `runPosture` is required rather than optional, so a caller — or a test
 * fixture — cannot leave it out. Omitting it used to short-circuit the guards
 * below to "not blocked", which fails OPEN: an assertion meant to prove that a
 * clean plan does not block passed instead because availability was never
 * stated. Rendering can keep the optional field, because an absent posture
 * there means "offer nothing", which fails closed.
 */
export type RunPostureGateStateWithAvailability = RunPostureGateState & {
  /** The Gateway's posture for this run; `undefined` only when it is unread. */
  runPosture: ResourcePosture | undefined;
};

export function postureResolveBlockReason(
  state: RunPostureGateStateWithAvailability,
): string | null {
  // A block may only guard a choice the operator can actually see and clear.
  // The panel renders nothing outside an operator wait, and an unread posture
  // hides it too, so blocking there strands the decision behind a control that
  // is not on screen. This is the other half of the rule that an unknown
  // posture must never clear a selection: unknown means do nothing — neither
  // destroy the operator's input nor stand in their way.
  if (!postureChoicesApply(state.runPosture)) return null;
  if (!state.choice) return null;
  if (state.status === 'idle' || state.status === 'loading') {
    return 'Waiting for the Gateway to report what this choice would do.';
  }
  if (state.status === 'error') {
    const detail = state.message ? ` ${state.message}` : '';
    return `The posture preview request failed, so this choice is unproven. Retry it or clear the choice.${detail}`;
  }
  if (!state.plan) {
    return 'The Gateway returned no plan for this choice. Retry it or clear the choice.';
  }
  if (state.plan.rejection) {
    return `The Gateway rejected this choice, so pick another. ${rejectionMessage(state.plan.rejection)}`;
  }
  return null;
}

/**
 * Whether the operator may resolve the gate with this choice. A previewed
 * rejection blocks it: sending a choice the Gateway already refused would only
 * produce the same refusal after the decision is gone.
 */
export function canResolveWithPostureChoice(state: RunPostureGateStateWithAvailability): boolean {
  return postureResolveBlockReason(state) === null;
}

export interface RunPostureGateRenderContext {
  state: RunPostureGateState;
  disabled: boolean;
  onSelect: (choice: ResourcePostureGateChoice | null) => void;
}

export function renderRunPostureGateChoices(ctx: RunPostureGateRenderContext): unknown {
  const { state } = ctx;
  // Outside an operator wait the Gateway ignores a gate choice, so there is
  // nothing honest to show. The guard lives here so no caller can bypass it.
  if (!postureChoicesApply(state.runPosture)) return nothing;
  const plan = state.status === 'ready' ? state.plan : undefined;
  return html`
    <style>
      .posture-gate {
        margin: 10px 0 0;
        border-top: 1px solid ${colors.bgCard};
        padding-top: 10px;
      }
      .posture-gate-title {
        color: ${colors.textMuted};
        font-size: ${fonts.sizeXs};
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .posture-gate-choices {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 6px;
      }
      .posture-gate-btn {
        background: transparent;
        border: 1px solid ${colors.bgCardHover};
        border-radius: 4px;
        color: ${colors.textMuted};
        cursor: pointer;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        padding: 3px 8px;
      }
      .posture-gate-btn.selected {
        border-color: ${colors.accent};
        color: ${colors.accent};
      }
      .posture-gate-btn:disabled {
        cursor: default;
        opacity: 0.5;
      }
      .posture-gate-help,
      .posture-gate-summary,
      .posture-gate-line {
        color: ${colors.textMuted};
        font-size: ${fonts.sizeXs};
        margin-top: 4px;
      }
      .posture-gate-line {
        font-family: ${fonts.mono};
      }
      .posture-gate-error {
        color: ${colors.statusFail};
        font-size: ${fonts.sizeXs};
        margin-top: 6px;
      }
    </style>
    <div class="posture-gate" data-testid="run-posture-gate">
      <div class="posture-gate-title">Resource posture for this wait</div>
      <div class="posture-gate-choices">
        ${RUN_POSTURE_GATE_CHOICES.map(
          (choice) => html`
            <button
              class="posture-gate-btn ${state.choice === choice ? 'selected' : ''}"
              type="button"
              data-testid="run-posture-choice-${choice}"
              title=${gateChoiceHelp(choice)}
              ?disabled=${ctx.disabled}
              @click=${() => ctx.onSelect(state.choice === choice ? null : choice)}
            >
              ${gateChoiceLabel(choice)}
            </button>
          `,
        )}
      </div>
      ${state.choice
        ? html`<div class="posture-gate-help">${gateChoiceHelp(state.choice)}</div>`
        : html`<div class="posture-gate-help">
            No choice selected — the run's own policy applies.
          </div>`}
      ${state.status === 'loading'
        ? html`<div class="posture-gate-summary" data-testid="run-posture-preview-loading">
            Asking the Gateway what this would do…
          </div>`
        : nothing}
      ${state.status === 'error'
        ? html`<div class="posture-gate-error" role="alert" data-testid="run-posture-preview-error">
            ${state.message ?? 'Posture preview failed.'}
          </div>`
        : nothing}
      ${plan
        ? html`
            <div
              class="posture-gate-summary"
              data-testid="run-posture-preview-summary"
              data-policy-source=${plan.policySource}
              data-rejected=${plan.rejection ? 'true' : 'false'}
              data-choice-honored=${state.choice
                ? String(postureChoiceHonored(plan, state.choice))
                : 'none'}
            >
              ${postureGatePreviewSummary(plan)}
            </div>
            ${state.choice && !plan.rejection && !postureChoiceHonored(plan, state.choice)
              ? html`<div class="posture-gate-help" data-testid="run-posture-preview-not-honored">
                  The Gateway did not resolve this plan from the choice — it came from
                  ${policySourceLabel(plan.policySource)}. Resolving now applies that, not the
                  choice above.
                </div>`
              : nothing}
            ${postureGatePreviewLines(plan).map(
              (line) => html`
                <div
                  class="posture-gate-line"
                  data-testid="run-posture-preview-${line.action}-${line.capabilityId}"
                >
                  ${line.action} ${line.capabilityId} — ${line.reason}
                </div>
              `,
            )}
            ${plan.effects.length
              ? html`<div class="posture-gate-line" data-testid="run-posture-preview-effects">
                  Release effects: ${plan.effects.join('; ')}
                </div>`
              : nothing}
            ${plan.rejection
              ? html`<div
                  class="posture-gate-error"
                  role="alert"
                  data-testid="run-posture-preview-rejection"
                >
                  ${rejectionMessage(plan.rejection)}
                </div>`
              : nothing}
          `
        : nothing}
      ${state.appliedTransition?.rejection
        ? html`<div
            class="posture-gate-error"
            role="alert"
            data-testid="run-posture-apply-rejection"
          >
            ${rejectionMessage(state.appliedTransition.rejection)}
          </div>`
        : nothing}
    </div>
  `;
}
