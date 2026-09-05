import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, type LayoutChangeEvent, Pressable, ScrollView, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  buildRunResolveDecisionParams,
  type DecisionListResult,
  Events,
  Methods,
  type RecipeRunArtifactGroup,
  type ResourcePostureGateChoice,
  reviewChainForRun,
  type Run,
  type RunGetResult,
  type RunRecipeRunsForRunResult,
  type RuntimePosturePreviewResult,
  type RuntimePostureStatusResult,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import { DocumentViewer } from '../../components/DocumentViewer';
import { EvidenceReviewWorkspace } from '../../components/EvidenceReviewWorkspace';
import { MediaViewer } from '../../components/MediaViewer';
import { TaskProgressFallbackPanel, TaskProgressPanel } from '../../components/TaskProgressPanel';
import { useRunResourcePosture } from '../../hooks/useRunResourcePosture';
import {
  type ArtifactManifestEntry,
  artifactsForRecipeRun,
  artifactUrlForEntry,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  groupVisualArtifactPairs,
} from '../../lib/artifact-url';
import { documentTitle, presentDecision } from '../../lib/decision-presentation';
import { decisionRunId, enrichDecisionWithRunContext } from '../../lib/decision-run-context';
import { diffArtifactCandidate } from '../../lib/diff';
import { gatewayFetch } from '../../lib/gateway-http-auth';
import { isGatewayBackgroundPauseError } from '../../lib/recoverable-errors';
import {
  canResolveWithPostureChoice,
  initialRunPostureGateState,
  observePostureTransition,
  postureApplyAlert,
  postureChoiceForResolve,
  postureGateKey,
  postureResolveBlock,
  postureTransitionBaseline,
  runPostureGateApplied,
  runPostureGateForContext,
  runPostureGatePreviewFailed,
  runPostureGatePreviewLoaded,
  runPostureGateSelect,
  type RunPostureGateState,
} from '../../lib/run-posture-gate';
import { runRefreshEventMatches } from '../../lib/run-refresh';
import {
  hasRunWorkspaceDiff,
  selectSlotRecipeArtifactsForPreviewScope,
} from '../../lib/slot-workspace';
import {
  effectiveTaskProgressForRun,
  fallbackTaskProgressSummary,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
} from '../../lib/task-progress';
import { baseStyles, colors, spacing } from '../../lib/theme';
import {
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
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
import { ReviewHistoryPanel } from '../run-detail/components/ReviewHistoryPanel';

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
import { ResourcePostureGatePanel } from './components/ResourcePostureGatePanel';
import { decisionWorkspaceStyles as styles } from './styles/decision-workspace.styles';

const TONE_COLORS = {
  ok: colors.statusOk,
  warn: colors.statusWarn,
  fail: colors.statusFail,
  info: colors.accent,
} as const;

/** Bounded wait for the Gateway to report a resolution's own posture transition. */
const POSTURE_APPLY_POLL_ATTEMPTS = 10;
const POSTURE_APPLY_POLL_DELAY_MS = 600;

type DecisionSectionKey = 'signals' | 'evidence' | 'reports' | 'progress' | 'terminal' | 'actions';

export default function DecisionDetailScreen({ embedded = false }: { embedded?: boolean }) {
  const {
    id,
    decisionId,
    runId: routeRunId,
    recipeRun: routeRecipeRun,
    artifact: routeArtifactPath,
  } = useLocalSearchParams<{
    id: string;
    decisionId?: string | string[];
    runId?: string | string[];
    recipeRun?: string | string[];
    artifact?: string | string[];
  }>();
  const resolvedDecisionId = routeParamString(decisionId) || routeParamString(id);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const artifactAuthHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const storeDecision = useDecisionStore((s) =>
    s.decisions.find((d) => d.id === resolvedDecisionId),
  );
  const setDecisions = useDecisionStore((s) => s.setDecisions);
  const removeDecision = useDecisionStore((s) => s.removeDecision);
  const [decision, setDecision] = useState<DecisionDetail | null>(storeDecision ?? null);
  const [error, setError] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [documentViewer, setDocumentViewer] = useState<{ title: string; body: string } | null>(
    null,
  );
  const [sourceRun, setSourceRun] = useState<Run | null>(null);
  const [recipeRuns, setRecipeRuns] = useState<RecipeRunArtifactGroup[]>([]);
  const [recipeArtifactCount, setRecipeArtifactCount] = useState<number | null>(null);
  const [recipeAvailabilityError, setRecipeAvailabilityError] = useState<string | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgressStructured | null>(null);
  const [taskProgressError, setTaskProgressError] = useState<string | null>(null);
  const [loadingDocument, setLoadingDocument] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const sectionOffsetsRef = useRef<Partial<Record<DecisionSectionKey, number>>>({});
  const documentAbortRef = useRef<AbortController | null>(null);
  const sourceRunRequestRef = useRef(0);
  const recipeRunsRequestRef = useRef(0);
  const requestedArtifactPath = routeParamString(routeArtifactPath).trim();

  const refreshDecision = useCallback(() => {
    if (!client || !resolvedDecisionId) return;
    const fallbackRunId = routeParamString(routeRunId).trim();
    setError(null);
    client
      .request<DecisionListResult>('decision.list')
      .then((result) => {
        setDecisions(result.decisions);
        const next = result.decisions.find((d) => d.id === resolvedDecisionId) ?? null;
        if (next) {
          setDecision(next);
          return null;
        }
        if (!fallbackRunId) {
          setDecision(null);
          setError('Decision is no longer pending.');
          return null;
        }
        return client.request<RunGetResult>('run.get', { runId: fallbackRunId });
      })
      .then((result) => {
        if (!result) return;
        const runDecision = result.run.decisions?.find((d) => d.id === resolvedDecisionId) ?? null;
        if (!runDecision) {
          setDecision(null);
          setError('Decision is no longer pending.');
          return;
        }
        setDecision(decisionDetailFromRun(result.run, runDecision));
      })
      .catch((err: Error) => {
        setError(`Failed to refresh decision: ${err.message}`);
      });
  }, [client, resolvedDecisionId, routeRunId, setDecisions]);

  useEffect(() => {
    return () => {
      documentAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (storeDecision) {
      setDecision(storeDecision);
      return;
    }
    refreshDecision();
  }, [refreshDecision, storeDecision]);

  const sourceRunId = useMemo(() => {
    const routeFallbackRunId = routeParamString(routeRunId).trim();
    return decisionRunId(decision) ?? (routeFallbackRunId ? routeFallbackRunId : null);
  }, [decision, routeRunId]);
  const decisionWithRunContext = useMemo(
    () => enrichDecisionWithRunContext(decision, sourceRun),
    [decision, sourceRun],
  );
  const presentation = useMemo(
    () => (decisionWithRunContext ? presentDecision(decisionWithRunContext) : null),
    [decisionWithRunContext],
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
  const pairs = useMemo(
    () =>
      presentation?.runId
        ? groupArtifacts(presentation.artifactManifest, gatewayUrl, presentation.runId)
        : [],
    [gatewayUrl, presentation?.artifactManifest, presentation?.runId],
  );
  const diffArtifact = useMemo(
    () => (presentation ? diffArtifactCandidate(presentation.artifactManifest) : undefined),
    [presentation],
  );
  const refreshSourceRun = useCallback(
    async (reason: string) => {
      if (!client || !sourceRunId) return;
      const requestId = sourceRunRequestRef.current + 1;
      sourceRunRequestRef.current = requestId;
      try {
        const result = await client.request<RunGetResult>('run.get', { runId: sourceRunId });
        if (sourceRunRequestRef.current !== requestId) return;
        setSourceRun(result.run);
      } catch (err) {
        if (sourceRunRequestRef.current !== requestId) return;
        setSourceRun(null);
        setError(
          `Failed to refresh run workspace context after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, sourceRunId],
  );

  const refreshRecipeRuns = useCallback(
    async (reason: string, reset: boolean) => {
      if (!client || !sourceRunId) return;
      const requestId = recipeRunsRequestRef.current + 1;
      recipeRunsRequestRef.current = requestId;
      if (reset) {
        setRecipeRuns([]);
        setRecipeArtifactCount(null);
        setRecipeAvailabilityError(null);
      }
      try {
        const result = await client.request<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
          runId: sourceRunId,
        });
        if (recipeRunsRequestRef.current !== requestId) return;
        setRecipeRuns(result.recipeRuns);
        setRecipeArtifactCount(
          result.recipeRuns.reduce(
            (count, group) => count + artifactsForRecipeRun(group).length,
            0,
          ),
        );
        setRecipeAvailabilityError(null);
      } catch (err) {
        if (recipeRunsRequestRef.current !== requestId) return;
        if (isGatewayBackgroundPauseError(err)) {
          // App transitions can pause gateway refreshes; keep cached decision
          // evidence visible instead of replacing the workspace with noise.
          console.warn(
            `Recipe evidence availability paused after ${reason}: ${(err as Error).message}`,
          );
          return;
        }
        setRecipeRuns([]);
        setRecipeArtifactCount(null);
        setRecipeAvailabilityError(
          `Failed to refresh recipe evidence availability after ${reason}: ${(err as Error).message}`,
        );
      }
    },
    [client, sourceRunId],
  );

  useEffect(() => {
    if (!sourceRunId) {
      setSourceRun(null);
      return;
    }
    void refreshSourceRun('initial load');
  }, [refreshSourceRun, sourceRunId]);

  useEffect(() => {
    if (!sourceRunId) {
      setRecipeRuns([]);
      setRecipeArtifactCount(null);
      setRecipeAvailabilityError(null);
      return;
    }
    void refreshRecipeRuns('initial load', true);
  }, [refreshRecipeRuns, sourceRunId]);

  useEffect(() => {
    if (!client || !sourceRunId) return;
    const handleRunEvent = (payload: unknown, reason: string) => {
      const event = payload as { run?: Run; runId?: string };
      if (!runRefreshEventMatches(sourceRunId, event)) return;
      if (event.run?.id === sourceRunId) {
        sourceRunRequestRef.current += 1;
        setSourceRun(event.run);
      } else {
        void refreshSourceRun(reason);
      }
      void refreshRecipeRuns(reason, false);
      refreshDecision();
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
  }, [client, refreshDecision, refreshRecipeRuns, refreshSourceRun, sourceRunId]);

  const fetchTaskProgress = useCallback(() => {
    if (!client || !sourceRun?.slotId) return Promise.resolve();
    return client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, {
        slotId: sourceRun.slotId,
        runId: sourceRun.id,
      })
      .then((result) => {
        setTaskProgress(result.structured ?? null);
        setTaskProgressError(null);
      })
      .catch((err: Error) => {
        setTaskProgressError(`Task progress unavailable: ${err.message}`);
      });
  }, [client, sourceRun?.id, sourceRun?.slotId]);

  useEffect(() => {
    if (!client || !sourceRun) return;
    const unsub = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      const update = payload as TaskProgressUpdatedPayload;
      if (!shouldAcceptTaskProgressUpdate(sourceRun, update)) return;
      setTaskProgress(update.progress.structured ?? null);
      setTaskProgressError(null);
    });
    return unsub;
  }, [client, sourceRun]);

  useEffect(() => {
    if (!isWorkerProgressActive(sourceRun)) {
      setTaskProgress(null);
      setTaskProgressError(null);
      return;
    }
    void fetchTaskProgress();
    const timer = setInterval(() => {
      void fetchTaskProgress();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTaskProgress, sourceRun]);
  const resolveAction = useCallback(
    (actionId: string) => {
      if (!client || !decision) return;
      // A choice the Gateway already refused, or one whose effect is still
      // unproven, must not be sent: the decision would be consumed and the
      // refusal repeated with nothing left to undo.
      // Re-derived here rather than trusting the effect to have run: a decision
      // that cannot carry a choice, or a run that has left the wait, must not be
      // blocked by a verdict about a choice that no longer applies to it.
      const gate = runPostureGateForContext(postureGate, { gateKey, ...postureAvailability });
      const postureBlock = postureResolveBlock(gate, postureAvailability);
      if (!canResolveWithPostureChoice(gate, postureAvailability)) {
        Alert.alert('Resource posture', postureBlock.message);
        return;
      }
      const method = decision.runMeta ? 'run.resolveDecision' : 'decision.resolve';
      const resourcePosture = postureChoiceForResolve(gate, postureAvailability);
      const params = decision.runMeta
        ? buildRunResolveDecisionParams({
            runId: decision.runMeta.runId,
            decision,
            actionId,
            ...(resourcePosture ? { resourcePosture } : {}),
          })
        : { decisionId: decision.id, actionId };

      // Transition ids already on screen. `run.resolveDecision` returns before
      // reconciliation finishes, so the run it returns still carries the previous
      // transition; anything already in this baseline is not this resolution's
      // outcome and must never be reported as one.
      const baseline = postureTransitionBaseline(runPostureStatus.state, resourcePosture);

      Alert.alert('Confirm action', `Send "${actionId}" for ${decision.title}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send',
          onPress: () => {
            client
              .request(method, params)
              .then(() => {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                removeDecision(decision.id);
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
                  { attempts: POSTURE_APPLY_POLL_ATTEMPTS, delayMs: POSTURE_APPLY_POLL_DELAY_MS },
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
              .catch((err: Error) => Alert.alert('Failed to resolve', err.message));
          },
        },
      ]);
    },
    [
      applyPostureGate,
      client,
      decision,
      embedded,
      gateKey,
      postureAvailability,
      postureGate,
      removeDecision,
      router,
      runPostureStatus.state,
      sourceRunId,
    ],
  );

  const openDocumentArtifact = useCallback(
    (artifact: ArtifactManifestEntry) => {
      if (!presentation?.runId) return;
      const url = artifactUrlForEntry(gatewayUrl, presentation.runId, artifact);
      documentAbortRef.current?.abort();
      const controller = new AbortController();
      documentAbortRef.current = controller;
      setLoadingDocument(artifact.path);
      gatewayFetch(url, artifactAuthHeaders, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((body) => setDocumentViewer({ title: documentTitle(artifact.path), body }))
        .catch((err: Error) => {
          // Abort is the expected cleanup path when the operator closes/navigates mid-fetch.
          if (err.name === 'AbortError') return;
          Alert.alert('Failed to load document', err.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingDocument(null);
        });
    },
    [artifactAuthHeaders, gatewayUrl, presentation?.runId],
  );

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
          artifact: artifact.path,
          filter:
            artifactFilterParamForArtifactPath(artifact.path) ??
            artifactFilterParamForWorkspaceNav('review'),
        },
      });
    },
    [decisionRouteContext, openDiffArtifact, presentation?.runId, router],
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
          ).pairs
        : [],
    [gatewayUrl, pairs.length, presentation?.runId, recipeRuns],
  );
  const recipeScopedArtifacts = useMemo(
    () => selectSlotRecipeArtifactsForPreviewScope(recipeRuns, null),
    [recipeRuns],
  );
  const recipePreviewArtifacts = useMemo(
    () => recipeScopedArtifacts.slice(0, 4),
    [recipeScopedArtifacts],
  );
  const recipeVisualPairs = useMemo(
    () =>
      presentation?.runId
        ? groupVisualArtifactPairs(recipeScopedArtifacts, (artifact) =>
            artifactUrlForEntry(gatewayUrl, presentation.runId!, artifact),
          ).pairs
        : [],
    [gatewayUrl, presentation?.runId, recipeScopedArtifacts],
  );
  const priorityPairs = pairs.length > 0 ? pairs : recipeFallbackPairs;
  const primaryPair = priorityPairs[0] ?? null;
  const primaryPairIsRecipeFallback = pairs.length === 0 && recipeFallbackPairs.length > 0;
  const priorityCompareRecipeRunId = primaryPairIsRecipeFallback
    ? recipeRunIdForVisualPair(recipeRuns, primaryPair)
    : DECISION_EVIDENCE_RECIPE_RUN_PARAM;
  const visualViewerItems = useMemo(() => {
    if (!presentation?.runId) return [];
    const runId = presentation.runId;
    const items = presentation.artifactManifest
      .filter((artifact) => ['image', 'video'].includes(classifyArtifact(artifact)))
      .map((artifact) => ({
        uri: artifactUrlForEntry(gatewayUrl, runId, artifact),
        title: artifact.label ?? artifact.path,
        mediaType: classifyArtifact(artifact),
        authHeaders: artifactAuthHeaders,
      }));

    for (const pair of recipeFallbackPairs) {
      for (const artifact of [pair.before, pair.after]) {
        items.push({
          uri: artifact.url,
          title: artifact.label ?? artifact.path,
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
  }, [
    artifactAuthHeaders,
    gatewayUrl,
    presentation?.artifactManifest,
    presentation?.runId,
    recipeFallbackPairs,
  ]);

  if (!decision || !presentation) {
    return (
      <View style={[baseStyles.container, styles.center, { paddingBottom: insets.bottom }]}>
        <Text style={baseStyles.textSecondary}>{error ?? 'Loading decision...'}</Text>
        <Pressable style={styles.secondaryButton} onPress={refreshDecision}>
          <Text style={styles.secondaryButtonText}>Refresh</Text>
        </Pressable>
      </View>
    );
  }

  const toneColor = TONE_COLORS[presentation.tone];
  const viewerIndex = viewerUri
    ? visualViewerItems.findIndex((item) => item.uri === viewerUri)
    : -1;
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
                setViewerUri(visualTarget.url);
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

        {!embedded ? (
          <DecisionWorkspaceCockpit
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
            <TaskProgressFallbackPanel
              summary={fallbackTaskProgress}
              error={taskProgressError}
              compact
            />
          </View>
        ) : null}

        {embedded && sourceRun ? (
          <ReviewHistoryPanel
            run={sourceRun}
            chain={reviewChainForRun(sourceRun)}
            onOpenArtifact={(artifactPath) => {
              router.push({
                pathname: '/workspace/run/[runId]/files',
                params: {
                  runId: sourceRun.id,
                  ...decisionRouteContext,
                  recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  artifact: artifactPath,
                  filter:
                    artifactFilterParamForArtifactPath(artifactPath) ??
                    artifactFilterParamForWorkspaceNav('review'),
                },
              });
            }}
          />
        ) : null}

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
              runId={presentation.runId}
              gatewayUrl={gatewayUrl}
              artifacts={presentation.artifactManifest}
              pairs={pairs}
              authHeaders={artifactAuthHeaders}
              onOpenVisual={setViewerUri}
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
              disabled={!client || !sourceRunId}
              onSelect={selectPostureChoice}
            />
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
            presentation.actions.map((action) => (
              <Pressable
                key={action.id}
                style={[
                  styles.actionButton,
                  action.style === 'primary' && { backgroundColor: colors.accent },
                  action.style === 'danger' && { backgroundColor: colors.statusFail },
                ]}
                onPress={() => resolveAction(action.id)}
              >
                <Text style={styles.actionText}>{action.label}</Text>
                {action.description && (
                  <Text style={styles.actionDescription}>{action.description}</Text>
                )}
              </Pressable>
            ))
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
          visible={canShowViewer}
          uri={viewerUri}
          items={visualViewerItems}
          authHeaders={artifactAuthHeaders}
          initialIndex={Math.max(0, viewerIndex)}
          onClose={() => setViewerUri(null)}
        />
        <DocumentViewer
          visible={!!documentViewer}
          title={documentViewer?.title ?? ''}
          body={documentViewer?.body ?? ''}
          onClose={() => setDocumentViewer(null)}
        />
      </Animated.ScrollView>
    </View>
  );
}
