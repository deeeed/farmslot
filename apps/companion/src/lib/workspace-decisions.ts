import type { RunDecision } from '@farmslot/protocol';

export interface WorkspaceDecisionSource {
  decisions?: RunDecision[] | null;
}

const READY_WORKSPACE_KINDS = new Set(['ready']);
const REVIEW_WORKSPACE_KINDS = new Set(['ready', 'review', 'no-change']);
const REVIEW_GATE_WORKSPACE_KINDS = new Set(['review', 'no-change']);

export function selectReadyWorkspaceDecision(
  source: WorkspaceDecisionSource | null | undefined,
): RunDecision | null {
  return latestDecisionMatching(source?.decisions, (decision) =>
    READY_WORKSPACE_KINDS.has(workspaceDecisionKind(decision)),
  );
}

export function selectReviewGateWorkspaceDecision(
  source: WorkspaceDecisionSource | null | undefined,
): RunDecision | null {
  return latestDecisionMatching(source?.decisions, (decision) =>
    REVIEW_GATE_WORKSPACE_KINDS.has(workspaceDecisionKind(decision)),
  );
}

export function selectReviewWorkspaceDecision(
  source: WorkspaceDecisionSource | null | undefined,
): RunDecision | null {
  return latestDecisionMatching(source?.decisions, (decision) =>
    REVIEW_WORKSPACE_KINDS.has(workspaceDecisionKind(decision)),
  );
}

export function selectRetrospectiveWorkspaceDecision(
  source: WorkspaceDecisionSource | null | undefined,
): RunDecision | null {
  return latestDecisionMatching(
    source?.decisions,
    (decision) => workspaceDecisionKind(decision) === 'retrospective',
  );
}

export function selectPrimaryWorkspaceDecision(
  source: WorkspaceDecisionSource | null | undefined,
): RunDecision | null {
  return (
    selectReviewWorkspaceDecision(source) ??
    selectRetrospectiveWorkspaceDecision(source) ??
    latestDecisionMatching(source?.decisions, () => true)
  );
}

export function workspaceDecisionKind(decision: RunDecision | null | undefined): string {
  return decision?.payload?.kind ?? decision?.type ?? '';
}

function latestDecisionMatching(
  decisions: RunDecision[] | null | undefined,
  predicate: (decision: RunDecision) => boolean,
): RunDecision | null {
  const matches = (decisions ?? []).filter(predicate).sort(compareDecisionsNewestFirst);
  return matches.find((decision) => !decision.resolvedAt) ?? matches[0] ?? null;
}

function compareDecisionsNewestFirst(left: RunDecision, right: RunDecision): number {
  return decisionTimestamp(right) - decisionTimestamp(left);
}

function decisionTimestamp(decision: RunDecision): number {
  const timestamp = Date.parse(decision.resolvedAt ?? decision.createdAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
