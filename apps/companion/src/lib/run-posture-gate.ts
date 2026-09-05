/**
 * Human-gate resource-posture choices for Companion (ADR-054, deliverable 8).
 *
 * The operator picks one of the four gate choices; the Gateway answers with the
 * exact plan through `runtime.posture.preview`, and that plan is what is shown
 * before the decision is resolved. Nothing here resolves policy: the choice is
 * sent to the Gateway as a typed `resourcePosture` param on
 * `run.resolveDecision`, and `free-slot` is offered exactly as the Gateway
 * defines it — including its rejection, which is reported as a block on that
 * choice rather than hidden, pre-empted, or dressed up as a request failure.
 *
 * This module is pure: the screen owns the RPC calls and feeds their outcomes
 * back through these transitions, so the staleness rules are testable without a
 * gateway or a renderer.
 */
import {
  RESOURCE_POSTURE_GATE_CHOICES,
  type ResourcePosture,
  type ResourcePostureGateChoice,
  type ResourcePosturePlan,
  type ResourcePostureTransition,
} from '@farmslot/protocol';

import { policySourceLabel, postureLabel, rejectionMessage } from './run-resource-posture';

/** Operator-facing copy. The posture each choice resolves to comes from the Gateway. */
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

export const RUN_POSTURE_GATE_CHOICES: readonly ResourcePostureGateChoice[] =
  RESOURCE_POSTURE_GATE_CHOICES;

export function gateChoiceLabel(choice: ResourcePostureGateChoice): string {
  return GATE_CHOICE_COPY[choice].label;
}

export function gateChoiceHelp(choice: ResourcePostureGateChoice): string {
  return GATE_CHOICE_COPY[choice].help;
}

/** Preview state for the gate currently on screen. */
export interface RunPostureGateState {
  /**
   * Identity of the decisions this state belongs to. A preview requested for one
   * gate must never render beside another.
   */
  gateKey: string;
  /**
   * Monotonic id of the newest preview request. A response carrying an older id
   * lost the race and is discarded.
   */
  requestId: number;
  choice: ResourcePostureGateChoice | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  plan?: ResourcePosturePlan;
  message?: string;
  /** Apply outcome recorded after the decision resolved, so a rejection is visible. */
  appliedTransition?: ResourcePostureTransition;
}

export function initialRunPostureGateState(): RunPostureGateState {
  return { gateKey: '', requestId: 0, choice: null, status: 'idle' };
}

/**
 * Identity of the gate a preview belongs to.
 *
 * A plan is only ever true of the decision it was requested for. When one
 * decision is resolved and another opens on the same run, the run id is
 * unchanged, so keying on the run alone would leave the previous gate's plan
 * rendered beside the new decision. An empty run or decision id yields an empty
 * key, which never matches a real gate.
 */
export function postureGateKey(
  runId: string | null | undefined,
  decisionId: string | null | undefined,
): string {
  if (!runId || !decisionId) return '';
  return `${runId}:${decisionId}`;
}

/**
 * Rebind the gate state to the gate now on screen. A different gate gets a clean
 * state and a bumped request id, so a preview still in flight for the previous
 * gate cannot land on the new one.
 */
export function runPostureGateForKey(
  state: RunPostureGateState,
  gateKey: string,
): RunPostureGateState {
  if (state.gateKey === gateKey) return state;
  return { gateKey, requestId: state.requestId + 1, choice: null, status: 'idle' };
}

/**
 * Select a choice, or clear it by selecting it again. Selecting drops the
 * previous plan and the previous apply outcome: both describe a choice the
 * operator has moved away from.
 */
export function runPostureGateSelect(
  state: RunPostureGateState,
  choice: ResourcePostureGateChoice | null,
): RunPostureGateState {
  const next = state.choice === choice ? null : choice;
  const requestId = state.requestId + 1;
  if (!next) return { gateKey: state.gateKey, requestId, choice: null, status: 'idle' };
  return { gateKey: state.gateKey, requestId, choice: next, status: 'loading' };
}

/** Whether a preview response still belongs to the selection on screen. */
export function runPostureGateResponseApplies(
  state: RunPostureGateState,
  response: { gateKey: string; requestId: number },
): boolean {
  return state.gateKey === response.gateKey && state.requestId === response.requestId;
}

export function runPostureGatePreviewLoaded(
  state: RunPostureGateState,
  response: { gateKey: string; requestId: number; plan: ResourcePosturePlan },
): RunPostureGateState {
  if (!runPostureGateResponseApplies(state, response)) return state;
  return { ...state, status: 'ready', plan: response.plan, message: undefined };
}

export function runPostureGatePreviewFailed(
  state: RunPostureGateState,
  response: { gateKey: string; requestId: number; message: string },
): RunPostureGateState {
  if (!runPostureGateResponseApplies(state, response)) return state;
  return { ...state, status: 'error', plan: undefined, message: response.message };
}

