import { useEffect, useState } from 'react';

import { type FsReadResult, Methods, type ReviewChainEntry, type Run } from '@farmslot/protocol';
import {
  loadReviewHistoryArtifacts,
  reviewHistoryArtifactPaths,
  type ReviewHistoryArtifacts,
  reviewHistoryIdentity,
  reviewHistoryView,
} from '@farmslot/review-dispatch';

import { artifactUrl } from '../../lib/artifact-url';
import { currentFarmConnection } from '../../lib/connection-authority';
import { gatewayFetch } from '../../lib/gateway-http-auth';
import { useConnectionStore } from '../../store/connection';

export function useReviewHistory(run: Run, chain: ReviewChainEntry[]) {
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const url = useConnectionStore((state) => state.gatewayUrl);
  const headers = useConnectionStore((state) => state.activeProfileHttpAuthHeaders);
  const epoch = useConnectionStore((state) => state.authorityEpoch);
  const [revision, setRevision] = useState(0);
  const profile = useConnectionStore((state) => state.activeProfileId);
  const identity = `${profile}:${epoch}:${revision}:${url}:${client?.connectionGeneration}:${reviewHistoryIdentity(run)}`;
  const [saved, setSaved] = useState<{ identity: string; artifacts: ReviewHistoryArtifacts }>();
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
        return (await client.request<FsReadResult>(Methods.FS_READ, params)).content;
      },
    ).then((artifacts) => {
      if (!disposed && current()) setSaved({ identity, artifacts });
    });
    return () => {
      disposed = true;
    };
  }, [identity, status, client]);
  return {
    ...reviewHistoryView(run, saved?.identity === identity ? saved.artifacts : {}, chain),
    loading:
      status === 'connected' &&
      saved?.identity !== identity &&
      reviewHistoryArtifactPaths(run).length > 0,
    refresh: () => setRevision((value) => value + 1),
  };
}
