import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ImageSourcePropType } from 'react-native';

import type { Run } from '@farmslot/protocol';

import { type ArtifactHttpHeaders, artifactSource } from '../lib/artifact-url';
import {
  artifactImageKey,
  fetchArtifactBytes,
  fetchRunArtifactBytes,
  type GateDiffContent,
  gateDiffContent,
  gateDiffSource,
  heldImageSource,
  openHeldContent,
} from '../lib/held-content';
import { getResourceCache, subscribeResourceCache } from '../lib/resource-cache';
import { useConnectionStore } from '../store/connection';

import { useConnectedTransport } from './useConnectedTransport';

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
 * shown from its verified bytes at any size (stored as opened up to 2 MB). Without a `sha256`, or
 * when no read completes, today's URL source. Undefined while the bytes are being read, and after
 * live bytes failed verification.
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
    source: ImageSourcePropType | undefined;
    settled: boolean;
  }>();
  const current =
    resolved && resolved.cache === cache && resolved.identity === identity ? resolved : undefined;
  const settled = current?.settled === true;
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
      .then((result) => {
        if (active)
          setResolved({
            cache,
            identity: `${keyId}\n${uri}`,
            // Verified or rejected bytes are final; only an unavailable read tries again.
            settled: result.status !== 'unavailable',
            source: heldImageSource(result, artifactSource(uri, headers)),
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [cache, connected, headers, keyId, settled, uri]);
  if (!keyId) return artifactSource(uri, headers);
  return current?.source;
}