/** Record the Gateway's apply outcome so a rejection at resolve time stays visible. */
export function runPostureGateApplied(
  state: RunPostureGateState,
  transition: ResourcePostureTransition | undefined,
): RunPostureGateState {
  if (!transition) return state;
  return { ...state, appliedTransition: transition };
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
 * Whether the Gateway resolved the plan from the operator's choice.
 *
 * `project-default` is the one choice whose meaning is to defer: it asks for
 * whatever the dispatch config, project, and framework defaults resolve to, so a
 * plan sourced from one of those levels IS that choice being honoured. Treating
 * every non-`gate-choice` source as unhonoured warned the operator that their
 * choice had been ignored at the exact moment it was obeyed.
 */
export function postureChoiceHonored(
  plan: ResourcePosturePlan,
  choice: ResourcePostureGateChoice,
): boolean {
  if (choice === 'project-default') return plan.policySource !== 'gate-choice';
  return plan.policySource === 'gate-choice';
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
 * One-line summary of the plan, for an operator who will not read every row on a
 * phone: the posture, the precedence level that produced it, and the effect.
 *
 * A rejected plan says nothing was applied rather than "no capability changes" —
 * the two are indistinguishable in the counts and mean opposite things, one a
 * safe no-op and the other a refusal.
 */
export function postureGatePreviewSummary(plan: ResourcePosturePlan): string {
  const parts: string[] = [];
  if (plan.acquire.length) parts.push(`${plan.acquire.length} to acquire`);
  if (plan.retain.length) parts.push(`${plan.retain.length} retained`);
  if (plan.warm.length) parts.push(`${plan.warm.length} left warm`);
  if (plan.stop.length) parts.push(`${plan.stop.length} stopped`);
  const body = plan.rejection
    ? 'nothing applied'
    : parts.length
      ? parts.join(' · ')
      : 'no capability changes';
  return `${postureLabel(plan.posture)} via ${policySourceLabel(plan.policySource)} — ${body}`;
}

/**
 * Why resolving the gate with the current choice is blocked.
 *
 * `rejected` is kept apart from `request-failed` on purpose. A rejection is the
 * Gateway's considered answer — `free-slot` on a gate-held run comes back as a
 * typed `park-ineligible` rejection — and the fix is to pick another choice. A
 * failed request is a broken round trip and the fix is to retry it. Collapsing
 * them into one error would tell the operator to retry something that will never
 * succeed, or to abandon a choice that only needed another attempt.
 */
export type RunPostureGateBlockKind = 'none' | 'pending' | 'request-failed' | 'rejected';

export interface RunPostureGateBlock {
  kind: RunPostureGateBlockKind;
  message: string;
}

export function postureResolveBlock(state: RunPostureGateState): RunPostureGateBlock {
  if (!state.choice) return { kind: 'none', message: '' };
  if (state.status === 'idle' || state.status === 'loading') {
    return {
      kind: 'pending',
      message: 'Waiting for the Gateway to report what this choice would do.',
    };
  }
  if (state.status === 'error') {
    const detail = state.message ? ` ${state.message}` : '';
    return {
      kind: 'request-failed',
      message: `The posture preview request failed, so this choice is unproven. Retry it or clear the choice.${detail}`,
    };
  }
  if (!state.plan) {
    return {
      kind: 'request-failed',
      message: 'The Gateway returned no plan for this choice. Retry it or clear the choice.',
    };
  }
  if (state.plan.rejection) {
    return {
      kind: 'rejected',
      message: `The Gateway will not apply this choice, so pick another. ${rejectionMessage(
        state.plan.rejection,
      )}`,
    };
  }
  return { kind: 'none', message: '' };
}

export function postureResolveBlockReason(state: RunPostureGateState): string | null {
  const block = postureResolveBlock(state);
  return block.kind === 'none' ? null : block.message;
}

/**
 * Whether the operator may resolve the gate with this choice. A previewed
 * rejection blocks it: sending a choice the Gateway already refused would only
 * produce the same refusal after the decision is gone.
 */
export function canResolveWithPostureChoice(state: RunPostureGateState): boolean {
  return postureResolveBlock(state).kind === 'none';
}

/**
 * The choice to send on `run.resolveDecision`, or undefined when none applies.
 * Guarded on the Gateway's posture so a choice picked before the run left the
 * operator wait is not forwarded as if it still meant something.
 */
export function postureChoiceForResolve(
  state: RunPostureGateState,
  runPosture: ResourcePosture | undefined,
): ResourcePostureGateChoice | undefined {
  if (!postureChoicesApply(runPosture)) return undefined;
  if (!state.choice) return undefined;
  if (!canResolveWithPostureChoice(state)) return undefined;
  return state.choice;
}
