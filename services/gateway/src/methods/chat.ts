// methods/chat.ts — Co-pilot chat RPC handlers

import {
  type ChatAbortParams,
  type ChatAbortResult,
  type ChatClearParams,
  type ChatClearResult,
  type ChatConfirmActionParams,
  type ChatConfirmActionResult,
  type ChatContextResult,
  type ChatHistoryParams,
  type ChatHistoryResult,
  type ChatListActionsParams,
  type ChatListActionsResult,
  type ChatNewParams,
  type ChatNewResult,
  type ChatObserverEvidenceParams,
  type ChatObserverEvidenceResult,
  type ChatSaveMemoryParams,
  type ChatSaveMemoryResult,
  type ChatScreenEvidenceParams,
  type ChatScreenEvidenceResult,
  type ChatSendParams,
  type ChatSendResult,
  type ChatSessionContextParams,
  type ChatSessionContextResult,
  type ChatSessionCreateParams,
  type ChatSessionCreateResult,
  type ChatSessionDeleteParams,
  type ChatSessionDeleteResult,
  type ChatSessionPinParams,
  type ChatSessionPinResult,
  type ChatSessionsBulkDeleteParams,
  type ChatSessionsBulkDeleteResult,
  type ChatSessionsResult,
  Events,
  GLOBAL_CHAT_SESSION_ID,
} from '@farmslot/protocol';

import {
  clearChatActionsForSession,
  confirmChatAction,
  listChatActions,
} from '../chat/chat-actions.js';
// abortChatSession is also imported above for chat.abort; chat.sessionDelete
// reuses it so deleting a session cancels any in-flight LLM call routed to
// that session (otherwise a phantom write to a resurrected session id and
// wasted tokens until the call completes).
import { buildFleetContext } from '../chat/chat-context.js';
import {
  abortChatSession,
  clearSessionPiHistory,
  processChatMessage,
} from '../chat/chat-engine.js';
import { saveMemory, saveSessionMemory } from '../chat/chat-memory.js';
import {
  clearSession,
  createChatSession,
  deleteSession,
  deleteSessions,
  generateMessageId,
  getSession,
  getSessionMessages,
  listSessionSummaries,
  markSessionSaved,
  normalizeSessionId,
  pinSession,
  summarizeSession,
} from '../chat/chat-store.js';
import { readObserverEvidence } from '../chat/copilot-observer.js';
import { clearScreenEvidenceSnapshot, readLastScreenEvidence } from '../chat/screen-evidence.js';
import { getLLMConfig } from '../llm/config.js';
import { describeModel } from '../llm/index.js';

type Emit = (event: string, payload: unknown) => void;

