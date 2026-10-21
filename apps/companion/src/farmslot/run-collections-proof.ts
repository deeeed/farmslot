import { Platform } from 'react-native';

import { nativeResourceStoreDiagnostics } from '@farmslot/local-store/native';
import type {
  FamilyObservabilityGetResult,
  FamilyObservabilitySnapshot,
  Run,
  RunGetResult,
  RunRecipeRunsForRunResult,
} from '@farmslot/protocol';
import {
  type ResourceQuery,
  resourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { nativeActiveRunsQuery, nativeDecisionsQuery } from '../lib/gateway-run-sync';
import { getResourceCache, getResourceWorkspaceKey } from '../lib/resource-cache';
import { useConnectionStore } from '../store/connection';
import { useDecisionStore } from '../store/decisions';
import { useRunStore } from '../store/runs';

import type { FarmslotRecipeUiObserver } from './RecipeBridgeProvider';

const startedAt = Date.now();
interface FamilyProofFrame {
  focused: boolean;
  routeRunId: string;
  snapshot: FamilyObservabilitySnapshot | null;
  selectedFullRun: Run | null;
  runIds: readonly string[];
  recipes: readonly ResourceQueryState<RunRecipeRunsForRunResult>[];
}
const familyFrames = new Map<string, Set<() => FamilyProofFrame>>();
interface DiffProofFrame {
  focused: boolean;
  run: Run | null;
  recipes: ResourceQueryState<RunRecipeRunsForRunResult>;
}
const diffFrames = new Map<string, Set<() => DiffProofFrame>>();
interface ArtifactProofFrame {
  focused: boolean;
  run: Run | null;
  recipes: ResourceQueryState<RunRecipeRunsForRunResult>;
  query?: ResourceQuery<RunRecipeRunsForRunResult>;
  decisionId?: string;
  artifactPaths: readonly string[];
  syncBusy: boolean;
}
const artifactFrames = new Map<string, Set<() => ArtifactProofFrame>>();

/** Read the artifact view's actual selection and render inputs without changing them. */
export function observeNativeArtifactFrame(runId: string, read: () => ArtifactProofFrame) {
  const frames = artifactFrames.get(runId) ?? new Set<() => ArtifactProofFrame>();
  artifactFrames.set(runId, frames);
  frames.add(read);
  return () => {
    frames.delete(read);
    if (!frames.size && artifactFrames.get(runId) === frames) artifactFrames.delete(runId);
  };
}

/** Observe the focused diff's actual render inputs, without adopting or seeding data. */
export function observeNativeDiffFrame(runId: string, read: () => DiffProofFrame) {
  const frames = diffFrames.get(runId) ?? new Set<() => DiffProofFrame>();
  diffFrames.set(runId, frames);
  frames.add(read);
  return () => {
    frames.delete(read);
    if (!frames.size && diffFrames.get(runId) === frames) diffFrames.delete(runId);
  };
}

/** Observe the production render projection without changing any UI or cache value. */
export function observeNativeFamilyFrame(familyId: string, read: () => FamilyProofFrame) {
  const frames = familyFrames.get(familyId) ?? new Set<() => FamilyProofFrame>();
  familyFrames.set(familyId, frames);
  frames.add(read);
  return () => {
    frames.delete(read);
    if (!frames.size && familyFrames.get(familyId) === frames) familyFrames.delete(familyId);
  };
}

/** Read production projections and actual store diagnostics without issuing a query. */
export const observeRunCollectionsProof: FarmslotRecipeUiObserver = async (refs) => {
  const match = /^runs-cache:(detail|family|diff|artifacts):([a-f0-9-]{36})$/.exec(refs[0] ?? '');
  const detailId = match?.[2];
  const family =
    match?.[1] === 'family' && detailId
      ? getResourceCache()?.read(
          resourceQuery<FamilyObservabilityGetResult>('family.observability.get', {
            familyId: detailId,
          }),
        )
      : undefined;
  if (refs[0] !== 'runs-cache:snapshot' && !detailId) return undefined;
  const runStore = useRunStore.getState();
  const decisionStore = useDecisionStore.getState();
  const cache = getResourceCache();
  const artifactFrame = detailId
    ? [...(artifactFrames.get(detailId) ?? [])].map((read) => read()).find((value) => value.focused)
    : undefined;
  const diffFrame = detailId
    ? [...(diffFrames.get(detailId) ?? [])].map((read) => read()).find((value) => value.focused)
    : undefined;
  const frame = detailId
    ? [...(familyFrames.get(detailId) ?? [])].map((read) => read()).find((value) => value.focused)
    : undefined;
  const familySelected = frame?.selectedFullRun
    ? cache?.read(resourceQuery<RunGetResult>('run.get', { runId: frame.selectedFullRun.id }))
    : undefined;
  return {
    observations: {
      runCollections: {
        platform: Platform.OS,
        startedAt,
        online: useConnectionStore.getState().client?.connectionState === 'connected',
        workspaceKey: getResourceWorkspaceKey(),
        runsStatus: runStore.observation.status,
        runsObservedAt: runStore.observation.observedAt,
        runs: runStore.runs.map(({ id, ticketOrPr, tags }) => ({ id, ticketOrPr, tags })),
        activeIds: cache?.read(nativeActiveRunsQuery).data?.runs.map(({ id }) => id),
        historyLoaded: runStore.historyLoaded,
        decisionsStatus: decisionStore.observation.status,
        decisionsObservedAt: decisionStore.observation.observedAt,
        decisions: decisionStore.decisions.map(({ id, title }) => ({ id, title })),
        decisionProjectionMatches: decisionStore.observation === cache?.read(nativeDecisionsQuery),
        ...(match?.[1] === 'artifacts' && detailId
          ? {
              artifactProjectionMatches: Boolean(
                artifactFrame?.query &&
                artifactFrame.run ===
                  cache?.read(resourceQuery<RunGetResult>('run.get', { runId: detailId })).data
                    ?.run &&
                artifactFrame.recipes === cache?.read(artifactFrame.query),
              ),
              artifactRecipes: artifactFrame?.recipes,
              artifactParams: artifactFrame?.query?.params,
              artifactDecisionId: artifactFrame?.decisionId,
              artifactPaths: artifactFrame?.artifactPaths,
              artifactSyncBusy: artifactFrame?.syncBusy,
            }
          : {}),
        ...(match?.[1] === 'diff' && detailId
          ? {
              diffProjectionMatches: Boolean(
                diffFrame &&
                diffFrame.run ===
                  cache?.read(resourceQuery<RunGetResult>('run.get', { runId: detailId })).data
                    ?.run &&
                diffFrame.recipes ===
                  cache?.read(
                    resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
                      runId: detailId,
                    }),
                  ),
              ),
              diffRecipes: diffFrame?.recipes,
            }
          : {}),
        ...(family
          ? {
              family,
              familySelected,
              familyRouteRunId: frame?.routeRunId,
              familySelectionInRoute: Boolean(
                frame?.selectedFullRun && frame.routeRunId === frame.selectedFullRun.id,
              ),
              familyProjectionMatches: Boolean(frame && frame.snapshot === family.data?.snapshot),
              selectedRunProjectionMatches: Boolean(
                frame && frame.selectedFullRun === familySelected?.data?.run,
              ),
              familyRecipeProjectionMatches: Boolean(
                frame &&
                frame.runIds.length === family.data?.snapshot.runs.length &&
                frame.recipes.length === frame.runIds.length &&
                frame.recipes.every(
                  (state, index) =>
                    state ===
                    cache?.read(
                      resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
                        runId: frame.runIds[index],
                      }),
                    ),
                ),
              ),
              familyRecipes: family.data?.snapshot.runs.map(({ runId }) => ({
                runId,
                status: cache?.read(
                  resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', { runId }),
                ).status,
              })),
            }
          : {}),
        ...(detailId
          ? {
              detail: cache?.read(resourceQuery<RunGetResult>('run.get', { runId: detailId })),
              recipes: cache?.read(
                resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
                  runId: detailId,
                  includeRecordedEvidence: true,
                }),
              ),
            }
          : {}),
        diagnostics: await nativeResourceStoreDiagnostics(),
      },
    },
  };
};
