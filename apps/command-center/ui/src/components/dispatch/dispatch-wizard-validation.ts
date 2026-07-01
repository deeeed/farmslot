import type { FlowType } from '@farmslot/protocol';

import type { DispatchCandidate } from './dispatch-wizard-selectors.js';
import { candidateDispatchable } from './dispatch-wizard-selectors.js';

export function canDispatch(input: {
  flowType: FlowType | null;
  ticketId: string;
  project: string;
  comparisonFlow: boolean;
  comparisonParentRunId: string;
}): boolean {
  if (input.comparisonFlow && !input.comparisonParentRunId.trim()) return false;
  return !!input.flowType && input.ticketId.trim().length > 0 && !!input.project;
}

export function validationHint(input: {
  flowType: FlowType | null;
  ticketId: string;
  project: string;
  matchingProject: boolean;
  comparisonFlow: boolean;
  comparisonParentRunId: string;
}): string {
  if (input.comparisonFlow && !input.comparisonParentRunId.trim()) {
    return 'Pick a baseline run for this comparison sibling';
  }
  if (!input.flowType) return 'Select a flow type';
  if (!input.ticketId.trim()) return 'Enter a ticket or PR number';
  if (!input.project) return input.matchingProject ? 'Matching project...' : 'Select a project';
  return '';
}

export function dispatchBlockedReason(input: {
  machineFilterActive: boolean;
  slotOverride: string;
  selectedCandidate: DispatchCandidate | null;
  dispatchableCandidateCount: number;
}): string | null {
  if (input.selectedCandidate && !candidateDispatchable(input.selectedCandidate)) {
    return `Selected slot ${input.selectedCandidate.slotId} is not free — choose a free slot or use Queue.`;
  }
  if (input.machineFilterActive && !input.slotOverride && input.dispatchableCandidateCount === 0) {
    return 'No free slots on the filtered machines — drop the filter or use Queue.';
  }
  return null;
}

export function isDispatchBlocked(input: {
  canDispatch: boolean;
  dispatching: boolean;
  connectionStale: boolean;
  hydrating: boolean;
  bootstrapFailed: boolean;
  loadingCandidates: boolean;
  candidateRefreshFailed: boolean;
  activeRunConflict: boolean;
  variantInputBlocked: boolean;
  dispatchBlockedReason: string | null;
}): boolean {
  return (
    !input.canDispatch ||
    input.dispatching ||
    input.connectionStale ||
    input.hydrating ||
    input.bootstrapFailed ||
    input.loadingCandidates ||
    input.candidateRefreshFailed ||
    !!input.dispatchBlockedReason ||
    input.activeRunConflict ||
    input.variantInputBlocked
  );
}

export function queueBlockedReason(input: {
  canDispatch: boolean;
  validationHint: string;
  connectionStale: boolean;
  machineFilterActive: boolean;
  allowedSlots: readonly string[] | undefined;
}): string | null {
  if (!input.canDispatch) return input.validationHint;
  if (input.connectionStale) return 'Gateway connection is stale.';
  if (!input.machineFilterActive) return null;
  if (input.allowedSlots && input.allowedSlots.length === 0) {
    return 'No slots match the active machine filter for this project.';
  }
  return null;
}

export function isQueueBlocked(input: {
  queueBlockedReason: string | null;
  canDispatch: boolean;
  connectionStale: boolean;
}): boolean {
  if (input.queueBlockedReason) return true;
  return !input.canDispatch || input.connectionStale;
}
