/**
 * Acceptance evidence (ADR-060) in the artifact viewer: one criterion's evidence
 * as an ordered, swipeable set opened on the entry the operator tapped, and the
 * route that reaches it. Evidence paths are task-dir relative, which is what the
 * gateway's run-artifact route serves without a recipe run.
 */
import {
  createEvidenceReviewModel,
  type EvidenceReviewMediaType,
  type EvidenceReviewModel,
} from '@farmslot/adapter-sdk/evidence';
import {
  Methods,
  recordedEvidenceClosureIdentity,
  type RunRecipeRunsForRunResult,
  type RunRecordedEvidenceReview,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import type { EvidenceAcceptanceReview } from '../components/EvidenceAcOverlay';

import { DECISION_EVIDENCE_RECIPE_RUN_PARAM } from './artifact-url';
import type { AcceptanceLedgerRow, AcceptanceLedgerView } from './task-progress-view';

/** The viewer renders text for anything that is not an image or a video. */
export type AcceptanceEvidenceMediaType = EvidenceReviewMediaType;

export interface AcceptanceEvidenceViewerItem {
  path: string;
  uri: string;
  title: string;
  /** Criterion, verdict, proof mode and recipe nodes, shown on the viewer header. */
  detail: string;
  mediaType: AcceptanceEvidenceMediaType;
}

export interface AcceptanceEvidenceViewer {
  items: AcceptanceEvidenceViewerItem[];
  initialIndex: number;
}

export interface AcceptanceEvidenceStripItem {
  criterionId: string;
  path: string;
  name: string;
  mediaType: AcceptanceEvidenceMediaType;
}

function rowModel(row: AcceptanceLedgerRow): EvidenceReviewModel {
  const status = row.criterion.status;
  return createEvidenceReviewModel({
    criteria: [row.criterion],
    ledger: status
      ? {
          schemaVersion: 1,
          criteria: [{ ...status, evidence: row.evidence.map((entry) => entry.path) }],
        }
      : null,
    evidenceLinks: [{ id: row.criterion.id, evidence: row.evidence.map((entry) => entry.path) }],
  });
}

/**
 * The criterion's evidence in ledger order, opened on `openPath`. Null when
 * `openPath` is not evidence of this criterion: the viewer must not open an
 * unrelated file under this criterion's verdict.
 */
export function acceptanceEvidenceViewer(
  row: AcceptanceLedgerRow,
  openPath: string,
  urlFor: (path: string) => string,
  model = rowModel(row),
): AcceptanceEvidenceViewer | null {
  const selection = model.selectClaim(row.criterion.id, openPath);
  if (!selection) return null;
  const items = selection.artifacts.map(({ artifactPath: path, name, mediaType }) => ({
    path,
    uri: urlFor(path),
    title: name,
    detail: selection.caption,
    mediaType,
  }));
  const initialIndex = items.findIndex((item) => item.path === openPath);
  return initialIndex < 0 ? null : { items, initialIndex };
}

/** Every criterion's evidence once, attributed to the first criterion that cites it. */
export function acceptanceEvidenceStrip(
  view: Pick<AcceptanceLedgerView, 'rows'>,
  model?: EvidenceReviewModel | null,
): AcceptanceEvidenceStripItem[] {
  const strip = view.rows.flatMap((row) =>
    (
      model?.claims.find((claim) => claim.id === row.criterion.id) ?? rowModel(row).claims[0]!
    ).evidence.map(({ artifactPath: path, name, mediaType }) => ({
      criterionId: row.criterion.id,
      path,
      name,
      mediaType,
    })),
  );
  return uniqueByPath(strip);
}

function uniqueByPath<T extends { path: string }>(entries: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

/**
 * The run files viewer as its own stack screen, so closing it always returns to
 * the screen that opened it rather than switching tabs inside the run workspace.
 */
export function acceptanceEvidenceHref(
  runId: string,
  criterionId: string,
  path: string,
  recipeRunId?: string | null,
  decisionId?: string,
  /** The execution read within that decision's snapshot, when one was chosen. */
  decisionExecutionId?: string,
) {
  return {
    pathname: '/evidence/[runId]' as const,
    params: {
      runId,
      ac: criterionId,
      evidence: path,
      recipeRun: recipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
      ...(decisionId ? { evidenceDecision: decisionId } : {}),
      ...(decisionId && decisionExecutionId ? { evidenceExecution: decisionExecutionId } : {}),
    },
  };
}

/** The execution a route names; none when it reads the default or the decision's. */
export function explicitRecipeRunId(recipeRun: string | null | undefined): string | undefined {
  return recipeRun && recipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM ? recipeRun : undefined;
}

/** The execution the evidence viewer reads: the route's own, or the one within its decision. */
export function acceptanceViewerRecipeRunId(
  recipeRun: string | undefined,
  evidenceExecution: string,
): string | undefined {
  return explicitRecipeRunId(recipeRun) ?? (evidenceExecution || undefined);
}

/**
 * The recorded-evidence read. Within a decision it reads that decision's snapshot; a named
 * execution narrows either read.
 */
export function recordedEvidenceQuery(
  runId: string,
  decision: { id: string; evidenceSnapshotHash: string | undefined } | undefined,
  recipeRunId: string | undefined,
) {
  return resourceQuery<RunRecipeRunsForRunResult>(Methods.RUN_RECIPE_RUNS_FOR_RUN, {
    runId,
    includeRecordedEvidence: true,
    ...(decision
      ? { decisionId: decision.id, evidenceSnapshotHash: decision.evidenceSnapshotHash }
      : {}),
    ...(recipeRunId ? { recipeRunId } : {}),
  });
}

/**
 * The criteria a recording's overlay may act on. The viewer keeps the evidence it opened on;
 * when the run has recorded newer evidence since, verdicts would judge files the screen does
 * not show, so they wait for a reopen.
 */
export function recordingAcceptanceReview(
  review: EvidenceAcceptanceReview | undefined,
  openedEvidenceKey: string | null | undefined,
): EvidenceAcceptanceReview | undefined {
  if (!review || openedEvidenceKey === undefined || review.evidenceKey === openedEvidenceKey)
    return review;
  return { ...review, record: undefined, stale: true };
}

/**
 * The identity of a verified recorded-evidence read: its execution and checked files.
 * Null for a read with errors (a pruned or unverifiable package still lists files it has
 * no digest for) or without a recorded execution: the reads the evidence model will not
 * bind verdicts to either.
 */
export function recordedEvidenceKey(
  review: Pick<RunRecordedEvidenceReview, 'input' | 'errors' | 'failureCode'> | undefined,
): string | null {
  if (!review?.input?.claims?.recipeRunId || review.errors.length > 0 || review.failureCode)
    return null;
  return recordedEvidenceClosureIdentity(review.input);
}
