import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Run } from '@farmslot/protocol';
import { acceptanceClaimRows } from '@farmslot/review-dispatch';

import type { EvidenceAcceptanceReview } from '../../components/EvidenceAcOverlay';
import type { MediaViewerItem } from '../../components/MediaViewer';
import { useRunAcceptance } from '../../hooks/useRunAcceptance';
import { acceptanceEvidenceViewer } from '../../lib/acceptance-evidence';
import { type ArtifactHttpHeaders, artifactUrl } from '../../lib/artifact-url';
import { recordedEvidenceArtifactUrl } from '../../lib/evidence-media-items';
import type { GatewayClient } from '../../lib/gateway-client';

export interface AcceptanceEvidenceViewerInput {
  client: GatewayClient | null;
  run: Run | null;
  /** Route `ac`; empty when the screen was not opened on a criterion. */
  criterionId: string;
  /** Route `evidence`: the task-relative file to open on. */
  evidencePath: string;
  recipeRunId?: string;
  decisionId?: string;
  gatewayUrl: string;
  authHeaders: ArtifactHttpHeaders;
}

/**
 * The run files screen opened on one acceptance criterion's evidence (`ac` +
 * `evidence` route params): the viewer swipes through that criterion's files only
 * and its header carries the criterion's verdict. Closing returns to the screen
 * that opened it.
 */
export function useAcceptanceEvidenceViewer(input: AcceptanceEvidenceViewerInput) {
  const { client, run, criterionId, evidencePath, gatewayUrl, authHeaders } = input;
  const router = useRouter();
  const active = Boolean(criterionId && evidencePath);
  const acceptance = useRunAcceptance(client, active ? run : null, {
    recipeRunId: input.recipeRunId,
    decisionId: input.decisionId,
  });
  const [open, setOpen] = useState(active);

  useEffect(() => {
    setOpen(active);
  }, [active, criterionId, evidencePath]);

  const row = acceptance.view?.rows.find((candidate) => candidate.criterion.id === criterionId);
  const runId = run?.id ?? '';
  const resolveArtifactUrl = useCallback(
    (path: string) =>
      acceptance.evidenceModel?.report
        ? recordedEvidenceArtifactUrl(gatewayUrl, runId, acceptance.evidenceModel, path)
        : artifactUrl(gatewayUrl, runId, path, acceptance.recipeRunId ?? undefined),
    [acceptance.evidenceModel, acceptance.recipeRunId, gatewayUrl, runId],
  );
  const viewer = useMemo(
    () =>
      row && runId
        ? acceptanceEvidenceViewer(
            row,
            evidencePath,
            resolveArtifactUrl,
            acceptance.evidenceModel ?? undefined,
          )
        : null,
    [acceptance.evidenceModel, evidencePath, resolveArtifactUrl, row, runId],
  );
  // The run's criteria over the recording, the rows its acceptance list shows.
  const review = useMemo<EvidenceAcceptanceReview | undefined>(() => {
    const { view, evidenceModel } = acceptance;
    if (!view || !evidenceModel) return undefined;
    return {
      rows: acceptanceClaimRows({
        criteria: acceptance.acceptanceCriteria ?? undefined,
        ledger: acceptance.acceptanceStatus ?? undefined,
        claims: view.rows.map(({ review: reviewed, criterion }) => reviewed ?? criterion),
        judgmentRows: evidenceModel.judgmentRows(acceptance.reviewer),
        pendingVisualClaimIds: evidenceModel.pendingVisualClaimIds,
      }),
      record: acceptance.commandsReady ? acceptance.recordVisualReview : undefined,
      evidenceKey: acceptance.evidenceKey,
    };
  }, [acceptance]);
  const items = useMemo<MediaViewerItem[]>(
    () =>
      (viewer?.items ?? []).map((item) => ({
        uri: item.uri,
        title: item.title,
        detail: item.detail,
        mediaType: item.mediaType,
        authHeaders,
        path: item.path,
        evidenceModel: acceptance.evidenceModel ?? undefined,
        evidenceKey: acceptance.evidenceKey,
        resolveArtifactUrl,
        sharedArtifact: {
          runId,
          path: item.path,
          slotId: run?.slotId ?? undefined,
          recipeRunId: acceptance.recipeRunId ?? undefined,
          criterionId,
        },
      })),
    [
      acceptance.evidenceKey,
      acceptance.evidenceModel,
      acceptance.recipeRunId,
      authHeaders,
      criterionId,
      resolveArtifactUrl,
      run?.slotId,
      runId,
      viewer,
    ],
  );

  const error = !active
    ? null
    : (acceptance.error ??
      (acceptance.view && !row
        ? `${criterionId} is not a criterion of this run`
        : row && !viewer
          ? `${evidencePath} is not evidence for ${criterionId}`
          : null));

  const close = useCallback(() => {
    setOpen(false);
    if (router.canGoBack()) router.back();
  }, [router]);

  return {
    visible: open && items.length > 0,
    items,
    review,
    initialIndex: viewer?.initialIndex ?? 0,
    error,
    close,
  };
}
