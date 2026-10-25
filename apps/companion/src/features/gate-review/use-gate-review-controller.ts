import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';

import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  Events,
  evidenceAttestationAvailable,
  isValidEvidenceAttestationReason,
  Methods,
  type Run,
  type RunDecision,
  type RunGetResult,
} from '@farmslot/protocol';
import {
  gateReviewLineageOptions,
  ReviewDispatchViewModel,
  reviewLineagesForRun,
  reviewRequestContextForRun,
} from '@farmslot/review-dispatch';

import type { MediaViewerItem } from '../../components/MediaViewer';
import { useConnectedTransport } from '../../hooks/useConnectedTransport';
import { useHumanGateGuard } from '../../hooks/useHumanGateGuard';
import type { RunAcceptance } from '../../hooks/useRunAcceptance';
import { acceptanceEvidenceHref } from '../../lib/acceptance-evidence';
import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  groupVisualArtifactPairs,
  type VisualArtifactPair,
} from '../../lib/artifact-url';
import { requestClaimUntestableOverride } from '../../lib/claim-overrides';
import { decisionResolveRequest, gateActionReasons } from '../../lib/decision-resolve';
import {
  evidenceMediaItems,
  recordedEvidenceArtifactUrl,
  selectedEvidenceMediaItem,
} from '../../lib/evidence-media-items';
import {
  type ApprovePublishGuard,
  type GateReviewAction,
  type GateReviewSummary,
  gateReviewSummary,
  type GateReviewVerdict,
  HUMAN_GATE_DECISION_TYPE,
} from '../../lib/gate-review';
import { isGatewayBackgroundPauseError } from '../../lib/recoverable-errors';
import { requestAnotherReviewRound } from '../../lib/review-budget';
import { runRefreshEventMatches } from '../../lib/run-refresh';
import { useConnectionStore } from '../../store/connection';
import { useDecisionStore } from '../../store/decisions';
import { decisionDetailFromRun } from '../decision-workspace/components/decision-workspace-panels';

export interface GateReviewRouteParams {
  runId: string;
  decisionId: string;
}

export interface GateReviewMedia {
  items: MediaViewerItem[];
  uri: string;
}

export interface GateReviewViewModel {
  run: Run;
  reviewPicker: ReviewDispatchViewModel;
  decision: RunDecision;
  summary: GateReviewSummary;
  reviews: GateReviewVerdict[];
  acceptance: RunAcceptance;
  gatewayUrl: string;
  artifacts: ArtifactManifestEntry[];
  pairs: VisualArtifactPair[];
  media: GateReviewMedia | null;
  guard: ApprovePublishGuard;
  actions: GateReviewAction[];
  authHeaders: ArtifactHttpHeaders;
  sendingActionId: string | null;
  attestationReason: string;
  /** A refresh that failed after the gate was already on screen. */
  error: string | null;
}

export type GateReviewScreenState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; viewModel: GateReviewViewModel };

const RUN_EVENTS = [
  Events.RUN_UPDATED,
  Events.RUN_COMPLETED,
  Events.RUN_DECISION_NEW,
  Events.RUN_DECISION_UPDATED,
  Events.RUN_DECISION_RESOLVED,
] as const;

