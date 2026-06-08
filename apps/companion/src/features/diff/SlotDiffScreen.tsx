import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
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

import { BeforeAfterPreview } from '../../components/BeforeAfterPreview';
import { MobileDiffViewer } from '../../components/MobileDiffViewer';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import {
  artifactsForRecipeRun,
  artifactUrlForEntry,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
  groupVisualArtifactPairs,
} from '../../lib/artifact-url';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import {
  type RunRefreshEvent,
  runRefreshEventMatchesSlotWorkspace,
  runRefreshEventRunId,
} from '../../lib/run-refresh';
import {
  selectSlotCompareTarget,
  selectSlotRecipeArtifactsForPreviewScope,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isSlotWorkerProgressActive,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
} from '../../lib/task-progress';
import { baseStyles } from '../../lib/theme';
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
  targetWorkspaceRouteContextParams,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { useFleetStore } from '../../store/fleet';

import { routeParamString, SlotDiffCockpit } from './components/slot-diff-panels';
import { slotDiffStyles as styles } from './styles/slot-diff.styles';

export default function SlotDiffViewerScreen() {
  const { slotId, path, workspace, decisionKind } = useLocalSearchParams<{
    slotId: string;
    path?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const slot = useFleetStore((s) => s.fleet?.slots.find((entry) => entry.slot === slotId));
  const [diffText, setDiffText] = useState('');
  const [currentRun, setCurrentRun] = useState<Run | null>(null);
  const [recipeRuns, setRecipeRuns] = useState<RecipeRunArtifactGroup[]>([]);
  const [recipeRunsLoaded, setRecipeRunsLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgressStructured | null>(null);
  const [_taskProgressError, setTaskProgressError] = useState<string | null>(null);
  const runRefreshRequestRef = useRef(0);
  const recipeRunsRefreshRequestRef = useRef(0);
  const diffRefreshRequestRef = useRef(0);

  const pathParamError = Array.isArray(path) ? 'Only one diff path can be opened at a time.' : null;
  const requestedPath = !pathParamError && typeof path === 'string' ? path.trim() : '';
  const currentRunId = slot?.currentRunId ?? null;
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        'diff',
      ),
    [decisionKind, workspace],
  );
  const slotRouteContext = useMemo(
    () => targetWorkspaceRouteContextParams('slot', workspaceRouteContext.decisionKind),
    [workspaceRouteContext.decisionKind],
  );
  const compareRouteContext = useMemo(
    () => targetWorkspaceRouteContextParams('compare', workspaceRouteContext.decisionKind),
    [workspaceRouteContext.decisionKind],
  );

  const refreshCurrentRun = useCallback(
    async (reason: string, targetRunId: string | null = currentRunId) => {
      const requestId = runRefreshRequestRef.current + 1;
      runRefreshRequestRef.current = requestId;
      if (!client || !targetRunId) {
        setCurrentRun(null);
        return;
      }

      try {
        const result = await client.request<RunGetResult>('run.get', { runId: targetRunId });
        if (runRefreshRequestRef.current !== requestId) return;
        setCurrentRun(result.run);
      } catch (err) {
        if (runRefreshRequestRef.current !== requestId) return;
        setCurrentRun(null);
        setError(
          `Failed to refresh live diff run context after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, currentRunId],
  );

  useEffect(() => {
    if (!currentRunId) {
      runRefreshRequestRef.current += 1;
      setCurrentRun(null);
      return;
    }
    void refreshCurrentRun('initial load', currentRunId);
  }, [currentRunId, refreshCurrentRun]);

  const refreshRecipeRuns = useCallback(
    async (reason: string, targetRunId: string | null = currentRunId, reset: boolean) => {
      const requestId = recipeRunsRefreshRequestRef.current + 1;
      recipeRunsRefreshRequestRef.current = requestId;
      if (!client || !targetRunId) {
        setRecipeRuns([]);
        setRecipeRunsLoaded(false);
        return;
      }
      if (reset) {
        setRecipeRuns([]);
        setRecipeRunsLoaded(false);
      }
      try {
        const result = await client.request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
          runId: targetRunId,
        });
        if (recipeRunsRefreshRequestRef.current !== requestId) return;
        setRecipeRuns(result.recipeRuns);
        setRecipeRunsLoaded(true);
      } catch (err) {
        if (recipeRunsRefreshRequestRef.current !== requestId) return;
        setRecipeRuns([]);
        setRecipeRunsLoaded(true);
        setError(
          `Failed to refresh live diff recipe context after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, currentRunId],
  );

  useEffect(() => {
    if (!currentRunId) {
      recipeRunsRefreshRequestRef.current += 1;
      setRecipeRuns([]);
      setRecipeRunsLoaded(false);
      return;
    }
    void refreshRecipeRuns('initial load', currentRunId, true);
  }, [currentRunId, refreshRecipeRuns]);

  const refreshDiff = useCallback(
    async (reason: string, reset: boolean) => {
      const requestId = diffRefreshRequestRef.current + 1;
      diffRefreshRequestRef.current = requestId;
      if (!client || !slotId || pathParamError) {
        setDiffText('');
        setLoading(false);
        return;
      }

      if (reset) setLoading(true);
      setError(null);
      try {
        const result = await client.request<GitDiffResult>(Methods.GIT_DIFF, { slotId });
        if (diffRefreshRequestRef.current !== requestId) return;
        setDiffText(result.diff);
      } catch (err) {
        if (diffRefreshRequestRef.current !== requestId) return;
        setDiffText('');
        setError(
          `Failed to refresh live workspace diff after ${reason}: ${(err as Error).message}`,
        );
      } finally {
        if (diffRefreshRequestRef.current === requestId) setLoading(false);
      }
    },
    [client, pathParamError, slotId],
  );

  useEffect(() => {
    void refreshDiff('initial load', true);
  }, [refreshDiff, requestedPath]);

  useEffect(() => {
    if (!client || !slotId) return;
    const handleRunEvent = (payload: unknown, reason: string) => {
      const event = payload as RunRefreshEvent & { run?: Run | null };
      if (
        !runRefreshEventMatchesSlotWorkspace(
          { slotId, workspaceRunId: currentRun?.id ?? currentRunId },
          event,
        )
      ) {
        return;
      }

      const eventRunId = runRefreshEventRunId(event);
      if (event.run?.slotId === slotId) {
        runRefreshRequestRef.current += 1;
        setCurrentRun(event.run);
      } else if (eventRunId === currentRun?.id || eventRunId === currentRunId) {
        void refreshCurrentRun(reason, eventRunId);
      }
      const recipeRunId = event.run?.id ?? eventRunId ?? currentRun?.id ?? currentRunId;
      void refreshRecipeRuns(reason, recipeRunId, false);
      void refreshDiff(reason, false);
    };
    const unsubscribers = [
      client.subscribe(Events.RUN_CREATED, (payload) => handleRunEvent(payload, 'run.created')),
      client.subscribe(Events.RUN_UPDATED, (payload) => handleRunEvent(payload, 'run.updated')),
      client.subscribe(Events.RUN_COMPLETED, (payload) => handleRunEvent(payload, 'run.completed')),
      client.subscribe(Events.RUN_STEP_COMPLETED, (payload) =>
        handleRunEvent(payload, 'run.step.completed'),
      ),
      client.subscribe(Events.RUN_DECISION_NEW, (payload) =>
        handleRunEvent(payload, 'run.decision.new'),
      ),
      client.subscribe(Events.RUN_DECISION_UPDATED, (payload) =>
        handleRunEvent(payload, 'run.decision.updated'),
      ),
      client.subscribe(Events.RUN_DECISION_RESOLVED, (payload) =>
        handleRunEvent(payload, 'run.decision.resolved'),
      ),
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    client,
    currentRun?.id,
    currentRunId,
    refreshCurrentRun,
    refreshDiff,
    refreshRecipeRuns,
    slotId,
  ]);

  const fetchTaskProgress = useCallback(() => {
    if (!client || !currentRun?.slotId) return Promise.resolve();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, {
        slotId: currentRun.slotId,
        runId: currentRun.id,
      })
      .then((result) => {
        setTaskProgress(result.structured ?? null);
        setTaskProgressError(null);
      })
      .catch((err: Error) => {
        setTaskProgressError(`Task progress unavailable: ${err.message}`);
      });
  }, [client, currentRun?.id, currentRun?.slotId]);

  useEffect(() => {
    if (!client || !currentRun) return;
    const unsub = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      const update = payload as TaskProgressUpdatedPayload;
      if (!shouldAcceptTaskProgressUpdate(currentRun, update)) return;
      setTaskProgress(update.progress.structured ?? null);
      setTaskProgressError(null);
    });
    return unsub;
  }, [client, currentRun]);

  useEffect(() => {
    if (!isWorkerProgressActive(currentRun)) {
      setTaskProgress(null);
      setTaskProgressError(null);
      return;
    }
    void fetchTaskProgress();
    const timer = setInterval(() => {
      void fetchTaskProgress();
    }, 10_000);
    return () => clearInterval(timer);
  }, [currentRun, fetchTaskProgress]);

  const goBackOrSlot = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace({
      pathname: '/slot/[id]',
      params: { id: slotId, ...slotRouteContext },
    });
  }, [router, slotId, slotRouteContext]);

  const primaryDecision = selectPrimaryWorkspaceDecision(currentRun);
  const readyDecision = selectReadyWorkspaceDecision(currentRun);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(currentRun);
  const retroDecision = selectRetrospectiveWorkspaceDecision(currentRun);
  const workspaceNavMeta = summarizeRunWorkspaceNavMeta(currentRun);
  const navRunId = currentRun?.id ?? currentRunId;
  const recipeArtifactCount = recipeRunsLoaded
    ? recipeRuns.reduce((count, group) => count + artifactsForRecipeRun(group).length, 0)
    : null;
  const recipeAvailable = recipeArtifactCount === null ? undefined : recipeArtifactCount > 0;
  const diffAvailable = loading ? undefined : diffText.length > 0;
  const runArtifacts = currentRun ? extractRunArtifactManifest(currentRun) : [];
  const navVisualPairs = navRunId
    ? groupVisualArtifactPairs(runArtifacts, (artifact) =>
        artifactUrlForEntry(gatewayUrl, navRunId, artifact),
      ).pairs
    : [];
  const recipeVisualPairs =
    navRunId && navVisualPairs.length === 0
      ? groupVisualArtifactPairs(
          selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
          (artifact) => artifactUrlForEntry(gatewayUrl, navRunId, artifact),
        ).pairs
      : [];
  const priorityVisualPairs = navVisualPairs.length > 0 ? navVisualPairs : recipeVisualPairs;
  const priorityVisualPair = priorityVisualPairs[0] ?? null;
  const priorityCompareRecipeRunId =
    navVisualPairs.length > 0
      ? DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : (priorityVisualPair?.after.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM);
  const compareTarget = currentRun
    ? selectSlotCompareTarget({ runArtifacts, recipeRuns, selectedRecipeRunId: null })
    : null;
  const navVisualPairCount =
    priorityVisualPairs.length > 0 ? priorityVisualPairs.length : (compareTarget?.pairCount ?? 0);
  const navCompareArtifactPath =
    priorityVisualPair?.after.path ?? compareTarget?.artifactPath ?? null;
  const navCompareRecipeRunId = priorityVisualPair
    ? priorityCompareRecipeRunId
    : navVisualPairs.length > 0
      ? DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : compareTarget?.recipeRunId;
  const activeTaskProgress = isWorkerProgressActive(currentRun)
    ? (effectiveTaskProgressForRun(currentRun, taskProgress) ?? null)
    : null;
  const fallbackTaskProgress =
    !activeTaskProgress && (isWorkerProgressActive(currentRun) || isSlotWorkerProgressActive(slot))
      ? fallbackTaskProgressSummary(currentRun, slot)
      : null;

  return (
    <SafeAreaView edges={['top', 'bottom']} style={baseStyles.container}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={goBackOrSlot}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </Pressable>
        <View style={styles.headerTitle}>
          <Text style={styles.eyebrow}>Slot diff</Text>
          <Text style={styles.title} numberOfLines={2}>
            {requestedPath || slotId}
          </Text>
          {currentRun ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {currentRun.ticketOrPr} · {currentRun.status}
            </Text>
          ) : null}
        </View>
      </View>
      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        <RunWorkspaceNav
          current="diff"
          dense
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
          familyId={currentRun?.familyId}
          project={currentRun?.project}
          prNumber={currentRun?.prNumber}
          prRepo={prRepoFromWorkspaceSource(currentRun, currentRun?.prNumber ?? null)}
          recipeRunId={navRunId ? DECISION_EVIDENCE_RECIPE_RUN_PARAM : null}
          runId={navRunId}
          slotId={slotId}
          artifactPath={requestedPath}
          recipeAvailable={recipeAvailable}
          recipeArtifactCount={recipeArtifactCount}
          diffAvailable={diffAvailable}
          artifactCount={runArtifacts.length}
          visualPairCount={navVisualPairCount}
          compareArtifactPath={navCompareArtifactPath}
          compareRecipeRunId={navCompareRecipeRunId}
        />
        <SlotDiffCockpit
          slotId={slotId}
          run={currentRun}
          currentRunId={currentRunId}
          requestedPath={requestedPath}
          recipeArtifactCount={recipeArtifactCount}
          recipeAvailable={recipeAvailable}
          comparePairCount={navVisualPairCount}
          compareArtifactPath={navCompareArtifactPath}
          compareRecipeRunId={navCompareRecipeRunId}
          compareUsesRecipe={navVisualPairs.length === 0 && Boolean(compareTarget)}
          activeTaskProgress={activeTaskProgress}
          fallbackTaskProgress={fallbackTaskProgress}
          workspaceRouteContext={workspaceRouteContext}
        />
        {priorityVisualPair && navRunId ? (
          <View style={styles.comparePreviewPanel}>
            <BeforeAfterPreview
              pair={priorityVisualPair}
              authHeaders={artifactAuthHeaders}
              onOpenArtifact={(artifactPath) =>
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: navRunId,
                    ...compareRouteContext,
                    recipeRun: priorityCompareRecipeRunId,
                    filter: artifactFilterParamForWorkspaceNav('compare'),
                    artifact: artifactPath,
                  },
                })
              }
              eyebrow={navVisualPairs.length > 0 ? 'Live run evidence' : 'Recipe evidence'}
              title="Before → after context"
              hint={`${priorityVisualPairs.length} pair${priorityVisualPairs.length === 1 ? '' : 's'}`}
              imageHeight={64}
            />
          </View>
        ) : null}
        {pathParamError || error ? (
          <Text style={styles.errorText}>{pathParamError ?? error}</Text>
        ) : null}
        {diffText ? (
          <MobileDiffViewer
            title={requestedPath ? `${requestedPath} · workspace` : 'Workspace diff'}
            diffText={diffText}
            initialPath={requestedPath}
          />
        ) : loading ? (
          <Text style={styles.emptyText}>Loading live workspace diff…</Text>
        ) : (
          <Text style={styles.emptyText}>No live workspace diff found for this slot.</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
