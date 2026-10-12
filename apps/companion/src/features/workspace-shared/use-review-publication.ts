import { useEffect, useRef, useState } from 'react';
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
  toggleReviewFinding,
} from '@farmslot/protocol';

import { currentFarmConnection } from '../../lib/connection-authority';
import { loadReviewFindingSource, reviewFindingSourceRequest } from '../../lib/review-curation';
import { reviewPublicationView } from '../../lib/review-publication';
import { useConnectionStore } from '../../store/connection';
import { useRunStore } from '../../store/runs';

import { retryReviewPublication } from './review-publication-action';

export function useReviewPublication(
  run: Run | null,
  decision?: RunDecision | null,
  onRefreshed?: (run: Run) => void,
) {
  const client = useConnectionStore((state) => state.client);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const epoch = useConnectionStore((state) => state.authorityEpoch);
  const status = useConnectionStore((state) => state.status);
  const payload =
    decision?.type === 'engine_review_posting' &&
    !decision.resolvedAt &&
    decision.payload?.kind === 'review'
      ? decision.payload
      : null;
  const fingerprint = payload ? reviewPostingFingerprint(payload) : '';
  const identity = `${run?.id}:${decision?.id}:${fingerprint}:${profileId}:${epoch}:${client?.connectionGeneration}`;
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
  const storedRun = useRunStore((state) => state.runs.find((item) => item.id === run?.id));
  const effectiveRun = storedRun && run && storedRun.updatedAt >= run.updatedAt ? storedRun : run;
  const viewModel = effectiveRun ? reviewPublicationView(effectiveRun) : null;
  const captureCurrent = (bindSelection = true) => {
    const capturedScope = scope.current;
    const capturedCuration = curation;
    if (!client) return () => false;
    const isCurrentConnection = currentFarmConnection(client);
    return () =>
      active.current &&
      scope.current === capturedScope &&
      (!bindSelection || curationRef.current === capturedCuration) &&
      useConnectionStore.getState().client === client &&
      useConnectionStore.getState().activeProfileId === profileId &&
      useConnectionStore.getState().authorityEpoch === epoch &&
      isCurrentConnection();
  };
  const curationRef = useRef(curation);
  curationRef.current = curation;
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
    const isCurrentConnection = currentFarmConnection(client);
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
      if (operation === 'open') {
        if (viewModel?.url) await Linking.openURL(viewModel.url);
      } else if (operation === 'retry') {
        await retryReviewPublication(client, run.id, current, useRunStore.getState().upsertRun);
      } else {
        const result = await client.request<RunGetResult>(Methods.RUN_REFRESH_REVIEW_GATE, {
          runId: run.id,
        });
        if (current()) {
          useRunStore.getState().upsertRun(result.run);
          onRefreshed?.(result.run);
        }
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
    report: payload?.reviewMd,
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
    disabled: status !== 'connected' || Boolean(payload && !run),
    retry: () => {
      void execute('retry');
    },
    open: () => {
      void execute('open');
    },
  };
}
