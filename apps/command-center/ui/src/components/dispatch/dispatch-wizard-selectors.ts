import type {
  DispatchCandidatesResult,
  FlowType,
  PRStatus,
  Run,
  SlotStatus,
} from '@farmslot/protocol';

export type DispatchCandidate = DispatchCandidatesResult['candidates'][number];
export type NudgeIntent = 'nudge' | 'fresh';

export function resolveTargetBranch(input: {
  prs: ReadonlyArray<PRStatus>;
  flowType: FlowType | null;
  ticketId: string;
  normalizedTicket: string;
  project: string;
}): string | undefined {
  const ticketLooksLikePr = /(^|\/)\d+$|#\d+$|\/pull\//.test(
    (input.normalizedTicket || input.ticketId).trim(),
  );
  const flowExplicitlyPrBound = input.flowType === 'review-pr' || input.flowType === 'pr-complete';
  const flowExplicitlyNonPr = input.flowType === 'fix-bug' || input.flowType === 'dev';
  if (flowExplicitlyNonPr) return undefined;
  if (!flowExplicitlyPrBound && !ticketLooksLikePr) return undefined;

  const candidate = (input.normalizedTicket || input.ticketId).trim();
  if (!candidate) return undefined;
  const match = candidate.match(/^([^#]+)#(\d+)$/);
  if (match) {
    const repo = match[1] ?? '';
    const prStr = match[2] ?? '';
    const prNum = Number.parseInt(prStr, 10);
    const hit = input.prs.find((p) => p.pr === prNum && p.repo === repo);
    if (hit?.headRef) return hit.headRef;
  }

  const bareNum = candidate.match(/^#?(\d+)$/);
  if (bareNum) {
    const prNum = Number.parseInt(bareNum[1] ?? '', 10);
    const sameProject = input.prs.filter(
      (p) => p.pr === prNum && (!input.project || p.project === input.project),
    );
    if (sameProject.length === 1 && sameProject[0]?.headRef) return sameProject[0].headRef;
  }
  return undefined;
}

export function candidateDispatchable(candidate: DispatchCandidate): boolean {
  // A row FIND_SLOT would reject (branch ownership, missing companion resources)
  // must not be selectable, even when the slot itself is free/reuse-eligible.
  if (candidate.ineligibleReason) return false;
  return (
    candidate.free === true ||
    candidate.nudgeEligible === true ||
    candidate.replaceableWarm === true
  );
}

/** Backend pressure rejection for this row's machine, when present. */
export function candidatePressureRejection(candidate: DispatchCandidate) {
  const decision = candidate.pressureAdmission;
  return decision?.outcome === 'rejected' ? decision : null;
}

/**
 * True when the row's effective backend ineligibility is an overridable
 * sustained-pressure rejection, so the wizard may offer a deliberate override
 * on the disabled row. Keys off the structured `ineligibilitySource` the
 * gateway sets. The reason message stays display-only.
 */
export function pressureOverrideAvailable(candidate: DispatchCandidate): boolean {
  // Applies to fresh AND nudge rows: a rejected nudge row keeps its nudge
  // intent through the override flow instead of degrading to an invalid
  // busy-slot fresh dispatch.
  const rejection = candidatePressureRejection(candidate);
  return Boolean(rejection?.overridable && candidate.ineligibilitySource === 'pressure');
}

export function dispatchableCandidates(
  candidates: ReadonlyArray<DispatchCandidate>,
): DispatchCandidate[] {
  return candidates.filter((candidate) => candidateDispatchable(candidate));
}

export function selectedCandidate(
  candidates: ReadonlyArray<DispatchCandidate>,
  slotOverride: string,
): DispatchCandidate | null {
  if (!slotOverride) return null;
  return candidates.find((candidate) => candidate.slotId === slotOverride) ?? null;
}

export function selectedNudgeIntent(input: {
  candidates: ReadonlyArray<DispatchCandidate>;
  slotOverride: string;
  intents: ReadonlyMap<string, NudgeIntent>;
}): NudgeIntent | undefined {
  if (!input.slotOverride) return undefined;
  const candidate = input.candidates.find((item) => item.slotId === input.slotOverride);
  if (candidate?.replaceableWarm && !candidate.nudgeEligible) return 'fresh';
  if (!candidate?.nudgeEligible) return undefined;
  return (
    input.intents.get(input.slotOverride) ?? (candidate.nudgeMeta?.canNudge ? 'nudge' : 'fresh')
  );
}

export function resolveAllowedSlots(input: {
  machines: ReadonlyArray<string>;
  fleetSlots: ReadonlyArray<SlotStatus>;
  project: string;
}): string[] | undefined {
  if (input.machines.length === 0) return undefined;
  const machineSet = new Set(input.machines);
  return input.fleetSlots
    .filter((slot) => slot.project === input.project && machineSet.has(slot.machine))
    .map((slot) => slot.slot);
}

export function findSameTaskSlot(
  slots: ReadonlyArray<SlotStatus>,
  ticketId: string,
): SlotStatus | null {
  const needle = ticketId.trim().toUpperCase();
  if (!needle) return null;
  return slots.find((slot) => slot.taskId?.toUpperCase() === needle) ?? null;
}

export function slotSummaryLabel(input: {
  slotId: string;
  slots: ReadonlyArray<SlotStatus>;
  runs: ReadonlyArray<Run>;
}): string {
  const slot = input.slots.find((item) => item.slot === input.slotId);
  if (!slot) return '';
  const run = input.runs.find(
    (candidate) =>
      candidate.id === slot.currentRunId ||
      (candidate.slotId === slot.slot &&
        !['done', 'failed', 'cancelled'].includes(candidate.status)) ||
      (candidate.slotId === slot.slot &&
        candidate.taskFile &&
        slot.taskFile &&
        candidate.taskFile.includes(slot.taskFile)),
  );
  return run?.summary || slot.taskId || slot.taskFile || '';
}
