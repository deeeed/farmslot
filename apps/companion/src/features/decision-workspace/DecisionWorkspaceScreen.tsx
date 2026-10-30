import * as Haptics from 'expo-haptics';
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  evidenceAttestationAvailable,
  improvementApplyOutcome,
  type ImprovementApplyResult,
  isValidEvidenceAttestationReason,
  liveGateParkView,
  Methods,
  RESOURCE_POSTURE_TRANSITION_POLL_LIMIT,
  type ResourcePostureGateChoice,
  resourcePostureTransitionBaseline,
  reviewRoundBudgetLabel,
  type RunDecision,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type RuntimePosturePreviewResult,
  type RuntimePostureStatusResult,
  slotPickerViewModel,
  type TaskProgressResult,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import {
  gateReviewLineageOptions,
  resultDecisionView,
  ReviewDispatchViewModel,
  reviewLineagesForRun,
  reviewRequestContextForRun,
} from '@farmslot/review-dispatch';

import { DocumentViewer } from '../../components/DocumentViewer';
import { EvidenceReviewWorkspace } from '../../components/EvidenceReviewWorkspace';
import { MediaViewer, type MediaViewerItem } from '../../components/MediaViewer';
import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { ResultDecisionPanel } from '../../components/ResultDecisionPanel';
import { RunOutputReportViewer } from '../../components/RunOutputReportViewer';
import {
  acceptancePanelViewportHeight,
  TaskAcceptancePanel,
} from '../../components/TaskAcceptancePanel';
import { TaskProgressPanel } from '../../components/TaskProgressPanel';
import { useGateCriterionDrafts } from '../../hooks/useGateCriterionDrafts';
import { useHumanGateGuard } from '../../hooks/useHumanGateGuard';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import { useRunAcceptance } from '../../hooks/useRunAcceptance';
import { useRunOutputReport } from '../../hooks/useRunOutputReport';
import { useRunResourcePosture } from '../../hooks/useRunResourcePosture';
import { acceptanceEvidenceHref } from '../../lib/acceptance-evidence';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrlForEntry,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
} from '../../lib/artifact-url';
import { requestClaimUntestableOverride } from '../../lib/claim-overrides';
import { currentFarmConnection } from '../../lib/connection-authority';
import {
  type DecisionDocumentContent,
  decisionDocumentSelection,
  decisionEvidenceMediaItems,
} from '../../lib/decision-evidence-media';
import { documentTitle, presentDecision } from '../../lib/decision-presentation';
import {
  decisionResolveRequest,
  gateActionReasons,
  sendDecisionResolveRequest,
} from '../../lib/decision-resolve';
import { decisionRunId, enrichDecisionWithRunContext } from '../../lib/decision-run-context';
import { diffArtifactCandidate } from '../../lib/diff';
import {
  evidenceViewerSelection,
  recordedEvidenceArtifactUrl,
  selectedEvidenceMediaItem,
} from '../../lib/evidence-media-items';
import { gateReviewHref, HUMAN_GATE_DECISION_TYPE } from '../../lib/gate-review';
import { gatewayFetch } from '../../lib/gateway-http-auth';
import { nativeDecisionsQuery } from '../../lib/gateway-run-sync';
import { isGatewayBackgroundPauseError } from '../../lib/recoverable-errors';
import { getResourceCache } from '../../lib/resource-cache';
import { requestAnotherReviewRound } from '../../lib/review-budget';
import { assertNativeDecisionReady, assertNativeRunReady } from '../../lib/run-collections';
import {
  canResolveWithPostureChoice,
  initialRunPostureGateState,
  observePostureTransition,
  postureApplyAlert,
  postureChoiceForResolve,
  postureGateKey,
  postureResolveBlock,
  runPostureGateApplied,
  runPostureGateForContext,
  runPostureGatePreviewFailed,
  runPostureGatePreviewLoaded,
  runPostureGateSelect,
  type RunPostureGateState,
} from '../../lib/run-posture-gate';
import {
  hasRunWorkspaceDiff,
  selectSlotRecipeArtifactsForPreviewScope,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isWorkerProgressActive,
  taskProgressRequestForRun,
} from '../../lib/task-progress';
import { baseStyles, colors, spacing } from '../../lib/theme';
import { findVisualReviewSourceArtifacts } from '../../lib/visual-review';
import {
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
  supersedingResultDecisionId,
} from '../../lib/workspace-decisions';
import {
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  recipeWorkspaceParam,
  shouldPreserveArtifactForRecipeContext,
  targetWorkspaceRouteContextParams,
} from '../../lib/workspace-navigation';
import { useConnectionStore } from '../../store/connection';
import { useDecisionStore } from '../../store/decisions';
import { GateActions, GateReviewEntryCard } from '../gate-review/components/gate-review-panels';
import { GateBlockers } from '../gate-review/components/GateBlockers';
import { GateReviewSkeleton } from '../gate-review/components/GateReviewSkeleton';
import { PlanningChoices } from '../planning/PlanningControls';
import { ReviewDispatchPicker } from '../review-dispatch/ReviewDispatchPicker';
import { ReviewHistoryPanel } from '../run-detail/components/ReviewHistoryPanel';
import { VisualReviewEntryCard } from '../visual-review/components/VisualReviewEntryCard';
import { AskReviewer, ReviewPublicationPanel } from '../workspace-shared/ReviewPublication';
import { useReviewPublication } from '../workspace-shared/use-review-publication';

import {
  DecisionBeforeAfterPriorityPanel,
  type DecisionDetail,
  decisionDetailFromRun,
  DecisionFocusedArtifactCard,
  DecisionRecipeEvidenceSection,
  DecisionWorkspaceCockpit,
  groupArtifacts,
  Meta,
  recipeRunIdForVisualPair,
  routeParamString,
  signalTarget,
} from './components/decision-workspace-panels';
import {
  ResourcePostureGatePanel,
  ResourcePostureWithheldNotice,
  RunGateParkNotice,
} from './components/ResourcePostureGatePanel';
import { decisionWorkspaceStyles as styles } from './styles/decision-workspace.styles';
import { useDecisionCIContext } from './use-decision-ci-context';

const TONE_COLORS = {
  ok: colors.statusOk,
  warn: colors.statusWarn,
  fail: colors.statusFail,
  info: colors.accent,
} as const;

/** The shared poll bound; the interval is this client's own pacing. */
const POSTURE_APPLY_POLL_ATTEMPTS = RESOURCE_POSTURE_TRANSITION_POLL_LIMIT;
const POSTURE_APPLY_POLL_DELAY_MS = 600;

type DecisionSectionKey = 'signals' | 'evidence' | 'reports' | 'progress' | 'terminal' | 'actions';

