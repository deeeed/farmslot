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
  RESOURCE_CONTENT_LIMITS,
  type ResourceContentCohort,
  verifyResourceContent,
} from '@farmslot/protocol/client-cache';

import { artifactUrl } from './artifact-url';
import { gatewayFetch, type GatewayHttpAuthHeaders } from './gateway-http-auth';

export interface GateDiffSource extends ContentPrefetchArtifact {
  key: ContentKey;
  untrackedFiles?: ReviewDiffSnapshot['untrackedFiles'];
}

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

/** Evidence images up to 2 MB are content by their manifest `sha256` (Content rule 4). */
export function artifactImageKey(artifact: {
  path: string;
  sha256?: string;
  sizeBytes?: number;
}): ContentKey | undefined {
  if (
    !artifact.sha256 ||
    !isRunArtifactImagePath(artifact.path) ||
    (artifact.sizeBytes ?? 0) > RESOURCE_CONTENT_LIMITS.imageBytes
  )
    return undefined;
  return { kind: 'artifact', id: artifact.sha256 };
}

/**
 * Opens held bytes, which marks them opened. Without them, a live read (only passed while the
 * gateway is connected) is verified and stored as opened. Undefined leaves today's load path.
 */
export async function openHeldContent({
  cache,
  key,
  cohort,
  untrackedFiles,
  read,
}: {
  cache:
    | Pick<GatewayResourceCache, 'openContent' | 'storeContent' | 'contentWriteToken'>
    | undefined;
  key: ContentKey;
  cohort: ResourceContentCohort;
  untrackedFiles?: ReviewDiffSnapshot['untrackedFiles'];
  read?: () => Promise<Uint8Array>;
}): Promise<Uint8Array | undefined> {
  const held = await cache?.openContent(key);
  if (held || !read) return held;
  const token = cache?.contentWriteToken();
  const data = await read().catch(() => undefined);
  if (!data || !verifyResourceContent(key, data, untrackedFiles)) return undefined;
  await cache?.storeContent({
    key,
    data,
    origin: 'opened',
    cohort,
    token,
    ...(untrackedFiles?.length ? { untrackedFiles } : {}),
  });
  return data;
}

function imageType(data: Uint8Array): string {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP')
    return 'image/webp';
  return 'image/png';
}

/** `<Image>` takes no bytes, so held images up to 2 MB render as a data URI. */
export function imageDataUri(data: Uint8Array): string | undefined {
  if (data.byteLength > RESOURCE_CONTENT_LIMITS.imageBytes) return undefined;
  let binary = '';
  for (let index = 0; index < data.byteLength; index += 0x8000)
    binary += String.fromCharCode(...data.subarray(index, index + 0x8000));
  return `data:${imageType(data)};base64,${btoa(binary)}`;
}
