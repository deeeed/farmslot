/**
 * Dev-only `d12-native` recipe observer for the D12 native boot (prove-d12-native.mjs). It reads
 * the shared cache entries and held content the screens render, and the frames mounted screens
 * report, so it shows what the user sees. It never reads the gateway or drives app state.
 */
import {
  HUMAN_GATE_DECISION_TYPE,
  Methods,
  type PRListResult,
  type ReviewDiffSnapshot,
  type RunGetResult,
  type RunnerModelCatalogResult,
  type RunnerVisibleModelsGetResult,
} from '@farmslot/protocol';
import {
  type ContentKey,
  type GatewayResourceCache,
  parseUnifiedDiff,
  RESOURCE_CONTENT_LIMITS,
  resourceQuery,
  verifyResourceContent,
} from '@farmslot/protocol/client-cache';

import { decisionRunId } from '../lib/decision-run-context';
import { nativeDecisionsQuery } from '../lib/gateway-run-sync';
import { artifactImageKey, gateDiffSource } from '../lib/held-content';
import { getResourceCache, getResourceNativeOwnerId } from '../lib/resource-cache';
import { useConnectionStore } from '../store/connection';

/** New for each app process, so a cold restart shows. */
const launchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const FULL_BLOB_ID = /^[0-9a-f]{40}$/;
const GITLINK_MODE = '160000';

export type ArtifactImageState = 'loading' | 'failed' | 'loaded' | 'mismatch';
/** What one mounted ArtifactImage shows; `mountId` stays the same until it unmounts. */
export interface ArtifactImageFrame {
  id: string;
  state: ArtifactImageState;
  mountId: number;
}
/** What the gate review route renders for its decision. */
export interface GateReviewFrame {
  decisionId: string;
  ready: boolean;
  details: boolean;
}

const images = new Map<number, ArtifactImageFrame>();
let lastFailed: number | undefined;
let lastMounted: number | undefined;
const gateScreens = new Set<() => GateReviewFrame>();

export function reportArtifactImage(frame: ArtifactImageFrame): void {
  if (!images.has(frame.mountId)) lastMounted = frame.mountId;
  if (frame.state === 'failed') lastFailed = frame.mountId;
  images.set(frame.mountId, frame);
}
export function forgetArtifactImage(mountId: number): void {
  images.delete(mountId);
}
export function observeD12GateReview(read: () => GateReviewFrame): () => void {
  gateScreens.add(read);
  return () => {
    gateScreens.delete(read);
  };
}

type ProofCache = Pick<GatewayResourceCache, 'read' | 'hasContent' | 'readContent'>;

export interface D12NativeInputs {
  status: string;
  launchId: string;
  epoch?: string;
  connectionId: number;
  framesSent: number;
  cache: ProofCache | undefined;
  owner?: string;
  gateScreens: readonly GateReviewFrame[];
  /** The mount that most recently failed while still mounted, else the latest mount. */
  image?: ArtifactImageFrame;
}

/** Both sides of every text file the diff and its untracked manifest touch are held. */
async function bothSidesHeld(
  cache: ProofCache,
  text: string,
  untrackedFiles: ReviewDiffSnapshot['untrackedFiles'] = [],
): Promise<boolean> {
  const manifest = new Map(untrackedFiles.map((file) => [file.path, file.blobSha]));
  const files = parseUnifiedDiff(text).filter(
    (file) => !file.binary && file.oldMode !== GITLINK_MODE && file.newMode !== GITLINK_MODE,
  );
  const ids = files.flatMap((file) => [
    ...(file.oldPath ? [file.oldId] : []),
    ...(file.newPath ? [manifest.get(file.newPath) ?? file.newId] : []),
  ]);
  for (const [path, blobSha] of manifest)
    if (!files.some((file) => file.newPath === path)) ids.push(blobSha);
  for (const id of ids)
    if (!id || !FULL_BLOB_ID.test(id) || !(await cache.hasContent({ kind: 'blob', id })))
      return false;
  return true;
}

async function verified(
  cache: ProofCache,
  key: ContentKey,
  untracked?: ReviewDiffSnapshot['untrackedFiles'],
) {
  const data = await cache.readContent(key);
  return data ? { data, verified: verifyResourceContent(key, data, untracked) } : undefined;
}

