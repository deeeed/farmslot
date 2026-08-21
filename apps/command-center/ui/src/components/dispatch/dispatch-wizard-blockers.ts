import type { FlowType, SlotStatus } from '@farmslot/protocol';

import {
  dispatchableCandidates,
  type DispatchCandidate,
  resolveAllowedSlots,
  selectedCandidate,
} from './dispatch-wizard-selectors.js';
import {
  canDispatch,
  dispatchBlockedReason,
  isDispatchBlocked,
  isQueueBlocked,
  queueBlockedReason,
  validationHint,
} from './dispatch-wizard-validation.js';

export interface DispatchWizardBlockingInput {
  flowType: FlowType | null;
  ticketId: string;
  project: string;
  matchingProject: boolean;
  slotOverride: string;
  candidates: readonly DispatchCandidate[];
  machineFilters: readonly string[];
  fleetSlots: readonly SlotStatus[];
  dispatching: boolean;
  connectionStale: boolean;
  hydrating: boolean;
  bootstrapFailed: boolean;
  loadingCandidates: boolean;
  candidateRefreshFailed: boolean;
  activeRunConflict: boolean;
  variantInputBlocked: boolean;
  comparisonFlow: boolean;
  comparisonParentRunId: string;
  /** Operator confirmed the deliberate pressure override with a reason. */
  pressureOverrideReady: boolean;
}

export interface DispatchWizardBlockingState {
  allowedSlots: string[] | undefined;
  canDispatch: boolean;
  validationHint: string;
  dispatchBlockedReason: string | null;
  dispatchBlocked: boolean;
  queueBlockedReason: string | null;
  queueBlocked: boolean;
}

export function deriveDispatchWizardBlockingState(
  input: DispatchWizardBlockingInput,
): DispatchWizardBlockingState {
  const allowedSlots = resolveAllowedSlots({
    machines: input.machineFilters,
    fleetSlots: input.fleetSlots,
    project: input.project,
  });
  const canDispatchValue = canDispatch({
    flowType: input.flowType,
    ticketId: input.ticketId,
    project: input.project,
    comparisonFlow: input.comparisonFlow,
    comparisonParentRunId: input.comparisonParentRunId,
  });
  const validationHintValue = validationHint({
    flowType: input.flowType,
    ticketId: input.ticketId,
    project: input.project,
    matchingProject: input.matchingProject,
    comparisonFlow: input.comparisonFlow,
    comparisonParentRunId: input.comparisonParentRunId,
  });
  const dispatchBlockedReasonValue = dispatchBlockedReason({
    machineFilterActive: input.machineFilters.length > 0,
    slotOverride: input.slotOverride,
    selectedCandidate: selectedCandidate(input.candidates, input.slotOverride),
    dispatchableCandidateCount: dispatchableCandidates(input.candidates).length,
    pressureOverrideReady: input.pressureOverrideReady,
  });
  const queueBlockedReasonValue = queueBlockedReason({
    canDispatch: canDispatchValue,
    validationHint: validationHintValue,
    connectionStale: input.connectionStale,
    machineFilterActive: input.machineFilters.length > 0,
    allowedSlots,
  });
  return {
    allowedSlots,
    canDispatch: canDispatchValue,
    validationHint: validationHintValue,
    dispatchBlockedReason: dispatchBlockedReasonValue,
    dispatchBlocked: isDispatchBlocked({
      canDispatch: canDispatchValue,
      dispatching: input.dispatching,
      connectionStale: input.connectionStale,
      hydrating: input.hydrating,
      bootstrapFailed: input.bootstrapFailed,
      loadingCandidates: input.loadingCandidates,
      candidateRefreshFailed: input.candidateRefreshFailed,
      activeRunConflict: input.activeRunConflict,
      variantInputBlocked: input.variantInputBlocked,
      dispatchBlockedReason: dispatchBlockedReasonValue,
    }),
    queueBlockedReason: queueBlockedReasonValue,
    queueBlocked: isQueueBlocked({
      queueBlockedReason: queueBlockedReasonValue,
      canDispatch: canDispatchValue,
      connectionStale: input.connectionStale,
    }),
  };
}
