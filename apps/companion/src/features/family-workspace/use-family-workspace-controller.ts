import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Events,
  type FamilyObservabilityArtifact,
  type FamilyObservabilityGetResult,
  type FamilyObservabilityRunSummary,
  Methods,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';
import { type ResourceQuery, resourceQuery } from '@farmslot/protocol/client-cache';

import { observeNativeFamilyFrame } from '../../farmslot/run-collections-proof';
import { useResourceQueries, useResourceQuery } from '../../hooks/useResourceQuery';
import {
  artifactsForRecipeRun,
  artifactUrlForEntry,
  classifyArtifact,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
} from '../../lib/artifact-url';
import { currentFarmConnection } from '../../lib/connection-authority';
import { diffArtifactCandidate } from '../../lib/diff';
import {
  buildFamilyEvidenceGroups,
  familyArtifactKind,
  type FamilyEvidenceFilter,
  filterFamilyEvidenceGroups,
  isFamilyVideoArtifact,
  normalizeFamilyEvidenceFilterParam,
} from '../../lib/family-evidence';
import { collectFamilyRetrospectives } from '../../lib/family-retrospectives';
import { gatewayFetch } from '../../lib/gateway-http-auth';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { getResourceCache } from '../../lib/resource-cache';
import { selectSlotRecipeArtifactsForPreviewScope } from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
  taskProgressRequestForRun,
} from '../../lib/task-progress';
import {
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
  workspaceDecisionKind,
} from '../../lib/workspace-decisions';
import {
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceForArtifactRoute,
  targetWorkspaceRouteContextParams,
  workspaceForFamilySection,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { routeParamString } from '../workspace-shared/route-params';

import {
  familyArtifactUrl,
  hasRecipeArtifacts,
  recipeRunIdForVisualPair,
  summarizeFamilyRecipeEvidence,
  workflowStateColor,
} from './components/family-workspace-panels';
import {
  type FamilyRecipeEvidenceSummary,
  normalizeFamilySectionParam,
} from './family-workspace-model';

export function useFamilyWorkspaceController() {
  const {
    familyId,
    project,
    runId,
    section,
    recipeRun,
    artifact,
    workspace,
    decisionKind,
    evidence,
  } = useLocalSearchParams<{
    familyId: string;
    project?: string;
    runId?: string;
    section?: string;
    recipeRun?: string | string[];
    artifact?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
    evidence?: string | string[];
  }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const focused = useIsFocused();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const familyQuery = useMemo(
    () =>
      familyId
        ? resourceQuery<FamilyObservabilityGetResult>(Methods.FAMILY_OBSERVABILITY_GET, {
            familyId,
            ...(project ? { project } : {}),
          })
        : undefined,
    [familyId, project],
  );
  const familyObservation = useResourceQuery(familyQuery);
  const snapshot = familyObservation.data?.snapshot ?? null;
  const [actionError, setError] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [documentViewer, setDocumentViewer] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const [evidenceFilter, setEvidenceFilter] = useState<FamilyEvidenceFilter>('all');
  const [taskProgress, setTaskProgress] = useState<TaskProgressStructured | null>(null);
  const [taskProgressError, setTaskProgressError] = useState<string | null>(null);
  const documentAbortRef = useRef<AbortController | null>(null);
  const requestedRecipeRunId = routeParamString(recipeRun).trim();
  const requestedArtifactPath = routeParamString(artifact).trim();
  const requestedSection = normalizeFamilySectionParam(section);
  const requestedEvidenceFilter = normalizeFamilyEvidenceFilterParam(evidence);
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        workspaceForFamilySection(requestedSection) ?? 'family',
      ),
    [decisionKind, requestedSection, workspace],
  );

  useEffect(() => {
    return () => {
      documentAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (requestedEvidenceFilter) {
      setEvidenceFilter(requestedEvidenceFilter);
    } else if (requestedSection === 'evidence') {
      setEvidenceFilter('all');
    }
  }, [requestedEvidenceFilter, requestedSection]);

  const selectedRun =
    snapshot?.runs.find((run) => run.runId === runId) ??
    snapshot?.runs.find((run) => run.runId === snapshot.latestRunId) ??
    snapshot?.runs[0] ??
    null;
  const selectedId = selectedRun?.runId ?? runId;
  useEffect(() => {
    if (focused && selectedRun && selectedRun.runId !== runId)
      router.setParams({ runId: selectedRun.runId });
  }, [focused, router, selectedRun?.runId, runId]);
  const selectedQuery = useMemo(
    () =>
      selectedId ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId: selectedId }) : undefined,
    [selectedId],
  );
  const selectedRunObservation = useResourceQuery(selectedQuery);
  const selectedFullRun = selectedRunObservation.data?.run ?? null;
  const familyRunIdsKey = (
    snapshot?.runs.map(({ runId }) => runId) ?? (selectedId ? [selectedId] : [])
  ).join(',');
  const familyRunIds = useMemo(
    () => (familyRunIdsKey ? familyRunIdsKey.split(',') : []),
    [familyRunIdsKey],
  );
  const recipeQueries = useMemo(
    () =>
      familyRunIds.map((id) =>
        resourceQuery<RunRecipeRunsForRunResult>(Methods.RUN_RECIPE_RUNS_FOR_RUN, { runId: id }),
      ),
    [familyRunIds],
  );
  const recipeObservations = useResourceQueries(recipeQueries);
  const proofFrame = useRef({
    focused,
    routeRunId: runId ?? '',
    snapshot,
    selectedFullRun,
    runIds: familyRunIds,
    recipes: recipeObservations,
  });
  proofFrame.current = {
    focused,
    routeRunId: runId ?? '',
    snapshot,
    selectedFullRun,
    runIds: familyRunIds,
    recipes: recipeObservations,
  };
  useEffect(() => {
    if (__DEV__) return observeNativeFamilyFrame(familyId, () => proofFrame.current);
  }, [familyId]);
  const selectedRecipeObservation = recipeObservations[familyRunIds.indexOf(selectedId ?? '')];
  const selectedRecipeRuns = selectedRecipeObservation?.data?.recipeRuns ?? [];
  const selectedRecipeArtifactCount = selectedRecipeObservation?.data
    ? selectedRecipeRuns.reduce((count, group) => count + artifactsForRecipeRun(group).length, 0)
    : null;
  const familyRecipeEvidence = useMemo(() => {
    const summaries: Record<string, FamilyRecipeEvidenceSummary> = {};
    recipeObservations.forEach((observed, index) => {
      if (observed.data)
        summaries[familyRunIds[index]] = summarizeFamilyRecipeEvidence(
          observed.data.recipeRuns,
          gatewayUrl,
          familyRunIds[index],
        );
    });
    return summaries;
  }, [recipeObservations, familyRunIds, gatewayUrl]);
  const error =
    actionError ??
    familyObservation.error?.message ??
    selectedRunObservation.error?.message ??
    recipeObservations.find((observed) => observed.error)?.error?.message ??
    null;
  const retryFamily = useCallback(async () => {
    const cache = getResourceCache();
    if (!cache) return;
    setError(null);
    const queries: ResourceQuery[] = [
      ...(familyQuery ? [familyQuery] : []),
      ...(selectedQuery ? [selectedQuery] : []),
      ...recipeQueries,
    ];
    const failed = queries.filter((query) => cache.read(query).error);
    await Promise.all(
      (failed.length ? failed : familyQuery ? [familyQuery] : []).map((query) =>
        cache.retry(query),
      ),
    );
  }, [familyQuery, selectedQuery, recipeQueries]);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const authorityEpoch = useConnectionStore((state) => state.authorityEpoch);
  const viewKey = JSON.stringify([familyId, selectedId, profileId, authorityEpoch]);
  const scope = useRef({ key: viewKey, client });
  if (scope.current.key !== viewKey || scope.current.client !== client)
    scope.current = { key: viewKey, client };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const captureCurrent = useCallback(() => {
    const owner = scope.current;
    const connected = client
      ? currentFarmConnection(client, useConnectionStore.getState)
      : () => false;
    return () => mounted.current && scope.current === owner && connected();
  }, [client]);
  useEffect(() => {
    documentAbortRef.current?.abort();
    setError(null);
    setViewerUri(null);
    setDocumentViewer(null);
    setTaskProgress(null);
    setTaskProgressError(null);
  }, [viewKey]);

  const fetchTaskProgress = useCallback(() => {
    const params = taskProgressRequestForRun(selectedFullRun);
    if (!client || !params) return Promise.resolve();
    const current = captureCurrent();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, params)
      .then((result) => {
        if (!current()) return;
        setTaskProgress(result.structured ?? null);
        setTaskProgressError(null);
      })
      .catch((err: Error) => {
        if (!current()) return;
        setTaskProgressError(`Task progress unavailable: ${err.message}`);
      });
  }, [
    client,
    selectedFullRun?.id,
    selectedFullRun?.slotId,
    selectedFullRun?.reviewWorkspace?.workspaceId,
    captureCurrent,
    viewKey,
  ]);

  useEffect(() => {
    if (!client || !selectedFullRun) return;
    const current = captureCurrent();
    const unsub = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      if (!current()) return;
      const update = payload as TaskProgressUpdatedPayload;
      if (!shouldAcceptTaskProgressUpdate(selectedFullRun, update)) return;
      setTaskProgress(update.progress.structured ?? null);
      setTaskProgressError(null);
    });
    return unsub;
  }, [client, selectedFullRun, captureCurrent, viewKey]);

  useEffect(() => {
    if (!isWorkerProgressActive(selectedFullRun)) {
      setTaskProgress(null);
      setTaskProgressError(null);
      return;
    }
    void fetchTaskProgress();
    const timer = setInterval(() => {
      void fetchTaskProgress();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTaskProgress, selectedFullRun]);

  const runForArtifact = useCallback(
    (artifact: FamilyObservabilityArtifact) => {
      const runs = snapshot?.runs ?? [];
      const sourceRunId = artifact.sourceRunId ?? artifact.runId;
      return (
        runs.find((run) => run.runId === sourceRunId) ??
        runs.find((run) => run.runId === artifact.runId) ??
        null
      );
    },
    [snapshot?.runs],
  );
  const evidenceGroups = useMemo(
    () => buildFamilyEvidenceGroups(snapshot, runForArtifact),
    [runForArtifact, snapshot],
  );
  const filteredEvidenceGroups = useMemo(
    () => filterFamilyEvidenceGroups(evidenceGroups, evidenceFilter),
    [evidenceFilter, evidenceGroups],
  );
  const evidenceCounts = useMemo(
    () => ({
      all: snapshot?.evidence.length ?? 0,
      before: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'before',
      ).length,
      after: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'after',
      ).length,
      review: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'review',
      ).length,
      diffs: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'diffs',
      ).length,
      recipes: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'recipes',
      ).length,
      setup: (snapshot?.evidence ?? []).filter(
        (artifact) => familyArtifactKind(artifact) === 'setup',
      ).length,
      videos: (snapshot?.evidence ?? []).filter(isFamilyVideoArtifact).length,
    }),
    [snapshot?.evidence],
  );
  const visualPairs = useMemo(
    () =>
      groupVisualArtifactPairs(snapshot?.evidence ?? [], (artifact) =>
        familyArtifactUrl(gatewayUrl, artifact),
      ).pairs,
    [gatewayUrl, snapshot?.evidence],
  );
  const selectedRecipeVisualPairs = useMemo(() => {
    if (!selectedRun?.runId || visualPairs.length > 0) return [];
    return groupVisualArtifactPairs(
      selectSlotRecipeArtifactsForPreviewScope(selectedRecipeRuns, null),
      (artifact) => artifactUrlForEntry(gatewayUrl, selectedRun.runId, artifact),
    ).pairs;
  }, [gatewayUrl, selectedRecipeRuns, selectedRun?.runId, visualPairs.length]);
  const visualViewerItems = useMemo(() => {
    const items = (snapshot?.evidence ?? [])
      .filter((artifact) => ['image', 'video'].includes(classifyArtifact(artifact)))
      .map((artifact) => ({
        uri: familyArtifactUrl(gatewayUrl, artifact),
        title: artifact.path,
        mediaType: classifyArtifact(artifact),
        authHeaders: artifactAuthHeaders,
      }));
    for (const pair of selectedRecipeVisualPairs) {
      for (const artifact of [pair.before, pair.after]) {
        items.push({
          uri: artifact.url,
          title: artifact.path,
          mediaType: classifyArtifact(artifact),
          authHeaders: artifactAuthHeaders,
        });
      }
    }

    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.uri)) return false;
      seen.add(item.uri);
      return true;
    });
  }, [artifactAuthHeaders, gatewayUrl, selectedRecipeVisualPairs, snapshot?.evidence]);
  const viewerIndex = viewerUri
    ? Math.max(
        0,
        visualViewerItems.findIndex((item) => item.uri === viewerUri),
      )
    : 0;

  const openDocument = useCallback(
    (artifact: FamilyObservabilityArtifact) => {
      documentAbortRef.current?.abort();
      const controller = new AbortController();
      documentAbortRef.current = controller;
      const url = familyArtifactUrl(gatewayUrl, artifact);
      const current = captureCurrent();
      gatewayFetch(url, artifactAuthHeaders, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((body) => {
          if (current() && !controller.signal.aborted)
            setDocumentViewer({
              title: artifact.path.split('/').pop() ?? artifact.path,
              body,
            });
        })
        .catch((err: Error) => {
          // Abort is the expected cleanup path when navigating or opening another document.
          if (err.name === 'AbortError' || !current()) return;
          setError(`Failed to load ${artifact.path}: ${err.message}`);
        });
    },
    [artifactAuthHeaders, gatewayUrl, captureCurrent],
  );

  const diffRouteContext = useCallback(
    (routeContext = workspaceRouteContext) =>
      targetWorkspaceRouteContextParams('diff', routeContext.decisionKind),
    [workspaceRouteContext],
  );
  const artifactRouteContext = useCallback(
    (
      recipeRunId: string | null | undefined,
      filterParam: string | null | undefined,
      routeContext = workspaceRouteContext,
    ) =>
      targetWorkspaceRouteContextParams(
        targetWorkspaceForArtifactRoute(recipeRunId, filterParam),
        routeContext.decisionKind,
      ),
    [workspaceRouteContext],
  );
  const targetRouteContext = useCallback(
    (
      targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0],
      routeContext = workspaceRouteContext,
    ) => targetWorkspaceRouteContextParams(targetWorkspace, routeContext.decisionKind),
    [workspaceRouteContext],
  );

  const openDiffArtifact = useCallback(
    (artifact: FamilyObservabilityArtifact, routeContext = workspaceRouteContext) => {
      router.push({
        pathname: '/workspace/run/[runId]/diff',
        params: {
          runId: artifact.runId,
          ...diffRouteContext(routeContext),
          path: artifact.path,
          recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        },
      });
    },
    [diffRouteContext, router, workspaceRouteContext],
  );
  const openFamilyRecipeArtifact = useCallback(
    (
      runIdValue: string,
      recipeRunId: string,
      artifactPath: string,
      filterParam?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
      routeContext = workspaceRouteContext,
    ) => {
      if (diffArtifactCandidate([{ path: artifactPath }])) {
        router.push({
          pathname: '/workspace/run/[runId]/diff',
          params: {
            runId: runIdValue,
            ...diffRouteContext(routeContext),
            recipeRun: recipeRunId,
            path: artifactPath,
          },
        });
        return;
      }
      router.push({
        pathname: '/workspace/run/[runId]/files',
        params: {
          runId: runIdValue,
          ...artifactRouteContext(
            recipeRunId,
            filterParam ?? artifactFilterParamForWorkspaceNav('recipe'),
            routeContext,
          ),
          recipeRun: recipeRunId,
          artifact: artifactPath,
          filter: filterParam ?? artifactFilterParamForWorkspaceNav('recipe'),
        },
      });
    },
    [artifactRouteContext, diffRouteContext, router, workspaceRouteContext],
  );
  const openFamilyArtifactWorkspace = useCallback(
    (runIdValue: string, artifactPath?: string, routeContext = workspaceRouteContext) => {
      const filter =
        (artifactPath ? artifactFilterParamForArtifactPath(artifactPath) : undefined) ??
        artifactFilterParamForWorkspaceNav('review');
      if (artifactPath && diffArtifactCandidate([{ path: artifactPath }])) {
        router.push({
          pathname: '/workspace/run/[runId]/diff',
          params: {
            runId: runIdValue,
            ...diffRouteContext(routeContext),
            recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
            path: artifactPath,
          },
        });
        return;
      }
      router.push({
        pathname: '/workspace/run/[runId]/files',
        params: {
          runId: runIdValue,
          ...artifactRouteContext(DECISION_EVIDENCE_RECIPE_RUN_PARAM, filter, routeContext),
          recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
          filter,
          ...(artifactPath ? { artifact: artifactPath } : {}),
        },
      });
    },
    [artifactRouteContext, diffRouteContext, router, workspaceRouteContext],
  );

  const goBackOrRuns = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)/runs');
  }, [router]);

  if (!snapshot) {
    return {
      status: 'loading' as const,
      snapshot: null,
      error,
      client,
      insets,
      goBackOrRuns,
      familyObservation,
      selectedRunObservation,
      selectedFullRun,
      retryFamily,
      openSavedRun: () =>
        selectedFullRun &&
        router.push({
          pathname: '/workspace/run/[runId]/evidence',
          params: { runId: selectedFullRun.id },
        }),
    };
  }

  const workflowColor = workflowStateColor(snapshot.workflowState);
  const familyRetrospectives = collectFamilyRetrospectives(snapshot.runs);
  const pendingRetrospectiveCount = familyRetrospectives.filter(
    (entry) => !entry.decision.resolvedAt,
  ).length;
  const retrospectiveRouteContext = familySectionRouteContextParams(
    'retros',
    workspaceRouteContext.decisionKind,
  );
  const openPRForRun = (
    run: FamilyObservabilityRunSummary,
    routeContext = workspaceRouteContext,
  ) => {
    if (!run.prNumber) return;
    const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
    router.push({
      pathname: '/(tabs)/prs',
      params: {
        pr: String(run.prNumber),
        ...targetRouteContext('pr', routeContext),
        ...(prRepo ? { repo: prRepo } : {}),
      },
    });
  };
  const selectedActiveTaskProgress = isWorkerProgressActive(selectedFullRun)
    ? (effectiveTaskProgressForRun(selectedFullRun, taskProgress) ?? null)
    : null;
  const selectedFallbackTaskProgress =
    !selectedActiveTaskProgress && isWorkerProgressActive(selectedFullRun)
      ? fallbackTaskProgressSummary(selectedFullRun)
      : null;
  const readyDecision = selectReadyWorkspaceDecision(selectedRun);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(selectedRun);
  const retroDecision = selectRetrospectiveWorkspaceDecision(selectedRun);
  const selectedRecipeAvailable = selectedRun
    ? selectedRecipeArtifactCount === null
      ? hasRecipeArtifacts(selectedRun)
        ? true
        : undefined
      : selectedRecipeArtifactCount > 0
    : undefined;
  const selectedDiffValue = selectedRun?.diffStat.available
    ? `+${selectedRun.diffStat.additions} -${selectedRun.diffStat.deletions}`
    : selectedRun?.slotId
      ? 'workspace'
      : 'none';
  const requestedArtifactIsDiff = Boolean(
    requestedArtifactPath && diffArtifactCandidate([{ path: requestedArtifactPath }]),
  );
  const recipeEvidenceForRun = (
    run: FamilyObservabilityRunSummary,
  ): FamilyRecipeEvidenceSummary | null => familyRecipeEvidence[run.runId] ?? null;
  const recipeCountForRun = (run: FamilyObservabilityRunSummary): number | null =>
    recipeEvidenceForRun(run)?.artifactCount ?? null;
  const recipeAvailableForRun = (run: FamilyObservabilityRunSummary): boolean | undefined => {
    const count = recipeCountForRun(run);
    if (count !== null) return count > 0;
    if (run.runId === selectedRun?.runId) return selectedRecipeAvailable;
    return hasRecipeArtifacts(run) ? true : undefined;
  };
  const decisionRouteContextForRun = (run: FamilyObservabilityRunSummary, decisionId: string) =>
    decisionWorkspaceRouteParams(
      workspaceDecisionKind((run.decisions ?? []).find((decision) => decision.id === decisionId)),
    );
  const workspaceRecipeRunForRun = (runIdValue: string): string =>
    runIdValue === selectedRun?.runId
      ? requestedRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const focusedArtifactForRun = (runIdValue: string): string | undefined =>
    runIdValue === selectedRun?.runId && requestedArtifactPath ? requestedArtifactPath : undefined;
  const focusedArtifactParamsForRun = (runIdValue: string): { artifact?: string } => {
    const focusedArtifact = focusedArtifactForRun(runIdValue);
    return focusedArtifact ? { artifact: focusedArtifact } : {};
  };
  const recipeWorkspaceParamsForRun = (
    run: FamilyObservabilityRunSummary,
  ): { recipeRun: string; artifact?: string } => {
    const recipeEvidence = recipeEvidenceForRun(run);
    const recipeTarget =
      recipeEvidence?.recipeRunId ?? recipeWorkspaceParam(workspaceRecipeRunForRun(run.runId));
    const focusedArtifact = focusedArtifactForRun(run.runId);
    const artifact = shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifact)
      ? focusedArtifact
      : recipeEvidence?.artifactPath;
    return artifact ? { recipeRun: recipeTarget, artifact } : { recipeRun: recipeTarget };
  };
  const openFamilyRunDiff = (
    run: Pick<FamilyObservabilityRunSummary, 'runId' | 'diffStat' | 'slotId'>,
    routeContext = workspaceRouteContext,
  ) => {
    if (!run.diffStat.available && run.slotId) {
      router.push({
        pathname: '/workspace/slot/[slotId]/diff',
        params: {
          slotId: run.slotId,
          ...diffRouteContext(routeContext),
          ...(run.runId === selectedRun?.runId && requestedArtifactIsDiff
            ? { path: requestedArtifactPath }
            : {}),
        },
      });
      return;
    }
    router.push({
      pathname: '/workspace/run/[runId]/diff',
      params: {
        runId: run.runId,
        ...diffRouteContext(routeContext),
        recipeRun: workspaceRecipeRunForRun(run.runId),
        ...(run.runId === selectedRun?.runId && requestedArtifactIsDiff
          ? { path: requestedArtifactPath }
          : {}),
      },
    });
  };
  const openSelectedRunDiff = () => {
    if (!selectedRun) return;
    openFamilyRunDiff(selectedRun);
  };
  const priorityVisualPairs = visualPairs.length > 0 ? visualPairs : selectedRecipeVisualPairs;
  const priorityVisualPair = priorityVisualPairs[0] ?? null;
  const priorityVisualPairIsRecipe =
    visualPairs.length === 0 && selectedRecipeVisualPairs.length > 0;
  const priorityCompareRunId = priorityVisualPairIsRecipe
    ? (selectedRun?.runId ?? null)
    : (visualPairs[0]?.after.runId ?? null);
  const priorityCompareRecipeRunId = priorityVisualPairIsRecipe
    ? recipeRunIdForVisualPair(selectedRecipeRuns, priorityVisualPair)
    : DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  return {
    status: 'ready' as const,
    familyObservation,
    selectedRunObservation,
    selectedRecipeObservation,
    retryFamily,
    snapshot,
    error: error ?? null,
    client,
    insets,
    goBackOrRuns,
    workflowColor,
    familyRetrospectives,
    pendingRetrospectiveCount,
    retrospectiveRouteContext,
    openPRForRun,
    selectedActiveTaskProgress,
    selectedFallbackTaskProgress,
    readyDecision,
    reviewGateDecision,
    retroDecision,
    selectedRecipeAvailable,
    selectedDiffValue,
    requestedArtifactIsDiff,
    recipeEvidenceForRun,
    recipeCountForRun,
    recipeAvailableForRun,
    decisionRouteContextForRun,
    workspaceRecipeRunForRun,
    focusedArtifactForRun,
    focusedArtifactParamsForRun,
    recipeWorkspaceParamsForRun,
    openFamilyRunDiff,
    openSelectedRunDiff,
    priorityVisualPairs,
    priorityVisualPair,
    priorityVisualPairIsRecipe,
    priorityCompareRunId,
    priorityCompareRecipeRunId,
    gatewayUrl,
    artifactAuthHeaders,
    viewerUri,
    setViewerUri,
    documentViewer,
    setDocumentViewer,
    evidenceFilter,
    setEvidenceFilter,
    router,
    familyId,
    project,
    requestedSection,
    requestedRecipeRunId,
    requestedArtifactPath,
    workspaceRouteContext,
    selectedRun,
    selectedFullRun,
    selectedRecipeRuns,
    selectedRecipeVisualPairs,
    selectedRecipeArtifactCount,
    familyRecipeEvidence,
    visualPairs,
    evidenceGroups,
    filteredEvidenceGroups,
    evidenceCounts,
    taskProgress,
    taskProgressError,
    targetRouteContext,
    diffRouteContext,
    artifactRouteContext,
    openDocument,
    openDiffArtifact,
    openFamilyRecipeArtifact,
    openFamilyArtifactWorkspace,
    runForArtifact,
    visualViewerItems,
    viewerIndex,
    readyDecisionId: readyDecision?.id ?? null,
    reviewDecisionId: reviewGateDecision?.id ?? null,
    retroDecisionId: retroDecision?.id ?? null,
  };
}
