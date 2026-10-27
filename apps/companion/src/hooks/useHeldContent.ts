import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ImageSourcePropType } from 'react-native';

import type { Run } from '@farmslot/protocol';

import { type ArtifactHttpHeaders, artifactSource } from '../lib/artifact-url';
import {
  artifactImageKey,
  fetchArtifactBytes,
  fetchRunArtifactBytes,
  gateDiffSource,
  imageDataUri,
  openHeldContent,
} from '../lib/held-content';
import { getResourceCache, subscribeResourceCache } from '../lib/resource-cache';
import { useConnectionStore } from '../store/connection';

import { useConnectedTransport } from './useConnectedTransport';

export type GateDiffContent =
  | { status: 'none' | 'loading' | 'unavailable' }
  | { status: 'ready'; text: string };

const NONE: GateDiffContent = { status: 'none' };
const LOADING: GateDiffContent = { status: 'loading' };
const UNAVAILABLE: GateDiffContent = { status: 'unavailable' };

/**
 * The open gate's retained diff, verified by `diffHash`: held content first, then a live read
 * while connected. Unavailable leaves the screen on today's diff path.
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
  const ready = current?.status === 'ready';
  useEffect(() => {
    if (!source || ready) return;
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
      (data) =>
        settle(data ? { status: 'ready', text: new TextDecoder().decode(data) } : UNAVAILABLE),
      () => settle(UNAVAILABLE),
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [cache, connected, gatewayUrl, headers, ready, source]);
  if (!source) return NONE;
  return current ?? LOADING;
}

/**
 * An evidence image from held content by manifest `sha256`, read live and stored as opened while
 * connected, otherwise today's URL source. Undefined while the held bytes are being read.
 */
export function useArtifactImageSource(
  uri: string,
  headers: ArtifactHttpHeaders | undefined,
  artifact: { path: string; sha256?: string; sizeBytes?: number },
): ImageSourcePropType | undefined {
  const cache = useSyncExternalStore(subscribeResourceCache, getResourceCache, getResourceCache);
  const connected = useConnectedTransport() !== null;
  const keyId = artifactImageKey(artifact)?.id;
  const identity = keyId ? `${keyId}\n${uri}` : '';
  const [resolved, setResolved] = useState<{
    cache: typeof cache;
    identity: string;
    source: ImageSourcePropType;
    held: boolean;
  }>();
  const current =
    resolved && resolved.cache === cache && resolved.identity === identity ? resolved : undefined;
  const held = current?.held === true;
  useEffect(() => {
    if (!keyId || held) return;
    let active = true;
    const controller = new AbortController();
    openHeldContent({
      cache,
      key: { kind: 'artifact', id: keyId },
      cohort: 'gate',
      read: connected ? () => fetchArtifactBytes(uri, headers ?? {}, controller.signal) : undefined,
    })
      .catch(() => undefined)
      .then((data) => {
        const dataUri = data && imageDataUri(data);
        if (active)
          setResolved({
            cache,
            identity: `${keyId}\n${uri}`,
            held: Boolean(dataUri),
            source: dataUri ? { uri: dataUri } : artifactSource(uri, headers),
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [cache, connected, headers, held, keyId, uri]);
  if (!keyId) return artifactSource(uri, headers);
  return current?.source;
}
