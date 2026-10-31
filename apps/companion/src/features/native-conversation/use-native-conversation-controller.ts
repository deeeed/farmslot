import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Methods,
  type NativeSessionListResult,
  type NativeSessionResponse,
  type NativeSessionSendParams,
  type NativeSessionTargetParams,
  type RunGetResult,
} from '@farmslot/protocol';
import {
  nativeCommandLockSettled,
  nativeHistoryCanAct,
  nativeHistoryCanSend,
  nativeHistoryQuery,
  nativeMessageCancelable,
  nativeMessageDropped,
  nativeMessageShown,
  nativeObservationQuery,
  nativeSendLabel,
  nativeTimeline,
  nativeTimelineRows,
  type NativeTranscript,
  nativeWork,
  resourceQuery,
} from '@farmslot/protocol/client-cache';

import { observeNativeConversation } from '../../farmslot/run-collections-proof';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import { currentFarmConnection } from '../../lib/connection-authority';
import { nativeConversationWritable, nativeRetryAvailable } from '../../lib/native-conversation';
import {
  createNativeConversationStorage,
  nativeConversationStorageKey,
} from '../../lib/native-conversation-storage';
import {
  nativeWorkerForAction,
  nativeWorkerViewControl,
  nativeWorkerViewForRun,
  type NativeWorkerViewSelection,
  type NativeWorkerViewTarget,
  sameNativeWorkerViewBinding,
} from '../../lib/native-worker-target';
import { getResourceCache, getResourceNativeOwnerId } from '../../lib/resource-cache';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { canOpenNativeConversation } from '../../lib/workspace-access';
import { useConnectionStore } from '../../store/connection';

import { useNativeSessionResume } from './use-native-session-resume';
import { useNativeSessionSetup } from './use-native-session-setup';

export interface NativeConversationParams {
  sessionId?: string;
  executionNodeId?: string;
  runId?: string;
  contextId?: string;
  leaseId?: string;
  generation?: string;
  draft?: string;
}
type PendingCommand = NativeSessionSendParams & { generation: string };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const conversationStorage = createNativeConversationStorage(AsyncStorage);