/** The first pending ready gate in the shared decisions observation, as its screens show it. */
async function gateObservation(cache: ProofCache, screens: readonly GateReviewFrame[]) {
  const pending = (cache.read(nativeDecisionsQuery).data?.decisions ?? []).find(
    (decision) => decision.type === HUMAN_GATE_DECISION_TYPE && decision.payload?.kind === 'ready',
  );
  const runId = pending ? decisionRunId(pending) : null;
  if (!pending || !runId) return undefined;
  const run = cache.read(resourceQuery<RunGetResult>(Methods.RUN_GET, { runId })).data?.run ?? null;
  const decision = run?.decisions.find((entry) => entry.id === pending.id);
  const manifest =
    decision?.payload?.kind === 'ready' ? (decision.payload.prPackage?.evidenceManifest ?? []) : [];
  const imageKeys = manifest.flatMap((entry) => {
    const key = artifactImageKey(entry);
    return key
      ? [{ key, cached: (entry.sizeBytes ?? 0) <= RESOURCE_CONTENT_LIMITS.imageBytes }]
      : [];
  });
  const source = gateDiffSource(run);
  const diff = source ? await verified(cache, source.key, source.untrackedFiles) : undefined;
  const screen = screens.find((frame) => frame.decisionId === pending.id);
  const held = async () => {
    if (!source || !(await cache.hasContent(source.key))) return false;
    for (const { key, cached } of imageKeys)
      if (cached && !(await cache.hasContent(key))) return false;
    return true;
  };
  return {
    decisionId: pending.id,
    packageHeld: await held(),
    opened: screen?.ready === true,
    details: screen?.details === true,
    diff: diff?.verified === true,
    // No Companion screen renders both sides; this is what prefetch holds for them.
    bothSides:
      diff?.verified === true &&
      (await bothSidesHeld(cache, new TextDecoder().decode(diff.data), source?.untrackedFiles)),
    images: await Promise.all(
      imageKeys.map(async ({ key }) => ({
        sha256: key.id,
        verified: (await verified(cache, key))?.verified === true,
      })),
    ),
  };
}

/** The model ids of the entries the review-dispatch picker observes. */
function catalogObservation(cache: ProofCache, owner: string | undefined) {
  const visible = owner
    ? cache.read(
        resourceQuery<RunnerVisibleModelsGetResult>(Methods.RUNNER_VISIBLE_MODELS_GET, {}, owner),
      ).data
    : undefined;
  const models = new Set<string>();
  for (const { runner } of visible?.runners ?? [])
    for (const model of cache.read(
      resourceQuery<RunnerModelCatalogResult>(Methods.RUNNER_MODEL_CATALOG, { runner }),
    ).data?.models ?? [])
      models.add(model.id);
  return { models: [...models].sort() };
}

/** The PR dashboard's rows, with the upstream time it shows. */
function upstreamObservation(cache: ProofCache) {
  const state = cache.read(resourceQuery<PRListResult>(Methods.PR_LIST));
  const observedAt = state.sourceObservation?.observedAt ?? state.observedAt;
  return { prs: (state.data?.prs ?? []).map((pr) => ({ number: pr.pr, observedAt })) };
}

export async function d12NativeObservation(inputs: D12NativeInputs) {
  const { cache } = inputs;
  return {
    status: inputs.status,
    launchId: inputs.launchId,
    epoch: inputs.epoch,
    connectionId: inputs.connectionId,
    framesSent: inputs.framesSent,
    gate: cache ? await gateObservation(cache, inputs.gateScreens) : undefined,
    catalog: cache ? catalogObservation(cache, inputs.owner) : { models: [] },
    upstream: cache ? upstreamObservation(cache) : { prs: [] },
    image: inputs.image,
  };
}

/** `d12-native`, or `d12-native:reset` to restart the sent-frame count. */
export async function observeD12Native(ref: string) {
  const state = useConnectionStore.getState();
  const meter = state.client?.offlineBaseline;
  if (ref === 'd12-native:reset') meter?.resetFramesSent();
  const failed = lastFailed === undefined ? undefined : images.get(lastFailed);
  return {
    observations: {
      d12Native: await d12NativeObservation({
        status: state.status,
        launchId,
        epoch: state.client?.authenticatedConnection?.capabilities.resourceChanges?.epoch,
        connectionId: meter?.connection() ?? 0,
        framesSent: meter?.framesSent() ?? 0,
        cache: getResourceCache(),
        owner: getResourceNativeOwnerId(),
        gateScreens: [...gateScreens].map((read) => read()),
        image: failed ?? (lastMounted === undefined ? undefined : images.get(lastMounted)),
      }),
    },
  };
}
