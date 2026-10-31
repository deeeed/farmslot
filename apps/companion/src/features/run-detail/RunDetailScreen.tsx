import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createEvidenceReviewModel, runEvidencePending } from '@farmslot/adapter-sdk/evidence';
import {
  cancelledRunSlotChoices,
  deriveRunLifecycleView,
  extractRunArtifactManifest,
  isSlotFreedByPark,
  isTerminalRunStatus,
  liveGateParkView,
  Methods,
  type RecipeRunArtifactGroup,
  reviewChainForRun,
  type RunGetResult,
  type RunStep,
  type TaskProgressResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import {
  humanGateBlockingReason,
  pendingOutputReview,
  runActivityView,
  runResultsSummary,
  runTerminalView,
} from '@farmslot/review-dispatch';

import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { RunLinkedTickets } from '../../components/RunLinkedTickets';
import { RunOutputReportViewer } from '../../components/RunOutputReportViewer';
import { RunPipelineFull } from '../../components/RunPipeline';
import { RunTitle } from '../../components/RunTitle';
import { TaskAcceptancePanel } from '../../components/TaskAcceptancePanel';
import { TaskProgressPanel } from '../../components/TaskProgressPanel';
import { useResourceQuery } from '../../hooks/useResourceQuery';
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
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { getResourceCache } from '../../lib/resource-cache';
import { readErrorMessage } from '../../lib/resource-read-status';
import { assertNativeRunReady } from '../../lib/run-collections';
import {
  runWorkspaceDiffValue,
  selectSlotCompareTarget,
  summarizeSlotWorkspaceGates,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isWorkerProgressActive,
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
import { useFleetStore } from '../../store/fleet';
import { heldConnectionCurrent } from '../../store/held-connection';
import DecisionDetailScreen from '../decision-workspace/DecisionWorkspaceScreen';
import { GateReviewEntryCard } from '../gate-review/components/gate-review-panels';
import { NativeWorkerLinks } from '../native-conversation/components/NativeWorkerLinks';
import { SourceStatusSection } from '../sources/SourceStatusSection';
import { CancelledRunSlotRelease } from '../workspace-shared/CancelledRunSlotRelease';
import { formatDuration } from '../workspace-shared/format';
import { useReviewPackageTab } from '../workspace-shared/review-package-tabs';
import { ReviewPublication } from '../workspace-shared/ReviewPublication';

import { InteractiveOperatorPacketsPanel } from './components/InteractiveOperatorPacketsPanel';
import { ReviewHistoryPanel } from './components/ReviewHistoryPanel';
import {
  CockpitTile,
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
import { assertRunEvidenceReady, runEvidenceQuery } from './run-evidence';

const emptyRecipeRuns: RecipeRunArtifactGroup[] = [];

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
  const fleetSlots = useFleetStore((s) => s.fleet?.slots);
  const profileId = useConnectionStore((s) => s.activeProfileId);
  const authorityEpoch = useConnectionStore((s) => s.authorityEpoch);
  const requestedRecipeRunId = Array.isArray(recipeRun)
    ? (recipeRun[0] ?? null)
    : (recipeRun ?? null);
  const runQuery = useMemo(
    () =>
      resolvedRunId ? resourceQuery<RunGetResult>('run.get', { runId: resolvedRunId }) : undefined,
    [resolvedRunId],
  );
  const runObservation = useResourceQuery(runQuery);
  const run = runObservation.data?.run ?? null;
  const outputReview = useMemo(() => pendingOutputReview(run), [run]);
  const recipeQuery = useMemo(
    () => runEvidenceQuery(resolvedRunId, run, requestedRecipeRunId),
    [resolvedRunId, run, requestedRecipeRunId],
  );
  const recipeObservation = useResourceQuery(recipeQuery);
  const evidenceCache = getResourceCache();
  const reviewContext = useMemo(
    () => ({ resolvedRunId, requestedRecipeRunId, profileId, authorityEpoch, client, recipeQuery }),
    [resolvedRunId, requestedRecipeRunId, profileId, authorityEpoch, client, recipeQuery],
  );
  const currentReviewContext = useRef(reviewContext);
  currentReviewContext.current = reviewContext;
  const recipeRuns = recipeObservation.data?.recipeRuns ?? emptyRecipeRuns;
  const recordedEvidence = recipeObservation.data?.recordedEvidence ?? null;
  const recipeRunsLoaded = recipeObservation.data !== undefined;
  const selectedRecipeRunId =
    requestedRecipeRunId === DECISION_EVIDENCE_RECIPE_RUN_PARAM
      ? null
      : resolveRecipeRunSelection(
          recipeRuns,
          requestedRecipeRunId,
          recipeObservation.data?.selectedRecipeRunId,
        );
  const [actionError, setError] = useState<string | null>(null);
  const progressQuery = useMemo(() => {
    const target = taskProgressRequestForRun(run);
    return target ? resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, target) : undefined;
  }, [run?.id, run?.slotId, run?.reviewWorkspace?.workspaceId]);
  const progressObservation = useResourceQuery(progressQuery);
  const taskProgress = progressObservation.data?.structured ?? null;
  const acceptanceStatus = progressObservation.data?.acceptanceStatus ?? null;
  const acceptanceCriteria = progressObservation.data?.acceptanceCriteria ?? null;
  const acceptanceStatusError =
    readErrorMessage(progressObservation, heldConnectionCurrent()) ??
    progressObservation.data?.acceptanceStatusError ??
    null;
  const taskProgressError = readErrorMessage(progressObservation, heldConnectionCurrent())
    ? `Task progress unavailable: ${readErrorMessage(progressObservation, heldConnectionCurrent())}`
    : null;
  const error =
    actionError ??
    readErrorMessage(runObservation, heldConnectionCurrent()) ??
    readErrorMessage(recipeObservation, heldConnectionCurrent()) ??
    readErrorMessage(progressObservation, heldConnectionCurrent()) ??
    null;
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [replayingStepName, setReplayingStepName] = useState<string | null>(null);
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

  const evidencePending = run ? runEvidencePending(run) : false;
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
        evidencePending,
        artifactPrefix: recordedEvidence?.artifactPrefix,
        packagePath: recordedEvidence?.packagePath,
        ledger: acceptanceStatus,
        criteria: acceptanceCriteria ?? undefined,
        report: recordedEvidence?.report,
      }),
    [
      acceptanceCriteria,
      acceptanceStatus,
      outputReview,
      recordedEvidence,
      run?.output,
      evidencePending,
    ],
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
    contextKey: JSON.stringify([profileId, authorityEpoch, recipeQuery?.id]),
  });
  const retryRun = useCallback(async () => {
    if (runQuery) await getResourceCache()?.retry(runQuery);
    if (recipeQuery) await getResourceCache()?.retry(recipeQuery);
    if (progressQuery) await getResourceCache()?.retry(progressQuery);
  }, [runQuery, recipeQuery, progressQuery]);

  useEffect(() => {
    setError(null);
    setExpandedStep(null);
    setReplayingStepName(null);
  }, [resolvedRunId, profileId, authorityEpoch]);

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
        assertNativeRunReady(run.id, run);
        await client.request(Methods.RUN_REPLAY_STEP, {
          runId: run.id,
          stepName,
          ...(skipPrepare ? { skipPrepare: true } : {}),
        });
        if (!isCurrent()) return;
        setExpandedStep(null);
      } catch (err) {
        if (isCurrent()) setError(`Failed to retry from ${stepName}: ${(err as Error).message}`);
      } finally {
        if (isCurrent()) setReplayingStepName(null);
      }
    },
    [client, run],
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
          retry={() => void retryRun()}
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
    connectionStatus === 'connected' &&
    runObservation.status === 'ready';
  const cancelledSlot = cancelledRunSlotChoices(run, fleetSlots ?? []);
  const focusedArtifactPath = requestedArtifactPath.trim() || null;
  const focusedArtifactIsDiff = Boolean(
    focusedArtifactPath && diffArtifactCandidate([{ path: focusedArtifactPath }]),
  );
  const recordRunVisualReview = async (
    id: string,
    verdict: Parameters<typeof recordVisualClaimReview>[4],
    reason?: string,
  ) => {
    assertNativeRunReady(run.id, run);
    assertRunEvidenceReady({
      cache: evidenceCache,
      currentCache: getResourceCache(),
      contextCurrent:
        currentReviewContext.current === reviewContext &&
        useConnectionStore.getState().client === client &&
        useConnectionStore.getState().activeProfileId === profileId &&
        useConnectionStore.getState().authorityEpoch === authorityEpoch,
      recipeQuery,
      progressQuery,
      evidence: recipeObservation.data,
    });
    await recordVisualClaimReview(client, run.id, evidenceModel, id, verdict, reason);
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

  const reviewStatus = humanGateBlockingReason(run);
  const terminal = runTerminalView(run);
  const openTerminal = () => {
    if (terminal.disabledReason) return;
    if (!terminal.target) return;
    router.push({
      pathname: terminal.target.slotId
        ? '/workspace/slot/[slotId]/terminal'
        : '/run-terminal/[runId]',
      params: {
        ...terminal.target,
        ...targetRouteContext('terminal'),
        details: '1',
        ...(workspaceRecipeRunId ? { recipeRun: workspaceRecipeRunId } : {}),
        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
      },
    });
  };

  return (
    <View style={baseStyles.container}>
      <ResourceReadStatus
        observations={[
          { observation: runObservation, label: 'run' },
          { observation: recipeObservation, label: 'run evidence' },
          ...(progressQuery ? [{ observation: progressObservation, label: 'task progress' }] : []),
        ]}
      />
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
              <Text style={[styles.statusText, { color: statusColor }]} numberOfLines={1}>
                {runActivityView(run)?.label ?? lifecycle.activityLabel ?? lifecycle.label}
              </Text>
            </View>
          </View>
          <Text style={styles.ticketText}>{run.ticketOrPr}</Text>
          <RunLinkedTickets
            key={run.id}
            run={run}
            disabled={runObservation.status !== 'ready' || connectionStatus !== 'connected'}
            onSave={
              client
                ? async (linkedTicketRefs) => {
                    if (!currentFarmConnection(client)())
                      throw new Error('Wait for the current connection before editing tickets.');
                    assertNativeRunReady(run.id, run);
                    await client.request(Methods.RUN_LINKED_TICKETS_SET, {
                      runId: run.id,
                      linkedTicketRefs,
                    });
                  }
                : undefined
            }
          />
          {run.summary && <RunTitle style={baseStyles.textSecondary} title={run.summary} />}
          <CockpitTile
            testID="companion-run-open-terminal"
            label={terminal.label}
            value={
              terminal.disabledReason ??
              (terminal.target?.slotId ||
                terminal.context?.nativeSession?.executionNodeId ||
                run.reviewWorkspace?.machine ||
                'Current session')
            }
            disabled={Boolean(terminal.disabledReason)}
            onPress={openTerminal}
          />
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
          {cancelledSlot ? (
            <CancelledRunSlotRelease
              hold={cancelledSlot.hold}
              replay={{
                label: cancelledSlot.replayLabel,
                disabled: !replayAllowed || Boolean(replayingStepName),
                onReplay: () => confirmReplayStep(cancelledSlot.replayStepName),
              }}
            />
          ) : null}
        </View>

        {reviewStatus ? (
          <Text accessibilityLiveRegion="polite" style={baseStyles.textSecondary}>
            {reviewStatus}
          </Text>
        ) : null}
        {openGate?.type === 'engine_review_posting' ? (
          <DecisionDetailScreen
            embedded
            showReviewHistory={false}
            decisionId={openGate.id}
            runId={run.id}
          />
        ) : openGate ? (
          <GateReviewEntryCard
            testID="companion-open-gate-review"
            onOpen={() => router.push(gateReviewHref(run.id, openGate.id))}
          />
        ) : null}

        <NativeWorkerLinks run={run} />

        <RunPosturePanel state={runPosture} gatePark={liveGateParkView(run)} />
        <ReviewPublication run={run} context="saved" />
        <ReviewHistoryPanel
          run={run}
          chain={reviewChainForRun(run)}
          onOpenArtifact={(path) => openRunEvidenceArtifact(path)}
        />

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
            terminalLabel={terminal.label}
            terminalDisabledReason={terminal.disabledReason}
            onOpenTerminal={openTerminal}
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
            terminalLabel={terminal.label}
            onOpenTerminal={openTerminal}
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
            {run.acceptanceRegistration ||
            acceptanceStatus ||
            acceptanceCriteria?.length ||
            acceptanceStatusError ||
            evidenceModel.claims.length ||
            evidenceModel.errors.length ? (
              <TaskAcceptancePanel
                acceptanceRegistration={run.acceptanceRegistration}
                evidenceModel={evidenceModel}
                judgmentRows={evidenceModel.judgmentRows(client?.authenticatedPrincipal ?? null)}
                onRecordVisualReview={
                  runObservation.status === 'ready' &&
                  recipeObservation.status === 'ready' &&
                  progressObservation.status === 'ready'
                    ? recordRunVisualReview
                    : undefined
                }
                acceptanceStatus={acceptanceStatus}
                acceptanceCriteria={acceptanceCriteria}
                error={acceptanceStatusError}
                onRetry={
                  progressQuery ? () => void getResourceCache()?.retry(progressQuery) : undefined
                }
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
                run={run}
                taskProgress={activeTaskProgress}
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
                run={run}
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
        onRecordVisualReview={
          runObservation.status === 'ready' &&
          recipeObservation.status === 'ready' &&
          progressObservation.status === 'ready'
            ? recordRunVisualReview
            : undefined
        }
        onOpenEvidence={openAcceptanceEvidence}
        onOpenArtifact={(path) => openRunEvidenceArtifact(path, DECISION_EVIDENCE_RECIPE_RUN_PARAM)}
      />
    </View>
  );
}