export function useNativeConversationController(params: NativeConversationParams) {
  const focused = useIsFocused();
  const client = useConnectionStore((state) => state.client);
  const connection = useConnectionStore((state) => state.status);
  const profile = useConnectionStore((state) => state.activeProfileId);
  const gatewayUrl = useConnectionStore((state) => state.gatewayUrl);
  const principalId = useConnectionStore((state) => state.principalId);
  const access = useWorkspaceRenderAccess();
  const authorityEpoch = useConnectionStore((state) => state.authorityEpoch);
  const creation = useNativeSessionSetup(!params.sessionId);
  const [draft, setDraft] = useState(params.draft ?? '');
  const [pending, setPending] = useState<PendingCommand>();
  const [responses, setResponses] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const alive = useRef(true);
  const mutation = useRef(false);
  const draftRef = useRef(draft);
  const pendingRef = useRef(pending);
  const responsesRef = useRef(responses);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const node = params.executionNodeId ?? 'local';
  const storageKey = nativeConversationStorageKey({
    profile,
    gatewayUrl,
    principalId,
    node,
    sessionId: params.sessionId,
    runId: params.runId,
    contextId: params.contextId,
    leaseId: params.leaseId,
  });
  const currentStorageKey = useRef(storageKey);
  currentStorageKey.current = storageKey;
  const selection = useMemo<NativeWorkerViewSelection>(
    () => ({
      runId: params.runId ?? '',
      contextId: params.contextId,
      sessionId: params.sessionId,
      executionNodeId: node,
      leaseId: params.leaseId,
      generation: params.generation,
    }),
    [params.runId, params.contextId, params.sessionId, params.leaseId, params.generation, node],
  );
  const runQuery = useMemo(
    () =>
      params.runId
        ? resourceQuery<RunGetResult>(Methods.RUN_GET, { runId: params.runId })
        : undefined,
    [params.runId],
  );
  const runObservation = useResourceQuery(runQuery);
  const worker = useMemo(
    () =>
      runObservation.data && runQuery
        ? nativeWorkerViewForRun(runObservation.data.run, selection)
        : undefined,
    [runObservation.data, runQuery, selection],
  );
  const currentWorker = useCallback(
    (): NativeWorkerViewTarget | undefined =>
      runQuery &&
      nativeWorkerForAction(
        getResourceCache()?.read(runQuery),
        selection,
        useConnectionStore.getState().status === 'connected',
      ),
    [runQuery, selection],
  );
  const generation = client?.connectionGeneration;
  const farmConnection = useMemo(
    () =>
      params.runId && client
        ? currentFarmConnection(client, useConnectionStore.getState)
        : undefined,
    [client, generation, connection, profile, principalId, authorityEpoch, params.runId],
  );

  useEffect(() => {
    alive.current = true;
    let restoring = true;
    setReady(false);
    setPending(undefined);
    pendingRef.current = undefined;
    setResponses([]);
    responsesRef.current = [];
    setDraft(params.draft ?? '');
    draftRef.current = params.draft ?? '';
    void (async () => {
      try {
        const saved = await conversationStorage.read(storageKey);
        if (!alive.current || !restoring) return;
        if (saved) {
          const value = JSON.parse(saved) as {
            draft?: string;
            pending?: PendingCommand;
            responses?: string[];
          };
          draftRef.current = value.draft ?? params.draft ?? '';
          setDraft(draftRef.current);
          setPending(value.pending);
          pendingRef.current = value.pending;
          setResponses(value.responses ?? []);
          responsesRef.current = value.responses ?? [];
        }
        setReady(true);
      } catch (cause) {
        if (alive.current && restoring)
          setError(`Cannot restore conversation controls: ${message(cause)}`);
      }
    })();
    return () => {
      restoring = false;
      alive.current = false;
    };
  }, [storageKey, params.draft]);

  const persist = useCallback(
    async (text: string, command: PendingCommand | undefined, answered: string[]) => {
      const content = JSON.stringify({ draft: text, pending: command, responses: answered });
      await conversationStorage.write(storageKey, content);
    },
    [storageKey],
  );

  const historyOwner = getResourceNativeOwnerId();
  const historyQuery = useMemo(
    () =>
      params.sessionId && historyOwner && (!params.runId || worker)
        ? nativeHistoryQuery(
            {
              sessionId: params.sessionId,
              executionNodeId: node,
              ...(worker
                ? {
                    worker: {
                      runId: worker.runId,
                      contextId: worker.contextId,
                      generation: worker.binding.generation ?? '',
                      leaseId: worker.binding.leaseId,
                    },
                  }
                : {}),
            },
            historyOwner,
          )
        : undefined,
    [params.sessionId, params.runId, node, worker, historyOwner],
  );
  const inventoryQuery = useMemo(
    () =>
      !params.sessionId && historyOwner
        ? nativeObservationQuery<NativeSessionListResult>(
            Methods.NATIVE_SESSION_LIST,
            {},
            historyOwner,
          )
        : undefined,
    [params.sessionId, historyOwner],
  );
  const historyObservation = useResourceQuery(historyQuery);
  const inventoryObservation = useResourceQuery(inventoryQuery);
  const allowed = canOpenNativeConversation(
    access,
    params.runId || params.contextId || params.leaseId || params.generation,
  );
  const snapshot = allowed ? historyObservation.data : undefined;
  const transcript: NativeTranscript = {
    events: snapshot?.events ?? [],
    cursor: snapshot?.cursor ?? 0,
  };
  const sessions = allowed
    ? (inventoryObservation.data?.sessions ?? [])
        .filter((session) => !session.workerManaged)
        .slice()
        .reverse()
    : [];
  const unavailable = (inventoryObservation.data?.unavailableExecutionNodes ?? []).map(
    (item) => `${item.executionNodeId}: ${item.message}`,
  );
  const caughtUp = historyObservation.status === 'ready' && !!snapshot && !snapshot.hasMore;
  const pollError = !allowed
    ? 'This account cannot open a farm worker conversation.'
    : ((params.sessionId ? historyObservation : inventoryObservation).error?.message ?? '');
  refreshRef.current = async () => {
    const query = historyQuery ?? inventoryQuery;
    try {
      if (query && getResourceCache()?.read<unknown>(query).error)
        await getResourceCache()?.retry<unknown>(query);
    } catch (cause) {
      if (alive.current && currentStorageKey.current === storageKey) setError(message(cause));
    }
  };
  // Reconcile a journal from accepted observations only. Reconnect never dispatches it.
  useEffect(() => {
    if (!caughtUp || !snapshot || !ready) return;
    const command = pendingRef.current;
    const receipt = snapshot.commands.find(
      (item) => item.commandId === command?.commandId && item.generation === command?.generation,
    );
    if (
      command &&
      nativeCommandLockSettled(command, snapshot.session.generation, receipt, snapshot.events)
    ) {
      pendingRef.current = undefined;
      setPending(undefined);
      // The host failed it unseen (the session closed while it was queued): back to the composer.
      if (nativeMessageDropped(receipt)) {
        draftRef.current = command.text;
        setDraft(command.text);
      }
      void persist(draftRef.current, undefined, responsesRef.current).catch((cause) => {
        if (alive.current && currentStorageKey.current === storageKey) setError(message(cause));
      });
    }
  }, [caughtUp, snapshot, ready, persist]);

  const session = snapshot?.session;
  const workerControl = worker && nativeWorkerViewControl(worker, session);
  const writable = nativeConversationWritable({
    allowed,
    ready,
    connected: connection === 'connected',
    history: historyObservation,
    snapshot,
    run: params.runId ? runObservation : undefined,
    workerControl: !!workerControl,
  });
  const target: NativeSessionTargetParams = {
    sessionId: params.sessionId ?? '',
    executionNodeId: node,
    ...(workerControl ? { worker: workerControl } : {}),
  };
  /** `history`: "exact" for actions on the snapshot on screen; "current" for a new message. */
  const assertCurrentControls = (history: 'exact' | 'current' = 'exact') => {
    const live = useConnectionStore.getState();
    if (
      !client ||
      !alive.current ||
      live.client !== client ||
      live.status !== 'connected' ||
      client.connectionState !== 'connected' ||
      client.connectionGeneration !== generation ||
      live.activeProfileId !== profile ||
      live.principalId !== principalId ||
      live.authorityEpoch !== authorityEpoch
    )
      throw new Error('The conversation connection changed. Reopen it before acting.');
    const observation = historyQuery ? getResourceCache()?.read(historyQuery) : undefined;
    if (
      !historyQuery ||
      !(history === 'exact'
        ? nativeHistoryCanAct(observation, snapshot, live.status === 'connected')
        : nativeHistoryCanSend(observation, snapshot, live.status === 'connected'))
    )
      throw new Error('Wait for current conversation history before acting.');
    if (!params.runId) return;
    if (!farmConnection?.()) throw new Error('The worker conversation connection changed.');
    const current = currentWorker();
    if (
      !current ||
      !sameNativeWorkerViewBinding(worker, current) ||
      !nativeWorkerViewControl(current, session)
    )
      throw new Error('Wait for the current worker conversation before acting.');
  };
  const resume = useNativeSessionResume(
    session,
    caughtUp && !pollError && !busy,
    !params.runId,
    assertCurrentControls,
  );
  const mutate = async (action: () => Promise<void>, history: 'exact' | 'current' = 'exact') => {
    if (!client || !writable || mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    try {
      await conversationStorage.transition(storageKey, async () => {
        assertCurrentControls(history);
        await action();
      });
    } catch (cause) {
      if (alive.current && currentStorageKey.current === storageKey) setError(message(cause));
    } finally {
      mutation.current = false;
      if (alive.current && currentStorageKey.current === storageKey) {
        setBusy(false);
        await refreshRef.current();
      }
    }
  };
  const send = () =>
    mutate(async () => {
      if (!session || !nativeSendLabel(session.state) || pendingRef.current || !draft.trim())
        return;
      const command: PendingCommand = {
        ...target,
        generation: session.generation,
        commandId: `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text: draft.trim(),
      };
      pendingRef.current = command;
      setPending(command);
      draftRef.current = '';
      setDraft('');
      let issued = false;
      try {
        await persist('', command, responsesRef.current);
        assertCurrentControls('current');
        issued = true;
        const { generation: _, ...request } = command;
        await client!.request(Methods.NATIVE_SESSION_SEND, request, 30_000);
      } catch (cause) {
        // Never sent: the message goes back to the composer instead of waiting on a delivery.
        if (!issued) {
          pendingRef.current = undefined;
          draftRef.current = command.text;
          if (alive.current) {
            setPending(undefined);
            setDraft(command.text);
          }
          try {
            await persist(command.text, undefined, responsesRef.current);
          } catch (storageFailure) {
            throw new AggregateError([cause, storageFailure], 'Cannot restore the unsent message.');
          }
        }
        throw cause;
      }
    }, 'current');
  const retry = () =>
    mutate(async () => {
      const command = pendingRef.current;
      if (!command || !session || command.generation !== session.generation) return;
      await persist(draftRef.current, command, responsesRef.current);
      assertCurrentControls('current');
      const { generation: _, ...request } = command;
      await client!.request(Methods.NATIVE_SESSION_SEND, request, 30_000);
    }, 'current');
  const respond = (requestId: string, response: NativeSessionResponse) =>
    mutate(async () => {
      const request = snapshot?.pendingRequests.find((item) => item.request?.id === requestId);
      if (
        !request ||
        request.generation !== session?.generation ||
        responsesRef.current.includes(requestId) ||
        request.responseState === 'unknown'
      )
        return;
      if (
        request.type === 'question.requested'
          ? !session?.capabilities.questions
          : !session?.capabilities.approvals
      )
        return;
      const answered = [...responsesRef.current, requestId];
      responsesRef.current = answered;
      setResponses(answered);
      let issued = false;
      try {
        await persist(draftRef.current, pendingRef.current, answered);
        assertCurrentControls();
        issued = true;
        await client!.request(
          Methods.NATIVE_SESSION_RESPOND,
          { ...target, requestId, ...response },
          30_000,
        );
      } catch (cause) {
        if (!issued) {
          const unsent = responsesRef.current.filter((id) => id !== requestId);
          responsesRef.current = unsent;
          if (alive.current) setResponses(unsent);
          try {
            await persist(draftRef.current, pendingRef.current, unsent);
          } catch (storageFailure) {
            throw new AggregateError([cause, storageFailure], 'Cannot restore the unsent answer.');
          }
        }
        throw cause;
      }
    });
  /** Edit: the host removes the queued message, and reconciling its receipt restores the text. */
  const edit = () =>
    mutate(async () => {
      const command = pendingRef.current;
      const queued = snapshot?.commands.find((item) => item.commandId === command?.commandId);
      if (command && nativeMessageCancelable(session, queued))
        await client!.request(
          Methods.NATIVE_SESSION_CANCEL,
          { ...target, commandId: command.commandId },
          30_000,
        );
    });
  const entries = nativeTimeline(transcript.events);
  const rows = nativeTimelineRows(entries);
  const work = nativeWork(transcript.events);
  const sendLabel = nativeSendLabel(session?.state);
  const receipt = snapshot?.commands.find((item) => item.commandId === pending?.commandId);
  /** The pending message, until the conversation shows it. */
  const pendingText =
    pending && !nativeMessageShown(transcript.events, pending.commandId) ? pending.text : undefined;
  const canSend = writable && !!sendLabel && !pending && !busy && !!draft.trim();
  const proof = useRef({
    focused,
    observation: runObservation,
    selection,
    worker,
    session,
    timeline: entries,
    cursor: transcript.cursor,
    eventCount: transcript.events.length,
    pageReadCount: snapshot?.historyRead?.pageReadCount ?? 0,
    pageAfters: snapshot?.historyRead?.pageAfters ?? [],
    historyObservation,
    historyQuery,
    commands: snapshot?.commands ?? [],
    draft,
    pendingCommandId: pending?.commandId,
    pendingText,
    responses,
    ready,
    caughtUp,
    writable,
    canSend,
    resumeAvailable: resume.viewModel.available,
    resumeReady: resume.viewModel.ready,
    busy,
  });
  proof.current = {
    focused,
    observation: runObservation,
    selection,
    worker,
    session,
    timeline: entries,
    cursor: transcript.cursor,
    eventCount: transcript.events.length,
    pageReadCount: snapshot?.historyRead?.pageReadCount ?? 0,
    pageAfters: snapshot?.historyRead?.pageAfters ?? [],
    historyObservation,
    historyQuery,
    commands: snapshot?.commands ?? [],
    draft,
    pendingCommandId: pending?.commandId,
    pendingText,
    responses,
    ready,
    caughtUp,
    writable,
    canSend,
    resumeAvailable: resume.viewModel.available,
    resumeReady: resume.viewModel.ready,
    busy,
  };
  useEffect(() => {
    if (__DEV__ && (params.runId || params.sessionId))
      return observeNativeConversation((params.runId || params.sessionId)!, () => ({
        ...proof.current,
      }));
  }, [params.runId, params.sessionId, storageKey]);
  return {
    viewModel: {
      sessions,
      unavailable,
      creation: creation.viewModel,
      resume: resume.viewModel,
      session,
      entries,
      rows,
      work,
      requests: snapshot?.pendingRequests ?? [],
      responses,
      draft,
      pending,
      pendingText,
      receipt,
      canRetry: nativeRetryAvailable(receipt),
      canEdit: nativeMessageCancelable(session, receipt),
      error: error || pollError || creation.viewModel.error || resume.viewModel.error,
      busy,
      ready,
      connected: connection === 'connected',
      writable,
      canSend,
      sendLabel: sendLabel ?? 'Send',
      canStop:
        writable &&
        !!session?.capabilities.interrupt &&
        ['running', 'waiting'].includes(session.state) &&
        !busy,
      workerLabel: worker
        ? `${worker.label}${snapshot?.scope?.released || worker.readOnly ? ' · Task history' : ''}`
        : undefined,
      historyObservation,
      inventoryObservation,
      runObservation: params.runId ? runObservation : undefined,
    },
    actions: {
      creation: creation.actions,
      resume: {
        profiles: resume.actions.profiles,
        resume: async () => {
          const generation = client?.connectionGeneration;
          const next = await resume.actions.resume();
          if (!next || !alive.current || client?.connectionGeneration !== generation) return;
          try {
            await conversationStorage.write(
              nativeConversationStorageKey({
                profile,
                gatewayUrl,
                principalId,
                node: next.executionNodeId,
                sessionId: next.id,
              }),
              JSON.stringify({ draft: draftRef.current, responses: [] }),
            );
            if (alive.current && client?.connectionGeneration === generation) return next;
          } catch (cause) {
            if (alive.current)
              setError(
                `Conversation resumed, but the draft could not be saved: ${message(cause)}. Open it from the session list.`,
              );
          }
        },
      },
      refresh: () => refreshRef.current(),
      retryRun: async () => {
        if (!runQuery) return;
        const cache = getResourceCache();
        try {
          if (cache?.read(runQuery).error) await cache.retry(runQuery);
          if (alive.current) await refreshRef.current();
        } catch (cause) {
          if (alive.current && currentStorageKey.current === storageKey) setError(message(cause));
        }
      },
      send,
      retry,
      edit,
      respond,
      setDraft: (value: string) => {
        draftRef.current = value;
        setDraft(value);
        void persist(value, pendingRef.current, responsesRef.current).catch((cause) => {
          if (alive.current) setError(`Cannot save draft: ${message(cause)}`);
        });
      },
      saveDraft: () =>
        persist(draftRef.current, pendingRef.current, responsesRef.current).catch((cause) =>
          setError(message(cause)),
        ),
      stop: () =>
        mutate(async () => {
          if (session?.capabilities.interrupt)
            await client!.request(Methods.NATIVE_SESSION_INTERRUPT, target, 30_000);
        }),
    },
  };
}
