import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ImageSourcePropType } from 'react-native';

import type { GitDiffResult, Run } from '@farmslot/protocol';
import { activeRunDiffQuery, type ResourceQuery } from '@farmslot/protocol/client-cache';

import { type ArtifactHttpHeaders, artifactSource, heldArtifactFile } from '../lib/artifact-url';
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
  type HeldContentStage,
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

/** Header contents, by sorted entries. */
function headersKey(headers: ArtifactHttpHeaders | undefined): string {
  return JSON.stringify(
    Object.entries(headers ?? {}).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

/**
 * The previous headers object while its contents are equal. Every connection callback stores a
 * new one, so reads and image sources depend on this: equal headers set again never abort a read
 * in flight or rebuild a source, and changed values restart the read.
 */
function useStableHeaders<T extends ArtifactHttpHeaders | undefined>(headers: T): T {
  const key = headersKey(headers);
  const stable = useRef({ key, headers });
  if (stable.current.key !== key) stable.current = { key, headers };
  return stable.current.headers;
}

/**
 * The open gate's retained diff, verified by `diffHash`: held content first, then a live read
 * while connected. Unavailable leaves the screen on today's diff path; a mismatch is final.
 */
export function useGateDiffContent(run: Run | null): GateDiffContent {
  const cache = useSyncExternalStore(subscribeResourceCache, getResourceCache, getResourceCache);
  const connected = useConnectedTransport() !== null;
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const headers = useStableHeaders(useConnectionStore((s) => s.activeProfileHttpAuthHeaders));
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

/** `url` for an image without a `sha256`, else where its verified read stands. */
export type ArtifactImageRead = 'url' | 'reading' | HeldContentResult['status'];
/** Where an image's current read stands: a step of the open, then its result or its abort. */
export type ArtifactReadStage = HeldContentStage | 'committed' | 'aborted';

/**
 * An evidence image from held content by manifest `sha256`, or read live while connected and
 * shown from its verified bytes at any size (stored as opened up to 2 MB); it never loads from its
 * raw URL. No source while the bytes are being read, after they failed verification, and while no
 * read completes, which is retried on reconnect. Without a `sha256`, today's URL source.
 */
export function useArtifactImageSource(
  uri: string,
  headers: ArtifactHttpHeaders | undefined,
  artifact: { path: string; sha256?: string },
  /** Dev-only recipe evidence: each read, numbered from 1, its stages and its fetch outcome. */
  trace?: (
    run: number,
    stage: ArtifactReadStage,
    fetch?: { bytes: number } | { error: string },
  ) => void,
): { source: ImageSourcePropType | undefined; read: ArtifactImageRead } {
  const traceRef = useRef(trace);
  traceRef.current = trace;
  const runs = useRef(0);
  const stableHeaders = useStableHeaders(headers);
  const cache = useSyncExternalStore(subscribeResourceCache, getResourceCache, getResourceCache);
  const connected = useConnectedTransport() !== null;
  const keyId = artifactImageKey(artifact)?.id;
  // An image too large for a content row may be held as a verified file: show it, read nothing.
  const heldFile = keyId ? heldArtifactFile(keyId) : undefined;
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
    if (!keyId || settled || heldFile) return;
    let active = true;
    let done = false;
    const run = ++runs.current;
    // A cleaned-up read reports nothing later, its aborted fetch included.
    const note = (stage: ArtifactReadStage, fetch?: { bytes: number } | { error: string }) => {
      if (active) traceRef.current?.(run, stage, fetch);
    };
    const controller = new AbortController();
    openHeldContent({
      cache,
      key: { kind: 'artifact', id: keyId },
      cohort: 'gate',
      read: connected
        ? () =>
            fetchArtifactBytes(uri, stableHeaders ?? {}, controller.signal).then(
              (bytes) => {
                note('fetch', { bytes: bytes.byteLength });
                return bytes;
              },
              (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                note('fetch', { error: message });
                throw error;
              },
            )
        : undefined,
      onStage: note,
    })
      .catch(() => ({ status: 'unavailable' as const }))
      .then((next) => {
        done = true;
        note('committed');
        if (active) setResolved({ cache, identity: `${keyId}\n${uri}`, result: next });
      });
    return () => {
      active = false;
      if (!done) traceRef.current?.(run, 'aborted');
      controller.abort();
    };
  }, [cache, connected, heldFile, keyId, settled, stableHeaders, uri]);
  const source = useMemo(
    () =>
      heldFile
        ? { uri: heldFile }
        : artifactImageSource(keyId, result, artifactSource(uri, stableHeaders)),
    [heldFile, keyId, result, stableHeaders, uri],
  );
  if (heldFile) return { source, read: 'ready' };
  return { source, read: keyId ? (result?.status ?? 'reading') : 'url' };
}
