import type {
  FamilyObservabilityRunSummary,
  RetrospectivePayload,
  RunDecision,
} from '@farmslot/protocol';

export function pendingRetrospectiveDecision(
  run: Pick<FamilyObservabilityRunSummary, 'decisions'>,
): RunDecision | null {
  return (
    run.decisions?.find((decision) => decision.type === 'retrospective' && !decision.resolvedAt) ??
    null
  );
}

export function retrospectivePayload(
  decision: Pick<RunDecision, 'payload'> | null | undefined,
): RetrospectivePayload | undefined {
  const rawPayload = decision?.payload;
  return rawPayload && (rawPayload as RetrospectivePayload).kind === 'retrospective'
    ? (rawPayload as RetrospectivePayload)
    : undefined;
}

export function retrospectiveCiWatchLabel(payload: RetrospectivePayload): string | null {
  const ciWatch = payload.ciWatch;
  if (!ciWatch) return null;
  const result = ciWatch.result ?? 'unknown';
  return ciWatch.total != null ? `${result} · ${ciWatch.passed ?? 0}/${ciWatch.total}` : result;
}

export function retrospectiveCommentsSummary(payload: RetrospectivePayload): string | null {
  const summary = payload.commentsTriageSummary;
  if (!summary) return null;
  const pathSuffix = summary.actionablePaths?.length
    ? ` · paths: ${summary.actionablePaths.join(', ')}`
    : '';
  return `${summary.total} total · ${summary.real} REAL · ${summary.fixed} fixed${pathSuffix}`;
}
