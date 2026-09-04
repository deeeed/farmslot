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
  type ResourcePostureGateChoice,
  type ResourcePosturePlan,
  type ResourcePostureTransition,
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
  const body = parts.length ? parts.join(' · ') : 'no capability changes';
  return `${postureLabel(plan.posture)} via ${policySourceLabel(plan.policySource)} — ${body}`;
}

/**
 * Whether the operator may resolve the gate with this choice. A previewed
 * rejection blocks it: sending a choice the Gateway already refused would only
 * produce the same refusal after the decision is gone.
 */
export function canResolveWithPostureChoice(state: RunPostureGateState): boolean {
  if (!state.choice) return true;
  if (state.status !== 'ready' || !state.plan) return false;
  return !state.plan.rejection;
}

export interface RunPostureGateRenderContext {
  state: RunPostureGateState;
  disabled: boolean;
  onSelect: (choice: ResourcePostureGateChoice | null) => void;
}

export function renderRunPostureGateChoices(ctx: RunPostureGateRenderContext): unknown {
  const { state } = ctx;
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
            <div class="posture-gate-summary" data-testid="run-posture-preview-summary">
              ${postureGatePreviewSummary(plan)}
            </div>
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
