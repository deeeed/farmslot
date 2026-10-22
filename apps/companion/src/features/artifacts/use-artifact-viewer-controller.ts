import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  extractRunArtifactManifest,
  Methods,
  type RecipeRunArtifactGroup,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type RunRefreshMirrorResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { observeNativeArtifactFrame } from '../../farmslot/run-collections-proof';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import {
  type ArtifactStickyChromeLayout,
  artifactStickyChromeThreshold,
  artifactStickyChromeVisible,
} from '../../lib/artifact-sticky-chrome';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrlForEntry,
  classifyArtifact,
  countVisualArtifactPairs,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  resolveRecipeRunSelection,
} from '../../lib/artifact-url';
import {
  type ArtifactWorkspaceFilter,
  buildArtifactWorkspaceCounts,
  filterArtifactWorkspace,
  isArtifactWorkspaceFilter,
} from '../../lib/artifact-workspace';
import { currentFarmConnection } from '../../lib/connection-authority';
import { diffArtifactCandidate } from '../../lib/diff';
import { evidenceMediaItems } from '../../lib/evidence-media-items';
import { gatewayFetch } from '../../lib/gateway-http-auth';
import { getResourceCache, getResourceWorkspaceKey } from '../../lib/resource-cache';
import { assertNativeRunReady } from '../../lib/run-collections';
import { recordVisualClaimReview } from '../../lib/visual-claim-review';
import { selectArtifactWorkspaceDecision } from '../../lib/workspace-decisions';
import {
  artifactWorkspaceNavCurrent,
  targetWorkspaceRouteContextParams,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { routeParamString } from '../workspace-shared/route-params';

import { useAcceptanceEvidenceViewer } from './use-acceptance-evidence-viewer';

const ARTIFACT_FILTERS: Array<{ id: ArtifactWorkspaceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'After' },
  { id: 'review', label: 'Review files' },
  { id: 'visual', label: 'Visual files' },
  { id: 'docs', label: 'Doc files' },
  { id: 'diffs', label: 'Diff files' },
  { id: 'recipes', label: 'Recipe files' },
  { id: 'supporting', label: 'Other' },
];
const ARTIFACT_STICKY_NAV_FALLBACK_THRESHOLD = 180;
const ARTIFACT_STICKY_NAV_ACTIVATION_LEAD = 96;
const ARTIFACT_STICKY_NAV_MAX_THRESHOLD = 32;

const emptyRecipeRuns: RecipeRunArtifactGroup[] = [];

