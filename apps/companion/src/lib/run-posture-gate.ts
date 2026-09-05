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
  correlateResourcePostureTransition,
  isTerminalResourcePostureOutcome,
  RESOURCE_POSTURE_GATE_CHOICES,
  type ResourcePosture,
  type ResourcePostureGateChoice,
  type ResourcePosturePlan,
  type ResourcePostureTransition,
  type ResourcePostureTransitionBaseline,
  resourcePostureTransitions,
  type RunResourcePostureState,
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
  /**
   * The Gateway posture observed when the choice was made. A response that
   * comes back after the run moved to a different boundary describes that
   * boundary, not the wait the operator was answering.
   */
  requestedAtPosture?: ResourcePosture;
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
 * Rebind the gate state to the gate and the Gateway posture now on screen.
 *
 * Two things invalidate a selection. A different gate gets a clean state, so a
 * preview still in flight for the previous decision cannot land on the new one.
 * A run that has left the operator wait invalidates the selection too: the
 * choices stop being offered, and leaving the selection behind would keep a
 * previewed rejection blocking every action on a decision the choice no longer
 * has any bearing on. Both bump the request id so an in-flight response is
 * discarded rather than repopulating what was just cleared.
 *
 * The applied transition survives: it reports something that already happened,
 * and it does not block anything.
 */
export function runPostureGateForContext(
  state: RunPostureGateState,
  context: PostureChoiceAvailability & { gateKey: string },
): RunPostureGateState {
  if (state.gateKey !== context.gateKey) {
    return {
      gateKey: context.gateKey,
      requestId: state.requestId + 1,
      choice: null,
      status: 'idle',
      ...(state.appliedTransition ? { appliedTransition: state.appliedTransition } : {}),
    };
  }
  if (postureChoicesApply(context)) return state;
  // An unread posture means the status has not come back yet, never that the
  // choice stopped applying. Clearing on it would discard a selection the
  // operator just made because a refresh happened to be in flight or to fail.
  // Nothing is forwarded while the posture is unknown, so keeping it is safe.
  if (context.runPosture === undefined) return state;
  if (state.choice === null && state.status === 'idle') return state;
  return {
    gateKey: state.gateKey,
    requestId: state.requestId + 1,
    choice: null,
    status: 'idle',
    ...(state.appliedTransition ? { appliedTransition: state.appliedTransition } : {}),
  };
}

/**
 * Select a choice, or clear it by selecting it again. Selecting drops the
 * previous plan and the previous apply outcome: both describe a choice the
 * operator has moved away from.
 */
export function runPostureGateSelect(
  state: RunPostureGateState,
  choice: ResourcePostureGateChoice | null,
  availability: PostureChoiceAvailability,
): RunPostureGateState {
  const requestId = state.requestId + 1;
  const cleared: RunPostureGateState = {
    gateKey: state.gateKey,
    requestId,
    choice: null,
    status: 'idle',
  };
  // The Gateway only resolves a gate choice at an operator wait. Selecting
  // anywhere else would preview a different boundary and render it as the effect
  // of the choice, so the guard lives here and no caller can bypass it.
  if (!postureChoicesApply(availability)) return cleared;
  const next = state.choice === choice ? null : choice;
  if (!next) return cleared;
  return {
    gateKey: state.gateKey,
    requestId,
    choice: next,
    status: 'loading',
    requestedAtPosture: availability.runPosture,
  };
}

/**
 * Whether a preview response still belongs to the selection on screen.
 *
 * The posture is part of the identity, not just the gate and the request id. If
 * the run left the operator wait between the request and the response, the
 * Gateway computed the plan for whatever boundary it had reached, and rendering
 * that as the effect of the operator's choice is the failure this guards.
 */
