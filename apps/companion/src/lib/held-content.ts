/**
 * Content the device holds by identity (ADR-071 Content rules): the gate package diff by
 * `diffHash` and evidence images by manifest `sha256`. Held bytes are read first, offline
 * and online; a live read is verified before it is shown or stored.
 */
import {
  isRunArtifactImagePath,
  openHumanGateDecision,
  type ReviewDiffSnapshot,
  type Run,
} from '@farmslot/protocol';
import {
  type ContentKey,
  type ContentPrefetchArtifact,
  type GatewayResourceCache,
  type ResourceContentCohort,
  verifyResourceContent,
} from '@farmslot/protocol/client-cache';

import { artifactUrl } from './artifact-url';
import { gatewayFetch, type GatewayHttpAuthHeaders } from './gateway-http-auth';

export interface GateDiffSource extends ContentPrefetchArtifact {
  key: ContentKey;
  untrackedFiles?: ReviewDiffSnapshot['untrackedFiles'];
}

/** The steps of `openHeldContent`, in order. */
export type HeldContentStage = 'open-held' | 'fetch' | 'verify' | 'store';

/** `mismatch`: bytes this client fetched failed verification; they are never shown. */
export type HeldContentResult =
  | { status: 'ready'; data: Uint8Array }
  | { status: 'unavailable' | 'mismatch' };

export type GateDiffContent =
  | { status: 'none' | 'loading' | 'unavailable' | 'mismatch' }
  | { status: 'ready'; text: string };

/** Raw artifact bytes. An authorization refusal rejects with `code: 'AUTH_FORBIDDEN'`. */
export async function fetchArtifactBytes(
  uri: string,
  headers: GatewayHttpAuthHeaders,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await gatewayFetch(uri, headers, { signal });
  if (response.status === 401 || response.status === 403)
    throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'AUTH_FORBIDDEN' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** `/api/run-artifact` with the retained bundle digest. */
export function fetchRunArtifactBytes(
  gatewayUrl: string,
  headers: GatewayHttpAuthHeaders,
  { runId, path, bundleDigest }: ContentPrefetchArtifact,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return fetchArtifactBytes(
    artifactUrl(gatewayUrl, runId, path, undefined, undefined, bundleDigest),
    headers,
    signal,
  );
}

/** The open gate's retained diff (`reviewSnapshot.diffPath`), identified by its `diffHash`. */
export function gateDiffSource(run: Run | null): GateDiffSource | undefined {
  const decision = openHumanGateDecision(run);
  const prPackage = decision?.payload?.kind === 'ready' ? decision.payload.prPackage : undefined;
  const snapshot = prPackage?.reviewSnapshot;
  if (!run || !snapshot?.diffPath || !snapshot.diffHash) return undefined;
  return {
    key: { kind: 'diff', id: snapshot.diffHash },
    runId: run.id,
    path: snapshot.diffPath,
    bundleDigest: prPackage?.artifactBundle?.bundleDigest,
    untrackedFiles: snapshot.untrackedFiles,
  };
}

/**
 * An evidence image with a manifest `sha256` is content by it at any size, so it is shown only
 * from verified bytes. Only storing is capped, at 2 MB (Content rule 4).
 */
export function artifactImageKey(artifact: {
  path: string;
  sha256?: string;
}): ContentKey | undefined {
  if (!artifact.sha256 || !isRunArtifactImagePath(artifact.path)) return undefined;
  return { kind: 'artifact', id: artifact.sha256 };
}

/**
 * Opens held bytes, which marks them opened. Without them, a live read (only passed while the
 * gateway is connected) is verified and stored as opened. A failed read is unavailable, which
 * leaves today's load path; bytes that fail verification are a mismatch.
 */
export async function openHeldContent({
  cache,
  key,
  cohort,
  untrackedFiles,
  read,
  onStage,
}: {
  cache:
    | Pick<GatewayResourceCache, 'openContent' | 'storeContent' | 'contentWriteToken'>
    | undefined;
  key: ContentKey;
  cohort: ResourceContentCohort;
  untrackedFiles?: ReviewDiffSnapshot['untrackedFiles'];
  read?: () => Promise<Uint8Array>;
  /** Dev-only recipe evidence: the step the open is waiting on. */
  onStage?: (stage: HeldContentStage) => void;
}): Promise<HeldContentResult> {
  onStage?.('open-held');
  const held = await cache?.openContent(key);
  if (held) return { status: 'ready', data: held };
  if (!read) return { status: 'unavailable' };
  const token = cache?.contentWriteToken();
  onStage?.('fetch');
  const data = await read().catch(() => undefined);
  if (!data) return { status: 'unavailable' };
  onStage?.('verify');
  if (!verifyResourceContent(key, data, untrackedFiles)) return { status: 'mismatch' };
  onStage?.('store');
  await cache?.storeContent({
    key,
    data,
    origin: 'opened',
    cohort,
    token,
    ...(untrackedFiles?.length ? { untrackedFiles } : {}),
  });
  return { status: 'ready', data };
}

export function gateDiffContent(result: HeldContentResult): GateDiffContent {
  return result.status === 'ready'
    ? { status: 'ready', text: new TextDecoder().decode(result.data) }
    : { status: result.status };
}

/**
 * Only a package diff that is missing or could not be read falls back to the run's diff artifact
 * or workspace diff. A mismatch keeps its notice instead of loading the same diff unverified.
 */
export function gateDiffFallsBack(content: GateDiffContent): boolean {
  return content.status === 'none' || content.status === 'unavailable';
}

function imageType(data: Uint8Array): string {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP')
    return 'image/webp';
  return 'image/png';
}

/**
 * What an artifact image renders. Without a manifest `sha256` (no key), its URL as today. With
 * one, never the raw URL: verified bytes as a data URI at any size, so the image shown is the one
 * verified; while reading, after an unavailable read or a mismatch, no source, the same
 * unavailable image as a failed load.
 */
export function artifactImageSource<T>(
  keyId: string | undefined,
  result: HeldContentResult | undefined,
  urlSource: T,
): { uri: string } | T | undefined {
  if (!keyId) return urlSource;
  return result?.status === 'ready' ? { uri: imageDataUri(result.data) } : undefined;
}

/** `<Image>` takes no bytes, so verified image bytes render as a data URI. */
export function imageDataUri(data: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < data.byteLength; index += 0x8000)
    binary += String.fromCharCode(...data.subarray(index, index + 0x8000));
  return `data:${imageType(data)};base64,${btoa(binary)}`;
}
