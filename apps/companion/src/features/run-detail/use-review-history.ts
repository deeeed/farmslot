import { useEffect, useRef, useState } from 'react';

import {
  type FsReadResult,
  type GitDiffResult,
  Methods,
  type ReviewChainEntry,
  type ReviewedFindingContext,
  type Run,
} from '@farmslot/protocol';
import {
  loadReviewHistoryArtifacts,
  mergeReviewHistoryArtifacts,
  reviewHistoryArtifactPaths,
  type ReviewHistoryArtifacts,
  reviewHistoryCacheScope,
  type ReviewHistoryFinding,
  reviewHistoryIdentity,
  type ReviewHistoryRound,
  reviewHistorySourceRequest,
  reviewHistoryView,
} from '@farmslot/review-dispatch';

import { artifactUrl } from '../../lib/artifact-url';
import { currentFarmConnection } from '../../lib/connection-authority';
import { gatewayFetch } from '../../lib/gateway-http-auth';
import { loadReviewFindingSource, readReviewWorkspace } from '../../lib/review-curation';
import { useConnectionStore } from '../../store/connection';

export function useReviewHistory(run: Run, chain: ReviewChainEntry[]) {
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const url = useConnectionStore((state) => state.gatewayUrl);
  const headers = useConnectionStore((state) => state.activeProfileHttpAuthHeaders);
  const epoch = useConnectionStore((state) => state.authorityEpoch);
  const [revision, setRevision] = useState(0);
  const profile = useConnectionStore((state) => state.activeProfileId);
  const principal = useConnectionStore((state) => state.principalId);
  const artifactScope = reviewHistoryCacheScope(run.id, {
    profileId: profile,
    gatewayUrl: url,
    principalId: principal,
  });
  const identity = `${artifactScope}:${epoch}:${client?.connectionGeneration}:${revision}:${reviewHistoryIdentity(run)}`;
  const [saved, setSaved] = useState<{
    identity: string;
    scope: string;
    artifacts: ReviewHistoryArtifacts;
    error?: string;
  }>();
  useEffect(() => {
    if (!client || status !== 'connected') return;
    let disposed = false;
    const current = currentFarmConnection(client, useConnectionStore.getState);
    void loadReviewHistoryArtifacts(
      run,
      async (path) => {
        const response = await gatewayFetch(artifactUrl(url, run.id, path), headers);
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Artifact HTTP ${response.status}`);
        return response.text();
      },
      async (params) => {
        if (!current()) throw new Error('Farm connection changed');
        return (await readReviewWorkspace<FsReadResult>(Methods.FS_READ, params)).content;
      },
      async (params) => {
        if (!current()) throw new Error('Farm connection changed');
        if (params.slotId)
          return (await readReviewWorkspace<GitDiffResult>(Methods.GIT_DIFF, params)).diff;
        const { runId = '', base = '', head = '' } = params;
        if (!runId || !base || !head) throw new Error('Review range is unavailable');
        return (
          await client.request<GitDiffResult>(Methods.GIT_DIFF, { slotId: '', runId, base, head })
        ).diff;
      },
    )
      .then((artifacts) => {
        if (!disposed && current())
          setSaved((previous) => ({
            identity,
            scope: artifactScope,
            artifacts: mergeReviewHistoryArtifacts(
              previous?.scope === artifactScope ? previous.artifacts : {},
              artifacts,
            ),
          }));
      })
      .catch((error: unknown) => {
        if (!disposed && current())
          setSaved((previous) => ({
            identity,
            scope: artifactScope,
            artifacts: previous?.scope === artifactScope ? previous.artifacts : {},
            error: error instanceof Error ? error.message : String(error),
          }));
      });
    return () => {
      disposed = true;
    };
  }, [identity, status, client]);
  const selection = useRef<object | null>(null);
  const [source, setSource] = useState<{
    identity: string;
    key: string;
    loading?: boolean;
    context?: ReviewedFindingContext;
    error?: string;
  }>();
  const inspect = async (round: ReviewHistoryRound, finding: ReviewHistoryFinding) => {
    if (!client || status !== 'connected') return;
    const params = reviewHistorySourceRequest(run, round, finding);
    if (!params) return;
    const request = {};
    selection.current = request;
    const key = `${round.key}:${finding.id}`;
    const connected = currentFarmConnection(client, useConnectionStore.getState);
    const current = () => selection.current === request && connected();
    setSource({ identity, key, loading: true });
    try {
      const context = await loadReviewFindingSource(client, params, finding.line!, current);
      if (context) setSource({ identity, key, context });
    } catch (error) {
      if (current())
        setSource({ identity, key, error: error instanceof Error ? error.message : String(error) });
    }
  };
  return {
    source: source?.identity === identity ? source : undefined,
    inspect: (round: ReviewHistoryRound, finding: ReviewHistoryFinding) =>
      void inspect(round, finding),
    ...reviewHistoryView(run, saved?.scope === artifactScope ? saved.artifacts : {}, chain),
    error: saved?.identity === identity ? saved.error : undefined,
    loading:
      status === 'connected' &&
      saved?.identity !== identity &&
      reviewHistoryArtifactPaths(run).length > 0,
    refresh: () => setRevision((value) => value + 1),
  };
}
