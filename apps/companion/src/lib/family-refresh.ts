export type FamilyRefreshRunEvent = {
  run?: {
    id?: string | null;
    familyId?: string | null;
    project?: string | null;
  } | null;
  runId?: string | null;
};

export type FamilyRefreshScope = {
  familyId: string;
  project?: string | null;
  runIds: readonly string[];
};

export function shouldRefreshFamilySnapshotForRunEvent(
  scope: FamilyRefreshScope,
  event: FamilyRefreshRunEvent,
): boolean {
  const eventRun = event.run ?? null;
  if (
    eventRun?.familyId === scope.familyId &&
    projectMatchesScope(scope.project, eventRun.project)
  ) {
    return true;
  }

  const eventRunId = eventRun?.id ?? event.runId ?? null;
  return Boolean(eventRunId && scope.runIds.includes(eventRunId));
}

function projectMatchesScope(
  scopeProject: string | null | undefined,
  eventProject: string | null | undefined,
): boolean {
  return !scopeProject || !eventProject || scopeProject === eventProject;
}