export async function chatSend(params: ChatSendParams, emit: Emit): Promise<ChatSendResult> {
  const sessionId = normalizeSessionId(params.sessionId);
  const requestId = generateMessageId();
  let emittedChatResponse = false;
  const streamingEmit: Emit = (event, payload) => {
    if (event === Events.CHAT_RESPONSE) emittedChatResponse = true;
    emit(event, payload);
  };
  void processChatMessage(
    sessionId,
    params.message,
    params.clientContext,
    params.intent,
    streamingEmit,
  ).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[chat] async chat.send failed: ${message}`);
    if (!emittedChatResponse) {
      emit(Events.CHAT_RESPONSE, {
        sessionId,
        state: 'error',
        errorMessage: message,
      });
    }
  });
  return { messageId: requestId };
}

export function chatHistory(params: ChatHistoryParams): ChatHistoryResult {
  const sessionId = normalizeSessionId(params.sessionId);
  const messages = getSessionMessages(sessionId, params.limit);
  return { messages };
}

export function chatClear(params: ChatClearParams): ChatClearResult {
  if (!params.sessionId) {
    console.warn('[chat] chat.clear ignored because sessionId was omitted');
    return {};
  }
  const sessionId = normalizeSessionId(params.sessionId);
  clearSessionPiHistory(sessionId);
  clearScreenEvidenceSnapshot(sessionId);
  clearChatActionsForSession(sessionId);
  clearSession(sessionId);
  return {};
}

export async function chatNew(params: ChatNewParams, emit: Emit): Promise<ChatNewResult> {
  const sessionId = normalizeSessionId(params.sessionId);
  // Don't materialize a missing chat session here. chatNew's job is to
  // save-and-clear the active chat plus drop associated side-effects (pi
  // history, screen evidence, action cards). Materializing a missing session
  // would create-then-clear an empty ephemeral that leaks into getAllSessions
  // until restart. Side-effect cleanups are still safe to run unconditionally
  // because they're keyed by sessionId, not by an extant chat-store entry.
  const session = getSession(sessionId);
  let savedPath: string | undefined;
  if (session && session.messages.length > 0) {
    savedPath = await saveSessionMemory(sessionId, session.messages, emit);
  }
  clearSessionPiHistory(sessionId);
  clearScreenEvidenceSnapshot(sessionId);
  clearChatActionsForSession(sessionId);
  if (session) {
    clearSession(sessionId);
    if (savedPath !== undefined) markSessionSaved(sessionId, savedPath);
  }
  return savedPath !== undefined ? { savedPath } : {};
}

export function chatSessions(): ChatSessionsResult {
  return { sessions: listSessionSummaries() };
}

export function chatSessionCreate(params: ChatSessionCreateParams = {}): ChatSessionCreateResult {
  const session = createChatSession({
    sessionId: params.sessionId,
    title: params.title,
    pinned: params.pinned,
  });
  return { session: summarizeSession(session) };
}

export async function chatSessionDelete(
  params: ChatSessionDeleteParams,
): Promise<ChatSessionDeleteResult> {
  if (!params.sessionId) throw new Error('chat.sessionDelete requires sessionId');
  const id = normalizeSessionId(params.sessionId);
  // Store-layer also rejects global; we run cleanups before delegating so the
  // session's side-effect state is wiped even if the deleteSession call
  // throws due to a future change in normalize behavior.
  if (id === GLOBAL_CHAT_SESSION_ID)
    throw new Error('Cannot delete the shared global chat session');
  abortChatSession(id);
  clearSessionPiHistory(id);
  clearScreenEvidenceSnapshot(id);
  clearChatActionsForSession(id);
  const deleted = await deleteSession(id);
  return { ok: true, deleted };
}

export async function chatSessionsBulkDelete(
  params: ChatSessionsBulkDeleteParams,
): Promise<ChatSessionsBulkDeleteResult> {
  const ids = (params.sessionIds ?? []).map((id) => normalizeSessionId(id));
  // Pre-flight cleanup before the store-layer delete so side-effect state is
  // wiped atomically. Store-layer also throws on global; check here so we
  // don't run cleanups for non-global ids first.
  if (ids.includes(GLOBAL_CHAT_SESSION_ID)) {
    throw new Error('Cannot delete the shared global chat session');
  }
  for (const id of ids) {
    abortChatSession(id);
    clearSessionPiHistory(id);
    clearScreenEvidenceSnapshot(id);
    clearChatActionsForSession(id);
  }
  const deleted = await deleteSessions(ids);
  return { deleted };
}

export async function chatSessionPin(params: ChatSessionPinParams): Promise<ChatSessionPinResult> {
  if (!params.sessionId) throw new Error('chat.sessionPin requires sessionId');
  const session = await pinSession(params.sessionId);
  if (!session) throw new Error(`No chat session: ${params.sessionId}`);
  return { session: summarizeSession(session) };
}

export function chatScreenEvidence(
  params: ChatScreenEvidenceParams = {},
): ChatScreenEvidenceResult {
  const sessionId = normalizeSessionId(params.sessionId);
  return { snapshot: readLastScreenEvidence(sessionId) };
}

export function chatObserverEvidence(
  params: ChatObserverEvidenceParams = {},
): ChatObserverEvidenceResult {
  return { evidence: readObserverEvidence(params) };
}

export async function chatSaveMemory(
  params: ChatSaveMemoryParams,
  _emit: Emit,
): Promise<ChatSaveMemoryResult> {
  await saveMemory(params.content);
  return {};
}

export async function chatConfirmAction(
  params: ChatConfirmActionParams,
  emit: Emit,
): Promise<ChatConfirmActionResult> {
  return confirmChatAction(params, emit);
}

export function chatListActions(params: ChatListActionsParams): ChatListActionsResult {
  return { actions: listChatActions(params.sessionId) };
}

export function chatAbort(params: ChatAbortParams): ChatAbortResult {
  abortChatSession(normalizeSessionId(params.sessionId));
  return {};
}

export async function chatContext(): Promise<ChatContextResult> {
  const context = await buildFleetContext();
  return {
    context,
    generatedAt: new Date().toISOString(),
    charCount: context.length,
  };
}

const CHAT_CONTEXT_WARNING_THRESHOLD_TOKENS = 80_000;

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-haiku-4-5': 200_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  // Codex models_cache reports 272k for the GPT-5.6 family.
  'gpt-5.6-sol': 272_000,
  'gpt-5.6-terra': 272_000,
  'gpt-5.6-luna': 272_000,
  'gpt-5.6': 272_000,
  'gpt-5.5': 400_000,
  'gpt-5.4': 400_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.3-codex-spark': 400_000,
};

const CONTEXT_WINDOW_ESTIMATE_NOTE =
  'Window estimates use provider-reported inputTokens. Cache read/write tokens are not currently reported separately by the gateway, so remaining/window-used values may be approximate when provider caching is active.';

export function chatSessionContext(
  params: ChatSessionContextParams = {},
): ChatSessionContextResult {
  const sessionId = normalizeSessionId(params.sessionId);
  const session = getSession(sessionId);
  const cfg = getLLMConfig();
  const runtimeIdentity = describeModel(cfg.defaultProvider, cfg.copilotModel);
  const messages = session?.messages ?? [];
  const assistantUsage = messages
    .filter((message) => message.role === 'assistant' && message.usage)
    .map((message) => message.usage!);
  const totalInputTokens = assistantUsage.reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0);
  const totalOutputTokens = assistantUsage.reduce(
    (sum, usage) => sum + (usage.outputTokens ?? 0),
    0,
  );
  const totalCostUsd = assistantUsage.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0);
  const lastUsage = assistantUsage.at(-1);
  const estimatedMaxTokens = estimateContextWindow(runtimeIdentity);
  const lastInputTokens = lastUsage?.inputTokens;
  const remainingInputTokens =
    estimatedMaxTokens !== null && lastInputTokens !== undefined
      ? Math.max(0, estimatedMaxTokens - lastInputTokens)
      : null;
  const lastInputPct =
    estimatedMaxTokens !== null && lastInputTokens !== undefined
      ? Math.min(100, Math.round((lastInputTokens / estimatedMaxTokens) * 10_000) / 100)
      : null;

  return {
    sessionId,
    generatedAt: new Date().toISOString(),
    model: {
      provider: cfg.defaultProvider,
      configuredModel: cfg.copilotModel,
      runtimeIdentity,
    },
    messages: {
      total: messages.length,
      user: messages.filter((message) => message.role === 'user').length,
      assistant: messages.filter((message) => message.role === 'assistant').length,
      system: messages.filter((message) => message.role === 'system').length,
    },
    usage: {
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      ...(lastUsage?.inputTokens !== undefined ? { lastInputTokens: lastUsage.inputTokens } : {}),
      ...(lastUsage?.outputTokens !== undefined
        ? { lastOutputTokens: lastUsage.outputTokens }
        : {}),
      ...(lastUsage?.costUsd !== undefined ? { lastCostUsd: lastUsage.costUsd } : {}),
    },
    contextWindow: {
      estimatedMaxTokens,
      warningThresholdTokens: CHAT_CONTEXT_WARNING_THRESHOLD_TOKENS,
      lastInputPct,
      remainingInputTokens,
      note: CONTEXT_WINDOW_ESTIMATE_NOTE,
    },
    compaction: {
      automatic: false,
      jumpsUntilCompact: null,
      status: 'not-implemented',
      note: 'Co-Pilot chat sessions persist until /new. The gateway does not currently have automatic compaction or a provider-reported jumps-until-compact counter.',
    },
  };
}

export function estimateContextWindow(runtimeIdentity: string): number | null {
  const identityWithoutTier = runtimeIdentity.replace(/\s+\(requested tier:.*\)$/i, '').trim();
  const rawModelKey = identityWithoutTier.split(/[/:]/).at(-1)?.trim() ?? identityWithoutTier;
  if (/\[1m\]$/i.test(rawModelKey)) return 1_000_000;
  const modelKey = rawModelKey.replace(/\[[^\]]+\]$/g, '');
  const exact = MODEL_CONTEXT_WINDOWS[modelKey];
  if (exact !== undefined) return exact;
  const match = Object.entries(MODEL_CONTEXT_WINDOWS)
    .filter(([model]) => modelKey === model || modelKey.startsWith(`${model}-`))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return match?.[1] ?? null;
}
