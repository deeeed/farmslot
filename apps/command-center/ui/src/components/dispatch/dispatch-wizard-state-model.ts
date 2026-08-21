import type { DispatchCandidatesResult, FlowType, Run, SlotStatus } from '@farmslot/protocol';

import { candidateDispatchable, pressureOverrideAvailable } from './dispatch-wizard-selectors.js';

export type DispatchMode = 'interactive' | 'autonomous';
export type NudgeIntent = 'nudge' | 'fresh';

export interface CandidateResultStateInput {
  candidates: DispatchCandidatesResult['candidates'];
  previousOverride: string;
  nudgeIntents: ReadonlyMap<string, NudgeIntent>;
  flowType: FlowType | null;
  normalizedTicket: string;
  ticketId: string;
  comparisonLane: boolean;
  comparisonFamilyId: string;
  lastFetchScoringKey: string | undefined;
}

export interface CandidateResultState {
  candidates: DispatchCandidatesResult['candidates'];
  slotOverride: string;
  nudgeIntents: Map<string, NudgeIntent>;
  nudgeIntentsChanged: boolean;
  scoringKey: string;
}

export interface DispatchFleetViewStateInput {
  slots: readonly SlotStatus[];
  currentProject: string;
  globalProjectFilters: readonly string[];
  globalMachineFilters: readonly string[];
}

export interface DispatchFleetViewState {
  slots: SlotStatus[];
  availableProjects: string[];
  project: string;
  projectAutoSelected: boolean;
  projectCleared: boolean;
  allProjectSlots: SlotStatus[];
  machineFilterSignature: string;
}

export function deriveCandidateResultState(input: CandidateResultStateInput): CandidateResultState {
  const nudgeIntents = new Map(input.nudgeIntents);
  let nudgeIntentsChanged = false;
  const eligibleByIdNow = new Set(
    input.candidates
      .filter((candidate) => candidate.nudgeEligible)
      .map((candidate) => candidate.slotId),
  );
  for (const slotId of [...nudgeIntents.keys()]) {
    if (!eligibleByIdNow.has(slotId)) {
      nudgeIntents.delete(slotId);
      nudgeIntentsChanged = true;
    }
  }

  const dispatchable = input.candidates.filter((candidate) => candidateDispatchable(candidate));
  const scoringKey = dispatchScoringKey({
    flowType: input.flowType,
    normalizedTicket: input.normalizedTicket,
    ticketId: input.ticketId,
    comparisonLane: input.comparisonLane,
    comparisonFamilyId: input.comparisonFamilyId,
  });
  const scoringChanged = scoringKey !== input.lastFetchScoringKey;
  // A pressure-rejected row is not dispatchable, but the operator may have
  // deliberately selected it to review the decision or collect an override.
  // periodic candidate refreshes must not bounce the selection off it.
  const overrideStillValid =
    !scoringChanged &&
    Boolean(input.previousOverride) &&
    input.candidates.some(
      (candidate) =>
        candidate.slotId === input.previousOverride &&
        (candidateDispatchable(candidate) || pressureOverrideAvailable(candidate)),
    );
  return {
    candidates: input.candidates,
    slotOverride: overrideStillValid ? input.previousOverride : (dispatchable[0]?.slotId ?? ''),
    nudgeIntents,
    nudgeIntentsChanged,
    scoringKey,
  };
}

export function deriveDispatchFleetViewState(
  input: DispatchFleetViewStateInput,
): DispatchFleetViewState {
  const slots = input.slots.filter(
    (slot) =>
      (input.globalMachineFilters.length === 0 ||
        input.globalMachineFilters.includes(slot.machine)) &&
      (input.globalProjectFilters.length === 0 ||
        input.globalProjectFilters.includes(slot.project)),
  );
  const availableProjects = [...new Set(slots.map((slot) => slot.project))].sort();

  let project = input.currentProject;
  let projectAutoSelected = false;
  let projectCleared = false;
  if (availableProjects.length === 1 && project !== availableProjects[0]) {
    project = availableProjects[0];
    projectAutoSelected = true;
  }
  if (project && availableProjects.length > 0 && !availableProjects.includes(project)) {
    project = '';
    projectCleared = true;
  }

  return {
    slots,
    availableProjects,
    project,
    projectAutoSelected,
    projectCleared,
    allProjectSlots: project ? slots.filter((slot) => slot.project === project) : slots,
    machineFilterSignature: [...input.globalMachineFilters].sort().join(','),
  };
}

interface DispatchScoringKeyInput {
  flowType: FlowType | null;
  normalizedTicket: string;
  ticketId: string;
  comparisonLane: boolean;
  comparisonFamilyId: string;
}

export function dispatchScoringKey(input: DispatchScoringKeyInput): string {
  return [
    input.flowType ?? '',
    (input.normalizedTicket || input.ticketId).trim(),
    input.comparisonLane && input.comparisonFamilyId ? `lane:${input.comparisonFamilyId}` : '',
  ].join('|');
}

export function findActiveRunConflict(
  runs: readonly Run[],
  input: { ticket: string; normalizedTicket: string; project: string },
): { id: string; status: string } | null {
  const ticket = input.ticket.trim();
  if (!ticket || !input.project) return null;
  const run = runs.find(
    (candidate) =>
      (candidate.ticketOrPr === ticket ||
        Boolean(input.normalizedTicket && candidate.ticketOrPr === input.normalizedTicket)) &&
      candidate.project === input.project &&
      !['done', 'cancelled', 'failed'].includes(candidate.status),
  );
  return run ? { id: run.id, status: run.status } : null;
}

export function deriveIssueTypeFlowState(
  issueType: string | undefined,
  currentFlowType: FlowType | null,
  autoFlowType: boolean,
): { flowType: FlowType; autoFlowType: boolean; mode: DispatchMode } | null {
  if (!issueType || (currentFlowType && !autoFlowType)) return null;
  const type = issueType.toLowerCase();
  if (type === 'bug') return { flowType: 'fix-bug', autoFlowType: true, mode: 'autonomous' };
  if (['task', 'story', 'feature', 'sub-task'].includes(type)) {
    return { flowType: 'dev', autoFlowType: true, mode: 'interactive' };
  }
  return null;
}