export default function DecisionDetailScreen({
  embedded = false,
  showReviewHistory = true,
  decisionId: suppliedDecisionId,
  runId: suppliedRunId,
}: {
  embedded?: boolean;
  showReviewHistory?: boolean;
  decisionId?: string;
  runId?: string;
}) {
  const {
    id,
    decisionId,
    runId: urlRunId,
    recipeRun: routeRecipeRun,
    artifact: routeArtifactPath,
  } = useLocalSearchParams<{
    id: string;
    decisionId?: string | string[];
    runId?: string | string[];
    recipeRun?: string | string[];
    artifact?: string | string[];
  }>();
  const routeRunId = suppliedRunId ?? urlRunId;
  const resolvedDecisionId =
    suppliedDecisionId ?? (routeParamString(decisionId) || routeParamString(id));
  const reviewPicker = useMemo(
    () =>
      new ReviewDispatchViewModel({
        context: { allowedActions: ['request-review'], allowSequence: true },
      }),
    [resolvedDecisionId],
  );
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const router = useRouter();
  const isFocused = useIsFocused();
  const client = useConnectionStore((s) => s.client);
  const profileId = useConnectionStore((s) => s.activeProfileId);
  const authorityEpoch = useConnectionStore((s) => s.authorityEpoch);
  const scopeKey = JSON.stringify([resolvedDecisionId, profileId, authorityEpoch]);
  const scope = useRef({ key: scopeKey, client });
  if (scope.current.key !== scopeKey || scope.current.client !== client)
    scope.current = { key: scopeKey, client };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const captureCurrent = useCallback(() => {
    const owner = scope.current;
    const connected = client ? currentFarmConnection(client) : () => false;
    return () => mounted.current && scope.current === owner && connected();
  }, [client]);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const storeDecision = useDecisionStore((s) =>
    s.decisions.find((d) => d.id === resolvedDecisionId),
  );
  const decisionsObservation = useDecisionStore((s) => s.observation);
  const sourceRunId =
    decisionRunId(storeDecision ?? null) ?? (routeParamString(routeRunId).trim() || null);
  const sourceQuery = useMemo(
    () =>
      sourceRunId ? resourceQuery<RunGetResult>('run.get', { runId: sourceRunId }) : undefined,
    [sourceRunId],
  );
  const sourceObservation = useResourceQuery(sourceQuery);
  const sourceRun = sourceObservation.data?.run ?? null;
  const progressQuery = useMemo(() => {
    const target = taskProgressRequestForRun(sourceRun);
    return target ? resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, target) : undefined;
  }, [sourceRun?.id, sourceRun?.slotId, sourceRun?.reviewWorkspace?.workspaceId]);
  const progressObservation = useResourceQuery(progressQuery);
  const taskProgress = progressObservation.data?.structured ?? null;
  const taskProgressError = progressObservation.error
    ? `Task progress unavailable: ${progressObservation.error.message}`
    : null;
  const sourceDecision = sourceRun?.decisions.find(({ id }) => id === resolvedDecisionId);
  const decision = useMemo<DecisionDetail | null>(
    () =>
      sourceRun && sourceDecision
        ? decisionDetailFromRun(sourceRun, sourceDecision)
        : (storeDecision ?? null),
    [sourceRun, sourceDecision, storeDecision],
  );
  const actionsCurrent =
    client?.connectionState === 'connected' &&
    decisionsObservation.status === 'ready' &&
    (!sourceRunId || sourceObservation.status === 'ready');
  const [actionError, setError] = useState<string | null>(null);
  const error =
    actionError ??
    sourceObservation.error?.message ??
    progressObservation.error?.message ??
    decisionsObservation.error?.message ??
    (decisionsObservation.status === 'ready' &&
    (!sourceRunId || sourceObservation.status === 'ready') &&
    !decision
      ? 'Decision is no longer pending.'
      : null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [documentViewer, setDocumentViewer] = useState<DecisionDocumentContent | null>(null);
  useEffect(() => {
    // ADR-063 Amendment 5: a gate lists its lineages; rows preselect their runner's latest
    // available one in WARM.
    const lineageOptions = gateReviewLineageOptions(sourceRun, resolvedDecisionId);
    reviewPicker.setContext({
      ...reviewPicker.context,
      reviewLineages: reviewLineagesForRun(sourceRun),
      reviewContext: lineageOptions ? undefined : reviewRequestContextForRun(sourceRun),
      lineageOptions,
    });
  }, [resolvedDecisionId, reviewPicker, sourceRun]);
  const [loadingDocument, setLoadingDocument] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<{ decisionId: string; slotId: string } | null>(
    null,
  );
  const scrollRef = useRef<ScrollView>(null);
  const sectionOffsetsRef = useRef<Partial<Record<DecisionSectionKey, number>>>({});
  const documentAbortRef = useRef<AbortController | null>(null);
  const requestedArtifactPath = routeParamString(routeArtifactPath).trim();
  useEffect(() => {
    documentAbortRef.current?.abort();
    setError(null);
    setViewerUri(null);
    setDocumentViewer(null);
    setLoadingDocument(null);
  }, [scopeKey]);

  const refreshDecision = useCallback(() => {
    const cache = getResourceCache();
    if (!cache) return;
    setError(null);
    const current = captureCurrent();
    void Promise.all([
      cache.retry(nativeDecisionsQuery),
      ...(sourceQuery ? [cache.retry(sourceQuery)] : []),
      ...(progressQuery ? [cache.retry(progressQuery)] : []),
    ]).catch((failure: unknown) => {
      if (current()) setError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [sourceQuery, progressQuery, captureCurrent]);

  useEffect(() => {
    return () => {
      documentAbortRef.current?.abort();
    };
  }, []);

  const focusGateClaim = (claimId: string) => {
    if (!sourceRunId || !decision) return;
    const href = gateReviewHref(sourceRunId, decision.id);
    router.push({ ...href, params: { ...href.params, ac: claimId } });
  };
  const decisionWithRunContext = useMemo(
    () => enrichDecisionWithRunContext(decision, sourceRun),
    [decision, sourceRun],
  );
  const reviewPublication = useReviewPublication(sourceRun, decision);
  const presentation = useMemo(
    () => (decisionWithRunContext ? presentDecision(decisionWithRunContext) : null),
    [decisionWithRunContext],
  );
  const ciContext = useDecisionCIContext(
    decisionWithRunContext,
    presentation?.prNumber ?? null,
    sourceRun?.project ?? presentation?.project ?? null,
    presentation?.repo ?? null,
  );
  const slotPicker = useMemo(
    () =>
      decision?.payload?.kind === 'slot_picker'
        ? slotPickerViewModel(
            decision.payload,
            selectedSlot?.decisionId === decision.id ? selectedSlot.slotId : null,
          )
        : null,
    [decision, selectedSlot],
  );
  const decisionRouteContext = useMemo(
    () => decisionWorkspaceRouteParams(presentation?.kind),
    [presentation?.kind],
  );

  // ADR-054 gate choices. The posture comes from `runtime.posture.status` and the
  // effect of a choice from `runtime.posture.preview`; nothing on this screen
  // resolves retention policy of its own.
  const { posture: runPostureStatus } = useRunResourcePosture(
    client,
    sourceRunId,
    sourceRun?.updatedAt ?? '',
  );
  const runPosture = runPostureStatus.state?.posture;
  // The gate review's publish guard applies here too: this tab sends the same actions.
  const humanGate = useHumanGateGuard(client, sourceRun, decision);
  const draftState = useGateCriterionDrafts({
    runId: sourceRunId,
    decision,
    acceptance: humanGate?.acceptance,
    client,
  });
  const [acceptingGateId, setAcceptingGateId] = useState<string | null>(null);
  const supersedingResultId = supersedingResultDecisionId(decision, sourceRun);
  useEffect(() => {
    if (supersedingResultId) router.setParams({ decisionId: supersedingResultId });
  }, [router, supersedingResultId]);
  // A held run's output review carries the evidence and overrides shown under its result decision.
  const outputReviewDecision =
    decision?.payload?.kind === 'result-decision'
      ? sourceRun?.decisions.find(
          (item) =>
            decision.payload?.kind === 'result-decision' &&
            item.id === decision.payload.outputReviewDecisionId,
        )
      : decision;
  const outputReviewPayload =
    outputReviewDecision?.payload?.kind === 'output-review'
      ? outputReviewDecision.payload
      : undefined;
  const outputAcceptance = useRunAcceptance(client, outputReviewPayload ? sourceRun : null, {
    reportSnapshot: outputReviewPayload,
    decisionId: outputReviewPayload ? outputReviewDecision?.id : undefined,
  });
  const reviewBudget =
    decision?.payload?.kind === 'ready' ? decision.payload.reviewRoundBudget : null;
  const withheldActions = useMemo(
    () =>
      new Map(
        (humanGate?.actions ?? []).flatMap((action) =>
          action.disabledReason ? [[action.id, action.disabledReason] as const] : [],
        ),
      ),
    [humanGate],
  );
  const withheldActionsRef = useRef(withheldActions);
  withheldActionsRef.current = withheldActions;
  // Only `run.resolveDecision` carries a typed `resourcePosture`. A decision
  // reached through the route or `context.runId` alone resolves through
  // `decision.resolve`, which has nowhere to put a choice, so the choices must
  // not be offered for it.
  const postureAvailability = useMemo(
    () => ({ canForwardChoice: Boolean(decision?.runMeta), runPosture }),
    [decision?.runMeta, runPosture],
  );
  // Availability as of right now, for async handlers whose closure captured it
  // at request time. A response is only current if the run is still at the wait
  // the operator was answering.
  const postureAvailabilityRef = useRef(postureAvailability);
  useEffect(() => {
    postureAvailabilityRef.current = postureAvailability;
  }, [postureAvailability]);
  const [postureGate, setPostureGate] = useState(initialRunPostureGateState());
  // Mirrors the gate state synchronously. Deriving the next state from the
  // rendered value made two taps in one frame share a request id, so the first
  // choice's preview passed the staleness guard and rendered under the second.
  const postureGateRef = useRef(postureGate);
  const applyPostureGate = useCallback(
    (update: (current: RunPostureGateState) => RunPostureGateState) => {
      const next = update(postureGateRef.current);
      postureGateRef.current = next;
      setPostureGate(next);
      return next;
    },
    [],
  );
  const gateKey = postureGateKey(sourceRunId, resolvedDecisionId);
  useEffect(() => {
    // A plan is only true of the gate it was requested for and only while the
    // Gateway is still at that wait. Rebinding on both drops a preview in flight
    // for a decision the operator left, and clears a previewed rejection that
    // would otherwise keep blocking every action after the choices stop applying.
    applyPostureGate((current) =>
      runPostureGateForContext(current, { gateKey, ...postureAvailability }),
    );
  }, [applyPostureGate, gateKey, postureAvailability]);

  const selectPostureChoice = useCallback(
    (choice: ResourcePostureGateChoice) => {
      if (!client || !sourceRunId) return;
      const next = applyPostureGate((current) =>
        runPostureGateSelect(current, choice, postureAvailability),
      );
      if (!next.choice) return;
      const { gateKey: requestedGateKey, requestId } = next;
      client
        .request<RuntimePosturePreviewResult>(Methods.RUNTIME_POSTURE_PREVIEW, {
          runId: sourceRunId,
          gateChoice: next.choice,
        })
        .then((plan) => {
          applyPostureGate((current) =>
            runPostureGatePreviewLoaded(current, {
              gateKey: requestedGateKey,
              requestId,
              ...postureAvailabilityRef.current,
              plan,
            }),
          );
        })
        .catch((err: Error) => {
          applyPostureGate((current) =>
            runPostureGatePreviewFailed(current, {
              gateKey: requestedGateKey,
              requestId,
              ...postureAvailabilityRef.current,
              message: `Posture preview failed: ${err.message}`,
            }),
          );
        });
    },
    [applyPostureGate, client, postureAvailability, sourceRunId],
  );
  useEffect(() => {
    if (
      embedded ||
      !sourceRunId ||
      !presentation ||
      !['ready', 'review', 'no-change', 'retrospective'].includes(presentation.kind)
    ) {
      return;
    }
    router.replace({
      pathname: '/workspace/run/[runId]/gate',
      params: {
        runId: sourceRunId,
        decisionId: resolvedDecisionId,
        ...decisionWorkspaceRouteParams(presentation.kind),
      },
    });
  }, [embedded, presentation, resolvedDecisionId, router, sourceRunId]);
  const diffRouteContext = useMemo(
    () => targetWorkspaceRouteContextParams('diff', decisionRouteContext.decisionKind),
    [decisionRouteContext.decisionKind],
  );
  const checkedEvidenceModel =
    humanGate?.acceptance.evidenceModel ?? outputAcceptance.evidenceModel;
  const evidenceAcceptance =
    humanGate?.acceptance ?? (outputReviewPayload ? outputAcceptance : null);
  const pairs = useMemo(
    () =>
      presentation?.runId
        ? groupArtifacts(
            presentation.artifactManifest,
            gatewayUrl,
            presentation.runId,
            checkedEvidenceModel,
          )
        : [],
    [gatewayUrl, presentation?.artifactManifest, presentation?.runId, checkedEvidenceModel],
  );
  const diffArtifact = useMemo(
    () => (presentation ? diffArtifactCandidate(presentation.artifactManifest) : undefined),
    [presentation],
  );
  const recipeQuery = useMemo(
    () =>
      sourceRunId
        ? resourceQuery<RunRecipeRunsForRunResult>('run.recipeRunsForRun', { runId: sourceRunId })
        : undefined,
    [sourceRunId],
  );
  const recipeObservation = useResourceQuery(recipeQuery);
  const recipeRuns = recipeObservation.data?.recipeRuns ?? [];
  const recipeArtifactCount = recipeObservation.data
    ? recipeObservation.data.recipeRuns.reduce(
        (count, group) => count + artifactsForRecipeRun(group).length,
        0,
      )
    : null;
  const recipeAvailabilityError = recipeObservation.error?.message ?? null;

  const markOutputClaimUntestable = async (claimId: string, reason: string) => {
    const gate = sourceRun?.decisions.find(
      ({ id }) => id === (outputReviewDecision?.id ?? resolvedDecisionId),
    );
    const model = outputAcceptance.evidenceModel;
    if (!client || !sourceRun || !gate || !model) return;
    try {
      assertNativeRunReady(sourceRun.id, sourceRun);
      await requestClaimUntestableOverride(client, sourceRun.id, gate, model, claimId, reason);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  /** The gate's blocker actions: skip a criterion, or give it one more review round. */
  const gateBlockerAction = async (
    send: (gate: RunDecision, runId: string) => Promise<unknown>,
  ) => {
    if (!client || !sourceRun || !decision) return;
    try {
      assertNativeRunReady(sourceRun.id, sourceRun);
      assertNativeDecisionReady(decision.id);
      await send(decision, sourceRun.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const resolveAction = useCallback(
    (actionId: string, selectionData?: Record<string, unknown>, reason?: string) => {
      if (!client || !decision) return;
      try {
        assertNativeDecisionReady(decision.id);
        if (sourceRun) assertNativeRunReady(sourceRun.id, sourceRun);
      } catch (error) {
        Alert.alert(
          'Decision is not current',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const gateReasons = gateActionReasons(
        actionId,
        draftState.attestationReason,
        evidenceAttestationAvailable(
          decision.payload?.kind === 'ready' ? decision.payload.gateReadiness : undefined,
          actionId,
        ),
      );
      if (
        (gateReasons.evidenceAttestationReason !== undefined || gateReasons.reason !== undefined) &&
        !isValidEvidenceAttestationReason(draftState.attestationReason)
      ) {
        Alert.alert(
          'Written reason required',
          actionId === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION
            ? 'Explain the evidence policy attestation before approving.'
            : 'Explain why you accept these findings before publishing.',
        );
        return;
      }
      if (slotPicker && actionId === 'pick' && !slotPicker.selectedSlotId) {
        Alert.alert('Choose a slot', 'Select an available candidate before using this action.');
        return;
      }
      // A choice the Gateway already refused, or one whose effect is still
      // unproven, must not be sent: the decision would be consumed and the
      // refusal repeated with nothing left to undo.
      // Re-derived here rather than trusting the effect to have run: a decision
      // that cannot carry a choice, or a run that has left the wait, must not be
      // blocked by a verdict about a choice that no longer applies to it.
      const withheld = withheldActionsRef.current.get(actionId);
      if (withheld) {
        Alert.alert('Publish approval is disabled', withheld);
        return;
      }
      const gate = runPostureGateForContext(postureGate, { gateKey, ...postureAvailability });
      const postureBlock = postureResolveBlock(gate, postureAvailability);
      if (!canResolveWithPostureChoice(gate, postureAvailability)) {
        Alert.alert('Resource posture', postureBlock.message);
        return;
      }
      const resourcePosture = postureChoiceForResolve(gate, postureAvailability);
      const curatedPost = decision.type === 'engine_review_posting' && actionId === 'post';
      if (curatedPost && (!reviewPublication.curation || !decisionWithRunContext?.runMeta)) {
        Alert.alert('Review unavailable', 'Load the review run before posting selected findings.');
        return;
      }
      const reviewStillCurrent = curatedPost ? reviewPublication.captureCurrent() : null;
      const resolveRequest = decisionResolveRequest(
        curatedPost ? decisionWithRunContext! : decision,
        actionId,
        resourcePosture,
        curatedPost
          ? reviewPublication.selectionData
          : slotPicker && actionId === 'pick'
            ? { slotId: slotPicker.selectedSlotId }
            : selectionData,
        gateReasons.evidenceAttestationReason,
        reason ?? gateReasons.reason,
      );
      const { method } = resolveRequest;

      // Transition ids already on screen. `run.resolveDecision` returns before
      // reconciliation finishes, so the run it returns still carries the previous
      // transition; anything already in this baseline is not this resolution's
      // outcome and must never be reported as one.
      const baseline = resourcePostureTransitionBaseline(
        runPostureStatus.state,
        resourcePosture ?? null,
      );

      const actionLabel =
        decision.actions.find((action) => action.id === actionId)?.label ?? actionId;
      Alert.alert('Confirm action', `${actionLabel} for ${decision.title}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send',
          onPress: () => {
            try {
              assertNativeDecisionReady(decision.id);
              if (sourceRun) assertNativeRunReady(sourceRun.id, sourceRun);
            } catch (error) {
              Alert.alert(
                'Decision is not current',
                error instanceof Error ? error.message : String(error),
              );
              return;
            }
            if (reviewStillCurrent && !reviewStillCurrent()) {
              Alert.alert('Review changed', 'Inspect the current review before posting.');
              return;
            }
            // The guard may have changed while the confirmation was open.
            const withheldNow = withheldActionsRef.current.get(actionId);
            if (withheldNow) {
              Alert.alert('Publish approval is disabled', withheldNow);
              return;
            }
            const current = captureCurrent();
            const scope = draftState.model.scopeVersion;
            // Writes stay direct; the cached run and decisions observe their notifications.
            void draftState
              .submit({
                run: sourceRun,
                decision,
                actionId,
                reason: draftState.reasonInput,
                selectionData,
                resourcePosture,
                applied: () => {},
                fallback: () => sendDecisionResolveRequest(client, resolveRequest),
              })
              .then((result) => {
                if (!current() || scope !== draftState.model.scopeVersion) return;
                if (method === Methods.IMPROVEMENT_APPLY) {
                  const outcome = improvementApplyOutcome(result as ImprovementApplyResult);
                  if (!outcome.passed) {
                    Alert.alert('Improvement remains pending', outcome.message);
                    return;
                  }
                }
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                if (embedded && sourceRunId) {
                  router.replace({
                    pathname: '/workspace/run/[runId]/evidence',
                    params: { runId: sourceRunId },
                  });
                } else {
                  router.back();
                }
                // The decision is resolved either way, so navigation is not held
                // for reconciliation. Only a choice the operator actually made is
                // worth following: without one there is no outcome they asked for.
                if (!resourcePosture || !sourceRunId) return;
                void observePostureTransition(
                  baseline,
                  async () => {
                    const status = await client.request<RuntimePostureStatusResult>(
                      Methods.RUNTIME_POSTURE_STATUS,
                      { runId: sourceRunId },
                    );
                    return status.state;
                  },
                  {
                    attempts: POSTURE_APPLY_POLL_ATTEMPTS,
                    delayMs: POSTURE_APPLY_POLL_DELAY_MS,
                    // Backgrounding the app right after resolving pauses gateway
                    // requests. That is routine, not an unknown outcome, so the
                    // wait rides it out instead of alarming the operator.
                    isTransient: isGatewayBackgroundPauseError,
                  },
                ).then((observation) => {
                  if (observation.status === 'observed') {
                    applyPostureGate((current) =>
                      runPostureGateApplied(current, observation.transition),
                    );
                  }
                  const alert = postureApplyAlert(observation, resourcePosture);
                  if (alert) Alert.alert(alert.title, alert.message);
                });
              })
              .catch((err: Error) => {
                if (current()) draftState.reportError(scope, 'Failed to resolve')(err);
              });
          },
        },
      ]);
    },
    [
      applyPostureGate,
      draftState,
      client,
      decision,
      decisionWithRunContext,
      embedded,
      gateKey,
      postureAvailability,
      postureGate,
      reviewPublication,
      router,
      runPostureStatus.state,
      sourceRun,
      sourceRunId,
      slotPicker,
    ],
  );

  const openDocumentArtifact = useCallback(
    (artifact: ArtifactManifestEntry) => {
      if (!presentation?.runId) return;
      const sharedArtifact = decisionDocumentSelection(
        presentation.runId,
        sourceRun?.slotId ?? undefined,
        artifact,
      );
      const url = recordedEvidenceArtifactUrl(
        gatewayUrl,
        presentation.runId,
        checkedEvidenceModel,
        artifact,
      );
      documentAbortRef.current?.abort();
      const controller = new AbortController();
      documentAbortRef.current = controller;
      setLoadingDocument(artifact.path);
      const current = captureCurrent();
      gatewayFetch(url, artifactAuthHeaders, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((body) => {
          if (current())
            setDocumentViewer({ title: documentTitle(artifact.path), body, sharedArtifact });
        })
        .catch((err: Error) => {
          // Abort is the expected cleanup path when the operator closes/navigates mid-fetch.
          if (err.name === 'AbortError' || !current()) return;
          Alert.alert('Failed to load document', err.message);
        })
        .finally(() => {
          if (!controller.signal.aborted && current()) setLoadingDocument(null);
        });
    },
    [
      artifactAuthHeaders,
      checkedEvidenceModel,
      gatewayUrl,
      presentation?.runId,
      captureCurrent,
      sourceRun?.slotId,
    ],
  );

  const outputReport = useRunOutputReport({
    evidenceModel: outputAcceptance.evidenceModel,
    runId: presentation?.runId,
    gatewayUrl,
    authHeaders: artifactAuthHeaders,
    contextKey: scopeKey,
  });

  const openDiffArtifact = useCallback(
    (path: string, replace = false) => {
      if (!presentation?.runId) return;
      const routeRecipeRunId = routeParamString(routeRecipeRun).trim();
      const href = {
        pathname: '/workspace/run/[runId]/diff',
        params: {
          runId: presentation.runId,
          ...diffRouteContext,
          path,
          recipeRun: routeRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM,
        },
      } as const;
      if (replace) {
        router.replace(href);
        return;
      }
      router.push(href);
    },
    [diffRouteContext, presentation?.runId, routeRecipeRun, router],
  );

  const openArtifactWorkspaceForDecision = useCallback(
    (artifact: ArtifactManifestEntry) => {
      if (!presentation?.runId) return;
      if (diffArtifactCandidate([artifact])?.path === artifact.path) {
        openDiffArtifact(artifact.path);
        return;
      }
      router.push({
        pathname: '/workspace/run/[runId]/files',
        params: {
          runId: presentation.runId,
          ...decisionRouteContext,
          recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
          evidenceDecision: decision?.id,
          artifact: artifact.path,
          filter:
            artifactFilterParamForArtifactPath(artifact.path) ??
            artifactFilterParamForWorkspaceNav('review'),
        },
      });
    },
    [decisionRouteContext, openDiffArtifact, presentation?.runId, router, decision?.id],
  );

  const rememberSection = useCallback(
    (section: DecisionSectionKey) => (event: LayoutChangeEvent) => {
      sectionOffsetsRef.current[section] = event.nativeEvent.layout.y;
    },
    [],
  );

  const scrollToSection = useCallback((section: DecisionSectionKey) => {
    const sectionOffset = sectionOffsetsRef.current[section];
    if (typeof sectionOffset !== 'number') return;
    scrollRef.current?.scrollTo({
      y: Math.max(0, sectionOffset - spacing.md),
      animated: true,
    });
  }, []);

  const recipeFallbackPairs = useMemo(
    () =>
      presentation?.runId && pairs.length === 0
        ? groupVisualArtifactPairs(
            selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
            (artifact) => artifactUrlForEntry(gatewayUrl, presentation.runId!, artifact),
            checkedEvidenceModel,
          ).pairs
        : [],
    [gatewayUrl, pairs.length, presentation?.runId, recipeRuns, checkedEvidenceModel],
  );
  const recipeScopedArtifacts = useMemo(
    () => selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
    [recipeRuns],
  );
  const visualReviewSource = useMemo(
    () =>
      findVisualReviewSourceArtifacts([
        ...(presentation?.artifactManifest ?? []),
        ...recipeRuns.flatMap(artifactsForRecipeRun),
      ])[0] ?? null,
    [presentation?.artifactManifest, recipeRuns],
  );
  const recipePreviewArtifacts = useMemo(
    () => recipeScopedArtifacts.slice(0, 4),
    [recipeScopedArtifacts],
  );
  const recipeVisualPairs = useMemo(
    () =>
      presentation?.runId
        ? groupVisualArtifactPairs(
            recipeScopedArtifacts,
            (artifact) => artifactUrlForEntry(gatewayUrl, presentation.runId!, artifact),
            checkedEvidenceModel,
          ).pairs
        : [],
    [gatewayUrl, presentation?.runId, recipeScopedArtifacts, checkedEvidenceModel],
  );
  const priorityPairs = pairs.length > 0 ? pairs : recipeFallbackPairs;
  const primaryPair = priorityPairs[0] ?? null;
  const primaryPairIsRecipeFallback = pairs.length === 0 && recipeFallbackPairs.length > 0;
  const priorityCompareRecipeRunId = primaryPairIsRecipeFallback
    ? recipeRunIdForVisualPair(recipeRuns, primaryPair)
    : DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const [comparisonViewerItems, setComparisonViewerItems] = useState<MediaViewerItem[] | null>(
    null,
  );
  const openVisualArtifact = (uri: string) => {
    checkedEvidenceModel?.clearSelection();
    setComparisonViewerItems(null);
    setViewerUri(uri);
  };
  const visualViewerItems = useMemo(
    () =>
      decisionEvidenceMediaItems({
        runId: presentation?.runId,
        slotId: sourceRun?.slotId ?? undefined,
        artifacts: presentation?.artifactManifest ?? [],
        gatewayUrl,
        authHeaders: artifactAuthHeaders,
        recordedModel: checkedEvidenceModel,
        evidenceModel: humanGate?.acceptance.evidenceModel ?? outputAcceptance.evidenceModel,
        recipeFallbackPairs,
      }),
    [
      artifactAuthHeaders,
      gatewayUrl,
      presentation?.artifactManifest,
      presentation?.runId,
      recipeFallbackPairs,
      checkedEvidenceModel,
      sourceRun?.slotId,
      humanGate?.acceptance.evidenceModel,
      outputAcceptance.evidenceModel,
    ],
  );

  if (!decision || !presentation) {
    return (
      <View style={[baseStyles.container, styles.center, { paddingBottom: insets.bottom }]}>
        <GateReviewSkeleton error={error ?? undefined} retry={refreshDecision} />
      </View>
    );
  }

  const toneColor = TONE_COLORS[presentation.tone];
  const { items: viewerItems, index: viewerIndex } = evidenceViewerSelection(
    viewerUri,
    visualViewerItems,
    comparisonViewerItems,
  );
  const canShowViewer = viewerUri != null && viewerIndex >= 0;
  const readyDecision = selectReadyWorkspaceDecision(sourceRun) ?? null;
  const reviewGateDecision = selectReviewGateWorkspaceDecision(sourceRun) ?? null;
  const retroDecision = selectRetrospectiveWorkspaceDecision(sourceRun) ?? null;
  const activeTaskProgress = isWorkerProgressActive(sourceRun)
    ? (effectiveTaskProgressForRun(sourceRun, taskProgress) ?? null)
    : null;
  const fallbackTaskProgress =
    !activeTaskProgress && isWorkerProgressActive(sourceRun)
      ? fallbackTaskProgressSummary(sourceRun)
      : null;
  const currentDecisionIsReady = presentation.kind === 'ready';
  const currentDecisionIsReview =
    presentation.kind === 'review' || presentation.kind === 'no-change';
  const currentDecisionIsRetro = presentation.kind === 'retrospective';
  const readyDecisionId = readyDecision?.id ?? (currentDecisionIsReady ? decision.id : null);
  const reviewDecisionId = reviewGateDecision?.id ?? (currentDecisionIsReview ? decision.id : null);
  const retroDecisionId = retroDecision?.id ?? (currentDecisionIsRetro ? decision.id : null);
  const recipeAvailable = recipeArtifactCount === null ? undefined : recipeArtifactCount > 0;
  const routeRecipeRunId = routeParamString(routeRecipeRun).trim();
  const workspaceRecipeRunId = presentation.runId
    ? routeRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM
    : null;
  const diffAvailable = Boolean(
    diffArtifact?.path || presentation.diffStat || (sourceRun && hasRunWorkspaceDiff(sourceRun)),
  );
  const decisionDiffValue = presentation.diffStat
    ? `+${presentation.diffStat.additions} -${presentation.diffStat.deletions}`
    : diffArtifact?.path
      ? 'artifact'
      : diffAvailable
        ? 'workspace'
        : presentation.terminalSlotId
          ? 'slot'
          : 'none';
  const focusedArtifactPath = requestedArtifactPath || diffArtifact?.path || null;

  return (
    <View style={baseStyles.container}>
      <ResourceReadStatus
        observations={[
          { observation: decisionsObservation, label: 'decisions' },
          ...(sourceRunId ? [{ observation: sourceObservation, label: 'run' }] : []),
          ...(progressQuery ? [{ observation: progressObservation, label: 'task progress' }] : []),
        ]}
      />
      {!embedded ? (
        <Stack.Screen
          options={{
            title:
              presentation.kind === 'retrospective'
                ? 'Retrospective'
                : presentation.kind === 'ready'
                  ? 'Ready Gate'
                  : 'Review Gate',
          }}
        />
      ) : null}
      <Animated.ScrollView
        testID="companion-screen-decision-workspace"
        collapsable={false}
        ref={scrollRef}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: styles.scrollContent.paddingBottom + insets.bottom },
        ]}
      >
        <View style={[styles.headerCard, { borderLeftColor: toneColor }]}>
          <View style={styles.row}>
            <View style={[styles.kindBadge, { backgroundColor: toneColor + '25' }]}>
              <Text style={[styles.kindText, { color: toneColor }]}>{presentation.kindLabel}</Text>
            </View>
            <Text style={styles.ageText}>{new Date(decision.createdAt).toLocaleTimeString()}</Text>
          </View>
          <Text style={styles.title}>{presentation.title}</Text>
          {decision.type === 'engine_review_posting' ? <AskReviewer run={sourceRun} /> : null}
          <Text style={baseStyles.textSecondary}>
            {presentation.summary || presentation.description}
          </Text>
          {!embedded ? (
            <View style={styles.metaGrid}>
              <Meta label="Run" value={presentation.ticketOrPr ?? presentation.runId ?? '-'} />
              <Meta label="Slot" value={presentation.slotId ?? '-'} />
              <Meta label="Branch" value={presentation.branch ?? '-'} />
              <Meta label="Model" value={presentation.model ?? presentation.runner ?? '-'} />
            </View>
          ) : null}
        </View>

        {decision.type === HUMAN_GATE_DECISION_TYPE && !decision.resolvedAt && sourceRunId ? (
          <GateReviewEntryCard
            testID="companion-decision-open-gate-review"
            onOpen={() => router.push(gateReviewHref(sourceRunId, decision.id))}
          />
        ) : null}

        {!embedded && requestedArtifactPath ? (
          <DecisionFocusedArtifactCard
            artifactPath={requestedArtifactPath}
            runId={presentation.runId}
            slotId={presentation.terminalSlotId}
            familyId={presentation.familyId}
            prNumber={presentation.prNumber}
            recipeAvailable={recipeAvailable}
            recipeRunId={workspaceRecipeRunId}
            contextLabel={
              presentation.kind === 'retrospective' ? 'retro context' : 'review context'
            }
            comparePairCount={priorityPairs.length}
            onOpenArtifact={() => {
              if (!presentation.runId) return;
              const artifactFilter = artifactFilterParamForArtifactPath(requestedArtifactPath);
              const artifactRecipeRun =
                artifactFilter === 'recipes'
                  ? recipeWorkspaceParam(workspaceRecipeRunId)
                  : (workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM);
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: artifactRecipeRun,
                  filter: artifactFilter ?? artifactFilterParamForWorkspaceNav('review'),
                  artifact: requestedArtifactPath,
                },
              });
            }}
            onOpenRecipe={() => {
              if (!presentation.runId || recipeAvailable === false) return;
              const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: recipeTarget,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                  ...(shouldPreserveArtifactForRecipeContext(recipeTarget, requestedArtifactPath)
                    ? { artifact: requestedArtifactPath }
                    : {}),
                },
              });
            }}
            onOpenDiff={() => openDiffArtifact(requestedArtifactPath)}
            onOpenCompare={() => {
              if (!presentation.runId || !primaryPair) return;
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: priorityCompareRecipeRunId,
                  filter: artifactFilterParamForWorkspaceNav('compare'),
                  artifact: primaryPair.after.path,
                },
              });
            }}
            onOpenRun={() => {
              if (!presentation.runId) return;
              router.push({
                pathname: '/workspace/run/[runId]/evidence',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: requestedArtifactPath,
                },
              });
            }}
            onOpenSlot={() => {
              if (!presentation.terminalSlotId || !presentation.runId) return;
              router.push({
                pathname: '/workspace/slot/[slotId]/slot',
                params: {
                  slotId: presentation.terminalSlotId,
                  ...decisionRouteContext,
                  runId: presentation.runId,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: requestedArtifactPath,
                },
              });
            }}
            onOpenTerminal={() => {
              if (!presentation.terminalSlotId || !presentation.runId) return;
              router.push({
                pathname: '/workspace/slot/[slotId]/terminal',
                params: {
                  slotId: presentation.terminalSlotId,
                  ...decisionRouteContext,
                  runId: presentation.runId,
                  details: '1',
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: requestedArtifactPath,
                },
              });
            }}
            onOpenFamily={() => {
              if (!presentation.familyId || !presentation.runId) return;
              router.push({
                pathname: '/family/[familyId]',
                params: {
                  familyId: presentation.familyId,
                  ...((sourceRun?.project ?? presentation.project)
                    ? { project: sourceRun?.project ?? presentation.project }
                    : {}),
                  ...familySectionRouteContextParams(
                    presentation.kind === 'retrospective' ? 'retros' : 'focus',
                    decisionRouteContext.decisionKind,
                  ),
                  runId: presentation.runId,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: requestedArtifactPath,
                  section: presentation.kind === 'retrospective' ? 'retros' : 'focus',
                },
              });
            }}
            onOpenPR={() => {
              if (!presentation.prNumber) return;
              router.push({
                pathname: '/(tabs)/prs',
                params: {
                  pr: String(presentation.prNumber),
                  ...decisionRouteContext,
                  ...(presentation.repo ? { repo: presentation.repo } : {}),
                },
              });
            }}
          />
        ) : null}

        {!embedded && primaryPair ? (
          <DecisionBeforeAfterPriorityPanel
            pair={primaryPair}
            pairCount={priorityPairs.length}
            kindLabel={presentation.kindLabel}
            recipeFallback={primaryPairIsRecipeFallback}
            authHeaders={artifactAuthHeaders}
            artifactCount={presentation.artifactManifest.length}
            recipeArtifactCount={recipeArtifactCount}
            recipeAvailable={recipeAvailable}
            diffValue={decisionDiffValue}
            slotId={presentation.terminalSlotId}
            familyId={presentation.familyId}
            prNumber={presentation.prNumber}
            onOpenArtifact={(artifactPath) => {
              const visualTarget = [primaryPair.before, primaryPair.after].find(
                (artifact) => artifact.path === artifactPath,
              );
              if (visualTarget && ['image', 'video'].includes(classifyArtifact(visualTarget))) {
                openVisualArtifact(visualTarget.url);
                return;
              }
              const target = presentation.artifactManifest.find(
                (artifact) => artifact.path === artifactPath,
              );
              if (target) {
                openArtifactWorkspaceForDecision(target);
                return;
              }
              if (!primaryPairIsRecipeFallback || !presentation.runId) return;
              const recipeTarget = [primaryPair.before, primaryPair.after].find(
                (artifact) => artifact.path === artifactPath,
              );
              if (!recipeTarget) return;
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: priorityCompareRecipeRunId,
                  filter: artifactFilterParamForWorkspaceNav('compare'),
                  artifact: recipeTarget.path,
                },
              });
            }}
            onOpenCompare={() => {
              if (!presentation.runId) return;
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: priorityCompareRecipeRunId,
                  filter: artifactFilterParamForWorkspaceNav('compare'),
                  artifact: primaryPair.after.path,
                },
              });
            }}
            onOpenEvidence={() => {
              if (!presentation.runId) return;
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  filter: artifactFilterParamForWorkspaceNav('review'),
                },
              });
            }}
            onOpenRecipe={() => {
              if (!presentation.runId || recipeAvailable === false) return;
              const recipeTarget = recipeWorkspaceParam(workspaceRecipeRunId);
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: recipeTarget,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                  ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifactPath)
                    ? { artifact: focusedArtifactPath }
                    : {}),
                },
              });
            }}
            onOpenDiff={() => {
              if (diffArtifact?.path) {
                openDiffArtifact(diffArtifact.path);
                return;
              }
              if (presentation.runId && diffAvailable) {
                router.push({
                  pathname: '/workspace/run/[runId]/diff',
                  params: {
                    runId: presentation.runId,
                    ...diffRouteContext,
                    recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                });
                return;
              }
              if (presentation.terminalSlotId) {
                router.push({
                  pathname: '/workspace/slot/[slotId]/diff',
                  params: {
                    slotId: presentation.terminalSlotId,
                    ...diffRouteContext,
                  },
                });
              }
            }}
            onOpenRun={() => {
              if (!presentation.runId) return;
              router.push({
                pathname: '/workspace/run/[runId]/evidence',
                params: {
                  runId: presentation.runId,
                  ...decisionRouteContext,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                },
              });
            }}
            onOpenFamily={() => {
              if (!presentation.familyId || !presentation.runId) return;
              router.push({
                pathname: '/family/[familyId]',
                params: {
                  familyId: presentation.familyId,
                  ...((sourceRun?.project ?? presentation.project)
                    ? { project: sourceRun?.project ?? presentation.project }
                    : {}),
                  ...familySectionRouteContextParams(
                    presentation.kind === 'retrospective' ? 'retros' : 'focus',
                    decisionRouteContext.decisionKind,
                  ),
                  runId: presentation.runId,
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                  section: presentation.kind === 'retrospective' ? 'retros' : 'focus',
                },
              });
            }}
            onOpenTerminal={() => {
              if (!presentation.terminalSlotId || !presentation.runId) return;
              router.push({
                pathname: '/workspace/slot/[slotId]/terminal',
                params: {
                  slotId: presentation.terminalSlotId,
                  ...decisionRouteContext,
                  runId: presentation.runId,
                  details: '1',
                  recipeRun: workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                },
              });
            }}
            onOpenPR={() => {
              if (!presentation.prNumber) return;
              router.push({
                pathname: '/(tabs)/prs',
                params: {
                  pr: String(presentation.prNumber),
                  ...decisionRouteContext,
                  ...(presentation.repo ? { repo: presentation.repo } : {}),
                },
              });
            }}
          />
        ) : null}

        {!embedded || ciContext.view ? (
          <DecisionWorkspaceCockpit
            ci={ciContext.view}
            ciBusy={ciContext.busy}
            ciError={ciContext.error}
            onRefreshCI={ciContext.refresh}
            onOpenCILink={ciContext.openLink}
            compact={embedded}
            presentation={presentation}
            currentDecisionId={decision.id}
            readyDecisionId={readyDecisionId}
            reviewDecisionId={reviewDecisionId}
            retroDecisionId={retroDecisionId}
            diffPath={diffArtifact?.path}
            recipeArtifactCount={recipeArtifactCount}
            recipeAvailable={recipeAvailable}
            diffAvailable={diffAvailable}
            visualPairCount={priorityPairs.length}
            compareArtifactPath={primaryPair?.after.path ?? null}
            compareRecipeRunId={priorityCompareRecipeRunId}
            focusedArtifactPath={focusedArtifactPath}
            workspaceRecipeRunId={workspaceRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM}
            onJumpSignals={() => scrollToSection('signals')}
            onJumpEvidence={() => scrollToSection('evidence')}
            onJumpReports={() => scrollToSection('reports')}
            activeTaskProgress={activeTaskProgress}
            fallbackTaskProgress={fallbackTaskProgress}
            sourceRun={sourceRun}
            decisionRouteContext={decisionRouteContext}
            onJumpProgress={() => scrollToSection('progress')}
            onJumpTerminal={() => scrollToSection('terminal')}
            onJumpActions={() => scrollToSection('actions')}
          />
        ) : null}

        {error && <Text style={styles.errorText}>{error}</Text>}
        {recipeAvailabilityError && <Text style={styles.errorText}>{recipeAvailabilityError}</Text>}

        {!embedded && presentation.runId && visualReviewSource ? (
          <VisualReviewEntryCard
            onOpen={() =>
              router.push({
                pathname: '/visual-review/[runId]',
                params: {
                  runId: presentation.runId!,
                  source: visualReviewSource.path,
                  ...(visualReviewSource.recipeRunId
                    ? { recipeRun: visualReviewSource.recipeRunId }
                    : {}),
                },
              })
            }
          />
        ) : null}

        {!embedded && activeTaskProgress ? (
          <View
            testID="companion-decision-section-timeline"
            style={styles.section}
            onLayout={rememberSection('progress')}
          >
            <Text style={styles.sectionTitle}>Worker progress</Text>
            <TaskProgressPanel
              run={sourceRun}
              progress={activeTaskProgress}
              error={taskProgressError}
              compact
            />
          </View>
        ) : !embedded && fallbackTaskProgress ? (
          <View
            testID="companion-decision-section-timeline"
            style={styles.section}
            onLayout={rememberSection('progress')}
          >
            <Text style={styles.sectionTitle}>Worker progress</Text>
            <TaskProgressPanel summary={fallbackTaskProgress} error={taskProgressError} compact />
          </View>
        ) : null}

        {showReviewHistory && sourceRun ? <ReviewHistoryPanel run={sourceRun} /> : null}

        {presentation.highlights.length > 0 && (
          <View
            testID={
              !activeTaskProgress && !fallbackTaskProgress
                ? 'companion-decision-section-timeline'
                : undefined
            }
            style={styles.section}
            onLayout={rememberSection('signals')}
          >
            <Text style={styles.sectionTitle}>Gate signals</Text>
            <View style={styles.chipWrap}>
              {presentation.highlights.map((item) => {
                const color = TONE_COLORS[item.tone ?? 'info'];
                const target = signalTarget(
                  item.label,
                  presentation.runId,
                  diffArtifact?.path,
                  primaryPair?.after.path,
                  priorityCompareRecipeRunId,
                  decisionRouteContext,
                );
                const content = (
                  <>
                    <Text style={[styles.signalLabel, { color }]}>{item.label}</Text>
                    <View style={styles.signalValueRow}>
                      <Text style={styles.signalValue}>{item.value}</Text>
                      {target && <Text style={[styles.signalArrow, { color }]}>›</Text>}
                    </View>
                  </>
                );
                if (target) {
                  return (
                    <Pressable
                      key={`${item.label}-${item.value}`}
                      style={[
                        styles.signalChip,
                        styles.signalChipPressable,
                        { borderColor: color + '80' },
                      ]}
                      onPress={() => router.push(target)}
                    >
                      {content}
                    </Pressable>
                  );
                }
                return (
                  <View
                    key={`${item.label}-${item.value}`}
                    style={[styles.signalChip, { borderColor: color + '80' }]}
                  >
                    {content}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {presentation.criteria.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Acceptance criteria</Text>
            {presentation.criteria.map((criterion) => (
              <Text key={criterion} style={styles.bullet}>
                • {criterion}
              </Text>
            ))}
          </View>
        )}

        {!embedded && presentation.artifactManifest.length > 0 && presentation.runId && (
          <View
            testID="companion-decision-section-evidence"
            style={styles.section}
            onLayout={rememberSection('evidence')}
          >
            <Text style={styles.sectionTitle}>Evidence</Text>
            <EvidenceReviewWorkspace
              loading={evidenceAcceptance?.evidenceLoading}
              error={evidenceAcceptance?.evidenceError}
              retry={taskProgressRequestForRun(sourceRun) ? evidenceAcceptance?.retry : undefined}
              runId={presentation.runId}
              gatewayUrl={gatewayUrl}
              artifacts={presentation.artifactManifest}
              pairs={pairs}
              evidenceModel={humanGate?.acceptance.evidenceModel ?? outputAcceptance.evidenceModel}
              reviewer={humanGate?.acceptance.reviewer ?? outputAcceptance.reviewer}
              onRecordVisualReview={
                actionsCurrent && (humanGate?.acceptance ?? outputAcceptance).commandsReady
                  ? (humanGate?.acceptance.recordVisualReview ??
                    outputAcceptance.recordVisualReview)
                  : undefined
              }
              onFocusClaim={(offset) => {
                const section = sectionOffsetsRef.current.evidence;
                if (typeof section === 'number')
                  scrollRef.current?.scrollTo({
                    y: Math.max(0, section + offset - spacing.md),
                    animated: true,
                  });
              }}
              onOpenRecordedEvidence={(model, path) => {
                const item = selectedEvidenceMediaItem(
                  model,
                  path,
                  (path) =>
                    recordedEvidenceArtifactUrl(gatewayUrl, presentation.runId!, model, path),
                  artifactAuthHeaders,
                  { runId: presentation.runId!, slotId: sourceRun?.slotId ?? undefined },
                );
                setComparisonViewerItems([item]);
                setViewerUri(item.uri);
              }}
              authHeaders={artifactAuthHeaders}
              onOpenVisual={openVisualArtifact}
              onOpenDocument={openDocumentArtifact}
              onOpenDiff={openDiffArtifact}
              onOpenArtifactWorkspace={openArtifactWorkspaceForDecision}
            />
            {loadingDocument && (
              <Text style={baseStyles.textMuted}>Loading {loadingDocument}...</Text>
            )}
          </View>
        )}

        {!embedded && presentation.runId && recipeRuns.length > 0 ? (
          <DecisionRecipeEvidenceSection
            runId={presentation.runId}
            recipeArtifactCount={recipeArtifactCount}
            recipeAvailable={recipeAvailable}
            previewArtifacts={recipePreviewArtifacts}
            primaryPair={recipeVisualPairs[0] ?? null}
            authHeaders={artifactAuthHeaders}
            gatewayUrl={gatewayUrl}
            onOpenRecipeArtifacts={() =>
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: presentation.runId!,
                  ...decisionRouteContext,
                  recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                },
              })
            }
            onOpenRecipeArtifact={(
              artifactPath,
              recipeRunId,
              filter = artifactFilterParamForWorkspaceNav('recipe'),
            ) => {
              if (diffArtifactCandidate([{ path: artifactPath }])) {
                router.push({
                  pathname: '/workspace/run/[runId]/diff',
                  params: {
                    runId: presentation.runId!,
                    ...diffRouteContext,
                    recipeRun: recipeRunId,
                    path: artifactPath,
                  },
                });
                return;
              }
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: presentation.runId!,
                  ...decisionRouteContext,
                  recipeRun: recipeRunId,
                  filter,
                  artifact: artifactPath,
                },
              });
            }}
          />
        ) : null}

        {outputReviewPayload ? (
          <View
            style={styles.section}
            onLayout={rememberSection('reports')}
            testID="companion-output-review"
          >
            <Text style={styles.sectionTitle}>Review QA output</Text>
            <Text style={baseStyles.textMuted}>
              Report snapshot {outputReviewPayload.manifestDigest}
            </Text>
            <Pressable
              accessibilityRole="button"
              testID="companion-output-report"
              disabled={!outputAcceptance.evidenceModel || outputReport.loading}
              onPress={() => void outputReport.open()}
            >
              <Text style={styles.reportTitle}>
                {outputReport.loading ? 'Reading verified report…' : 'Read verified report'}
              </Text>
            </Pressable>
            <ScrollView
              nestedScrollEnabled
              testID="companion-output-acceptance"
              style={{ height: acceptancePanelViewportHeight(undefined, viewport.height) }}
            >
              <TaskAcceptancePanel
                loading={outputAcceptance.loading}
                evidenceModel={outputAcceptance.evidenceModel}
                judgmentRows={outputAcceptance.evidenceModel?.judgmentRows(
                  outputAcceptance.reviewer,
                )}
                onRecordVisualReview={
                  actionsCurrent && outputAcceptance.commandsReady
                    ? outputAcceptance.recordVisualReview
                    : undefined
                }
                onMarkUntestable={
                  actionsCurrent && outputAcceptance.commandsReady
                    ? markOutputClaimUntestable
                    : undefined
                }
                acceptanceStatus={outputAcceptance.acceptanceStatus}
                acceptanceCriteria={outputAcceptance.acceptanceCriteria}
                error={outputAcceptance.error}
                onRetry={taskProgressRequestForRun(sourceRun) ? outputAcceptance.retry : undefined}
                onOpenEvidence={(criterionId, path) =>
                  router.push(
                    acceptanceEvidenceHref(
                      presentation.runId!,
                      criterionId,
                      path,
                      outputAcceptance.recipeRunId,
                      outputReviewDecision?.id,
                    ),
                  )
                }
              />
            </ScrollView>
          </View>
        ) : null}

        {presentation.textSections.length > 0 && (
          <View style={styles.section} onLayout={rememberSection('reports')}>
            <Text style={styles.sectionTitle}>Reports</Text>
            {presentation.textSections.map((section, index) => (
              <Pressable
                key={section.title}
                accessibilityRole="button"
                accessibilityLabel={`Open ${section.title}`}
                testID={`companion-decision-report-${index}`}
                style={({ pressed }) => [styles.reportCard, pressed && styles.reportCardPressed]}
                onPress={() => setDocumentViewer(section)}
              >
                <View style={styles.reportKindBadge}>
                  <Text style={styles.reportKindText}>MD</Text>
                </View>
                <Text style={styles.reportTitle} numberOfLines={1}>
                  {section.title}
                </Text>
                <Text style={styles.reportOpenText}>Open ›</Text>
              </Pressable>
            ))}
          </View>
        )}

        {!embedded &&
          (() => {
            const terminalSlotId = presentation.terminalSlotId;
            if (!terminalSlotId) return null;
            return (
              <View style={styles.section} onLayout={rememberSection('terminal')}>
                <Text style={styles.sectionTitle}>Worker terminal</Text>
                <Pressable
                  style={styles.terminalButton}
                  onPress={() =>
                    router.push({
                      pathname: '/workspace/slot/[slotId]/terminal',
                      params: {
                        slotId: terminalSlotId,
                        ...decisionRouteContext,
                        details: '1',
                        ...(presentation.runId ? { runId: presentation.runId } : {}),
                        ...(presentation.runId
                          ? { recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM }
                          : {}),
                        ...(focusedArtifactPath ? { artifact: focusedArtifactPath } : {}),
                      },
                    })
                  }
                >
                  <Text style={styles.terminalButtonText}>Observe / reply to {terminalSlotId}</Text>
                </Pressable>
              </View>
            );
          })()}

        <View style={styles.section} onLayout={rememberSection('actions')}>
          <Text style={styles.sectionTitle}>Evidence-reviewed actions</Text>
          {reviewBudget ? (
            <Text style={styles.safetyText} testID="companion-review-round-budget">
              {reviewRoundBudgetLabel(reviewBudget)}
              {reviewBudget.diagnosis ? `\n${reviewBudget.diagnosis}` : ''}
            </Text>
          ) : null}
          {reviewPublication.curation && <ReviewPublicationPanel {...reviewPublication} />}
          <View style={styles.safetyCard}>
            <Text style={styles.safetyTitle}>Resolve only from full context</Text>
            <Text style={styles.safetyText}>
              {embedded
                ? 'Use the Evidence, Diff, Timeline, and Files tabs for supporting context before sending a response.'
                : 'Mobile gate shortcuts route here first. Review the summary, criteria, visual evidence, reports, artifacts, and terminal context above before sending a response.'}
            </Text>
          </View>
          {decision.resolvedAt ? null : (
            <ResourcePostureGatePanel
              gate={postureGate}
              availability={postureAvailability}
              disabled={!actionsCurrent || !sourceRunId}
              onSelect={selectPostureChoice}
            />
          )}
          {decision.resolvedAt ? null : (
            <ResourcePostureWithheldNotice gate={postureGate} availability={postureAvailability} />
          )}
          {decision.resolvedAt ? null : (
            <RunGateParkNotice view={sourceRun ? liveGateParkView(sourceRun) : null} />
          )}
          {decision.resolvedAt || !slotPicker ? null : (
            <View>
              <PlanningChoices
                label="Candidate slot"
                testID="companion-decision-slot-picker"
                options={slotPicker.candidates.map((candidate) => ({
                  value: candidate.slotId,
                  label: `${candidate.slotId}\n${candidate.branch || 'default branch'} · ${candidate.machine} · ${candidate.lifecycle} · score ${candidate.score}`,
                }))}
                value={slotPicker.selectedSlotId ?? ''}
                disabled={!actionsCurrent}
                onChange={(slotId) => setSelectedSlot({ decisionId: decision.id, slotId })}
              />
              {slotPicker.candidates.length === 0 ? (
                <Text style={styles.safetyText}>
                  No available candidates. Wait for a slot or abort.
                </Text>
              ) : null}
              {slotPicker.unavailableCount > 0 ? (
                <Text style={styles.safetyText}>
                  {slotPicker.unavailableCount} busy or disabled slot(s) cannot be selected.
                </Text>
              ) : null}
            </View>
          )}
          {decision.resolvedAt ? (
            <View style={styles.resolvedDecisionCard}>
              <Text style={styles.safetyTitle}>Already resolved</Text>
              <Text style={styles.safetyText}>
                Action: {decision.resolvedAction ?? 'resolved'} ·{' '}
                {new Date(decision.resolvedAt).toLocaleString()}
              </Text>
            </View>
          ) : (
            <>
              {humanGate ? (
                <>
                  <GateBlockers
                    run={sourceRun}
                    decision={decision}
                    actions={humanGate.actions}
                    evidenceModel={humanGate.acceptance.evidenceModel}
                    reviewer={humanGate.acceptance.reviewer}
                    busy={!actionsCurrent}
                    reviewPicker={reviewPicker}
                    onRequestReview={(reviewRequest) =>
                      resolveAction('request-review', { reviewRequest })
                    }
                    onReviewEvidence={focusGateClaim}
                    acceptingFindings={acceptingGateId === decision.id}
                    onAcceptFindingsChange={(accepting) =>
                      setAcceptingGateId(accepting ? decision.id : null)
                    }
                    onAnotherRound={(brief) =>
                      gateBlockerAction((gate, runId) => {
                        if (!client) throw new Error('Not connected to the gateway.');
                        return requestAnotherReviewRound(client, runId, gate, brief);
                      })
                    }
                  />
                  <GateActions
                    inlineBlockers
                    run={sourceRun}
                    loading={humanGate.acceptance.loading}
                    decision={decision}
                    actions={humanGate.actions.map((action) =>
                      action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION &&
                      !decisionWithRunContext?.runMeta
                        ? { ...action, disabledReason: 'Run context is unavailable.' }
                        : action,
                    )}
                    disabled={!actionsCurrent}
                    reviewDisabled={reviewBudget?.remaining === 0}
                    sendingActionId={draftState.model.submissionActionId}
                    reviewPicker={reviewPicker}
                    claims={humanGate.acceptance.evidenceModel?.claims}
                    judgmentRows={humanGate.acceptance.evidenceModel?.judgmentRows(
                      humanGate.acceptance.reviewer,
                    )}
                    onRecordVisualReview={
                      actionsCurrent && humanGate.acceptance.commandsReady
                        ? humanGate.acceptance.recordVisualReview
                        : undefined
                    }
                    onRefreshPackage={async () => {
                      if (!client || !sourceRun || !decision) return;
                      const current = captureCurrent();
                      try {
                        assertNativeRunReady(sourceRun.id, sourceRun);
                        assertNativeDecisionReady(decision.id);
                        await client.request(Methods.RUN_REFRESH_PUBLISH_PACKAGE, {
                          runId: sourceRun.id,
                          decisionId: decision.id,
                        });
                      } catch (failure) {
                        if (current())
                          setError(failure instanceof Error ? failure.message : String(failure));
                      }
                    }}
                    pendingVisualClaimIds={
                      humanGate.acceptance.evidenceModel?.pendingVisualClaimIds
                    }
                    readiness={
                      decision.payload?.kind === 'ready'
                        ? decision.payload.gateReadiness
                        : undefined
                    }
                    onFocusClaim={focusGateClaim}
                    drafts={draftState.actions}
                    criterionDrafts={decision.resolvedAt ? [] : draftState.model.entries}
                    attestationReason={draftState.reasonInput}
                    onAttestationReason={draftState.setReason}
                    onResolve={(action, selection) => resolveAction(action.id, selection)}
                    acceptingFindings={acceptingGateId === decision.id}
                    onAcceptFindings={() => setAcceptingGateId(decision.id)}
                  />
                </>
              ) : decision.payload?.kind === 'result-decision' ? (
                <ResultDecisionPanel
                  view={resultDecisionView({ id: decision.id, payload: decision.payload })}
                  disabled={!actionsCurrent}
                  onAction={(actionId, reason) => resolveAction(actionId, undefined, reason)}
                />
              ) : (
                presentation.actions.map((action) => {
                  const disabled =
                    !actionsCurrent ||
                    withheldActions.has(action.id) ||
                    (action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION &&
                      (!isValidEvidenceAttestationReason(draftState.attestationReason) ||
                        !decisionWithRunContext?.runMeta)) ||
                    (decision.type === 'engine_review_posting' &&
                      action.id === 'post' &&
                      (!reviewPublication.curation ||
                        reviewPublication.disabled ||
                        reviewPublication.busy ||
                        reviewPublication.postBlocked ||
                        !decisionWithRunContext?.runMeta)) ||
                    (!!slotPicker && action.id === 'pick' && !slotPicker.selectedSlotId);
                  if (action.id === 'request-review') {
                    return (
                      <ReviewDispatchPicker
                        key={action.id}
                        model={reviewPicker}
                        testID="companion-gate-review"
                        disabled={!actionsCurrent || disabled || reviewBudget?.remaining === 0}
                        action="request-review"
                        actionLabel={action.label}
                        onInvoke={(actionId, payload) =>
                          resolveAction(actionId, { reviewRequest: payload })
                        }
                      />
                    );
                  }
                  return (
                    <Pressable
                      key={action.id}
                      testID={`companion-decision-action-${action.id}`}
                      disabled={disabled}
                      accessibilityState={{ disabled }}
                      style={[
                        styles.actionButton,
                        action.style === 'primary' && { backgroundColor: colors.accent },
                        action.style === 'danger' && { backgroundColor: colors.statusFail },
                        disabled && styles.actionButtonDisabled,
                      ]}
                      onPress={() => resolveAction(action.id)}
                    >
                      <Text style={styles.actionText}>{action.label}</Text>
                      {action.description && (
                        <Text style={styles.actionDescription}>{action.description}</Text>
                      )}
                    </Pressable>
                  );
                })
              )}
            </>
          )}
          <View
            testID="companion-screen-decision-workspace-end"
            accessible
            collapsable={false}
            accessibilityLabel="End of Decision workspace"
            style={styles.captureEndMarker}
          />
        </View>

        <MediaViewer
          testID="companion-artifact-media-viewer"
          visible={isFocused && canShowViewer}
          uri={viewerUri}
          items={viewerItems}
          authHeaders={artifactAuthHeaders}
          initialIndex={Math.max(0, viewerIndex)}
          onClose={() => {
            setViewerUri(null);
            setComparisonViewerItems(null);
          }}
        />
        <DocumentViewer
          visible={isFocused && !!documentViewer}
          sharedArtifact={documentViewer?.sharedArtifact}
          title={documentViewer?.title ?? ''}
          body={documentViewer?.body ?? ''}
          onClose={() => setDocumentViewer(null)}
        />
        <RunOutputReportViewer
          report={outputReport}
          visible={isFocused && Boolean(sourceRunId)}
          evidenceModel={outputAcceptance.evidenceModel}
          judgmentRows={
            outputAcceptance.evidenceModel?.judgmentRows(outputAcceptance.reviewer) ?? []
          }
          onRecordVisualReview={
            actionsCurrent && outputAcceptance.commandsReady
              ? outputAcceptance.recordVisualReview
              : undefined
          }
          onOpenEvidence={(criterionId, path) => {
            if (!sourceRunId) return;
            router.push(
              acceptanceEvidenceHref(
                sourceRunId,
                criterionId,
                path,
                outputAcceptance.recipeRunId,
                decision?.id,
              ),
            );
          }}
          onOpenArtifact={(path) =>
            openArtifactWorkspaceForDecision(
              outputAcceptance.evidenceModel?.report?.artifactManifest.find(
                (file) => file.path === path,
              ) ?? { path, purpose: 'artifact' },
            )
          }
        />
      </Animated.ScrollView>
    </View>
  );
}