export function useArtifactViewerController() {
  const {
    runId,
    recipeRun,
    artifact,
    filter,
    workspace,
    decisionKind,
    ac,
    evidence,
    evidenceDecision,
  } = useLocalSearchParams<{
    runId: string;
    recipeRun?: string;
    artifact?: string | string[];
    filter?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
    /** Acceptance criterion whose evidence the viewer opens on (with `evidence`). */
    ac?: string | string[];
    evidence?: string | string[];
    evidenceDecision?: string | string[];
  }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const isFocused = useIsFocused();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const runQuery = useMemo(
    () => (runId ? resourceQuery<RunGetResult>('run.get', { runId }) : undefined),
    [runId],
  );
  const runObservation = useResourceQuery(runQuery);
  const run = runObservation.data?.run ?? null;
  const workspaceKey = getResourceWorkspaceKey();
  const [selectedRecipeRunId, setSelectedRecipeRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [documentViewer, setDocumentViewer] = useState<{ title: string; body: string } | null>(
    null,
  );
  const [artifactFilter, setArtifactFilter] = useState<ArtifactWorkspaceFilter>('all');
  const [artifactQuery, setArtifactQuery] = useState('');
  const [filterLayout, setFilterLayout] = useState<ArtifactStickyChromeLayout | null>(null);
  const [stickyNavVisible, setStickyNavVisible] = useState(false);
  const [artifactMirrorEpoch, setArtifactMirrorEpoch] = useState(0);
  const [artifactMirrorRefreshing, setArtifactMirrorRefreshing] = useState(false);
  const [artifactMirrorFeedback, setArtifactMirrorFeedback] = useState<string | null>(null);
  const stickyNavVisibleRef = useRef(false);
  const documentAbortRef = useRef<AbortController | null>(null);
  const syncRequestRef = useRef<symbol | undefined>(undefined);

  const frozenDecision = useMemo(
    () =>
      selectArtifactWorkspaceDecision(
        run,
        routeParamString(recipeRun),
        routeParamString(evidenceDecision).trim(),
      ),
    [evidenceDecision, recipeRun, run],
  );
  const frozenHash =
    frozenDecision?.payload?.kind === 'ready'
      ? frozenDecision.payload.prPackage?.packageHash
      : frozenDecision?.payload?.kind === 'output-review'
        ? frozenDecision.payload.manifestDigest
        : undefined;
  const acceptanceViewer = useAcceptanceEvidenceViewer({
    client,
    run,
    recipeRunId:
      typeof recipeRun === 'string' && recipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
        ? recipeRun
        : undefined,
    criterionId: routeParamString(ac).trim(),
    decisionId: frozenDecision?.id,
    evidencePath: routeParamString(evidence).trim(),
    gatewayUrl,
    authHeaders: artifactAuthHeaders,
  });

  const requestedRecipeRunId = typeof recipeRun === 'string' ? recipeRun : null;
  const requestedArtifactQuery = routeParamString(artifact).trim();
  const requestedFilterParam = routeParamString(filter).trim();
  const requestedFilter = isArtifactWorkspaceFilter(requestedFilterParam)
    ? requestedFilterParam
    : null;
  const frozenDecisionId = frozenDecision?.id;
  const recipeQuery = useMemo(
    () =>
      runId
        ? resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
            runId,
            includeRecordedEvidence: true,
            ...(frozenDecisionId
              ? { decisionId: frozenDecisionId, evidenceSnapshotHash: frozenHash }
              : {}),
            ...(requestedRecipeRunId && requestedRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
              ? { recipeRunId: requestedRecipeRunId }
              : {}),
          })
        : undefined,
    [requestedRecipeRunId, runId, frozenDecisionId, frozenHash],
  );
  const recipeObservation = useResourceQuery(recipeQuery);
  const recipeRunGroupsLoaded = Boolean(recipeObservation.data);
  const recordedEvidence = recipeObservation.data?.recordedEvidence ?? null;
  const recipeRuns = recipeObservation.data?.recipeRuns ?? emptyRecipeRuns;
  const gatewaySelectedRecipeRunId = recipeObservation.data?.selectedRecipeRunId ?? null;
  const scopeKey = JSON.stringify([
    workspaceKey,
    runId,
    frozenDecisionId,
    frozenHash,
    requestedRecipeRunId,
  ]);
  const scopeRef = useRef<string | undefined>(scopeKey);
  scopeRef.current = scopeKey;
  const [localScope, setLocalScope] = useState(scopeKey);
  const localCurrent = localScope === scopeKey;
  useEffect(() => {
    scopeRef.current = scopeKey;
    documentAbortRef.current?.abort();
    setViewerUri(null);
    setDocumentViewer(null);
    setError(null);
    setArtifactMirrorEpoch(0);
    setArtifactMirrorRefreshing(false);
    setArtifactMirrorFeedback(null);
    syncRequestRef.current = undefined;
    setLocalScope(scopeKey);
    return () => {
      if (scopeRef.current === scopeKey) scopeRef.current = undefined;
      documentAbortRef.current?.abort();
    };
  }, [scopeKey]);
  const commandsReady =
    client?.connectionState === 'connected' &&
    runObservation.status === 'ready' &&
    recipeObservation.status === 'ready';
  const assertCurrentInputs = useCallback(() => {
    if (getResourceWorkspaceKey() !== workspaceKey || scopeRef.current !== scopeKey)
      throw new Error('The artifact workspace changed. Open its current evidence before acting.');
    assertNativeRunReady(runId, run ?? undefined);
    if (
      !recipeQuery ||
      getResourceCache()?.read(recipeQuery) !== recipeObservation ||
      recipeObservation.status !== 'ready'
    )
      throw new Error('Wait for current evidence before acting.');
  }, [workspaceKey, scopeKey, runId, run, recipeQuery, recipeObservation]);
  const retry = useCallback(() => {
    const cache = getResourceCache();
    if (runQuery && cache?.read(runQuery).error) void cache.retry(runQuery);
    if (recipeQuery && cache?.read(recipeQuery).error) void cache.retry(recipeQuery);
  }, [runQuery, recipeQuery]);
  useEffect(() => {
    setSelectedRecipeRunId(
      requestedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
        ? null
        : resolveRecipeRunSelection(recipeRuns, requestedRecipeRunId, gatewaySelectedRecipeRunId),
    );
  }, [gatewaySelectedRecipeRunId, recipeRuns, requestedRecipeRunId]);

  useEffect(() => {
    if (!requestedArtifactQuery) return;
    if (!requestedFilter) setArtifactFilter('all');
    setArtifactQuery(requestedArtifactQuery);
  }, [requestedArtifactQuery, requestedFilter]);

  const awaitingRequestedRecipeRun = Boolean(
    !recipeRunGroupsLoaded &&
    requestedRecipeRunId &&
    requestedRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  );

  const selectedRecipeRun = useMemo(
    () => recipeRuns.find((group) => group.id === selectedRecipeRunId) ?? null,
    [recipeRuns, selectedRecipeRunId],
  );
  const workspaceRecipeRunId =
    requestedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
      ? DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : selectedRecipeRunId;
  const manifest = useMemo(() => {
    if (awaitingRequestedRecipeRun) return [];
    if (frozenDecision?.payload?.kind === 'ready')
      return (
        frozenDecision.payload.prPackage?.evidenceManifest ??
        frozenDecision.payload.artifactManifest ??
        []
      );
    if (frozenDecision?.payload?.kind === 'output-review')
      return run?.output?.artifactManifest ?? [];
    if (selectedRecipeRun) return artifactsForRecipeRun(selectedRecipeRun);
    return run ? extractRunArtifactManifest(run) : [];
  }, [awaitingRequestedRecipeRun, run, selectedRecipeRun, frozenDecision]);
  const proofFrame = useRef({
    focused: isFocused,
    run,
    recipes: recipeObservation,
    query: recipeQuery,
    decisionId: frozenDecisionId,
    artifactPaths: manifest.map(({ path }) => path),
    syncBusy: localCurrent && artifactMirrorRefreshing,
  });
  proofFrame.current = {
    focused: isFocused,
    run,
    recipes: recipeObservation,
    query: recipeQuery,
    decisionId: frozenDecisionId,
    artifactPaths: manifest.map(({ path }) => path),
    syncBusy: localCurrent && artifactMirrorRefreshing,
  };
  useEffect(() => {
    if (__DEV__) return observeNativeArtifactFrame(runId, () => proofFrame.current);
  }, [runId]);
  const artifactUrlFor = useCallback(
    (entry: ArtifactManifestEntry) =>
      artifactUrlForEntry(gatewayUrl, runId ?? '', entry, artifactMirrorEpoch),
    [artifactMirrorEpoch, gatewayUrl, runId],
  );
  const evidenceModel = useMemo(
    () =>
      createEvidenceReviewModel({
        context: 'artifact',
        gateDecision: frozenDecision ?? undefined,
        comparisonSnapshot: recordedEvidence?.comparisonSnapshot,
        artifacts: manifest,
        package: recordedEvidence?.input,
        contractVersion: recordedEvidence?.contractVersion,
        visualReviewAuthority: recordedEvidence?.visualReviewAuthority,
        visualReviewContext: recordedEvidence?.visualReviewContext,
        readErrors: recordedEvidence?.errors,
        artifactPrefix: recordedEvidence?.artifactPrefix,
        packagePath: recordedEvidence?.packagePath,
      }),
    [recordedEvidence, manifest, frozenDecision],
  );
  const visualPairCount = useMemo(
    () => countVisualArtifactPairs(manifest, evidenceModel),
    [manifest, evidenceModel],
  );
  const artifactCounts = useMemo(
    () => buildArtifactWorkspaceCounts(manifest, evidenceModel),
    [manifest, evidenceModel],
  );
  const filteredSingles = useMemo(
    () => filterArtifactWorkspace(manifest, artifactFilter, artifactQuery, evidenceModel),
    [artifactFilter, artifactQuery, manifest, evidenceModel],
  );
  const availableFilters = useMemo(
    () =>
      selectedRecipeRun
        ? ARTIFACT_FILTERS.filter((item) => item.id !== 'recipes')
        : ARTIFACT_FILTERS,
    [selectedRecipeRun],
  );
  const artifactDiffPath = useMemo(() => diffArtifactCandidate(manifest)?.path ?? null, [manifest]);
  const workspaceNavCurrent = artifactWorkspaceNavCurrent(
    workspaceRecipeRunId,
    artifactFilter,
    visualPairCount,
  );
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        workspaceNavCurrent,
      ),
    [decisionKind, workspace, workspaceNavCurrent],
  );
  const diffRouteContext = useMemo(
    () => targetWorkspaceRouteContextParams('diff', workspaceRouteContext.decisionKind),
    [workspaceRouteContext.decisionKind],
  );
  const stickyNavThreshold = artifactStickyChromeThreshold(
    filterLayout,
    ARTIFACT_STICKY_NAV_FALLBACK_THRESHOLD,
    ARTIFACT_STICKY_NAV_ACTIVATION_LEAD,
    ARTIFACT_STICKY_NAV_MAX_THRESHOLD,
  );

  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const visible = artifactStickyChromeVisible(
        event.nativeEvent.contentOffset.y,
        stickyNavThreshold,
      );
      if (stickyNavVisibleRef.current === visible) return;
      stickyNavVisibleRef.current = visible;
      setStickyNavVisible(visible);
    },
    [stickyNavThreshold],
  );

  const rememberFilterOffset = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setFilterLayout({ y, height });
  }, []);

  useEffect(() => {
    if (selectedRecipeRun && artifactFilter === 'recipes') setArtifactFilter('all');
  }, [artifactFilter, selectedRecipeRun]);

  useEffect(() => {
    if (requestedFilter) {
      setArtifactFilter(
        selectedRecipeRun && requestedFilter === 'recipes' ? 'all' : requestedFilter,
      );
      return;
    }
    if (!requestedArtifactQuery) setArtifactFilter('all');
  }, [requestedArtifactQuery, requestedFilter, selectedRecipeRun]);

  const refreshArtifactMirror = useCallback(async () => {
    if (!client || !runId || artifactMirrorRefreshing || syncRequestRef.current) return;
    const request = Symbol('artifact-sync');
    syncRequestRef.current = request;
    const connected = currentFarmConnection(client, useConnectionStore.getState);
    const current = () =>
      connected() && scopeRef.current === scopeKey && syncRequestRef.current === request;
    setArtifactMirrorRefreshing(true);
    setArtifactMirrorFeedback(null);
    try {
      assertCurrentInputs();
      const result = await client.request<RunRefreshMirrorResult>(Methods.RUN_REFRESH_MIRROR, {
        runId,
      });
      if (!current()) return;
      if (!result.ok) {
        setArtifactMirrorFeedback(result.reason || 'Artifact sync failed');
        return;
      }
      setArtifactMirrorEpoch((value) => value + 1);
      setArtifactMirrorFeedback(result.copied > 0 ? `Synced ${result.copied}` : 'Up to date');
    } catch (err) {
      if (current()) setArtifactMirrorFeedback(`Artifact sync failed: ${(err as Error).message}`);
    } finally {
      if (syncRequestRef.current === request) {
        syncRequestRef.current = undefined;
        if (scopeRef.current === scopeKey) setArtifactMirrorRefreshing(false);
      }
    }
  }, [artifactMirrorRefreshing, client, assertCurrentInputs, runId, scopeKey]);

  useEffect(() => {
    if (!artifactMirrorFeedback) return;
    const timer = setTimeout(() => setArtifactMirrorFeedback(null), 2500);
    return () => clearTimeout(timer);
  }, [artifactMirrorFeedback]);

  const openVisualArtifact = useCallback(
    (uri: string) => {
      evidenceModel.clearSelection();
      setViewerUri(uri);
    },
    [evidenceModel],
  );
  const visualViewerItems = useMemo(
    () => evidenceMediaItems(manifest, artifactUrlFor, artifactAuthHeaders, evidenceModel),
    [artifactAuthHeaders, artifactUrlFor, evidenceModel, manifest],
  );
  const viewerIndex = viewerUri ? visualViewerItems.findIndex((item) => item.uri === viewerUri) : 0;

  const openDocument = useCallback(
    (url: string, path: string) => {
      documentAbortRef.current?.abort();
      const controller = new AbortController();
      documentAbortRef.current = controller;
      gatewayFetch(url, artifactAuthHeaders, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((body) => {
          if (!controller.signal.aborted && scopeRef.current === scopeKey)
            setDocumentViewer({ title: path.split('/').pop() ?? path, body });
        })
        .catch((err: Error) => {
          // Abort is the expected cleanup path when the operator closes/navigates mid-fetch.
          if (err.name === 'AbortError' || scopeRef.current !== scopeKey) return;
          setError(`Failed to load ${path}: ${err.message}`);
        });
    },
    [artifactAuthHeaders, scopeKey],
  );
  const openReviewDocument = useCallback(
    (entry: ArtifactManifestEntry) => {
      if (!runId) return;
      openDocument(artifactUrlForEntry(gatewayUrl, runId, entry, artifactMirrorEpoch), entry.path);
    },
    [artifactMirrorEpoch, gatewayUrl, openDocument, runId],
  );

  const openProofArtifact = useCallback(
    (entry: ArtifactManifestEntry) => {
      const retained = manifest.find((file) => file.path === entry.path) ?? entry;
      if (classifyArtifact(retained) === 'document') {
        setViewerUri(null);
        openReviewDocument(retained);
      } else {
        setViewerUri(artifactUrlFor(retained));
      }
    },
    [artifactUrlFor, manifest, openReviewDocument],
  );

  const handleSelectRecipeRun = useCallback(
    (recipeRunId: string | null) => {
      setArtifactFilter('all');
      setArtifactQuery('');
      router.setParams({
        artifact: undefined,
        filter: undefined,
        ac: undefined,
        evidence: undefined,
        recipeRun: recipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
      });
    },
    [router],
  );

  const handleFilterChange = useCallback(
    (nextFilter: ArtifactWorkspaceFilter) => {
      setArtifactFilter(nextFilter);
      router.setParams({ filter: nextFilter === 'all' ? undefined : nextFilter });
    },
    [router],
  );

  const openDiffPath = useCallback(
    (path?: string) => {
      if (!runId) return;
      if (!path && !artifactDiffPath && run?.slotId) {
        router.push({
          pathname: '/workspace/slot/[slotId]/diff',
          params: { slotId: run.slotId, ...diffRouteContext },
        });
        return;
      }
      router.push({
        pathname: '/workspace/run/[runId]/diff',
        params: {
          runId,
          ...diffRouteContext,
          ...(path ? { path } : {}),
          ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
        },
      });
    },
    [artifactDiffPath, diffRouteContext, router, run?.slotId, runId, workspaceRecipeRunId],
  );

  const recordVisualReview = useCallback(
    async (id: string, verdict: 'confirmed' | 'rejected', reason?: string) => {
      assertCurrentInputs();
      await recordVisualClaimReview(client, runId, evidenceModel, id, verdict, reason);
    },
    [assertCurrentInputs, client, runId, evidenceModel],
  );
  const clearArtifactFocus = useCallback(() => {
    setArtifactQuery('');
    router.setParams({
      artifact: undefined,
      filter: undefined,
      recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
    });
  }, [router, workspaceRecipeRunId]);
  const selectFilter = useCallback(
    (filter: ArtifactWorkspaceFilter) => {
      handleFilterChange(filter);
      setArtifactQuery('');
      router.setParams({ artifact: undefined });
    },
    [handleFilterChange, router],
  );
  const openEvidence = useCallback(
    (id: string, path: string) => {
      evidenceModel.selectClaim(id, path);
      openProofArtifact({
        path,
        purpose: 'evidence',
        recipeRunId: selectedRecipeRunId ?? undefined,
      });
    },
    [evidenceModel, openProofArtifact, selectedRecipeRunId],
  );
  const openOccurrence = useCallback(
    (index: number) => {
      const selected = evidenceModel.selectOccurrence(index);
      const path = selected?.clips[0]?.videoPath ?? selected?.artifacts[0]?.path;
      if (path)
        openProofArtifact({
          path: evidenceModel.artifactPath(path),
          purpose: 'evidence',
          recipeRunId: selectedRecipeRunId ?? undefined,
        });
      else setError(selected?.message ?? 'This recipe step has no proof artifact.');
    },
    [evidenceModel, openProofArtifact, selectedRecipeRunId],
  );
  return {
    viewModel: {
      run,
      runId,
      runObservation,
      recipeObservation,
      insets,
      stickyNavVisible,
      artifactFilter,
      artifactQuery,
      artifactCounts,
      filteredSingles,
      visualPairCount,
      availableFilters,
      manifest,
      gatewayUrl,
      artifactAuthHeaders,
      recipeRuns,
      selectedRecipeRunId,
      selectedRecipeRun,
      artifactMirrorEpoch: localCurrent ? artifactMirrorEpoch : 0,
      artifactMirrorRefreshing: localCurrent && artifactMirrorRefreshing,
      artifactMirrorFeedback: localCurrent ? artifactMirrorFeedback : null,
      recordedEvidence,
      evidenceModel,
      reviewer: client?.authenticatedPrincipal ?? null,
      client,
      commandsReady,
      ownerKey: JSON.stringify([workspaceKey, runId]),
      error: (localCurrent ? error : null) ?? acceptanceViewer.error,
      isFocused,
      viewerUri: localCurrent ? viewerUri : null,
      viewerIndex,
      visualViewerItems,
      acceptanceViewer,
      documentViewer: localCurrent ? documentViewer : null,
    },
    actions: {
      handleListScroll,
      refreshArtifactMirror,
      handleSelectRecipeRun,
      openVisualArtifact,
      openReviewDocument,
      openDiffPath,
      rememberFilterOffset,
      openDocument,
      artifactUrlFor,
      selectFilter,
      clearArtifactFocus,
      recordVisualReview,
      openEvidence,
      openOccurrence,
      closeMedia: () => setViewerUri(null),
      closeDocument: () => setDocumentViewer(null),
      assertCurrentInputs,
      retry,
    },
  };
}
