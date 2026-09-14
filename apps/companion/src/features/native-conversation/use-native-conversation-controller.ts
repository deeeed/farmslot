import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  isTerminalRunStatus,
  Methods,
  type NativeSessionInfo,
  type NativeSessionListResult,
  type NativeSessionReadResult,
  type NativeSessionResponse,
  type NativeSessionSendParams,
  type NativeSessionTargetParams,
  type RunGetResult,
} from '@farmslot/protocol';

import {
  appendNativePage,
  nativeCommandLockSettled,
  nativeTimeline,
  type NativeTranscript,
} from '../../lib/native-conversation';
import {
  createNativeConversationStorage,
  nativeConversationStorageKey,
} from '../../lib/native-conversation-storage';
import {
  nativeWorkerViewControl,
  type NativeWorkerViewTarget,
} from '../../lib/native-worker-target';
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
  const client = useConnectionStore((state) => state.client);
  const connection = useConnectionStore((state) => state.status);
  const profile = useConnectionStore((state) => state.activeProfileId);
  const gatewayUrl = useConnectionStore((state) => state.gatewayUrl);
  const principalId = useConnectionStore((state) => state.principalId);
  const access = useConnectionStore((state) => state.workspaceAccess);
  const creation = useNativeSessionSetup(!params.sessionId);
  const [sessions, setSessions] = useState<NativeSessionInfo[]>([]);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<NativeSessionReadResult>();
  const [transcript, setTranscript] = useState<NativeTranscript>({ events: [], cursor: 0 });
  const [worker, setWorker] = useState<NativeWorkerViewTarget>();
  const [draft, setDraft] = useState(params.draft ?? '');
  const [pending, setPending] = useState<PendingCommand>();
  const [responses, setResponses] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [caughtUp, setCaughtUp] = useState(false);
  const alive = useRef(true);
  const mutation = useRef(false);
  const draftRef = useRef(draft);
  const transcriptRef = useRef(transcript);
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

  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const saved = await conversationStorage.read(storageKey);
        if (!alive.current) return;
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
        if (alive.current) setError(`Cannot restore conversation controls: ${message(cause)}`);
      }
    })();
    return () => {
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

  // A reconnect replays the same journal; it never resends a prompt or an approval.
  useEffect(() => {
    if (!ready || !client || connection !== 'connected') return;
    if (
      !canOpenNativeConversation(
        access,
        params.runId || params.contextId || params.leaseId || params.generation,
      )
    ) {
      setPollError('This account cannot open a farm worker conversation.');
      return;
    }
    let active = true;
    let polling = false;
    let timer: ReturnType<typeof setTimeout>;
    const generation = client.connectionGeneration;
    const current = () =>
      active &&
      client.connectionGeneration === generation &&
      (client.authenticatedPrincipal?.id ?? null) === principalId;
    const poll = async () => {
      if (polling || !current()) return;
      polling = true;
      try {
        if (!params.sessionId) {
          const result = await client.request<NativeSessionListResult>(
            Methods.NATIVE_SESSION_LIST,
            {},
          );
          if (!current()) return;
          setSessions(result.sessions.filter((session) => !session.workerManaged).reverse());
          setUnavailable(
            (result.unavailableExecutionNodes ?? []).map(
              (item) => `${item.executionNodeId}: ${item.message}`,
            ),
          );
        } else {
          let target: NativeWorkerViewTarget | undefined;
          if (params.runId) {
            const { run } = await client.request<RunGetResult>(Methods.RUN_GET, {
              runId: params.runId,
            });
            if (!current()) return;
            const context = run.agentContexts?.find((item) => item.id === params.contextId);
            const binding = [context?.nativeSession, ...(context?.nativeSessionHistory ?? [])].find(
              (item) =>
                item &&
                item.sessionId === params.sessionId &&
                item.executionNodeId === node &&
                item.leaseId === params.leaseId,
            );
            if (!context || !binding)
              throw new Error('This run no longer contains the selected worker conversation.');
            target = {
              runId: run.id,
              contextId: context.id,
              label: context.label,
              binding: { ...binding, generation: params.generation ?? binding.generation },
              readOnly:
                isTerminalRunStatus(run.status) || !!binding.closedAt || !!binding.releasedAt,
            };
            setWorker(target);
          }
          for (let count = 0; count < 20; count++) {
            const page: NativeSessionReadResult = await client.request<NativeSessionReadResult>(
              Methods.NATIVE_SESSION_READ,
              {
                sessionId: params.sessionId,
                executionNodeId: node,
                ...(transcriptRef.current.cursor ? { after: transcriptRef.current.cursor } : {}),
                ...(target
                  ? {
                      worker: {
                        runId: target.runId,
                        contextId: target.contextId,
                        generation: target.binding.generation ?? '',
                        leaseId: target.binding.leaseId,
                      },
                    }
                  : {}),
                limit: 200,
              },
            );
            if (!current()) return;
            if (page.session.id !== params.sessionId || page.session.executionNodeId !== node)
              throw new Error('Conversation replay returned another session or execution node.');
            if (
              target &&
              (page.session.workerLeaseId !== target.binding.leaseId ||
                page.scope?.leaseId !== target.binding.leaseId)
            )
              throw new Error(
                'This conversation belongs to another task. Open that task to continue.',
              );
            if (!transcriptRef.current.events.length && page.scope) {
              transcriptRef.current = { events: [], cursor: page.scope.startAfter };
            }
            transcriptRef.current = appendNativePage(transcriptRef.current, page);
            setTranscript(transcriptRef.current);
            setSnapshot(page);
            setCaughtUp(!page.hasMore);
            const command = pendingRef.current;
            const receipt = page.commands.find(
              (item) =>
                item.commandId === command?.commandId && item.generation === command?.generation,
            );
            if (
              command &&
              nativeCommandLockSettled(
                command,
                page.session.generation,
                receipt,
                transcriptRef.current.events,
              )
            ) {
              pendingRef.current = undefined;
              setPending(undefined);
              await persist(draftRef.current, undefined, responsesRef.current);
            }
            if (!page.hasMore) break;
          }
        }
        if (current()) setPollError('');
      } catch (cause) {
        if (current()) {
          setPollError(message(cause));
          setCaughtUp(false);
        }
      } finally {
        polling = false;
        if (current()) timer = setTimeout(() => void poll(), params.sessionId ? 1200 : 5000);
      }
    };
    refreshRef.current = poll;
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    client,
    connection,
    principalId,
    access,
    ready,
    params.sessionId,
    params.runId,
    params.contextId,
    params.leaseId,
    params.generation,
    node,
    storageKey,
    persist,
  ]);

  const session = snapshot?.session;
  const resume = useNativeSessionResume(session, !params.runId && caughtUp && !pollError && !busy);
  const workerControl = worker && nativeWorkerViewControl(worker, session);
  const writable =
    !!session &&
    ready &&
    caughtUp &&
    !pollError &&
    !snapshot?.scope?.released &&
    connection === 'connected' &&
    !['closed', 'failed', 'closing', 'starting'].includes(session.state) &&
    (session.workerManaged ? !!workerControl : !params.runId);
  const target: NativeSessionTargetParams = {
    sessionId: params.sessionId ?? '',
    executionNodeId: node,
    ...(workerControl ? { worker: workerControl } : {}),
  };
  const mutate = async (action: () => Promise<void>) => {
    if (!client || !writable || mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      mutation.current = false;
      if (alive.current) {
        setBusy(false);
        await refreshRef.current();
      }
    }
  };
  const send = () =>
    mutate(async () => {
      if (!session || session.state !== 'idle' || pendingRef.current || !draft.trim()) return;
      const command: PendingCommand = {
        ...target,
        generation: session.generation,
        commandId: `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text: draft.trim(),
      };
      const generation = client!.connectionGeneration;
      pendingRef.current = command;
      setPending(command);
      draftRef.current = '';
      setDraft('');
      await persist('', command, responsesRef.current);
      if (!alive.current || client!.connectionGeneration !== generation)
        throw new Error(
          'Gateway changed before submission. Reopen the original conversation to reconcile.',
        );
      const { generation: _, ...request } = command;
      await client!.request(Methods.NATIVE_SESSION_SEND, request, 30_000);
    });
  const retry = () =>
    mutate(async () => {
      const command = pendingRef.current;
      if (!command || !session || command.generation !== session.generation) return;
      const generation = client!.connectionGeneration;
      await persist(draftRef.current, command, responsesRef.current);
      if (!alive.current || client!.connectionGeneration !== generation)
        throw new Error('Gateway changed before retry.');
      const { generation: _, ...request } = command;
      await client!.request(Methods.NATIVE_SESSION_SEND, request, 30_000);
    });
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
      const generation = client!.connectionGeneration;
      responsesRef.current = answered;
      setResponses(answered);
      await persist(draftRef.current, pendingRef.current, answered);
      if (!alive.current || client!.connectionGeneration !== generation)
        throw new Error('Gateway changed before the response. The answer will not be resent.');
      await client!.request(
        Methods.NATIVE_SESSION_RESPOND,
        { ...target, requestId, ...response },
        30_000,
      );
    });
  return {
    viewModel: {
      sessions,
      unavailable,
      creation: creation.viewModel,
      resume: resume.viewModel,
      session,
      entries: nativeTimeline(transcript.events),
      requests: snapshot?.pendingRequests ?? [],
      responses,
      draft,
      pending,
      receipt: snapshot?.commands.find((item) => item.commandId === pending?.commandId),
      error: error || pollError || creation.viewModel.error || resume.viewModel.error,
      busy,
      ready,
      connected: connection === 'connected',
      writable,
      canSend: writable && session?.state === 'idle' && !pending && !busy && !!draft.trim(),
      canStop:
        writable &&
        !!session?.capabilities.interrupt &&
        ['running', 'waiting'].includes(session.state) &&
        !busy,
      workerLabel: worker
        ? `${worker.label}${snapshot?.scope?.released || worker.readOnly ? ' · Task history' : ''}`
        : undefined,
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
      send,
      retry,
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
