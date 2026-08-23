import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Events,
  isTerminalRunStatus,
  Methods,
  type RecipeRunArtifactGroup,
  type Run,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type RunReplayStepResult,
  type RunStep,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import { RunPipelineFull } from '../../components/RunPipeline';
import { TaskProgressFallbackPanel, TaskProgressPanel } from '../../components/TaskProgressPanel';
import {
  artifactsForRecipeRun,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
  resolveRecipeRunSelection,
} from '../../lib/artifact-url';
import { diffArtifactCandidate } from '../../lib/diff';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { isGatewayBackgroundPauseError } from '../../lib/recoverable-errors';
import { runRefreshEventMatches } from '../../lib/run-refresh';
import {
  runWorkspaceDiffValue,
  selectSlotCompareTarget,
  summarizeSlotWorkspaceGates,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
} from '../../lib/task-progress';
import { baseStyles, colors, spacing } from '../../lib/theme';
import { buildFailedStepDiagnosticDraft } from '../../lib/workspace-copilot';
import { workspaceDecisionKind } from '../../lib/workspace-decisions';
import {
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceForArtifactRoute,
  targetWorkspaceRouteContextParams,
  workspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { useRunStore } from '../../store/runs';
import { formatDuration } from '../workspace-shared/format';
import { useReviewPackageTab } from '../workspace-shared/review-package-tabs';

import { InteractiveOperatorPacketsPanel } from './components/InteractiveOperatorPacketsPanel';
import {
  decisionPresentationForRun,
  DecisionSummaryCard,
  MetricItem,
  PipelineStepCard,
  routeParamString,
  RunFocusedArtifactCard,
  RunReviewWorkspaceSummary,
} from './components/run-detail-panels';
import { runDetailStyles as styles } from './styles/run-detail.styles';

const STATUS_COLORS: Record<string, string> = {
  done: colors.statusOk,
  failed: colors.statusFail,
  cancelled: colors.statusWarn,
  monitoring: colors.lifecycleWorking,
  preparing: colors.lifecycleDispatching,
  dispatching: colors.lifecycleDispatching,
  'writing-task': colors.accent,
  grading: colors.accent,
  'slot-finding': colors.accent,
  paused: colors.statusWarn,
};

export default function RunDetailScreen() {
  const { id, runId, recipeRun, artifact, workspace, decisionKind } = useLocalSearchParams<{
    id?: string | string[];
    runId?: string | string[];
    recipeRun?: string | string[];
    artifact?: string | string[];
    workspace?: string | string[];
    decisionKind?: string | string[];
  }>();
  const resolvedRunId = routeParamString(id) || routeParamString(runId);
  const reviewPackageTab = useReviewPackageTab();
  const isTimelineTab = reviewPackageTab === 'timeline';
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const connectionStatus = useConnectionStore((s) => s.status);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const storeRun = useRunStore((s) => s.runs.find((r) => r.id === resolvedRunId));
  const upsertRun = useRunStore((s) => s.upsertRun);
  const [run, setRun] = useState<Run | null>(storeRun ?? null);
  const [recipeRuns, setRecipeRuns] = useState<RecipeRunArtifactGroup[]>([]);
  const [recipeRunsLoaded, setRecipeRunsLoaded] = useState(false);
  const [selectedRecipeRunId, setSelectedRecipeRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgressStructured | null>(null);
  const [taskProgressError, setTaskProgressError] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [replayingStepName, setReplayingStepName] = useState<string | null>(null);
  const recipeRunsRequestRef = useRef(0);

  const requestedRecipeRunId = Array.isArray(recipeRun)
    ? (recipeRun[0] ?? null)
    : (recipeRun ?? null);
  const requestedRecipeRunIdRef = useRef<string | null>(requestedRecipeRunId);
  const requestedArtifactPath = Array.isArray(artifact) ? (artifact[0] ?? '') : (artifact ?? '');
  const workspaceRouteContext = useMemo(
    () =>
      workspaceRouteContextParams(
        routeParamString(workspace),
        routeParamString(decisionKind),
        'run',
      ),
    [decisionKind, workspace],
  );
  const diffRouteContext = useMemo(
    () => targetWorkspaceRouteContextParams('diff', workspaceRouteContext.decisionKind),
    [workspaceRouteContext.decisionKind],
  );
  const targetRouteContext = useCallback(
    (targetWorkspace: Parameters<typeof targetWorkspaceRouteContextParams>[0]) =>
      targetWorkspaceRouteContextParams(targetWorkspace, workspaceRouteContext.decisionKind),
    [workspaceRouteContext.decisionKind],
  );

  useEffect(() => {
    requestedRecipeRunIdRef.current = requestedRecipeRunId;
  }, [requestedRecipeRunId]);

  const loadRecipeRuns = useCallback(
    (selectionHint: string | null) => {
      const requestId = recipeRunsRequestRef.current + 1;
      recipeRunsRequestRef.current = requestId;
      if (!client || !resolvedRunId) {
        setRecipeRunsLoaded(false);
        return Promise.resolve();
      }
      setRecipeRunsLoaded(false);
      return client
        .request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', { runId: resolvedRunId })
        .then((result) => {
          if (recipeRunsRequestRef.current !== requestId) return;
          setRecipeRuns(result.recipeRuns);
          setSelectedRecipeRunId(
            selectionHint === DECISION_EVIDENCE_RECIPE_RUN_PARAM
              ? null
              : resolveRecipeRunSelection(
                  result.recipeRuns,
                  selectionHint,
                  result.selectedRecipeRunId,
                ),
          );
        })
        .catch((err: Error) => {
          if (recipeRunsRequestRef.current !== requestId) return;
          throw err;
        })
        .finally(() => {
          if (recipeRunsRequestRef.current === requestId) setRecipeRunsLoaded(true);
        });
    },
    [client, resolvedRunId],
  );

  const loadRun = useCallback(() => {
    if (!client || !resolvedRunId) return Promise.resolve();
    setError(null);
    return client
      .request<RunGetResult>('run.get', { runId: resolvedRunId })
      .then((r) => setRun(r.run))
      .catch((err: Error) => {
        if (isGatewayBackgroundPauseError(err)) {
          // Android route screenshots and app transitions can briefly pause the
          // gateway while cached run data is still usable; keep review visible.
          console.warn(`Run refresh paused: ${err.message}`);
          return;
        }
        setError(`Failed to load run: ${err.message}`);
      });
  }, [client, resolvedRunId]);

  useEffect(() => {
    void loadRun();
  }, [loadRun]);

  const noteRecipeRunsUnavailable = useCallback((err: Error) => {
    if (isGatewayBackgroundPauseError(err)) {
      // Recipe artifacts are secondary context; route changes/background pauses can
      // race the refresh without blocking the primary evidence/diff/terminal review.
      console.warn(`Recipe runs unavailable: ${err.message}`);
      return;
    }
    setError(`Failed to load recipe runs: ${err.message}`);
  }, []);

  useEffect(() => {
    loadRecipeRuns(requestedRecipeRunId).catch(noteRecipeRunsUnavailable);
  }, [loadRecipeRuns, noteRecipeRunsUnavailable, requestedRecipeRunId]);

  useEffect(() => {
    if (!client || !resolvedRunId) return;
    const handleRunEvent = (payload: unknown, _reason: string) => {
      const event = payload as { run?: Run; runId?: string };
      if (!runRefreshEventMatches(resolvedRunId, event)) return;
      if (event.run?.id === resolvedRunId) {
        setRun(event.run);
        upsertRun(event.run);
      } else {
        void loadRun();
      }
      loadRecipeRuns(requestedRecipeRunIdRef.current).catch(noteRecipeRunsUnavailable);
    };
    const unsubscribers = [
      client.subscribe(Events.RUN_UPDATED, (payload) => handleRunEvent(payload, 'run.updated')),
      client.subscribe(Events.RUN_COMPLETED, (payload) => handleRunEvent(payload, 'run.completed')),
      client.subscribe(Events.RUN_STEP_COMPLETED, (payload) =>
        handleRunEvent(payload, 'run.step.completed'),
      ),
      client.subscribe(Events.RUN_DECISION_NEW, (payload) =>
        handleRunEvent(payload, 'run.decision.new'),
      ),
      client.subscribe(Events.RUN_DECISION_RESOLVED, (payload) =>
        handleRunEvent(payload, 'run.decision.resolved'),
      ),
      client.subscribe(Events.RUN_DECISION_UPDATED, (payload) =>
        handleRunEvent(payload, 'run.decision.updated'),
      ),
    ];
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [client, loadRecipeRuns, loadRun, resolvedRunId, upsertRun]);

  const fetchTaskProgress = useCallback(() => {
    if (!client || !run?.slotId) return Promise.resolve();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, { slotId: run.slotId, runId: run.id })
      .then((result) => {
        setTaskProgress(result.structured ?? null);
        setTaskProgressError(null);
      })
      .catch((err: Error) => {
        setTaskProgressError(`Task progress unavailable: ${err.message}`);
      });
  }, [client, run?.id, run?.slotId]);

  useEffect(() => {
    if (!isTimelineTab || !client || !run) return;
    const unsub = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      const update = payload as TaskProgressUpdatedPayload;
      if (!shouldAcceptTaskProgressUpdate(run, update)) return;
      setTaskProgress(update.progress.structured ?? null);
      setTaskProgressError(null);
    });
    return unsub;
  }, [client, isTimelineTab, run]);

  useEffect(() => {
    if (!isTimelineTab || !isWorkerProgressActive(run)) {
      setTaskProgress(null);
      setTaskProgressError(null);
      return;
    }
    void fetchTaskProgress();
    const timer = setInterval(() => {
      void fetchTaskProgress();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTaskProgress, isTimelineTab, run]);

  const goBackOrRuns = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)/runs');
  }, [router]);

  const replayStep = useCallback(
    async (stepName: string, skipPrepare?: boolean) => {
      if (!client || !run) return;
      setReplayingStepName(stepName);
      setError(null);
      try {
        const result = await client.request<RunReplayStepResult>(Methods.RUN_REPLAY_STEP, {
          runId: run.id,
          stepName,
          ...(skipPrepare ? { skipPrepare: true } : {}),
        });
        setRun(result.run);
        upsertRun(result.run);
        setExpandedStep(null);
      } catch (err) {
        setError(`Failed to retry from ${stepName}: ${(err as Error).message}`);
      } finally {
        setReplayingStepName(null);
      }
    },
    [client, run, upsertRun],
  );

  const confirmReplayStep = useCallback(
    (stepName: string, skipPrepare?: boolean) => {
      if (!run) return;
      Alert.alert(
        skipPrepare ? 'Warm retry from here?' : 'Retry from here?',
        skipPrepare
          ? `Replay "${stepName}" and subsequent steps for ${run.ticketOrPr}, reusing the warm slot.`
          : `Replay "${stepName}" and all subsequent steps for ${run.ticketOrPr}.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: skipPrepare ? 'Warm retry' : 'Retry',
            style: 'destructive',
            onPress: () => void replayStep(stepName, skipPrepare),
          },
        ],
      );
    },
    [replayStep, run],
  );

  const openFailedStepDiagnosis = useCallback(
    (step: RunStep) => {
      if (!run) return;
      router.push({
        pathname: '/(tabs)/copilot',
        params: {
          draft: buildFailedStepDiagnosticDraft({
            runId: run.id,
            ticketOrPr: run.ticketOrPr,
            flowType: run.flowType,
            slotId: run.slotId,
            stepName: step.name,
            stepDetail: step.detail,
          }),
        },
      });
    },
    [router, run],
  );

  const activeTaskProgress = useMemo(
    () => effectiveTaskProgressForRun(run, taskProgress) ?? null,
    [run, taskProgress],
  );
  const workspaceGates = useMemo(() => (run ? summarizeSlotWorkspaceGates(run) : []), [run]);
  const activeDiffValue = useMemo(
    () => (run ? runWorkspaceDiffValue(run, workspaceGates[0] ?? null) : '-'),
    [run, workspaceGates],
  );
  const selectedRecipeRun = useMemo(
    () => recipeRuns.find((group) => group.id === selectedRecipeRunId) ?? null,
    [recipeRuns, selectedRecipeRunId],
  );
  const workspaceRecipeRunId =
    requestedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
      ? DECISION_EVIDENCE_RECIPE_RUN_PARAM
      : selectedRecipeRunId;
  const selectedRecipeArtifactCount = selectedRecipeRun
    ? artifactsForRecipeRun(selectedRecipeRun).length
    : 0;
  const totalRecipeArtifactCount = useMemo(
    () => recipeRuns.reduce((sum, group) => sum + artifactsForRecipeRun(group).length, 0),
    [recipeRuns],
  );
  const recipeAvailable = recipeRunsLoaded ? totalRecipeArtifactCount > 0 : undefined;
  const visibleRecipeArtifactCount = recipeRunsLoaded
    ? totalRecipeArtifactCount || selectedRecipeArtifactCount
    : null;
  const compareTarget = useMemo(
    () =>
      run
        ? selectSlotCompareTarget({
            runArtifacts: extractRunArtifactManifest(run),
            recipeRuns,
            selectedRecipeRunId,
          })
        : null,
    [recipeRuns, run, selectedRecipeRunId],
  );

  if (!run) {
    return (
      <View
        style={[baseStyles.container, styles.center, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        <Text style={baseStyles.textSecondary}>
          {client && connectionStatus === 'connected'
            ? 'Loading run...'
            : 'Connect to the gateway to load this run.'}
        </Text>
        <Pressable style={styles.backFallbackButton} onPress={goBackOrRuns}>
          <Text style={styles.backFallbackText}>Back to runs</Text>
        </Pressable>
      </View>
    );
  }

  const statusColor = STATUS_COLORS[run.status] ?? colors.textMuted;
  const replayAllowed =
    ['failed', 'done', 'cancelled'].includes(run.status) &&
    !run.engineState?.operatorForceCompleted &&
    Boolean(client) &&
    connectionStatus === 'connected';
  const focusedArtifactPath = requestedArtifactPath.trim() || null;
  const focusedArtifactIsDiff = Boolean(
    focusedArtifactPath && diffArtifactCandidate([{ path: focusedArtifactPath }]),
  );
  const openRunEvidenceArtifact = (
    artifactPath?: string,
    recipeRunId?: string | null,
    filter?: ReturnType<typeof artifactFilterParamForWorkspaceNav>,
  ) => {
    const recipeRunParam = recipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM;
    if (artifactPath && diffArtifactCandidate([{ path: artifactPath }])) {
      router.push({
        pathname: '/workspace/run/[runId]/diff',
        params: {
          runId: run.id,
          ...diffRouteContext,
          path: artifactPath,
          recipeRun: recipeRunParam,
        },
      });
      return;
    }
    const targetFilter =
      filter ??
      (recipeRunParam !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
        ? artifactFilterParamForWorkspaceNav('recipe')
        : artifactPath
          ? (artifactFilterParamForArtifactPath(artifactPath) ??
            artifactFilterParamForWorkspaceNav('review'))
          : artifactFilterParamForWorkspaceNav('review'));
    router.push({
      pathname: '/workspace/run/[runId]/files',
      params: {
        runId: run.id,
        ...targetRouteContext(targetWorkspaceForArtifactRoute(recipeRunParam, targetFilter)),
        recipeRun: recipeRunParam,
        ...(targetFilter ? { filter: targetFilter } : {}),
        ...(artifactPath ? { artifact: artifactPath } : {}),
      },
    });
  };
  const openDecisionWorkspace = (decisionId: string) => {
    const targetDecision = run.decisions.find((decision) => decision.id === decisionId);
    const routeContext = decisionWorkspaceRouteParams(workspaceDecisionKind(targetDecision));
    if (['ready', 'review', 'no-change'].includes(workspaceDecisionKind(targetDecision))) {
      router.push({
        pathname: '/workspace/run/[runId]/gate',
        params: {
          runId: run.id,
          decisionId,
          ...routeContext,
          ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
          ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
        },
      });
      return;
    }
    router.push({
      pathname: '/decision/[id]',
      params: {
        id: decisionId,
        ...routeContext,
        runId: run.id,
        ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };
  const reviewPackageActiveTab = isTimelineTab ? 'timeline' : 'evidence';
  const standaloneDecisions = (run.decisions ?? []).filter(
    (decision) => workspaceDecisionKind(decision) === 'retrospective',
  );

  return (
    <View style={baseStyles.container}>
      <Animated.ScrollView
        testID="companion-screen-run-detail"
        collapsable={false}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: styles.scrollContent.paddingBottom + insets.bottom },
        ]}
      >
        <View style={styles.headerCard}>
          <View style={styles.row}>
            <View style={[styles.flowBadge, { backgroundColor: colors.accent + '30' }]}>
              <Text style={[styles.flowText, { color: colors.accent }]}>{run.flowType}</Text>
            </View>
            <View style={[styles.statusBadge, { backgroundColor: statusColor + '30' }]}>
              <Text style={[styles.statusText, { color: statusColor }]}>{run.status}</Text>
            </View>
          </View>
          <Text style={styles.ticketText}>{run.ticketOrPr}</Text>
          {run.summary && <Text style={baseStyles.textSecondary}>{run.summary}</Text>}
          <View style={[styles.row, { marginTop: spacing.lg }]}>
            {run.slotId && <Text style={baseStyles.textMuted}>Slot: {run.slotId}</Text>}
            <Text style={baseStyles.textMuted}>{formatDuration(run.metrics?.durationMs)}</Text>
          </View>
        </View>

        {reviewPackageActiveTab === 'evidence' && focusedArtifactPath ? (
          <RunFocusedArtifactCard
            artifactPath={focusedArtifactPath}
            recipeRunId={workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM}
            slotId={run.slotId}
            familyId={run.familyId}
            prNumber={run.prNumber}
            recipeAvailable={recipeAvailable}
            diffAvailable={activeDiffValue !== '-' || Boolean(run.slotId)}
            diffValue={activeDiffValue !== '-' ? activeDiffValue : run.slotId ? 'workspace' : '-'}
            comparePairCount={compareTarget?.pairCount ?? 0}
            onOpenArtifact={() =>
              openRunEvidenceArtifact(
                focusedArtifactPath,
                workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
              )
            }
            onOpenFiles={() =>
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: run.id,
                  ...targetRouteContext(
                    targetWorkspaceForArtifactRoute(
                      workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      artifactFilterParamForArtifactPath(focusedArtifactPath) ??
                        (workspaceRecipeRunId &&
                        workspaceRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                          ? artifactFilterParamForWorkspaceNav('recipe')
                          : artifactFilterParamForWorkspaceNav('review')),
                    ),
                  ),
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: focusedArtifactPath,
                  filter:
                    artifactFilterParamForArtifactPath(focusedArtifactPath) ??
                    (workspaceRecipeRunId &&
                    workspaceRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                      ? artifactFilterParamForWorkspaceNav('recipe')
                      : artifactFilterParamForWorkspaceNav('review')),
                },
              })
            }
            onOpenRecipe={() => {
              const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: run.id,
                  ...targetRouteContext('recipe'),
                  recipeRun: recipeTarget,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                  ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
                    ? { artifact: focusedArtifactPath }
                    : {}),
                },
              });
            }}
            onOpenDiff={() =>
              activeDiffValue === '-' && run.slotId
                ? router.push({
                    pathname: '/workspace/slot/[slotId]/diff',
                    params: {
                      slotId: run.slotId,
                      ...diffRouteContext,
                      ...(focusedArtifactIsDiff ? { path: focusedArtifactPath } : {}),
                    },
                  })
                : router.push({
                    pathname: '/workspace/run/[runId]/diff',
                    params: {
                      runId: run.id,
                      ...diffRouteContext,
                      ...(focusedArtifactIsDiff ? { path: focusedArtifactPath } : {}),
                      recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
            }
            onOpenCompare={() => {
              if (!compareTarget) return;
              openRunEvidenceArtifact(
                compareTarget.artifactPath,
                compareTarget.recipeRunId,
                artifactFilterParamForWorkspaceNav('compare'),
              );
            }}
            onOpenSlot={() => {
              if (!run.slotId) return;
              router.push({
                pathname: '/workspace/slot/[slotId]/slot',
                params: {
                  slotId: run.slotId,
                  ...targetRouteContext('slot'),
                  runId: run.id,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: focusedArtifactPath,
                },
              });
            }}
            onOpenTerminal={() => {
              if (!run.slotId) return;
              router.push({
                pathname: '/workspace/slot/[slotId]/terminal',
                params: {
                  slotId: run.slotId,
                  ...targetRouteContext('terminal'),
                  runId: run.id,
                  details: '1',
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: focusedArtifactPath,
                },
              });
            }}
            onOpenFamily={() => {
              if (!run.familyId) return;
              router.push({
                pathname: '/family/[familyId]',
                params: {
                  familyId: run.familyId,
                  project: run.project,
                  ...familySectionRouteContextParams('focus', workspaceRouteContext.decisionKind),
                  runId: run.id,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: focusedArtifactPath,
                  section: 'focus',
                },
              });
            }}
            onOpenPR={() => {
              if (!run.prNumber) return;
              const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
              router.push({
                pathname: '/(tabs)/prs',
                params: {
                  pr: String(run.prNumber),
                  ...targetRouteContext('pr'),
                  ...(prRepo ? { repo: prRepo } : {}),
                },
              });
            }}
          />
        ) : null}

        {reviewPackageActiveTab === 'evidence' ? (
          <RunReviewWorkspaceSummary
            run={run}
            gates={workspaceGates}
            gatewayUrl={gatewayUrl}
            artifactAuthHeaders={artifactAuthHeaders}
            recipeArtifactCount={visibleRecipeArtifactCount}
            recipeAvailable={recipeAvailable}
            recipeRuns={recipeRuns}
            selectedRecipeRunId={selectedRecipeRunId}
            compareTarget={compareTarget}
            onOpenDecision={openDecisionWorkspace}
            onOpenArtifacts={(artifactPath) =>
              openRunEvidenceArtifact(artifactPath, DECISION_EVIDENCE_RECIPE_RUN_PARAM)
            }
            onOpenRecipeArtifact={(artifactPath, recipeRunId) =>
              openRunEvidenceArtifact(
                artifactPath,
                recipeRunId,
                artifactFilterParamForWorkspaceNav('compare'),
              )
            }
            onOpenRecipe={() => {
              const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: run.id,
                  ...targetRouteContext('recipe'),
                  recipeRun: recipeTarget,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                  ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
                    ? { artifact: focusedArtifactPath }
                    : {}),
                },
              });
            }}
            onOpenDiff={() =>
              activeDiffValue === '-' && run.slotId
                ? router.push({
                    pathname: '/workspace/slot/[slotId]/diff',
                    params: { slotId: run.slotId, ...diffRouteContext },
                  })
                : router.push({
                    pathname: '/workspace/run/[runId]/diff',
                    params: {
                      runId: run.id,
                      ...diffRouteContext,
                      ...(focusedArtifactIsDiff && focusedArtifactPath
                        ? { path: focusedArtifactPath }
                        : {}),
                      recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
            }
            onOpenFamily={() =>
              run.familyId
                ? router.push({
                    pathname: '/family/[familyId]',
                    params: {
                      familyId: run.familyId,
                      project: run.project,
                      ...familySectionRouteContextParams(
                        'focus',
                        workspaceRouteContext.decisionKind,
                      ),
                      runId: run.id,
                      ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                      ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                      section: 'focus',
                    },
                  })
                : undefined
            }
            onOpenFamilyRetros={() =>
              run.familyId
                ? router.push({
                    pathname: '/family/[familyId]',
                    params: {
                      familyId: run.familyId,
                      project: run.project,
                      ...familySectionRouteContextParams(
                        'retros',
                        workspaceRouteContext.decisionKind,
                      ),
                      runId: run.id,
                      ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                      ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                      section: 'retros',
                    },
                  })
                : undefined
            }
            onOpenTerminal={() =>
              run.slotId
                ? router.push({
                    pathname: '/workspace/slot/[slotId]/terminal',
                    params: {
                      slotId: run.slotId,
                      ...targetRouteContext('terminal'),
                      runId: run.id,
                      details: '1',
                      ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                      ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                    },
                  })
                : undefined
            }
            onOpenSlot={() =>
              run.slotId
                ? router.push({
                    pathname: '/workspace/slot/[slotId]/slot',
                    params: {
                      slotId: run.slotId,
                      ...targetRouteContext('slot'),
                      runId: run.id,
                      recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                    },
                  })
                : undefined
            }
            onOpenPR={() => {
              if (!run.prNumber) return;
              const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
              router.push({
                pathname: '/(tabs)/prs',
                params: {
                  pr: String(run.prNumber),
                  ...targetRouteContext('pr'),
                  ...(prRepo ? { repo: prRepo } : {}),
                },
              });
            }}
            onOpenCompareTarget={() => {
              if (!compareTarget) return;
              openRunEvidenceArtifact(
                compareTarget.artifactPath,
                compareTarget.recipeRunId,
                artifactFilterParamForWorkspaceNav('compare'),
              );
            }}
          />
        ) : null}

        {reviewPackageActiveTab === 'timeline' ? (
          <InteractiveOperatorPacketsPanel
            run={run}
            client={client}
            gatewayUrl={gatewayUrl}
            artifactAuthHeaders={artifactAuthHeaders}
          />
        ) : null}

        {/* Decisions */}
        {reviewPackageActiveTab === 'evidence' && standaloneDecisions.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Decisions</Text>
            {standaloneDecisions.map((d) => (
              <DecisionSummaryCard
                key={d.id}
                presentation={decisionPresentationForRun(run, d)}
                resolvedAction={d.resolvedAction}
                resolvedAt={d.resolvedAt}
                onPress={() => openDecisionWorkspace(d.id)}
                onOpenArtifacts={() =>
                  router.push({
                    pathname: '/workspace/run/[runId]/files',
                    params: {
                      runId: run.id,
                      ...targetRouteContext(
                        workspaceRecipeRunId &&
                          workspaceRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                          ? 'recipe'
                          : 'artifacts',
                      ),
                      recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      filter:
                        workspaceRecipeRunId &&
                        workspaceRecipeRunId !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                          ? artifactFilterParamForWorkspaceNav('recipe')
                          : artifactFilterParamForWorkspaceNav('review'),
                      ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                    },
                  })
                }
                onOpenDiff={() =>
                  activeDiffValue === '-' && run.slotId
                    ? router.push({
                        pathname: '/workspace/slot/[slotId]/diff',
                        params: {
                          slotId: run.slotId,
                          ...diffRouteContext,
                          ...(focusedArtifactIsDiff && focusedArtifactPath
                            ? { path: focusedArtifactPath }
                            : {}),
                        },
                      })
                    : router.push({
                        pathname: '/workspace/run/[runId]/diff',
                        params: {
                          runId: run.id,
                          ...diffRouteContext,
                          recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                          ...(focusedArtifactIsDiff && focusedArtifactPath
                            ? { path: focusedArtifactPath }
                            : {}),
                        },
                      })
                }
                onOpenCompare={(artifactPath) => {
                  if (artifactPath) {
                    openRunEvidenceArtifact(artifactPath, DECISION_EVIDENCE_RECIPE_RUN_PARAM);
                    return;
                  }
                  if (compareTarget) {
                    openRunEvidenceArtifact(
                      compareTarget.artifactPath,
                      compareTarget.recipeRunId,
                      artifactFilterParamForWorkspaceNav('compare'),
                    );
                    return;
                  }
                  openRunEvidenceArtifact(undefined, DECISION_EVIDENCE_RECIPE_RUN_PARAM);
                }}
              />
            ))}
          </View>
        )}

        {reviewPackageActiveTab === 'timeline' ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Timeline</Text>
            {activeTaskProgress ? (
              <TaskProgressPanel
                run={run}
                progress={activeTaskProgress}
                error={taskProgressError}
                compact
              />
            ) : isWorkerProgressActive(run) ? (
              <TaskProgressFallbackPanel
                summary={fallbackTaskProgressSummary(run)}
                error={taskProgressError}
                compact
              />
            ) : null}
            {(run.steps ?? []).length > 0 && (
              <RunPipelineFull
                steps={run.steps}
                runStatus={run.status}
                onStepPress={(_name, i) =>
                  setExpandedStep((current) => {
                    const key = `${run.steps[i].name}-${i}`;
                    return current === key ? null : key;
                  })
                }
              />
            )}
            {(run.steps ?? []).map((step, i) => (
              <PipelineStepCard
                key={`${step.name}-${i}`}
                step={step}
                index={i}
                expanded={expandedStep === `${step.name}-${i}`}
                allowReplay={replayAllowed && !replayingStepName}
                replaying={replayingStepName === step.name}
                onReplayStep={(skipPrepare) => confirmReplayStep(step.name, skipPrepare)}
                onDiagnoseFailure={() => openFailedStepDiagnosis(step)}
                onOpenArtifact={(artifactPath) => {
                  if (diffArtifactCandidate([{ path: artifactPath }])) {
                    router.push({
                      pathname: '/workspace/run/[runId]/diff',
                      params: {
                        runId: run.id,
                        ...diffRouteContext,
                        path: artifactPath,
                        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      },
                    });
                    return;
                  }
                  router.push({
                    pathname: '/workspace/run/[runId]/files',
                    params: {
                      runId: run.id,
                      ...targetRouteContext(
                        targetWorkspaceForArtifactRoute(
                          DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                          artifactFilterParamForArtifactPath(artifactPath) ??
                            artifactFilterParamForWorkspaceNav('review'),
                        ),
                      ),
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      artifact: artifactPath,
                      filter:
                        artifactFilterParamForArtifactPath(artifactPath) ??
                        artifactFilterParamForWorkspaceNav('review'),
                    },
                  });
                }}
                onToggle={() =>
                  setExpandedStep((current) =>
                    current === `${step.name}-${i}` ? null : `${step.name}-${i}`,
                  )
                }
              />
            ))}
          </View>
        ) : null}

        {reviewPackageActiveTab === 'timeline' &&
          run.slotId &&
          !isTerminalRunStatus(run.status) && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Worker Terminal</Text>
              <Pressable
                style={styles.terminalButton}
                onPress={() =>
                  router.push({
                    pathname: '/workspace/slot/[slotId]/terminal',
                    params: {
                      slotId: run.slotId!,
                      ...targetRouteContext('terminal'),
                      runId: run.id,
                      details: '1',
                      ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
                      ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                    },
                  })
                }
              >
                <Text style={styles.terminalButtonText}>Observe / reply to {run.slotId}</Text>
              </Pressable>
            </View>
          )}

        {error && <Text style={styles.errorText}>{error}</Text>}

        {/* Metrics */}
        {reviewPackageActiveTab === 'timeline' ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Metrics</Text>
            <View style={styles.metricsGrid}>
              <MetricItem label="Nudges" value={String(run.metrics?.nudgeCount ?? 0)} />
              <MetricItem label="Model" value={run.metrics?.model ?? '-'} />
              <MetricItem label="Runner" value={run.metrics?.runner ?? '-'} />
              <MetricItem label="Outcome" value={run.metrics?.outcome ?? '-'} />
            </View>
          </View>
        ) : null}
        <View
          testID="companion-screen-run-detail-end"
          accessible
          collapsable={false}
          accessibilityLabel="End of Run Detail"
          style={styles.surfaceEndMarker}
        />
      </Animated.ScrollView>
    </View>
  );
}
