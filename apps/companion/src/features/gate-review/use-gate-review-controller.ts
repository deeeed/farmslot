import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';

import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  isValidEvidenceAttestationReason,
  Methods,
  type Run,
  type RunDecision,
  type RunGetResult,
} from '@farmslot/protocol';
import { resourceQuery, type ResourceQueryState } from '@farmslot/protocol/client-cache';
import {
  gateReviewLineageOptions,
  ReviewDispatchViewModel,
  reviewLineagesForRun,
  reviewRequestContextForRun,
} from '@farmslot/review-dispatch';

import type { MediaViewerItem } from '../../components/MediaViewer';
import { useConnectedTransport } from '../../hooks/useConnectedTransport';
import { useHumanGateGuard } from '../../hooks/useHumanGateGuard';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import type { RunAcceptance } from '../../hooks/useRunAcceptance';
import { acceptanceEvidenceHref } from '../../lib/acceptance-evidence';
import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  groupVisualArtifactPairs,
  type VisualArtifactPair,
} from '../../lib/artifact-url';
import { requestClaimUntestableOverride } from '../../lib/claim-overrides';
import { currentFarmConnection } from '../../lib/connection-authority';
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
import { getResourceCache } from '../../lib/resource-cache';
import { requestAnotherReviewRound } from '../../lib/review-budget';
import { assertNativeDecisionReady, assertNativeRunReady } from '../../lib/run-collections';
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
  observation: ResourceQueryState<RunGetResult>;
  commandsReady: boolean;
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

export function useGateReviewController({ runId, decisionId }: GateReviewRouteParams) {
  const router = useRouter();
  const client = useConnectionStore((s) => s.client);
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl);
  const authHeaders = useConnectionStore((s) => s.activeProfileHttpAuthHeaders);
  const authorityEpoch = useConnectionStore((s) => s.authorityEpoch);
  const connection = useConnectedTransport();
  const decisionsObservation = useDecisionStore((s) => s.observation);
  const query = useMemo(
    () => (runId ? resourceQuery<RunGetResult>('run.get', { runId }) : undefined),
    [runId],
  );
  const observation = useResourceQuery(query);
  const run = observation.data?.run ?? null;
  const actionsCurrent =
    connection !== null &&
    decisionsObservation.status === 'ready' &&
    observation.status === 'ready';
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendingActionId, setSendingActionId] = useState<string | null>(null);
  const [media, setMedia] = useState<GateReviewMedia | null>(null);
  useEffect(() => setMedia(null), [authorityEpoch, runId, decisionId]);
  const [evidenceReason, setEvidenceReason] = useState<{ decisionId: string; text: string } | null>(
    null,
  );
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

  // The shared cache owns full detail, reconnect reads and notification catch-up.
  useEffect(() => {
    setLoadError(null);
  }, [authorityEpoch, gatewayUrl, runId, decisionId]);
  const retry = useCallback(async () => {
    if (query) await getResourceCache()?.retry(query);
  }, [query]);

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
      observation,
      commandsReady: actionsCurrent,
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
      actions: gate.actions.map((action) =>
        actionsCurrent
          ? action
          : {
              ...action,
              disabledReason: 'Wait for current decisions before acting.',
            },
      ),
      attestationReason,
      authHeaders,
    };
  }, [
    actionsCurrent,
    attestationReason,
    authHeaders,
    decision,
    gate,
    gatewayUrl,
    media,
    observation,
    reviewPicker,
    run,
  ]);

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
      try {
        assertNativeDecisionReady(decision.id);
        assertNativeRunReady(run.id, run);
      } catch (error) {
        Alert.alert(
          'Decision is not current',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
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
      const confirmed = decisionResolveRequest(
        decisionDetailFromRun(run, decision),
        action.id,
        null,
        selectionData,
        gateActionReasons(action.id, attestationReason).evidenceAttestationReason,
        gateActionReasons(action.id, attestationReason).reason,
      );
      Alert.alert('Confirm action', `Send "${action.id}" for ${decision.title}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send',
          onPress: () => {
            try {
              assertNativeDecisionReady(decision.id);
              assertNativeRunReady(run.id, run);
            } catch (error) {
              Alert.alert(
                'Decision is not current',
                error instanceof Error ? error.message : String(error),
              );
              return;
            }
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
            const now = decisionResolveRequest(
              decisionDetailFromRun(latest.run, latest.decision),
              action.id,
              null,
              selectionData,
              gateActionReasons(action.id, latest.attestationReason).evidenceAttestationReason,
              gateActionReasons(action.id, latest.attestationReason).reason,
            );
            if (JSON.stringify(now) !== JSON.stringify(confirmed)) {
              Alert.alert(action.label, 'The publish package changed; review it again.');
              return;
            }
            setSendingActionId(action.id);
            const currentConnection = currentFarmConnection(client, useConnectionStore.getState);
            client
              .request(confirmed.method, confirmed.params)
              .then(() => {
                if (currentConnection())
                  return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              })
              .catch((err: Error) => {
                if (currentConnection()) Alert.alert('Failed to resolve', err.message);
              })
              .finally(() => {
                if (currentConnection()) setSendingActionId(null);
              });
          },
        },
      ]);
    },
    [attestationReason, client, decision, run],
  );

  const state = gateReviewScreenState({
    run,
    decision,
    viewModel,
    loadError: loadError ?? observation.error?.message ?? null,
    sendingActionId,
  });

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
          ),
        });
      },
      openRecordedEvidence: (model: EvidenceReviewModel, path: string) => {
        const item = selectedEvidenceMediaItem(
          model,
          path,
          (artifactPath) => recordedEvidenceArtifactUrl(gatewayUrl, runId, model, artifactPath),
          authHeaders,
        );
        setMedia({ items: [item], uri: item.uri });
      },
      recordVisualReview: async (
        claimId: string,
        verdict: 'confirmed' | 'rejected',
        reason?: string,
      ) => {
        if (!gate) throw new Error('The gate evidence review is unavailable.');
        assertNativeRunReady(runId, run ?? undefined);
        await gate.acceptance.recordVisualReview(claimId, verdict, reason);
      },
      markUntestable: async (claimId: string, reason: string) => {
        const model = viewModel?.acceptance.evidenceModel;
        if (!client || !run || !decision || !model) return;
        try {
          assertNativeRunReady(run.id, run);
          await requestClaimUntestableOverride(client, run.id, decision, model, claimId, reason);
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      },
      giveAnotherRound: async (brief: string) => {
        if (!client || !run || !decision) return;
        try {
          assertNativeRunReady(run.id, run);
          await requestAnotherReviewRound(client, run.id, decision, brief);
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
          assertNativeRunReady(run.id, run);
          await client.request(Methods.RUN_REFRESH_PUBLISH_PACKAGE, {
            runId: run.id,
            decisionId: decision.id,
          });
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
          setSendingActionId(null);
        }
      },
      refresh: () => void retry(),
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
