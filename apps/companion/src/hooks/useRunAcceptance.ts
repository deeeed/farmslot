/** Shared current-owner observations provide acceptance data and command readiness. */
import { useMemo, useRef } from 'react';

import {
  createEvidenceReviewModel,
  type EvidenceReviewModel,
  runEvidencePending,
} from '@farmslot/adapter-sdk/evidence';
import {
  type AcceptanceCriterionRef,
  type AcceptanceEvidenceLink,
  type AcceptanceStatusLedger,
  Methods,
  type OutputReviewPayload,
  type Run,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type SelfPrincipalSummary,
  type TaskProgressResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { recordedEvidenceKey } from '../lib/acceptance-evidence';
import type { GatewayClient } from '../lib/gateway-client';
import { getResourceCache } from '../lib/resource-cache';
import { assertNativeRunReady } from '../lib/run-collections';
import { taskProgressRequestForRun } from '../lib/task-progress';
import { type AcceptanceLedgerView, acceptanceLedgerView } from '../lib/task-progress-view';
import { recordVisualClaimReview } from '../lib/visual-claim-review';

import { useResourceQuery } from './useResourceQuery';

export interface RunAcceptance {
  commandsReady: boolean;
  /** No acceptance data or read error is available yet. */
  loading: boolean;
  evidenceLoading: boolean;
  evidenceError: string | null;
  /** Re-read acceptance and selected evidence even when the run has not changed. */
  retry(): void;
  evidenceModel: EvidenceReviewModel | null;
  reviewer: SelfPrincipalSummary | null;
  recordVisualReview(
    claimId: string,
    verdict: 'confirmed' | 'rejected',
    reason?: string,
  ): Promise<void>;
  recipeRunId: string | null;
  /**
   * Which recorded evidence the model shows: its execution and checked files. Verdicts
   * leave it unchanged; a newer recording replaces it. Null without recorded evidence.
   */
  evidenceKey: string | null;
  acceptanceStatus: AcceptanceStatusLedger | null;
  acceptanceCriteria: AcceptanceCriterionRef[] | null;
  acceptanceEvidenceLinks: AcceptanceEvidenceLink[] | null;
  /** Null until the first read lands, so "loading" is never mistaken for "no criteria". */
  view: AcceptanceLedgerView | null;
  error: string | null;
}

export type RunAcceptanceSource = Pick<Run, 'id' | 'slotId' | 'reviewWorkspace' | 'updatedAt'> &
  Partial<
    Pick<
      Run,
      | 'output'
      | 'decisions'
      | 'recordedEvidenceContractVersion'
      | 'links'
      | 'status'
      | 'artifactBundle'
    >
  >;

type AcceptanceData = Pick<
  TaskProgressResult,
  | 'acceptanceStatus'
  | 'acceptanceCriteria'
  | 'acceptanceEvidenceLinks'
  | 'acceptanceStatusError'
  | 'acceptanceEvidenceLinksError'
>;

const NO_PROGRESS_SURFACE = 'the run has no slot or review workspace to read them from';

export function useRunAcceptance(
  client: GatewayClient | null,
  run: RunAcceptanceSource | null,
  options: { recipeRunId?: string; reportSnapshot?: OutputReviewPayload; decisionId?: string } = {},
): RunAcceptance {
  const runId = run?.id;
  const fullRunQuery = useMemo(
    () => (runId ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId }) : undefined),
    [runId],
  );
  const fullRunObservation = useResourceQuery(fullRunQuery);
  const slotId = run?.slotId;
  const workspaceId = run?.reviewWorkspace?.workspaceId;
  const gate = options.decisionId
    ? run?.decisions?.find(({ id }) => id === options.decisionId)
    : undefined;
  const evidenceSnapshotHash =
    gate?.payload?.kind === 'ready'
      ? gate.payload.prPackage?.packageHash
      : gate?.payload?.kind === 'output-review'
        ? gate.payload.manifestDigest
        : undefined;
  const evidenceQuery = useMemo(
    () =>
      runId
        ? resourceQuery<RunRecipeRunsForRunResult>(Methods.RUN_RECIPE_RUNS_FOR_RUN, {
            runId,
            includeRecordedEvidence: true,
            ...(options.decisionId
              ? { decisionId: options.decisionId, evidenceSnapshotHash }
              : options.recipeRunId
                ? { recipeRunId: options.recipeRunId }
                : {}),
          })
        : undefined,
    [runId, options.decisionId, options.recipeRunId, evidenceSnapshotHash],
  );
  const evidenceObservation = useResourceQuery(evidenceQuery);
  const evidence = evidenceObservation.data ?? null;
  const evidenceRequestError = evidenceObservation.error?.message ?? null;
  const target = taskProgressRequestForRun(run);
  const noSurface = Boolean(run) && !target;
  const progressQuery = useMemo(
    () => (target ? resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, target) : undefined),
    [runId, slotId, workspaceId],
  );
  const progressObservation = useResourceQuery(progressQuery);
  const data: AcceptanceData | null = progressObservation.data ?? null;
  const requestError = progressObservation.error?.message ?? null;

  const evidencePending = run?.status
    ? runEvidencePending({
        status: run.status,
        artifactBundle: run.artifactBundle,
        output: run.output,
      })
    : false;
  const evidenceCache = getResourceCache();
  const reviewIdentity = JSON.stringify([runId, evidenceQuery?.id]);
  const currentReviewIdentity = useRef(reviewIdentity);
  currentReviewIdentity.current = reviewIdentity;
  return useMemo(() => {
    const acceptanceStatus = data?.acceptanceStatus ?? null;
    const acceptanceCriteria = data?.acceptanceCriteria ?? null;
    const acceptanceEvidenceLinks = data?.acceptanceEvidenceLinks ?? null;
    const error =
      (noSurface ? NO_PROGRESS_SURFACE : null) ??
      requestError ??
      data?.acceptanceStatusError ??
      (!acceptanceStatus ? (data?.acceptanceEvidenceLinksError ?? null) : null);
    const ledger = acceptanceStatus ?? { schemaVersion: 1 as const, criteria: [] };
    const evidenceModel = data
      ? createEvidenceReviewModel({
          context: 'gate',
          gateDecision: gate,
          artifacts:
            gate?.payload?.kind === 'ready'
              ? gate.payload.artifactManifest
              : run?.output?.artifactManifest,
          comparisonSnapshot:
            gate?.payload?.kind === 'ready'
              ? gate.payload.prPackage?.reviewSnapshot
              : evidence?.recordedEvidence?.comparisonSnapshot,
          criterionSourceUrl: run?.links?.find((link) => link.label === 'Jira')?.url,
          ledger: acceptanceStatus,
          criteria: acceptanceCriteria ?? undefined,
          evidenceLinks: acceptanceEvidenceLinks ?? undefined,
          package: evidence?.recordedEvidence?.input,
          contractVersion: evidence?.recordedEvidence?.contractVersion,
          claimOverrideAuthority: evidence?.recordedEvidence?.claimOverrideAuthority,
          visualReviewAuthority: evidence?.recordedEvidence?.visualReviewAuthority,
          visualReviewContext: evidence?.recordedEvidence?.visualReviewContext,
          readErrors:
            evidence?.recordedEvidence?.errors ??
            (evidenceRequestError ? [evidenceRequestError] : undefined),
          evidencePending,
          artifactPrefix: evidence?.recordedEvidence?.artifactPrefix,
          packagePath: evidence?.recordedEvidence?.packagePath,
          report: evidence?.recordedEvidence?.report,
          reportSnapshot: options.reportSnapshot,
        })
      : null;
    return {
      commandsReady:
        client?.connectionState === 'connected' &&
        fullRunObservation.status === 'ready' &&
        evidenceObservation.status === 'ready' &&
        progressObservation.status === 'ready',
      loading: !data && !error,
      evidenceLoading: !evidence && !error && !evidenceRequestError,
      evidenceError: error ?? evidenceRequestError,
      retry() {
        if (progressQuery) void getResourceCache()?.retry(progressQuery);
        if (evidenceQuery) void getResourceCache()?.retry(evidenceQuery);
      },
      evidenceModel,
      reviewer: client?.authenticatedPrincipal ?? null,
      async recordVisualReview(claimId, verdict, reason) {
        if (!runId) throw new Error('The current run is unavailable.');
        if (
          getResourceCache() !== evidenceCache ||
          currentReviewIdentity.current !== reviewIdentity
        )
          throw new Error('The review context changed. Open the current evidence before acting.');
        // Verdicts bind to evidence: they still act on a current read.
        if (!progressQuery || getResourceCache()?.read(progressQuery).status !== 'ready')
          throw new Error('Wait for current acceptance data before acting.');
        const currentEvidence = evidenceQuery ? getResourceCache()?.read(evidenceQuery) : undefined;
        if (currentEvidence?.status !== 'ready' || currentEvidence.data !== evidence)
          throw new Error('Wait for current evidence before acting.');
        assertNativeRunReady(runId, fullRunObservation.data?.run);
        await recordVisualClaimReview(client, runId, evidenceModel, claimId, verdict, reason);
      },
      recipeRunId: evidence?.selectedRecipeRunId ?? null,
      evidenceKey: recordedEvidenceKey(evidence?.recordedEvidence),
      acceptanceStatus,
      acceptanceCriteria,
      acceptanceEvidenceLinks,
      view: data
        ? acceptanceLedgerView(
            ledger,
            acceptanceCriteria ?? ledger.criteria,
            acceptanceEvidenceLinks ?? [],
            evidenceModel ?? undefined,
          )
        : null,
      error,
    };
  }, [
    client,
    evidenceCache,
    reviewIdentity,
    runId,
    data,
    evidence,
    noSurface,
    requestError,
    evidenceRequestError,
    evidenceQuery,
    evidenceObservation.status,
    fullRunObservation,
    progressQuery,
    progressObservation.status,
    run?.output,
    run?.links,
    evidencePending,
    gate,
    options.reportSnapshot,
  ]);
}
