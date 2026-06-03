import type { IntelligenceAction } from '@farmslot/protocol';

export const AUDIT_KEYS = [
  'id',
  'timestamp',
  'decidedAt',
  'runId',
  'familyId',
  'project',
  'stepName',
  'actor',
  'verdict.category',
  'verdict.patternId',
  'verdict.confidence',
  'guards[].name',
  'guards[].passed',
  'outcome',
  'outcomeReason',
  'latencyMs',
  'appliedAction.type',
  'appliedAction.stepName',
  'appliedAction.replayRunId',
  'appliedAction.tmuxKeys',
  'followupOutcome',
  'tier',
  'costUsd',
] as const;

export function redactToAllowlist(action: IntelligenceAction): IntelligenceAction {
  const verdict: IntelligenceAction['verdict'] = { confidence: action.verdict.confidence };
  if (action.verdict.category) verdict.category = action.verdict.category;
  if (action.verdict.patternId) verdict.patternId = action.verdict.patternId;
  const appliedAction = action.appliedAction
    ? {
        type: action.appliedAction.type,
        ...(action.appliedAction.stepName ? { stepName: action.appliedAction.stepName } : {}),
        ...(action.appliedAction.replayRunId
          ? { replayRunId: action.appliedAction.replayRunId }
          : {}),
        ...(action.appliedAction.tmuxKeys ? { tmuxKeys: action.appliedAction.tmuxKeys } : {}),
      }
    : undefined;
  const out: IntelligenceAction = {
    id: action.id,
    timestamp: action.timestamp,
    decidedAt: action.decidedAt,
    ...(action.familyId ? { familyId: action.familyId } : {}),
    ...(action.project ? { project: action.project } : {}),
    ...(action.stepName ? { stepName: action.stepName } : {}),
    runId: action.runId,
    actor: action.actor,
    verdict,
    guards: action.guards.map((g) => ({ name: g.name, passed: g.passed })),
    outcome: action.outcome,
    ...(action.outcomeReason ? { outcomeReason: action.outcomeReason } : {}),
    ...(typeof action.latencyMs === 'number' ? { latencyMs: action.latencyMs } : {}),
    ...(appliedAction ? { appliedAction } : {}),
    ...(action.followupOutcome ? { followupOutcome: action.followupOutcome } : {}),
    tier: action.tier,
    costUsd: action.costUsd,
  };
  return out;
}
