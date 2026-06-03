export type RunRefreshEvent = {
  run?: { id?: string | null; slotId?: string | null } | null;
  runId?: string | null;
  slotId?: string | null;
};

export type SlotWorkspaceRefreshScope = {
  slotId: string;
  workspaceRunId?: string | null;
  knownRunIds?: readonly string[];
};

export function runRefreshEventMatches(runId: string, event: RunRefreshEvent): boolean {
  const eventRunId = runRefreshEventRunId(event);
  return eventRunId === runId;
}

export function runRefreshEventMatchesSlotWorkspace(
  scope: SlotWorkspaceRefreshScope,
  event: RunRefreshEvent,
): boolean {
  if (event.slotId === scope.slotId) return true;
  if (event.run?.slotId === scope.slotId) return true;
  const eventRunId = runRefreshEventRunId(event);
  if (!eventRunId) return false;
  return eventRunId === scope.workspaceRunId || Boolean(scope.knownRunIds?.includes(eventRunId));
}

export function runRefreshEventRunId(event: RunRefreshEvent): string | null {
  return event.run?.id ?? event.runId ?? null;
}
