import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Run } from '@farmslot/protocol';

import type { MediaViewerItem } from '../../components/MediaViewer';
import { useRunAcceptance } from '../../hooks/useRunAcceptance';
import { acceptanceEvidenceViewer } from '../../lib/acceptance-evidence';
import { type ArtifactHttpHeaders, artifactUrl } from '../../lib/artifact-url';
import type { GatewayClient } from '../../lib/gateway-client';

export interface AcceptanceEvidenceViewerInput {
  client: GatewayClient | null;
  run: Run | null;
  /** Route `ac`; empty when the screen was not opened on a criterion. */
  criterionId: string;
  /** Route `evidence`: the task-relative file to open on. */
  evidencePath: string;
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
  const acceptance = useRunAcceptance(client, active ? run : null);
  const [open, setOpen] = useState(active);

  useEffect(() => {
    setOpen(active);
  }, [active, criterionId, evidencePath]);

  const row = acceptance.view?.rows.find((candidate) => candidate.criterion.id === criterionId);
  const runId = run?.id ?? '';
  const viewer = useMemo(
    () =>
      row && runId
        ? acceptanceEvidenceViewer(row, evidencePath, (path) =>
            artifactUrl(gatewayUrl, runId, path),
          )
        : null,
    [evidencePath, gatewayUrl, row, runId],
  );
  const items = useMemo<MediaViewerItem[]>(
    () =>
      (viewer?.items ?? []).map((item) => ({
        uri: item.uri,
        title: item.title,
        detail: item.detail,
        mediaType: item.mediaType,
        authHeaders,
      })),
    [authHeaders, viewer],
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
    initialIndex: viewer?.initialIndex ?? 0,
    error,
    close,
  };
}