export function useGateReviewController({ runId, decisionId }: GateReviewRouteParams) {
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const authHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const authorityEpoch = useConnectionStore((s) => s.authorityEpoch);
  const connection = useConnectedTransport();
  const removeDecision = useDecisionStore((s) => s.removeDecision);
  // The store's run comes from `run.list`, which trims gate payloads, so the
  // screen reads its own full copy through `run.get`.
  const [run, setRun] = useState<Run | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendingActionId, setSendingActionId] = useState<string | null>(null);
  const [media, setMedia] = useState<GateReviewMedia | null>(null);
  useEffect(() => setMedia(null), [authorityEpoch, runId, decisionId]);
  const [evidenceReason, setEvidenceReason] = useState<{ decisionId: string; text: string } | null>(
    null,
  );
  const requestRef = useRef(0);
  const reviewPicker = useMemo(
    () =>
      new ReviewDispatchViewModel({
        context: { allowedActions: ['request-review'], allowSequence: true },
      }),
    [],
  );
  useEffect(() => {
    // ADR-063 Amendment 5: a gate lists its lineages; rows preselect their runner's latest
    // available one in WARM.
    const lineageOptions = gateReviewLineageOptions(run, decisionId);
    reviewPicker.setContext({
      ...reviewPicker.context,
      reviewLineages: reviewLineagesForRun(run),
      reviewContext: lineageOptions ? undefined : reviewRequestContextForRun(run),
      lineageOptions,
    });
  }, [decisionId, reviewPicker, run]);

  const refresh = useCallback(
    async (reason: string) => {
      if (!client || !runId) return;
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      try {
        const result = await client.request<RunGetResult>('run.get', { runId });
        if (requestRef.current !== requestId) return;
        setRun(result.run);
        setLoadError(null);
      } catch (err) {
        if (requestRef.current !== requestId) return;
        if (isGatewayBackgroundPauseError(err)) {
          // Backgrounding pauses gateway requests; the gate on screen stays the
          // last answer until the next event or refresh replaces it.
          console.warn(`Gate review refresh paused after ${reason}: ${(err as Error).message}`);
          return;
        }
        setLoadError(`Failed to load the run after ${reason}: ${(err as Error).message}`);
      }
    },
    [client, runId],
  );

  // Another run, gateway or principal makes the copy on screen someone else's
  // answer: drop it along with any read still in flight.
  useEffect(() => {
    requestRef.current += 1;
    setRun(null);
    setLoadError(null);
  }, [authorityEpoch, gatewayUrl, refresh]);

  useEffect(() => {
    if (connection === null) {
      requestRef.current += 1;
      return;
    }
    void refresh('connect');
  }, [connection, refresh]);

  useEffect(() => {
    if (!client || !runId) return;
    const unsubscribers = RUN_EVENTS.map((event) =>
      client.subscribe(event, (payload) => {
        const update = payload as { run?: Run; runId?: string };
        if (!runRefreshEventMatches(runId, update)) return;
        if (update.run?.id === runId) {
          requestRef.current += 1;
          setRun(update.run);
          return;
        }
        void refresh(event);
      }),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [client, refresh, runId]);

  const decision = run?.decisions.find((candidate) => candidate.id === decisionId) ?? null;
  const gate = useHumanGateGuard(client, run, decision);
  // Send re-checks the gate as it is when the operator confirms, not as it was
  // when the confirmation opened.
  const attestationReason =
    evidenceReason?.decisionId === decision?.id ? (evidenceReason?.text ?? '') : '';
  const latestRef = useRef({ run, decision, gate, attestationReason });
  latestRef.current = { run, decision, gate, attestationReason };

  const viewModel = useMemo((): Omit<GateReviewViewModel, 'sendingActionId' | 'error'> | null => {
    if (!run || !decision || !gate) return null;
    const { acceptance } = gate;
    const artifacts =
      decision.payload?.kind === 'ready'
        ? (decision.payload.prPackage?.evidenceManifest ?? decision.payload.artifactManifest ?? [])
        : [];
    return {
      run,
      reviewPicker,
      decision,
      summary: gateReviewSummary(decision),
      reviews: gate.reviews,
      acceptance,
      gatewayUrl,
      artifacts,
      pairs: groupVisualArtifactPairs(
        artifacts,
        (artifact) =>
          recordedEvidenceArtifactUrl(gatewayUrl, run.id, acceptance.evidenceModel, artifact),
        acceptance.evidenceModel,
      ).pairs,
      media,
      guard: gate.guard,
      actions: gate.actions,
      attestationReason,
      authHeaders,
    };
  }, [attestationReason, authHeaders, decision, gate, gatewayUrl, media, reviewPicker, run]);

  const openEvidence = useCallback(
    (criterionId: string, path: string) => {
      router.push(
        acceptanceEvidenceHref(
          runId,
          criterionId,
          path,
          gate?.acceptance.recipeRunId,
          decision?.id,
        ),
      );
    },
    [decision?.id, gate?.acceptance.recipeRunId, router, runId],
  );

  const openLog = useCallback(
    (artifact: string) => {
      router.push({
        pathname: '/workspace/run/[runId]/files',
        params: { runId, artifact, recipeRun: 'decision-evidence', evidenceDecision: decision?.id },
      });
    },
    [decision?.id, router, runId],
  );

  const resolve = useCallback(
    (action: GateReviewAction, selectionData?: Record<string, unknown>) => {
      if (!client || !run || !decision || decision.resolvedAt) return;
      if (action.disabledReason) {
        // The button is disabled; this only guards a stale press racing a re-render.
        Alert.alert(action.label, action.disabledReason);
        return;
      }
      if (
        (action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION ||
          action.id === APPROVE_PUBLISH_UNRESOLVED_ACTION) &&
        !isValidEvidenceAttestationReason(attestationReason)
      ) {
        Alert.alert(action.label, 'A written reason is required.');
        return;
      }
      // Bound to the package on screen now, the one the operator is confirming.
      const confirmedReasons = gateActionReasons(
        action.id,
        attestationReason,
        evidenceAttestationAvailable(
          decision.payload?.kind === 'ready' ? decision.payload.gateReadiness : undefined,
          action.id,
        ),
      );
      const confirmed = decisionResolveRequest(
        decisionDetailFromRun(run, decision),
        action.id,
        null,
        selectionData,
        confirmedReasons.evidenceAttestationReason,
        confirmedReasons.reason,
      );
      Alert.alert('Confirm action', `${action.label} for ${decision.title}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send',
          onPress: () => {
            const latest = latestRef.current;
            const current = latest.gate?.actions.find((candidate) => candidate.id === action.id);
            if (!latest.run || !latest.decision || latest.decision.resolvedAt || !current) {
              Alert.alert(action.label, 'The gate changed; review it again before sending.');
              return;
            }
            if (current.disabledReason) {
              Alert.alert(action.label, current.disabledReason);
              return;
            }
            if (
              (action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION ||
                action.id === APPROVE_PUBLISH_UNRESOLVED_ACTION) &&
              !isValidEvidenceAttestationReason(latest.attestationReason)
            ) {
              Alert.alert(action.label, 'A written reason is required.');
              return;
            }
            // A package refreshed while the confirmation was open is not the one
            // the operator reviewed.
            const latestReasons = gateActionReasons(
              action.id,
              latest.attestationReason,
              evidenceAttestationAvailable(
                latest.decision.payload?.kind === 'ready'
                  ? latest.decision.payload.gateReadiness
                  : undefined,
                action.id,
              ),
            );
            const now = decisionResolveRequest(
              decisionDetailFromRun(latest.run, latest.decision),
              action.id,
              null,
              selectionData,
              latestReasons.evidenceAttestationReason,
              latestReasons.reason,
            );
            if (JSON.stringify(now) !== JSON.stringify(confirmed)) {
              Alert.alert(action.label, 'The publish package changed; review it again.');
              return;
            }
            setSendingActionId(action.id);
            client
              .request(confirmed.method, confirmed.params)
              .then(() => {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                removeDecision(decision.id);
                return refresh(`resolve ${action.id}`);
              })
              .catch((err: Error) => Alert.alert('Failed to resolve', err.message))
              .finally(() => setSendingActionId(null));
          },
        },
      ]);
    },
    [attestationReason, client, decision, refresh, removeDecision, run],
  );

  const state = gateReviewScreenState({ run, decision, viewModel, loadError, sendingActionId });

  return {
    state,
    actions: {
      closeMedia: () => setMedia(null),
      openVisual: (uri: string) => {
        if (!viewModel) return;
        viewModel.acceptance.evidenceModel?.clearSelection();
        setMedia({
          uri,
          items: evidenceMediaItems(
            viewModel.artifacts,
            (artifact) =>
              recordedEvidenceArtifactUrl(
                gatewayUrl,
                runId,
                viewModel.acceptance.evidenceModel,
                artifact,
              ),
            authHeaders,
            viewModel.acceptance.evidenceModel,
            { runId, slotId: run?.slotId ?? undefined },
          ),
        });
      },
      openRecordedEvidence: (model: EvidenceReviewModel, path: string) => {
        const item = selectedEvidenceMediaItem(
          model,
          path,
          (artifactPath) => recordedEvidenceArtifactUrl(gatewayUrl, runId, model, artifactPath),
          authHeaders,
          { runId, slotId: run?.slotId ?? undefined },
        );
        setMedia({ items: [item], uri: item.uri });
      },
      recordVisualReview: async (
        claimId: string,
        verdict: 'confirmed' | 'rejected',
        reason?: string,
      ) => {
        if (!gate) throw new Error('The gate evidence review is unavailable.');
        await gate.acceptance.recordVisualReview(claimId, verdict, reason);
        await refresh('visual review');
      },
      markUntestable: async (claimId: string, reason: string) => {
        const model = viewModel?.acceptance.evidenceModel;
        if (!client || !run || !decision || !model) return;
        try {
          await requestClaimUntestableOverride(client, run.id, decision, model, claimId, reason);
          await refresh('claim override');
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      },
      giveAnotherRound: async (brief: string) => {
        if (!client || !run || !decision) return;
        try {
          await requestAnotherReviewRound(client, run.id, decision, brief);
          await refresh('review budget extension');
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      },
      refreshPackage: async () => {
        if (
          sendingActionId ||
          !client ||
          !run ||
          decision?.payload?.kind !== 'ready' ||
          !decision.payload.prPackage
        )
          return;
        setSendingActionId('refresh-package');
        try {
          await client.request(Methods.RUN_REFRESH_PUBLISH_PACKAGE, {
            runId: run.id,
            decisionId: decision.id,
          });
          await refresh('package refresh');
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
          setSendingActionId(null);
        }
      },
      refresh: () => void refresh('manual refresh'),
      openEvidence,
      openLog,
      resolve,
      setAttestationReason: (text: string) => setEvidenceReason({ decisionId, text }),
    },
  };
}

export type GateReviewActions = ReturnType<typeof useGateReviewController>['actions'];

function gateReviewScreenState(input: {
  run: Run | null;
  decision: RunDecision | null;
  viewModel: Omit<GateReviewViewModel, 'sendingActionId' | 'error'> | null;
  loadError: string | null;
  sendingActionId: string | null;
}): GateReviewScreenState {
  const { run, decision, viewModel, loadError, sendingActionId } = input;
  if (!run) return loadError ? { status: 'error', message: loadError } : { status: 'loading' };
  if (!decision) return { status: 'error', message: 'This gate is no longer on the run.' };
  if (decision.type !== HUMAN_GATE_DECISION_TYPE || !viewModel) {
    return { status: 'error', message: 'This decision is not a publish gate.' };
  }
  return { status: 'ready', viewModel: { ...viewModel, sendingActionId, error: loadError } };
}
