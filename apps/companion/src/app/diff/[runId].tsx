import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Events,
  type GitDiffResult,
  Methods,
  type RecipeRunArtifactGroup,
  type Run,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import { MobileDiffViewer } from '../../components/MobileDiffViewer';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import { TaskProgressFallbackPanel, TaskProgressPanel } from '../../components/TaskProgressPanel';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrlForEntry,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
  groupVisualArtifactPairs,
  resolveRecipeRunSelection,
  type VisualArtifactPair,
} from '../../lib/artifact-url';
import { diffArtifactCandidate, diffFocusedFilePathFromRequest } from '../../lib/diff';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { runRefreshEventMatches } from '../../lib/run-refresh';
import { selectSlotRecipeArtifactsForPreviewScope } from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
  taskProgressPercent,
} from '../../lib/task-progress';
import { baseStyles, colors, fonts, radii, spacing } from '../../lib/theme';
import {
  selectPrimaryWorkspaceDecision,
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
  workspaceDecisionKind,
} from '../../lib/workspace-decisions';
import { summarizeRunWorkspaceNavMeta } from '../../lib/workspace-nav-meta';
import {
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForDiffContext,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceRouteContextParams,
  type WorkspaceRouteContext,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { useRunStore } from '../../store/runs';

export default function DiffViewerScreen() {
  const { runId, path, recipeRun, workspace, decisionKind } = useLocalSearchParams<{
    runId: string;
    path?: string;
    recipeRun?: string;
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const storeRun = useRunStore((s) => s.runs.find((r) => r.id === runId));
  const [run, setRun] = useState<Run | null>(storeRun ?? null);
  const [recipeRuns, setRecipeRuns] = useState<RecipeRunArtifactGroup[]>([]);
  const [recipeRunsLoaded, setRecipeRunsLoaded] = useState(false);
  const [selectedRecipeRunId, setSelectedRecipeRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceDiffText, setWorkspaceDiffText] = useState('');
  const [workspaceDiffError, setWorkspaceDiffError] = useState<string | null>(null);
  const [workspaceDiffLoading, setWorkspaceDiffLoading] = useState(false);
  const [taskProgress, setTaskProgress] = useState<TaskProgressStructured | null>(null);
  const [taskProgressError, setTaskProgressError] = useState<string | null>(null);
  const runRefreshRequestRef = useRef(0);
  const recipeRunRefreshRequestRef = useRef(0);
  const requestedRecipeRunId = typeof recipeRun === 'string' ? recipeRun : null;
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        'diff',
      ),
    [decisionKind, workspace],
  );
  const refreshRun = useCallback(
    async (reason: string) => {
      if (!client || !runId) return;
      const requestId = runRefreshRequestRef.current + 1;
      runRefreshRequestRef.current = requestId;
      try {
        const result = await client.request<RunGetResult>('run.get', { runId });
        if (runRefreshRequestRef.current !== requestId) return;
        setRun(result.run);
        setError(null);
      } catch (err) {
        if (runRefreshRequestRef.current !== requestId) return;
        setError(`Failed to refresh run diff after ${reason}: ${(err as Error).message}`);
      }
    },
    [client, runId],
  );

  useEffect(() => {
    void refreshRun('initial load');
  }, [refreshRun]);

  useEffect(() => {
    if (storeRun?.id === runId) setRun(storeRun);
  }, [runId, storeRun]);

  const refreshRecipeRuns = useCallback(
    async (reason: string, reset: boolean) => {
      const requestId = recipeRunRefreshRequestRef.current + 1;
      recipeRunRefreshRequestRef.current = requestId;
      if (!client || !runId) {
        setRecipeRuns([]);
        setRecipeRunsLoaded(false);
        setSelectedRecipeRunId(null);
        return;
      }
      if (reset) setRecipeRunsLoaded(false);
      try {
        const result = await client.request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
          runId,
        });
        if (recipeRunRefreshRequestRef.current !== requestId) return;
        setRecipeRuns(result.recipeRuns);
        if (requestedRecipeRunId && requestedRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM) {
          setSelectedRecipeRunId(
            resolveRecipeRunSelection(
              result.recipeRuns,
              requestedRecipeRunId,
              result.selectedRecipeRunId,
            ),
          );
        } else {
          setSelectedRecipeRunId(null);
        }
        setRecipeRunsLoaded(true);
      } catch (err) {
        if (recipeRunRefreshRequestRef.current !== requestId) return;
        setRecipeRunsLoaded(true);
        setError(
          `Failed to refresh recipe diff context after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, requestedRecipeRunId, runId],
  );

  useEffect(() => {
    if (!client || !runId) return;
    const maybeRefreshRun = (payload: unknown, reason: string) => {
      if (!runRefreshEventMatches(runId, payload as { run?: Run; runId?: string })) return;
      const eventRun = (payload as { run?: Run }).run;
      if (eventRun?.id === runId) {
        runRefreshRequestRef.current += 1;
        setRun(eventRun);
        setError(null);
      } else {
        void refreshRun(reason);
      }
      void refreshRecipeRuns(reason, false);
    };
    const unsubscribers = [
      client.subscribe(Events.RUN_UPDATED, (payload) => maybeRefreshRun(payload, 'run.updated')),
      client.subscribe(Events.RUN_COMPLETED, (payload) =>
        maybeRefreshRun(payload, 'run.completed'),
      ),
      client.subscribe(Events.RUN_STEP_COMPLETED, (payload) =>
        maybeRefreshRun(payload, 'run.step.completed'),
      ),
      client.subscribe(Events.RUN_DECISION_NEW, (payload) =>
        maybeRefreshRun(payload, 'run.decision.new'),
      ),
      client.subscribe(Events.RUN_DECISION_UPDATED, (payload) =>
        maybeRefreshRun(payload, 'run.decision.updated'),
      ),
      client.subscribe(Events.RUN_DECISION_RESOLVED, (payload) =>
        maybeRefreshRun(payload, 'run.decision.resolved'),
      ),
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [client, refreshRecipeRuns, refreshRun, runId]);

  useEffect(() => {
    if (!client || !runId) return;
    const timer = setInterval(() => {
      void refreshRun('poll');
    }, 30_000);
    return () => clearInterval(timer);
  }, [client, refreshRun, runId]);

  useEffect(() => {
    void refreshRecipeRuns('initial load', true);
  }, [refreshRecipeRuns]);

  const selectedRecipeRun = useMemo(
    () => recipeRuns.find((group) => group.id === selectedRecipeRunId) ?? null,
    [recipeRuns, selectedRecipeRunId],
  );
  const workspaceRecipeRunId = selectedRecipeRunId ?? requestedRecipeRunId;
  const manifest = useMemo(() => {
    if (selectedRecipeRun) return artifactsForRecipeRun(selectedRecipeRun);
    return run ? extractRunArtifactManifest(run) : [];
  }, [run, selectedRecipeRun]);
  const visualPairSummary = useMemo(
    () =>
      groupVisualArtifactPairs(manifest, (artifact) =>
        artifactUrlForEntry(gatewayUrl, runId, artifact),
      ),
    [gatewayUrl, manifest, runId],
  );
  const recipeFallbackPairSummary = useMemo(() => {
    if (selectedRecipeRun || visualPairSummary.pairs.length > 0) {
      return { pairs: [], singles: [] };
    }
    return groupVisualArtifactPairs(
      selectSlotRecipeArtifactsForPreviewScope(recipeRuns, selectedRecipeRunId),
      (artifact) => artifactUrlForEntry(gatewayUrl, runId, artifact),
    );
  }, [
    gatewayUrl,
    recipeRuns,
    runId,
    selectedRecipeRun,
    selectedRecipeRunId,
    visualPairSummary.pairs.length,
  ]);
  const priorityVisualPairs =
    visualPairSummary.pairs.length > 0 ? visualPairSummary.pairs : recipeFallbackPairSummary.pairs;
  const priorityVisualPair = priorityVisualPairs[0] ?? null;
  const priorityCompareRecipeRunId =
    visualPairSummary.pairs.length > 0
      ? workspaceRecipeRunId
      : recipeRunIdForVisualPair(recipeRuns, priorityVisualPair, selectedRecipeRunId);
  const pathParamError = Array.isArray(path) ? 'Only one diff path can be opened at a time.' : null;
  const requestedDiffPath = !pathParamError && typeof path === 'string' ? path.trim() : '';
  const requestedPathIsDiffArtifact = shouldPreserveArtifactForDiffContext(requestedDiffPath);
  const requestedDiffArtifact = requestedPathIsDiffArtifact
    ? manifest.find((artifact) => artifact.path === requestedDiffPath)
    : undefined;
  const inferredDiffArtifact = requestedPathIsDiffArtifact
    ? undefined
    : diffArtifactCandidate(manifest);
  const diffArtifact: ArtifactManifestEntry | undefined =
    requestedDiffArtifact ??
    (inferredDiffArtifact
      ? { ...inferredDiffArtifact, purpose: inferredDiffArtifact.purpose ?? 'diff' }
      : undefined);
  const diffArtifactPath = requestedPathIsDiffArtifact
    ? requestedDiffPath
    : (diffArtifact?.path ?? '');
  const focusedFilePath = diffFocusedFilePathFromRequest(requestedDiffPath, manifest);
  const recipeRunUrlParam =
    selectedRecipeRun && selectedRecipeRun.groupKind !== CURRENT_ARTIFACTS_RECIPE_RUN_PARAM
      ? selectedRecipeRun.id
      : null;
  const diffUrl =
    runId && diffArtifactPath
      ? artifactUrlForEntry(
          gatewayUrl,
          runId,
          diffArtifact ?? {
            path: diffArtifactPath,
            purpose: 'diff',
            ...(recipeRunUrlParam ? { recipeRunId: recipeRunUrlParam } : {}),
          },
        )
      : null;
  const canLoadWorkspaceDiff = Boolean(!selectedRecipeRun && run?.slotId && !diffUrl);
  const workspaceDiffSource = canLoadWorkspaceDiff && workspaceDiffText ? workspaceDiffText : '';
  const recipeArtifactCount = recipeRunsLoaded
    ? recipeRuns.reduce((count, group) => count + artifactsForRecipeRun(group).length, 0)
    : null;
  const recipeAvailable = recipeArtifactCount === null ? undefined : recipeArtifactCount > 0;
  const runArtifactCount = run ? extractRunArtifactManifest(run).length : manifest.length;
  const diffAvailable = Boolean(diffArtifactPath || canLoadWorkspaceDiff || workspaceDiffSource);
  const primaryDecision = selectPrimaryWorkspaceDecision(run);
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const workspaceNavMeta = summarizeRunWorkspaceNavMeta(run);
  const activeTaskProgress = isWorkerProgressActive(run)
    ? (effectiveTaskProgressForRun(run, taskProgress) ?? null)
    : null;
  const fallbackTaskProgress =
    !activeTaskProgress && isWorkerProgressActive(run) ? fallbackTaskProgressSummary(run) : null;

  const fetchTaskProgress = useCallback(() => {
    if (!client || !run?.slotId) return Promise.resolve();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, {
        slotId: run.slotId,
        runId: run.id,
      })
      .then((result) => {
        setTaskProgress(result.structured ?? null);
        setTaskProgressError(null);
      })
      .catch((err: Error) => {
        setTaskProgressError(`Task progress unavailable: ${err.message}`);
      });
  }, [client, run?.id, run?.slotId]);

  useEffect(() => {
    if (!client || !run) return;
    const unsub = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      const update = payload as TaskProgressUpdatedPayload;
      if (!shouldAcceptTaskProgressUpdate(run, update)) return;
      setTaskProgress(update.progress.structured ?? null);
      setTaskProgressError(null);
    });
    return unsub;
  }, [client, run]);

  useEffect(() => {
    if (!isWorkerProgressActive(run)) {
      setTaskProgress(null);
      setTaskProgressError(null);
      return;
    }
    void fetchTaskProgress();
    const timer = setInterval(() => {
      void fetchTaskProgress();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTaskProgress, run]);

  useEffect(() => {
    if (!client || !run?.slotId || !canLoadWorkspaceDiff) {
      setWorkspaceDiffText('');
      setWorkspaceDiffError(null);
      setWorkspaceDiffLoading(false);
      return;
    }

    let disposed = false;
    setWorkspaceDiffLoading(true);
    setWorkspaceDiffError(null);
    client
      .request<GitDiffResult>(Methods.GIT_DIFF, {
        slotId: run.slotId,
      })
      .then((result) => {
        if (disposed) return;
        setWorkspaceDiffText(result.diff);
      })
      .catch((err: Error) => {
        if (disposed) return;
        setWorkspaceDiffText('');
        setWorkspaceDiffError(`Failed to load live workspace diff: ${err.message}`);
      })
      .finally(() => {
        if (!disposed) setWorkspaceDiffLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [canLoadWorkspaceDiff, client, requestedDiffPath, run?.slotId]);

  const goBackOrRuns = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)/runs');
  }, [router]);

  return (
    <SafeAreaView edges={['top', 'bottom']} style={baseStyles.container}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={goBackOrRuns}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </Pressable>
        <View style={styles.headerTitle}>
          <Text style={styles.eyebrow}>Run diff</Text>
          <Text style={styles.title} numberOfLines={2}>
            {focusedFilePath || diffArtifactPath || run?.ticketOrPr || runId}
          </Text>
          {selectedRecipeRun ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {selectedRecipeRun.label} · {selectedRecipeRun.status}
            </Text>
          ) : null}
        </View>
      </View>
      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        <RunWorkspaceNav
          dense
          current="diff"
          routeWorkspace={workspaceRouteContext.workspace}
          routeDecisionKind={workspaceRouteContext.decisionKind}
          decisionId={primaryDecision?.id ?? null}
          decisionKind={workspaceDecisionKind(primaryDecision)}
          readyDecisionId={readyDecision?.id ?? null}
          reviewDecisionId={reviewGateDecision?.id ?? null}
          retroDecisionId={retroDecision?.id ?? null}
          readyMeta={workspaceNavMeta.readyMeta}
          reviewMeta={workspaceNavMeta.reviewMeta}
          retroMeta={workspaceNavMeta.retroMeta}
          familyId={run?.familyId}
          project={run?.project}
          prNumber={run?.prNumber}
          prRepo={prRepoFromWorkspaceSource(run, run?.prNumber ?? null)}
          recipeRunId={workspaceRecipeRunId}
          artifactPath={diffArtifactPath}
          slotId={run?.slotId}
          runId={runId}
          recipeAvailable={recipeAvailable}
          recipeArtifactCount={recipeArtifactCount}
          diffAvailable={diffAvailable}
          artifactCount={runArtifactCount}
          visualPairCount={priorityVisualPairs.length}
          compareArtifactPath={priorityVisualPair?.after.path ?? null}
          compareRecipeRunId={priorityCompareRecipeRunId}
        />
        <DiffWorkspaceCockpit
          run={run}
          runId={runId}
          diffPath={diffArtifactPath}
          focusedFilePath={focusedFilePath}
          manifestCount={manifest.length}
          visualPairCount={priorityVisualPairs.length}
          compareArtifactPath={priorityVisualPair?.after.path ?? null}
          recipeRunId={workspaceRecipeRunId}
          compareRecipeRunId={priorityCompareRecipeRunId}
          recipeLabel={selectedRecipeRun?.label}
          readyDecisionId={readyDecision?.id ?? null}
          reviewDecisionId={reviewGateDecision?.id ?? null}
          retroDecisionId={retroDecision?.id ?? null}
          diffSource={diffUrl ? 'artifact' : canLoadWorkspaceDiff ? 'live workspace' : 'missing'}
          activeTaskProgress={activeTaskProgress}
          fallbackTaskProgress={fallbackTaskProgress}
          workspaceRouteContext={workspaceRouteContext}
        />
        {activeTaskProgress ? (
          <View style={styles.progressPanel}>
            <TaskProgressPanel
              run={run}
              progress={activeTaskProgress}
              error={taskProgressError}
              compact
            />
          </View>
        ) : fallbackTaskProgress ? (
          <View style={styles.progressPanel}>
            <TaskProgressFallbackPanel
              summary={fallbackTaskProgress}
              error={taskProgressError}
              compact
            />
          </View>
        ) : null}
        {pathParamError || error ? (
          <Text style={styles.errorText}>{pathParamError ?? error}</Text>
        ) : null}
        {diffUrl ? (
          <MobileDiffViewer
            title={diffArtifactPath.split('/').pop() ?? 'Diff'}
            diffUrl={diffUrl}
            initialPath={focusedFilePath}
            fetchHeaders={artifactAuthHeaders}
          />
        ) : workspaceDiffSource ? (
          <MobileDiffViewer
            title={focusedFilePath ? `${focusedFilePath} · workspace` : 'Workspace diff'}
            diffText={workspaceDiffSource}
            initialPath={focusedFilePath}
          />
        ) : workspaceDiffLoading ? (
          <Text style={styles.emptyText}>Loading live workspace diff…</Text>
        ) : workspaceDiffError ? (
          <Text style={styles.errorText}>{workspaceDiffError}</Text>
        ) : (
          <Text style={styles.emptyText}>
            No diff artifact or live workspace diff found for{' '}
            {selectedRecipeRun ? 'this recipe run.' : 'this run.'}
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function DiffWorkspaceCockpit({
  run,
  runId,
  diffPath,
  focusedFilePath,
  manifestCount,
  visualPairCount,
  compareArtifactPath,
  recipeRunId,
  compareRecipeRunId,
  recipeLabel,
  readyDecisionId,
  reviewDecisionId,
  retroDecisionId,
  diffSource,
  activeTaskProgress,
  fallbackTaskProgress,
  workspaceRouteContext,
}: {
  run: Run | null;
  runId: string;
  diffPath: string;
  focusedFilePath: string;
  manifestCount: number;
  visualPairCount: number;
  compareArtifactPath: string | null;
  recipeRunId?: string | null;
  compareRecipeRunId?: string | null;
  recipeLabel?: string;
  readyDecisionId: string | null;
  reviewDecisionId: string | null;
  retroDecisionId: string | null;
  diffSource: 'artifact' | 'live workspace' | 'missing';
  activeTaskProgress: TaskProgressStructured | null;
  fallbackTaskProgress: ReturnType<typeof fallbackTaskProgressSummary> | null;
  workspaceRouteContext: WorkspaceRouteContext;
}) {
  const router = useRouter();
  const diffRouteContext = targetWorkspaceRouteContextParams(
    'diff',
    workspaceRouteContext.decisionKind,
  );
  const compareRouteContext = targetWorkspaceRouteContextParams(
    'compare',
    workspaceRouteContext.decisionKind,
  );
  const recipeRouteContext = targetWorkspaceRouteContextParams(
    'recipe',
    workspaceRouteContext.decisionKind,
  );
  const slotRouteContext = targetWorkspaceRouteContextParams(
    'slot',
    workspaceRouteContext.decisionKind,
  );
  const runRouteContext = targetWorkspaceRouteContextParams(
    'run',
    workspaceRouteContext.decisionKind,
  );
  const terminalRouteContext = targetWorkspaceRouteContextParams(
    'terminal',
    workspaceRouteContext.decisionKind,
  );
  const prRouteContext = targetWorkspaceRouteContextParams(
    'pr',
    workspaceRouteContext.decisionKind,
  );
  const contextLabel =
    recipeLabel ??
    (recipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
      ? 'decision evidence'
      : (recipeRunId ?? 'run evidence'));
  const progressValue = activeTaskProgress
    ? `${Math.round(taskProgressPercent(activeTaskProgress))}%`
    : fallbackTaskProgress?.percent != null
      ? `${Math.round(fallbackTaskProgress.percent)}%`
      : fallbackTaskProgress
        ? 'live'
        : '-';
  const artifactParams = {
    runId,
    ...diffRouteContext,
    ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
    filter: artifactFilterParamForWorkspaceNav('diff'),
    ...(diffPath ? { artifact: diffPath } : {}),
  };
  const openArtifacts = () =>
    router.push({
      pathname: '/artifacts/[runId]',
      params: artifactParams,
    });
  const openCompareArtifacts = () =>
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId,
        ...compareRouteContext,
        ...(compareRecipeRunId ? { recipeRun: compareRecipeRunId } : {}),
        filter: artifactFilterParamForWorkspaceNav('compare'),
        ...(compareArtifactPath ? { artifact: compareArtifactPath } : {}),
      },
    });
  const openRecipe = () => {
    const recipeTarget = recipeWorkspaceParam(recipeRunId);
    router.push({
      pathname: '/artifacts/[runId]',
      params: {
        runId,
        ...recipeRouteContext,
        recipeRun: recipeTarget,
        filter: artifactFilterParamForWorkspaceNav('recipe'),
        ...(shouldPreserveArtifactForRecipeContext(recipeTarget, diffPath)
          ? { artifact: diffPath }
          : {}),
      },
    });
  };
  const openSlot = () => {
    if (!run?.slotId) return;
    router.push({
      pathname: '/slot/[id]',
      params: {
        id: run.slotId,
        ...slotRouteContext,
        runId,
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(diffPath ? { artifact: diffPath } : {}),
      },
    });
  };
  const openFamily = () => {
    if (!run?.familyId) return;
    router.push({
      pathname: '/family/[familyId]',
      params: {
        familyId: run.familyId,
        project: run.project,
        ...familySectionRouteContextParams('ledger', workspaceRouteContext.decisionKind),
        runId,
        section: 'ledger',
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(diffPath ? { artifact: diffPath } : {}),
      },
    });
  };
  const openFamilyRetros = () => {
    if (!run?.familyId) return;
    router.push({
      pathname: '/family/[familyId]',
      params: {
        familyId: run.familyId,
        project: run.project,
        ...familySectionRouteContextParams('retros', workspaceRouteContext.decisionKind),
        runId,
        section: 'retros',
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(diffPath ? { artifact: diffPath } : {}),
      },
    });
  };
  const openRun = () =>
    router.push({
      pathname: '/run/[id]',
      params: {
        id: runId,
        ...runRouteContext,
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(diffPath ? { artifact: diffPath } : {}),
      },
    });
  const openPR = () => {
    if (!run?.prNumber) return;
    const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
    router.push({
      pathname: '/(tabs)/prs',
      params: {
        pr: String(run.prNumber),
        ...prRouteContext,
        ...(prRepo ? { repo: prRepo } : {}),
      },
    });
  };
  const openDecision = (decisionId: string | null) => {
    if (!decisionId) return;
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...decisionWorkspaceRouteParams(
          decisionId === readyDecisionId
            ? 'ready'
            : decisionId === retroDecisionId
              ? 'retrospective'
              : 'review',
        ),
        runId,
        ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
        ...(diffPath ? { artifact: diffPath } : {}),
      },
    });
  };

  return (
    <View style={styles.cockpitPanel}>
      <View style={styles.cockpitHeader}>
        <View style={styles.cockpitTitleBlock}>
          <Text style={styles.cockpitTitle}>Diff cockpit</Text>
          <Text style={styles.cockpitMeta} numberOfLines={1}>
            {contextLabel} · {diffSource}
          </Text>
        </View>
        <Pressable
          style={[styles.cockpitPill, !run?.slotId && styles.cockpitDisabled]}
          disabled={!run?.slotId}
          onPress={() => {
            if (!run?.slotId) return;
            router.push({
              pathname: '/terminal/[slotId]',
              params: {
                slotId: run.slotId,
                ...terminalRouteContext,
                runId,
                details: '1',
                ...(recipeRunId ? { recipeRun: recipeRunId } : {}),
                ...(diffPath ? { artifact: diffPath } : {}),
              },
            });
          }}
        >
          <Text style={styles.cockpitPillText}>Terminal</Text>
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.cockpitRail}
      >
        <DiffCockpitTile label="Source" value={diffSource} />
        <DiffCockpitTile label="Diff files" value={String(manifestCount)} onPress={openArtifacts} />
        <DiffCockpitTile
          label="Before→After"
          value={
            visualPairCount > 0
              ? `${visualPairCount} delta${visualPairCount === 1 ? '' : 's'}`
              : 'none'
          }
          onPress={openCompareArtifacts}
          disabled={visualPairCount === 0}
        />
        <DiffCockpitTile label="File" value={focusedFilePath || 'all'} />
        <DiffCockpitTile
          label="Ready gate"
          value={readyDecisionId ? 'available' : '-'}
          onPress={() => openDecision(readyDecisionId)}
          disabled={!readyDecisionId}
        />
        <DiffCockpitTile
          label="Review gate"
          value={reviewDecisionId ? 'available' : '-'}
          onPress={() => openDecision(reviewDecisionId)}
          disabled={!reviewDecisionId}
        />
        <DiffCockpitTile
          label="Retro gate"
          value={retroDecisionId ? 'available' : '-'}
          onPress={() => openDecision(retroDecisionId)}
          disabled={!retroDecisionId}
        />
        <DiffCockpitTile
          label="Progress"
          value={progressValue}
          disabled={!activeTaskProgress && !fallbackTaskProgress}
        />
        <DiffCockpitTile
          label="PR"
          value={run?.prNumber ? `#${run.prNumber}` : '-'}
          onPress={openPR}
          disabled={!run?.prNumber}
        />
        <DiffCockpitTile label="Path" value={diffPath || 'workspace'} />
        <DiffCockpitTile
          label="Slot"
          value={run?.slotId ?? '-'}
          onPress={openSlot}
          disabled={!run?.slotId}
        />
        <DiffCockpitTile
          label="Recipe files"
          value={recipeWorkspaceScopeLabel(recipeRunId)}
          onPress={openRecipe}
        />
        <DiffCockpitTile
          label="Family"
          value={shortId(run?.familyId)}
          onPress={openFamily}
          disabled={!run?.familyId}
        />
        <DiffCockpitTile
          label="Family retros"
          value={run?.familyId ? 'open' : '-'}
          onPress={openFamilyRetros}
          disabled={!run?.familyId}
        />
        <DiffCockpitTile label="Run" value={shortId(runId)} onPress={openRun} />
      </ScrollView>
    </View>
  );
}

function DiffCockpitTile({
  label,
  value,
  onPress,
  disabled,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <Text style={styles.cockpitTileLabel}>{label}</Text>
      <Text style={styles.cockpitTileValue} numberOfLines={1}>
        {value}
      </Text>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        style={[styles.cockpitTile, disabled && styles.cockpitDisabled]}
        onPress={onPress}
        disabled={disabled}
      >
        {content}
      </Pressable>
    );
  }

  return <View style={styles.cockpitTile}>{content}</View>;
}

