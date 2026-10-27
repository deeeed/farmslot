import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ImageSourcePropType } from 'react-native';

import type { GitDiffResult, Run } from '@farmslot/protocol';
import { activeRunDiffQuery, type ResourceQuery } from '@farmslot/protocol/client-cache';

import { type ArtifactHttpHeaders, artifactSource } from '../lib/artifact-url';
import { companionRunDiffBase } from '../lib/content-prefetch';
import {
  artifactImageKey,
  artifactImageSource,
  fetchArtifactBytes,
  fetchRunArtifactBytes,
  type GateDiffContent,
  gateDiffContent,
  gateDiffSource,
  type HeldContentResult,
  openHeldContent,
} from '../lib/held-content';
import { getResourceCache, subscribeResourceCache } from '../lib/resource-cache';
import { useWorkspaceRenderAccess } from '../lib/use-workspace-render-access';
import { useConnectionStore } from '../store/connection';

import { useConfigurationProjects } from './useConfigurationProjects';
import { useConnectedTransport } from './useConnectedTransport';

/**
 * The active run's diff since its base, with untracked files: the query prefetch keeps, so the
 * diff screens read the held snapshot offline. Undefined until the base is known.
 */
export function useActiveRunDiffQuery(
  run: Run | null | undefined,
): ResourceQuery<GitDiffResult> | undefined {
  const farm = useWorkspaceRenderAccess() === 'farm';
  const projects = useConfigurationProjects();
  const slotId = run?.slotId;
  const runId = run?.id;
  const base = run ? companionRunDiffBase(run, farm ? projects : undefined) : undefined;
  return useMemo(
    () => (slotId && runId && base ? activeRunDiffQuery({ slotId, runId, base }) : undefined),
    [base, runId, slotId],
  );
}

const NONE: GateDiffContent = { status: 'none' };
const LOADING: GateDiffContent = { status: 'loading' };
const UNAVAILABLE: GateDiffContent = { status: 'unavailable' };

/**
 * The open gate's retained diff, verified by `diffHash`: held content first, then a live read
 * while connected. Unavailable leaves the screen on today's diff path; a mismatch is final.
 */
export function useGateDiffContent(run: Run | null): GateDiffContent {
  const cache = useSyncExternalStore(subscribeResourceCache, getResourceCache, getResourceCache);
  const connected = useConnectedTransport() !== null;
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const headers = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const source = useMemo(() => gateDiffSource(run), [run]);
  const identity = source ? `${source.runId}\n${source.path}\n${source.key.id}` : '';
  const [resolved, setResolved] = useState<{
    cache: typeof cache;
    identity: string;
    content: GateDiffContent;
  }>();
  // A retired owner's bytes never render under the next one.
  const current =
    resolved && resolved.cache === cache && resolved.identity === identity
      ? resolved.content
      : undefined;
  const settled = current?.status === 'ready' || current?.status === 'mismatch';
  useEffect(() => {
    if (!source || settled) return;
    let active = true;
    const controller = new AbortController();
    const settle = (content: GateDiffContent) => {
      if (active)
        setResolved({
          cache,
          identity: `${source.runId}\n${source.path}\n${source.key.id}`,
          content,
        });
    };
    openHeldContent({
      cache,
      key: source.key,
      cohort: 'gate',
      untrackedFiles: source.untrackedFiles,
      read: connected
        ? () => fetchRunArtifactBytes(gatewayUrl, headers, source, controller.signal)
        : undefined,
    }).then(
      (result) => settle(gateDiffContent(result)),
      () => settle(UNAVAILABLE),
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [cache, connected, gatewayUrl, headers, settled, source]);
  if (!source) return NONE;
  return current ?? LOADING;
}

/**
 * An evidence image from held content by manifest `sha256`, or read live while connected and
 * shown from its verified bytes at any size (stored as opened up to 2 MB); it never loads from its
 * raw URL. Undefined while the bytes are being read, after they failed verification, and while no
 * read completes, which is retried on reconnect. Without a `sha256`, today's URL source.
 */
export function useArtifactImageSource(
  uri: string,
  headers: ArtifactHttpHeaders | undefined,
  artifact: { path: string; sha256?: string },
): ImageSourcePropType | undefined {
  const cache = useSyncExternalStore(subscribeResourceCache, getResourceCache, getResourceCache);
  const connected = useConnectedTransport() !== null;
  const keyId = artifactImageKey(artifact)?.id;
  const identity = keyId ? `${keyId}\n${uri}` : '';
  const [resolved, setResolved] = useState<{
    cache: typeof cache;
    identity: string;
    result: HeldContentResult;
  }>();
  const result =
    resolved && resolved.cache === cache && resolved.identity === identity
      ? resolved.result
      : undefined;
  // Verified or rejected bytes are final; only an unavailable read tries again.
  const settled = result !== undefined && result.status !== 'unavailable';
  useEffect(() => {
    if (!keyId || settled) return;
    let active = true;
    const controller = new AbortController();
    openHeldContent({
      cache,
      key: { kind: 'artifact', id: keyId },
      cohort: 'gate',
      read: connected ? () => fetchArtifactBytes(uri, headers ?? {}, controller.signal) : undefined,
    })
      .catch(() => ({ status: 'unavailable' as const }))
      .then((next) => {
        if (active) setResolved({ cache, identity: `${keyId}\n${uri}`, result: next });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [cache, connected, headers, keyId, settled, uri]);
  return useMemo(
    () => artifactImageSource(keyId, result, artifactSource(uri, headers)),
    [headers, keyId, result, uri],
  );
}
