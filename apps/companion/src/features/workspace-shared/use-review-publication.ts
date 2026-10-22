import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking } from 'react-native';

import {
  createReviewCuration,
  Methods,
  type ReviewCurationState,
  reviewCurationView,
  type ReviewedFindingContext,
  reviewPostingFingerprint,
  type ReviewPostRecommendation,
  type Run,
  type RunDecision,
  type RunGetResult,
  savedReviewView,
  toggleReviewFinding,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import { refreshReviewGateView } from '@farmslot/review-dispatch';

import { useResourceQuery } from '../../hooks/useResourceQuery';
import { currentFarmConnection } from '../../lib/connection-authority';
import { getResourceCache } from '../../lib/resource-cache';
import { loadReviewFindingSource, reviewFindingSourceRequest } from '../../lib/review-curation';
import { reviewPublicationView } from '../../lib/review-publication';
import { assertNativeRunReady } from '../../lib/run-collections';
import { useConnectionStore } from '../../store/connection';

export type ReviewPublicationContext = 'publication' | 'saved';

export function useReviewPublication(
  run: Run | null,
  selectedDecision?: RunDecision | null,
  context: ReviewPublicationContext = 'publication',
) {
  const client = useConnectionStore((state) => state.client);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const epoch = useConnectionStore((state) => state.authorityEpoch);
  const status = useConnectionStore((state) => state.status);
  const query = useMemo(
    () => (run?.id ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId: run.id }) : undefined),
    [run?.id],
  );
  const observation = useResourceQuery(query);
  const effectiveRun = observation.data?.run ?? null;
  const decision = selectedDecision
    ? (effectiveRun?.decisions.find(({ id }) => id === selectedDecision.id) ?? null)
    : null;

  const payload =
    context === 'publication' &&
    decision?.type === 'engine_review_posting' &&
    !decision.resolvedAt &&
    decision.payload?.kind === 'review'
      ? decision.payload
      : null;
  const fingerprint = payload ? reviewPostingFingerprint(payload) : '';
  const identity = `${run?.id}:${decision?.id}:${fingerprint}:${profileId}:${epoch}:${client?.connectionGeneration}:${context}`;
  const savedIdentity = `${run?.id}:${profileId}:${epoch}:${context}`;
  const scope = useRef({ client, identity });
  if (scope.current.client !== client || scope.current.identity !== identity)
    scope.current = { client, identity };
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [action, setAction] = useState<{ scope: object; busy: boolean; error?: string }>();
  const initial = useRef<{ fingerprint: string; state: ReviewCurationState | null }>({
    fingerprint: '',
    state: null,
  });
  if (initial.current.fingerprint !== fingerprint)
    initial.current = { fingerprint, state: payload ? createReviewCuration(payload) : null };
  const [curated, setCurated] = useState<{ scope: object; state: ReviewCurationState }>();
  const curation = curated?.scope === scope.current ? curated.state : initial.current.state;
  const [source, setSource] = useState<{
    scope: object;
    index: number;
    loading?: boolean;
    error?: string;
    context?: ReviewedFindingContext;
  }>();
  const sourceRequest = useRef<object | undefined>(undefined);
  const currentSource = source?.scope === scope.current ? source : undefined;
  const pending = useRef<object | undefined>(undefined);
  const currentAction = action?.scope === scope.current ? action : undefined;
  const savedCandidate = !payload && effectiveRun ? savedReviewView(effectiveRun) : null;
  const viewModel = effectiveRun ? reviewPublicationView(effectiveRun) : null;
  const captureCurrent = (bindSelection = true) => {
    const capturedScope = scope.current;
    const capturedCuration = curation;
    if (!client) return () => false;
    const isCurrentConnection = currentFarmConnection(client, useConnectionStore.getState);
    return () =>
      active.current &&
      scope.current === capturedScope &&
      (!bindSelection || curationRef.current === capturedCuration) &&
      isCurrentConnection();
  };
  const curationRef = useRef(curation);
  curationRef.current = curation;
  const readSaved = async () => {
    if (query) await getResourceCache()?.retry(query);
  };
  const changeCuration = (change: (state: ReviewCurationState) => ReviewCurationState) => {
    if (!curation) return;
    const state = change(curationRef.current!);
    curationRef.current = state;
    setCurated({ scope: scope.current, state });
  };
  const inspect = async (index: number) => {
    if (!client || !run || !payload || status !== 'connected') return;
    const capturedScope = scope.current;
    const request = {};
    sourceRequest.current = request;
    const isCurrentConnection = currentFarmConnection(client, useConnectionStore.getState);
    const current = () =>
      active.current &&
      scope.current === capturedScope &&
      sourceRequest.current === request &&
      isCurrentConnection();
    const params = reviewFindingSourceRequest(run.id, run.slotId, payload, index);
    if (!params) {
      setSource({
        scope: capturedScope,
        index,
        context: {
          available: false,
          note: 'Reviewed source is unavailable. A reviewed SHA and location are required.',
          lines: [],
        },
      });
      return;
    }
    setSource({ scope: capturedScope, index, loading: true });
    try {
      const context = await loadReviewFindingSource(
        client,
        params,
        payload.lineComments[index].line,
        current,
      );
      if (context) setSource({ scope: capturedScope, index, context });
    } catch (error) {
      if (current())
        setSource({
          scope: capturedScope,
          index,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  };
  const execute = async (operation: 'retry' | 'open' | 'refresh') => {
    if (!client || !run || status !== 'connected' || pending.current === scope.current) return;
    const capturedScope = scope.current;
    const current = captureCurrent(false);
    pending.current = capturedScope;
    setAction({ scope: capturedScope, busy: true });
    try {
      assertNativeRunReady(run.id, effectiveRun ?? undefined);
      if (operation === 'open') {
        if (viewModel?.url) await Linking.openURL(viewModel.url);
      } else if (operation === 'retry') {
        await client.request(Methods.PR_REVIEW_PUBLISH, { runId: run.id }, 120_000);
      } else {
        const result = await refreshReviewGateView(
          () => client.request<RunGetResult>(Methods.RUN_REFRESH_REVIEW_GATE, { runId: run.id }),
          async () => {
            if (!current() || !query) throw new Error('The review view changed during refresh.');
            const state = await getResourceCache()?.retry(query);
            if (state?.status !== 'ready' || !state.data)
              throw state?.error ?? new Error('The current review run is unavailable.');
            return state.data;
          },
        );
        if (result.error) throw new Error(result.error);
      }
      if (current()) setAction({ scope: capturedScope, busy: false });
    } catch (error) {
      if (current())
        setAction({
          scope: capturedScope,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (pending.current === capturedScope) pending.current = undefined;
    }
  };
  return {
    viewModel,
    observation,
    saved: savedCandidate,
    savedLoading: Boolean(run && observation.status === 'loading'),
    savedOffline: Boolean(savedCandidate && observation.status === 'stale'),
    savedError: observation.error?.message,
    readSaved: () => {
      void readSaved();
    },
    context,
    viewIdentity: payload ? identity : savedIdentity,
    report: payload?.reviewMd ?? effectiveRun?.reviewResult?.reviewMd,
    curation: payload && curation ? reviewCurationView(payload, curation) : null,
    selectionData: curation
      ? { ...curation, includedIndices: [...curation.includedIndices] }
      : undefined,
    source: currentSource,
    captureCurrent,
    toggleFinding: (index: number) => changeCuration((state) => toggleReviewFinding(state, index)),
    selectAll: (included: boolean) =>
      changeCuration((state) => ({
        ...state,
        includedIndices: included ? payload!.lineComments.map((_, index) => index) : [],
      })),
    setRecommendation: (recommendation: ReviewPostRecommendation) =>
      changeCuration((state) => ({ ...state, recommendation })),
    setIncludeEvidence: (includeEvidence: boolean) =>
      changeCuration((state) => ({ ...state, includeEvidence })),
    inspect: (index: number) => {
      void inspect(index);
    },
    refresh: () => {
      void execute('refresh');
    },
    busy: currentAction?.busy ?? false,
    error: viewModel?.state === 'published' ? undefined : currentAction?.error,
    disabled: status !== 'connected' || observation.status !== 'ready',
    retry: () => {
      void execute('retry');
    },
    open: () => {
      void execute('open');
    },
  };
}