export function runPostureGateResponseApplies(
  state: RunPostureGateState,
  response: PostureChoiceAvailability & { gateKey: string; requestId: number },
): boolean {
  if (state.gateKey !== response.gateKey || state.requestId !== response.requestId) return false;
  if (!postureChoicesApply(response)) return false;
  return state.requestedAtPosture === response.runPosture;
}

export function runPostureGatePreviewLoaded(
  state: RunPostureGateState,
  response: PostureChoiceAvailability & {
    gateKey: string;
    requestId: number;
    plan: ResourcePosturePlan;
  },
): RunPostureGateState {
  if (!runPostureGateResponseApplies(state, response)) return state;
  return { ...state, status: 'ready', plan: response.plan, message: undefined };
}

export function runPostureGatePreviewFailed(
  state: RunPostureGateState,
  response: PostureChoiceAvailability & {
    gateKey: string;
    requestId: number;
    message: string;
  },
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
export interface PostureChoiceAvailability {
  /**
   * Whether resolving this decision can carry the choice at all. Only
   * `run.resolveDecision` has the typed `resourcePosture` field; a decision
   * resolved through `decision.resolve` has nowhere to put it, so offering the
   * choices there shows the operator a plan that resolving silently discards.
   */
  canForwardChoice: boolean;
  runPosture: ResourcePosture | undefined;
}

export function postureChoicesApply(input: PostureChoiceAvailability): boolean {
  return input.canForwardChoice && input.runPosture === 'operator-wait';
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
  if (choice !== 'project-default') return plan.policySource === 'gate-choice';
  // Some other choice won, so this one was not what produced the plan.
  if (plan.policySource === 'gate-choice') return false;
  // The run's dispatch preset applied, which is precisely what deferring means.
  if (plan.policySource === 'run-dispatch') return true;
  return plan.posture === 'operator-wait';
}

/**
 * Why a held choice is not being forwarded, for the operator to read, or null
 * when there is nothing withheld. Silently dropping a selection the operator
 * made is its own dishonesty.
 *
 * Wording matches Command Center's `postureChoiceWithheldReason` so the same
 * situation reads the same on both surfaces. The first branch has no Command
 * Center counterpart: only `run.resolveDecision` carries a typed
 * `resourcePosture`, and that is a fact about the decision rather than a state
 * that may resolve, so it is reported ahead of an unread posture.
 */
export function postureChoiceWithheldReason(
  state: RunPostureGateState,
  availability: PostureChoiceAvailability,
): string | null {
  if (!state.choice) return null;
  if (postureChoicesApply(availability)) return null;
  const label = gateChoiceLabel(state.choice);
  const tail = `choice is withheld. Resolving now applies the run's own policy.`;
  if (!availability.canForwardChoice) {
    return `This decision cannot carry a posture choice, so the ${label} ${tail}`;
  }
  if (availability.runPosture === undefined) {
    return `Resource posture is unknown, so the ${label} ${tail}`;
  }
  return `This run is no longer at an operator wait, so the ${label} ${tail}`;
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

export function postureResolveBlock(
  state: RunPostureGateState,
  availability: PostureChoiceAvailability,
): RunPostureGateBlock {
  // The block exists to stop an offered choice being sent unproven or refused.
  // Where the choices are not offered nothing will be forwarded, so a verdict
  // about one must not stand between the operator and the decision.
  if (!postureChoicesApply(availability)) return { kind: 'none', message: '' };
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

export function postureResolveBlockReason(
  state: RunPostureGateState,
  availability: PostureChoiceAvailability,
): string | null {
  const block = postureResolveBlock(state, availability);
  return block.kind === 'none' ? null : block.message;
}

/**
 * Whether the operator may resolve the gate with this choice. A previewed
 * rejection blocks it: sending a choice the Gateway already refused would only
 * produce the same refusal after the decision is gone.
 */
export function canResolveWithPostureChoice(
  state: RunPostureGateState,
  availability: PostureChoiceAvailability,
): boolean {
  return postureResolveBlock(state, availability).kind === 'none';
}

/**
 * The choice to send on `run.resolveDecision`, or undefined when none applies.
 * Guarded on the Gateway's posture so a choice picked before the run left the
 * operator wait is not forwarded as if it still meant something.
 */
export function postureChoiceForResolve(
  state: RunPostureGateState,
  availability: PostureChoiceAvailability,
): ResourcePostureGateChoice | undefined {
  if (!postureChoicesApply(availability)) return undefined;
  if (!state.choice) return undefined;
  if (!canResolveWithPostureChoice(state, availability)) return undefined;
  return state.choice;
}

export type PostureTransitionObservation =
  | { status: 'observed'; transition: ResourcePostureTransition }
  /** The bounded wait elapsed with no correlated transition. Never a success. */
  | { status: 'pending' }
  | { status: 'unreadable'; message: string };

/**
 * Wait, briefly and finitely, for the Gateway to report this resolution's own
 * posture transition.
 *
 * Which record belongs to this resolution is decided by
 * `correlateResourcePostureTransition` in `@farmslot/protocol`, where the four
 * rules and their limits are documented once for every client. This function
 * owns only rule 4's polling half plus the mobile concern the shared code has no
 * business knowing about: a backgrounded app.
 *
 * The reader is injected so the wait is testable without a gateway.
 */
export async function observePostureTransition(
  baseline: ResourcePostureTransitionBaseline,
  read: () => Promise<RunResourcePostureState | undefined>,
  options: {
    attempts: number;
    delayMs: number;
    wait?: (ms: number) => Promise<void>;
    /**
     * Errors that mean "could not read just now", not "the read failed".
     * Backgrounding the app pauses gateway requests routinely, and calling that
     * an unknown outcome alarms the operator about something that is normal.
     */
    isTransient?: (err: unknown) => boolean;
  },
): Promise<PostureTransitionObservation> {
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    if (attempt > 0) await wait(options.delayMs);
    let state: RunResourcePostureState | undefined;
    try {
      state = await read();
    } catch (err) {
      // A transient pause is waited through; anything else is reported rather
      // than swallowed, since retrying past it would present a later silence as
      // "nothing happened".
      if (options.isTransient?.(err)) continue;
      return { status: 'unreadable', message: (err as Error).message };
    }
    const transition = correlateResourcePostureTransition(
      baseline,
      resourcePostureTransitions(state),
    );
    // Keep waiting while the Gateway is still working. The record is the right
    // one; it just does not yet say how it ended.
    if (transition && isTerminalResourcePostureOutcome(transition.outcome)) {
      return { status: 'observed', transition };
    }
  }
  return { status: 'pending' };
}

/**
 * What to tell the operator about a resolution's posture outcome, or null when
 * there is nothing worth interrupting them for.
 *
 * A clean apply says nothing: the posture summary on Run Detail already shows
 * it. Silence is reserved for outcomes that are both correlated and fine.
 */
export function postureApplyAlert(
  observation: PostureTransitionObservation,
  choice: ResourcePostureGateChoice,
): { title: string; message: string } | null {
  if (observation.status === 'pending') {
    return {
      title: 'Resource posture pending',
      message: `The Gateway has not reported the outcome of "${gateChoiceLabel(choice)}" yet. The run's posture summary will show it once reconciliation finishes.`,
    };
  }
  if (observation.status === 'unreadable') {
    return {
      title: 'Resource posture unknown',
      message: `The outcome of "${gateChoiceLabel(choice)}" could not be read: ${observation.message}`,
    };
  }
  const { transition } = observation;
  if (transition.rejection) {
    return {
      title: 'Resource posture not applied',
      message: rejectionMessage(transition.rejection),
    };
  }
  if (transition.failures.length) {
    return {
      title: 'Resource posture partly applied',
      message: transition.failures
        .map((failure) => `${failure.capabilityId}: ${failure.reason}`)
        .join('\n'),
    };
  }
  return null;
}
