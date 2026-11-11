import type { RunDecision } from '@farmslot/protocol';
import { isResultDecision, pendingResultDecision } from '@farmslot/review-dispatch';

import { DECISION_EVIDENCE_RECIPE_RUN_PARAM } from './artifact-url';

/**
 * Minimal decision shape both RunDecision and RunListDecision satisfy.
 * Used for navigation-only selectors that only need id, type, resolvedAt and
 * payload?.kind — none of the large detail fields.
 */
type WorkspaceDecisionEntry = {
  id: string;
  type: string;
  createdAt: string;
  resolvedAt?: string | null;
  resolvedAction?: string | null;
  description?: string;
  payload?: { kind: string } | null;
};

/**
 * Source for workspace decision navigation: a full Run (RunDecision) or a run.list row
 * (RunListDecision). Selectors return the decision type the source holds.
 */
export interface WorkspaceDecisionSource<
  D extends WorkspaceDecisionEntry = WorkspaceDecisionEntry,
> {
  decisions?: ReadonlyArray<D> | null;
}

/**
 * Source for functions that need the full RunDecision payload (artifact viewer,
 * gate review, primary decision).  Run.decisions: RunDecision[] satisfies this.
 */
export interface WorkspaceDecisionDetailSource {
  decisions?: RunDecision[] | null;
}

const READY_WORKSPACE_KINDS = new Set(['ready']);
const REVIEW_WORKSPACE_KINDS = new Set(['ready', 'review', 'no-change']);
const REVIEW_GATE_WORKSPACE_KINDS = new Set(['review', 'no-change']);

export function selectArtifactWorkspaceDecision(
  source: WorkspaceDecisionDetailSource | null | undefined,
  recipeRun: string,
  explicitDecisionId: string,
): RunDecision | undefined {
  if (recipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM) return undefined;
  return explicitDecisionId
    ? source?.decisions?.find((decision) => decision.id === explicitDecisionId)
    : (selectReadyWorkspaceDecision(source) ?? undefined);
}

export function selectReadyWorkspaceDecision<D extends WorkspaceDecisionEntry>(
  source: WorkspaceDecisionSource<D> | null | undefined,
): D | null {
  return latestDecisionMatching(source?.decisions, (decision) =>
    READY_WORKSPACE_KINDS.has(workspaceDecisionKind(decision)),
  );
}

export function selectReviewGateWorkspaceDecision<D extends WorkspaceDecisionEntry>(
  source: WorkspaceDecisionSource<D> | null | undefined,
): D | null {
  return latestDecisionMatching(source?.decisions, (decision) =>
    REVIEW_GATE_WORKSPACE_KINDS.has(workspaceDecisionKind(decision)),
  );
}

export function selectReviewWorkspaceDecision<D extends WorkspaceDecisionEntry>(
  source: WorkspaceDecisionSource<D> | null | undefined,
): D | null {
  return latestDecisionMatching(source?.decisions, (decision) =>
    REVIEW_WORKSPACE_KINDS.has(workspaceDecisionKind(decision)),
  );
}

export function selectRetrospectiveWorkspaceDecision<D extends WorkspaceDecisionEntry>(
  source: WorkspaceDecisionSource<D> | null | undefined,
): D | null {
  return latestDecisionMatching(
    source?.decisions,
    (decision) => workspaceDecisionKind(decision) === 'retrospective',
  );
}

export function selectPrimaryWorkspaceDecision(
  source: WorkspaceDecisionDetailSource | null | undefined,
): RunDecision | null {
  return (
    pendingResultDecision({ decisions: source?.decisions ?? [] }) ??
    selectReviewWorkspaceDecision(source) ??
    selectRetrospectiveWorkspaceDecision(source) ??
    latestDecisionMatching(source?.decisions, () => true)
  );
}

/**
 * The run's current result decision when it is not the one on screen. The gateway
 * re-presents a result decision under a new id when the output changes, the capture
 * fails, a review round is granted or the gateway restarts, and resolves the old one
 * 'superseded', so the screen follows the run instead of keeping the id it opened.
 */
export function supersedingResultDecisionId(
  decision: Pick<RunDecision, 'id' | 'payload'> | null | undefined,
  source: WorkspaceDecisionDetailSource | null | undefined,
): string | undefined {
  if (!decision || !isResultDecision(decision)) return undefined;
  const current = pendingResultDecision({ decisions: source?.decisions ?? [] });
  return current && current.id !== decision.id ? current.id : undefined;
}

export function workspaceDecisionKind(decision: WorkspaceDecisionEntry | null | undefined): string {
  return decision?.payload?.kind ?? decision?.type ?? '';
}

function latestDecisionMatching<D extends WorkspaceDecisionEntry>(
  decisions: ReadonlyArray<D> | null | undefined,
  predicate: (decision: D) => boolean,
): D | null {
  const matches = (decisions ?? []).filter(predicate).sort(compareDecisionsNewestFirst);
  return matches.find((decision) => !decision.resolvedAt) ?? matches[0] ?? null;
}

function compareDecisionsNewestFirst(
  left: WorkspaceDecisionEntry,
  right: WorkspaceDecisionEntry,
): number {
  return decisionTimestamp(right) - decisionTimestamp(left);
}

function decisionTimestamp(decision: WorkspaceDecisionEntry): number {
  const timestamp = Date.parse(decision.resolvedAt ?? decision.createdAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