function shortId(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length > 10 ? `${value.slice(0, 8)}…` : value;
}

function routeParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function recipeRunIdForVisualPair(
  recipeRuns: RecipeRunArtifactGroup[],
  pair: VisualArtifactPair | null,
  selectedRecipeRunId: string | null,
): string {
  if (!pair) return selectedRecipeRunId ?? recipeRuns[0]?.id ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM;
  const directRecipeRunId = pair.after.recipeRunId ?? pair.before.recipeRunId;
  if (directRecipeRunId) return directRecipeRunId;
  const sourceGroup = recipeRuns.find((group) => {
    const artifacts = artifactsForRecipeRun(group);
    return artifacts.some(
      (artifact) => artifact.path === pair.before.path || artifact.path === pair.after.path,
    );
  });
  return (
    sourceGroup?.id ??
    selectedRecipeRunId ??
    recipeRuns[0]?.id ??
    CURRENT_ARTIFACTS_RECIPE_RUN_PARAM
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgCard,
  },
  backButton: {
    paddingVertical: spacing.xs,
  },
  backButtonText: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '900',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  progressPanel: {
    marginBottom: spacing.lg,
  },
  cockpitPanel: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '33',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.lg,
    padding: spacing.sm,
  },
  cockpitHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  cockpitTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  cockpitTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  cockpitMeta: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  cockpitPill: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '66',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  cockpitPillText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  cockpitRail: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  cockpitTile: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 112,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  cockpitTileLabel: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  cockpitTileValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  cockpitDisabled: {
    opacity: 0.45,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: fonts.sizeSm,
  },
  errorText: {
    color: colors.statusFail,
    fontSize: fonts.sizeSm,
    marginBottom: spacing.md,
  },
});
