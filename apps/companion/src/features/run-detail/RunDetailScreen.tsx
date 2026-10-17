import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  type AcceptanceCriterionRef,
  type AcceptanceStatusLedger,
  deriveRunLifecycleView,
  Events,
  extractRunArtifactManifest,
  isSlotFreedByPark,
  isTerminalRunStatus,
  liveGateParkView,
  Methods,
  type RecipeRunArtifactGroup,
  type Run,
  type RunRecipeRunsForRunResult,
  type RunRecordedEvidenceReview,
  type RunReplayStepResult,
  type RunStep,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';
import {
  pendingOutputReview,
  publicationReviewBlockingReason,
  runResultsSummary,
} from '@farmslot/review-dispatch';

import { RunOutputReportViewer } from '../../components/RunOutputReportViewer';
import { RunPipelineFull } from '../../components/RunPipeline';
import { RunTitle } from '../../components/RunTitle';
import { TaskAcceptancePanel } from '../../components/TaskAcceptancePanel';
import { TaskProgressPanel } from '../../components/TaskProgressPanel';
import { useConnectedTransport } from '../../hooks/useConnectedTransport';
import { useRunOutputReport } from '../../hooks/useRunOutputReport';
import { useRunResourcePosture } from '../../hooks/useRunResourcePosture';
import { acceptanceEvidenceHref } from '../../lib/acceptance-evidence';
import {
  artifactsForRecipeRun,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  resolveRecipeRunSelection,
} from '../../lib/artifact-url';
import { currentFarmConnection } from '../../lib/connection-authority';
import { diffArtifactCandidate } from '../../lib/diff';
import { gateReviewHref, openHumanGateDecision } from '../../lib/gate-review';
import { nativeRunConversationParams } from '../../lib/native-worker-target';
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
  taskProgressRequestForRun,
} from '../../lib/task-progress';
import { baseStyles, colors, spacing } from '../../lib/theme';
import { recordVisualClaimReview } from '../../lib/visual-claim-review';
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
import { GateReviewEntryCard } from '../gate-review/components/gate-review-panels';
import { NativeWorkerLinks } from '../native-conversation/components/NativeWorkerLinks';
import { SourceStatusSection } from '../sources/SourceStatusSection';
import { formatDuration } from '../workspace-shared/format';
import { useReviewPackageTab } from '../workspace-shared/review-package-tabs';
import { readReviewRun } from '../workspace-shared/review-publication-action';
import { ReviewPublication } from '../workspace-shared/ReviewPublication';

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
import { RunDetailSkeleton } from './components/RunDetailSkeleton';
import { RunPosturePanel } from './components/RunPosturePanel';
import { RunResultsCard } from './components/RunResultsCard';
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
  const connection = useConnectedTransport();
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const storeRun = useRunStore((s) => s.runs.find((r) => r.id === resolvedRunId));
  const upsertRun = useRunStore((s) => s.upsertRun);
  const profileId = useConnectionStore((s) => s.activeProfileId);
  const authorityEpoch = useConnectionStore((s) => s.authorityEpoch);
  // A transport pause invalidates pending reads, not already-authorized evidence.
  const readIdentity = `${resolvedRunId}:${profileId}:${authorityEpoch}`;
  const readScope = useRef({ client, identity: readIdentity });
  if (readScope.current.client !== client || readScope.current.identity !== readIdentity)
    readScope.current = { client, identity: readIdentity };
  const readRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [loadedRun, setLoadedRun] = useState<{ scope: object; run: Run }>();
  const run = loadedRun?.scope === readScope.current ? loadedRun.run : (storeRun ?? null);
  const setRun = (value: Run) => setLoadedRun({ scope: readScope.current, run: value });
  const [recipeRuns, setRecipeRuns] = useState<RecipeRunArtifactGroup[]>([]);
  // The open output review's snapshot is what the retained report is checked against.
  const outputReview = useMemo(() => pendingOutputReview(run), [run]);
  const [recordedEvidence, setRecordedEvidence] = useState<RunRecordedEvidenceReview | null>(null);
  const [recipeRunsLoaded, setRecipeRunsLoaded] = useState(false);
  const [selectedRecipeRunId, setSelectedRecipeRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgressStructured | null>(null);
  // The acceptance ledger (ADR-060) rides the same progress read and broadcast.
  const [acceptanceStatus, setAcceptanceStatus] = useState<AcceptanceStatusLedger | null>(null);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<AcceptanceCriterionRef[] | null>(
    null,
  );
  const [acceptanceStatusError, setAcceptanceStatusError] = useState<string | null>(null);
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

  const evidenceModel = useMemo(
    () =>
      createEvidenceReviewModel({
        context: 'run-detail',
        reportSnapshot: outputReview?.payload,
        comparisonSnapshot: recordedEvidence?.comparisonSnapshot,
        artifacts: run ? extractRunArtifactManifest(run) : [],
        criterionSourceUrl: run?.links?.find((link) => link.label === 'Jira')?.url,
        package: recordedEvidence?.input,
        contractVersion: recordedEvidence?.contractVersion,
        visualReviewAuthority: recordedEvidence?.visualReviewAuthority,
        visualReviewContext: recordedEvidence?.visualReviewContext,
        readErrors: recordedEvidence?.errors,
        artifactPrefix: recordedEvidence?.artifactPrefix,
        packagePath: recordedEvidence?.packagePath,
        ledger: acceptanceStatus,
        criteria: acceptanceCriteria ?? undefined,
        report: recordedEvidence?.report,
      }),
    [acceptanceCriteria, acceptanceStatus, outputReview, recordedEvidence, run?.output],
  );
  const runResults = useMemo(
    () => (run ? runResultsSummary(run, extractRunArtifactManifest(run).length) : null),
    [run],
  );
  const outputReport = useRunOutputReport({
    evidenceModel,
    runId: run?.id,
    gatewayUrl,
    authHeaders: artifactAuthHeaders,
  });
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
        .request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
          runId: resolvedRunId,
          includeRecordedEvidence: true,
          ...(selectionHint && selectionHint !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
            ? { recipeRunId: selectionHint }
            : {}),
        })
        .then((result) => {
          if (recipeRunsRequestRef.current !== requestId) return;
          setRecipeRuns(result.recipeRuns);
          setRecordedEvidence(result.recordedEvidence ?? null);
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
    if (!client || !resolvedRunId || connection === null) return Promise.resolve();
    const scope = readScope.current;
    const request = ++readRequest.current;
    const connectionCurrent = currentFarmConnection(client, useConnectionStore.getState);
    const current = () =>
      mounted.current &&
      readScope.current === scope &&
      readRequest.current === request &&
      connectionCurrent();
    setError(null);
    return readReviewRun(client, resolvedRunId, current, (value) => {
      setLoadedRun({ scope, run: value });
    }).catch((err: Error) => {
      if (!current()) return;
      if (isGatewayBackgroundPauseError(err)) {
        // Reconnect retries a paused read while cached run data stays visible.
        console.warn(`Run refresh paused: ${err.message}`);
        return;
      }
      setError(`Failed to load run: ${err.message}`);
    });
  }, [client, resolvedRunId, connection, profileId, authorityEpoch]);

  useEffect(() => {
    // Each reconnect re-reads: the operator packets' publish guard judges this run.
    if (connection === null) return;
    void loadRun();
  }, [connection, loadRun]);

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
    // Each reconnect re-reads, as the run does: a load that was paused before the gateway
    // connected, or while it restarted, otherwise leaves the recorded evidence and its
    // report missing until the screen is opened again.
    if (connection === null) return;
    loadRecipeRuns(requestedRecipeRunId).catch(noteRecipeRunsUnavailable);
  }, [connection, loadRecipeRuns, noteRecipeRunsUnavailable, requestedRecipeRunId]);

  useEffect(() => {
    if (!client || !resolvedRunId || connection === null) return;
    const scope = readScope.current;
    const connectionCurrent = currentFarmConnection(client, useConnectionStore.getState);
    const handleRunEvent = (payload: unknown, _reason: string) => {
      if (!mounted.current || readScope.current !== scope || !connectionCurrent()) return;
      const event = payload as { run?: Run; runId?: string };
      if (!runRefreshEventMatches(resolvedRunId, event)) return;
      if (event.run?.id === resolvedRunId) {
        ++readRequest.current; // A complete event supersedes any earlier run.get reply.
        setLoadedRun({ scope, run: event.run });
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
  }, [client, connection, loadRecipeRuns, loadRun, resolvedRunId, upsertRun]);

  const fetchTaskProgress = useCallback(() => {
    const params = taskProgressRequestForRun(run);
    if (!client || !params) return Promise.resolve();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, params)
      .then((result) => {
        setTaskProgress(result.structured ?? null);
        setAcceptanceStatus(result.acceptanceStatus ?? null);
        setAcceptanceCriteria(result.acceptanceCriteria ?? null);
        setAcceptanceStatusError(result.acceptanceStatusError ?? null);
        setTaskProgressError(null);
      })
      .catch((err: Error) => {
        setTaskProgressError(`Task progress unavailable: ${err.message}`);
      });
  }, [client, run?.id, run?.slotId, run?.reviewWorkspace?.workspaceId]);

  useEffect(() => {
    if (!isTimelineTab || !client || !run) return;
    const unsub = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      const update = payload as TaskProgressUpdatedPayload;
      if (!shouldAcceptTaskProgressUpdate(run, update)) return;
      setTaskProgress(update.progress.structured ?? null);
      setAcceptanceStatus(update.progress.acceptanceStatus ?? null);
      setAcceptanceCriteria(update.progress.acceptanceCriteria ?? null);
      setAcceptanceStatusError(update.progress.acceptanceStatusError ?? null);
      setTaskProgressError(null);
    });
    return unsub;
  }, [client, isTimelineTab, run]);

  useEffect(() => {
    if (!isTimelineTab || !isWorkerProgressActive(run)) {
      setTaskProgress(null);
      setAcceptanceStatus(null);
      setAcceptanceCriteria(null);
      setAcceptanceStatusError(null);
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
      const isCurrent = currentFarmConnection(client);
      if (!isCurrent()) return;
      setReplayingStepName(stepName);
      setError(null);
      try {
        const result = await client.request<RunReplayStepResult>(Methods.RUN_REPLAY_STEP, {
          runId: run.id,
          stepName,
          ...(skipPrepare ? { skipPrepare: true } : {}),
        });
        if (!isCurrent()) return;
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
  // ADR-054: the run carries the persisted desired policy, but only
  // `runtime.posture.status` re-merges it with what the providers are observed
  // to be doing, so the summary is never rendered from `run.resourcePosture`.
  const { posture: runPosture } = useRunResourcePosture(
    client,
    resolvedRunId || null,
    run?.updatedAt ?? '',
  );
  const compareTarget = useMemo(
    () =>
      run
        ? selectSlotCompareTarget({
            runArtifacts: extractRunArtifactManifest(run),
            recipeRuns,
            selectedRecipeRunId,
            evidenceModel,
          })
        : null,
    [recipeRuns, run, selectedRecipeRunId, evidenceModel],
  );

  if (!run)
    return (
      <View style={[baseStyles.container, { paddingBottom: insets.bottom }]}>
        <RunDetailSkeleton
          error={error ?? (connectionStatus !== 'connected' ? 'Connect to the gateway' : undefined)}
          retry={() => void loadRun()}
        />
        <Pressable style={styles.backFallbackButton} onPress={goBackOrRuns}>
          <Text style={styles.backFallbackText}>Back to runs</Text>
        </Pressable>
      </View>
    );

  const lifecycle = deriveRunLifecycleView(run);
  const statusColor =
    STATUS_COLORS[run.status] ??
    {
      ok: colors.statusOk,
      fail: colors.statusFail,
      warn: colors.statusWarn,
      running: colors.lifecycleWorking,
      muted: colors.textMuted,
    }[lifecycle.tone];
  const replayAllowed =
    isTerminalRunStatus(run.status) &&
    !run.engineState?.operatorForceCompleted &&
    Boolean(client) &&
    connectionStatus === 'connected';
  const focusedArtifactPath = requestedArtifactPath.trim() || null;
  const focusedArtifactIsDiff = Boolean(
    focusedArtifactPath && diffArtifactCandidate([{ path: focusedArtifactPath }]),
  );
  const recordRunVisualReview = async (
    id: string,
    verdict: Parameters<typeof recordVisualClaimReview>[4],
    reason?: string,
  ) => {
    await recordVisualClaimReview(client, run.id, evidenceModel, id, verdict, reason);
    await loadRecipeRuns(selectedRecipeRunId);
  };
  const openAcceptanceEvidence = (criterionId: string, path: string) =>
    router.push(acceptanceEvidenceHref(run.id, criterionId, path, selectedRecipeRunId));
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
  const openGate = openHumanGateDecision(run);
  const standaloneDecisions = (run.decisions ?? []).filter(
    (decision) => workspaceDecisionKind(decision) === 'retrospective',
  );

  const reviewStatus = publicationReviewBlockingReason(run);

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
              <Text style={[styles.statusText, { color: statusColor }]}>
                {lifecycle.activityLabel ?? lifecycle.label}
              </Text>
            </View>
          </View>
          <Text style={styles.ticketText}>{run.ticketOrPr}</Text>
          {run.summary && <RunTitle style={baseStyles.textSecondary} title={run.summary} />}
          {run.qa && (
            <Text style={baseStyles.textSecondary} testID="companion-run-qa-profile">
              QA profile: {run.qa.profile.title} ({run.qa.profile.id})
            </Text>
          )}
          <View style={[styles.row, { marginTop: spacing.lg }]}>
            {run.slotId && (
              <Text style={baseStyles.textMuted} testID="companion-run-detail-slot">
                Slot: {run.slotId}
                {/*
                  `isSlotFreedByPark` ignores `phase`, and cancel skips slot
                  release for a park-freed run, so this marker outlives the run.
                  On a terminal run the release is still a fact but no restore
                  is coming, and the wording must not imply one.
                */}
                {isSlotFreedByPark(run)
                  ? isTerminalRunStatus(run.status)
                    ? ' (released to dispatch; no restore pending)'
                    : ' (freed for dispatch)'
                  : ''}
              </Text>
            )}
            <Text style={baseStyles.textMuted}>{formatDuration(run.metrics?.durationMs)}</Text>
          </View>
        </View>

        {reviewStatus ? (
          <Text accessibilityLiveRegion="polite" style={baseStyles.textSecondary}>
            {reviewStatus}
          </Text>
        ) : null}
        {openGate ? (
          <GateReviewEntryCard
            testID="companion-open-gate-review"
            onOpen={() => router.push(gateReviewHref(run.id, openGate.id))}
          />
        ) : null}

        {reviewPackageActiveTab === 'timeline' && run.transport === 'native' ? (
          <NativeWorkerLinks run={run} />
        ) : null}

        <RunPosturePanel state={runPosture} gatePark={liveGateParkView(run)} />
        <ReviewPublication run={run} context="saved" />

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
            terminalLabel={run.transport === 'native' ? 'Conversation' : 'Terminal'}
            onOpenTerminal={() => {
              if (run.transport === 'native') {
                const params = nativeRunConversationParams(run);
                if (params) router.push({ pathname: '/native', params });
                return;
              }
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

        {reviewPackageActiveTab === 'evidence' && runResults?.shouldRender ? (
          <RunResultsCard
            summary={runResults}
            hasReport={Boolean(run.output?.reportPath)}
            captureError={run.output?.captureError}
            loadingReport={outputReport.loading}
            onReadReport={() => void outputReport.open()}
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
            terminalLabel={run.transport === 'native' ? 'Conversation' : 'Terminal'}
            onOpenTerminal={() =>
              run.transport === 'native'
                ? (() => {
                    const params = nativeRunConversationParams(run);
                    if (params) router.push({ pathname: '/native', params });
                  })()
                : run.slotId
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
            {acceptanceStatus ||
            acceptanceCriteria?.length ||
            acceptanceStatusError ||
            evidenceModel.claims.length ||
            evidenceModel.errors.length ? (
              <TaskAcceptancePanel
                evidenceModel={evidenceModel}
                judgmentRows={evidenceModel.judgmentRows(client?.authenticatedPrincipal ?? null)}
                onRecordVisualReview={recordRunVisualReview}
                acceptanceStatus={acceptanceStatus}
                acceptanceCriteria={acceptanceCriteria}
                error={acceptanceStatusError}
                onOpenEvidence={openAcceptanceEvidence}
              />
            ) : null}
            {activeTaskProgress ? (
              <TaskProgressPanel
                run={run}
                progress={activeTaskProgress}
                error={taskProgressError}
                compact
              />
            ) : isWorkerProgressActive(run) ? (
              <TaskProgressPanel
                summary={fallbackTaskProgressSummary(run)}
                error={taskProgressError}
                compact
              />
            ) : null}
            <SourceStatusSection
              context={{ target: { scope: 'run', targetId: run.id }, actions: ['pin', 'unpin'] }}
            />
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
          run.transport !== 'native' &&
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
      <RunOutputReportViewer
        report={outputReport}
        evidenceModel={evidenceModel}
        judgmentRows={evidenceModel.judgmentRows(client?.authenticatedPrincipal ?? null)}
        onRecordVisualReview={recordRunVisualReview}
        onOpenEvidence={openAcceptanceEvidence}
        onOpenArtifact={(path) => openRunEvidenceArtifact(path, DECISION_EVIDENCE_RECIPE_RUN_PARAM)}
      />
    </View>
  );
}
