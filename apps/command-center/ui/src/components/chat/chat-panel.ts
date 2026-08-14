import { html } from 'lit';
import { customElement } from 'lit/decorators.js';

import type {
  ChatClientContext,
  ChatHistoryResult,
  ChatListActionsResult,
  ChatMemorySavedPayload,
  ChatMessage,
  ChatNewResult,
  ChatNextStep,
  ChatResponsePayload,
  ChatSendIntent,
  ChatSessionContextResult,
  ChatSessionCreateResult,
  ChatSessionsResult,
  CopilotConfigureResult,
  CopilotObserverNotificationPayload,
  CopilotRuntimeSession,
  CopilotRuntimeUpdatedPayload,
  CopilotStartResult,
  CopilotStatusResult,
  CopilotStopResult,
  TmuxWorkerListResult,
} from '@farmslot/protocol';
import { Events, Methods } from '@farmslot/protocol';

import './chat-message.js';
import './chat-history-modal.js';
import '../shared/runner-model-effort-picker.js';
import '../terminal/terminal-view.js';

import { gateway, GatewayRequestError } from '../../gateway-client.js';
import { safeLsSet } from '../../utils/storage.js';
import type { RunnerModelEffortChangeDetail } from '../shared/runner-model-effort-picker.js';

import { buildChatClientContext } from './chat-client-context.js';
import { collectChatActionIds, pruneStaleChatActions } from './chat-panel-action-model.js';
import {
  ACTIVE_SESSION_KEY,
  chatSessionDisplayName,
  clampChatDrawerHeight,
  errorMessage,
  formatChatInt,
  formatChatUsd,
  SHARED_SESSION_ID,
  UNAVAILABLE_REJECT_CODES,
} from './chat-panel-model.js';
import { applyChatPanelResponse } from './chat-panel-response-model.js';
import {
  copilotRuntimeStatusLabel,
  dangerousLaunchSummary,
  dangerousStartParams,
} from './chat-panel-runtime-model.js';
import { ChatPanelState } from './chat-panel-state.js';
import { renderChatPanelStyles } from './chat-panel-styles.js';
import { chatPanelViewModel } from './chat-panel-view-model.js';

@customElement('chat-panel')
export class ChatPanel extends ChatPanelState {
  protected override createRenderRoot() {
    return this;
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has('open') && this.open) {
      void this.updateComplete.then(() => {
        const input = this.querySelector('.cp-input');
        if (input instanceof HTMLTextAreaElement) input.focus();
      });
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadHistory();
    void this.loadRuntime();
    void this.loadSessions();
    this.unsubResponse = gateway.subscribe<ChatResponsePayload>(Events.CHAT_RESPONSE, (payload) => {
      this.handleChatResponse(payload);
    });
    this.unsubMemory = gateway.subscribe<ChatMemorySavedPayload>(Events.CHAT_MEMORY_SAVED, (p) => {
      if (!p.sessionId || p.sessionId === this.activeSessionId()) this.showMemoryToast(p.path);
    });
    this.unsubObserver = gateway.subscribe<CopilotObserverNotificationPayload>(
      Events.COPILOT_OBSERVER_NOTIFICATION,
      (payload) => {
        this.observerNotifications = [payload, ...this.observerNotifications].slice(0, 5);
        this.dispatchEvent(
          new CustomEvent('notification', { detail: payload, bubbles: true, composed: true }),
        );
      },
    );
    this.unsubRuntime = gateway.subscribe<CopilotRuntimeUpdatedPayload>(
      Events.COPILOT_RUNTIME_UPDATED,
      ({ session }) => {
        this.syncRuntime(session);
      },
    );
    this.unsubConnection = gateway.onConnectionChange((s) => {
      if (s !== 'connected') return;
      void this.loadRuntime(true);
      void this.reconcileActionsAfterReconnect();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubResponse?.();
    this.unsubMemory?.();
    this.unsubObserver?.();
    this.unsubRuntime?.();
    this.unsubConnection?.();
    this.stopResize();
  }

  private activeSessionId(): string {
    return this.activeSessionIdValue;
  }

  private switchSession(nextId: string, loadHistory = true) {
    const previous = this.activeSessionId();
    if (previous === nextId) return;
    this.abortStreamingSession(previous);
    this.resetStreamingState();
    this.activeSessionIdValue = nextId;
    safeLsSet(ACTIVE_SESSION_KEY, nextId);
    if (loadHistory) void this.loadHistory();
    if (this.usageOpen) void this.loadUsageContext();
  }

  private resetStreamingState() {
    this.streamingText = '';
    this.streamingStatus = '';
    this.streamingError = '';
    this.sending = false;
  }

  private async loadSessions() {
    try {
      const result = await gateway.request<ChatSessionsResult>(Methods.CHAT_SESSIONS, {});
      this.sessionSummaries = result.sessions;
    } catch (err) {
      const message = errorMessage(err);
      if (
        message === 'Not connected' ||
        (err instanceof GatewayRequestError && err.code === 'METHOD_NOT_FOUND')
      )
        return;
      console.warn('[chat-panel] could not load sessions:', err);
    }
  }

  // On WS reconnect: prune action cards the gateway no longer knows about
  // (gateway restart drops the registry — invalidate-all v1) and toast the
  // operator. Only the active session is reconciled here; other sessions get
  // pruned via loadHistory() when the operator switches in.
  private async reconcileActionsAfterReconnect(): Promise<void> {
    const renderedIds = collectChatActionIds(this.messages);
    if (renderedIds.size === 0) return;
    const sessionId = this.activeSessionId();
    let liveIds: Set<string>;
    try {
      const result = await gateway.request<ChatListActionsResult>(Methods.CHAT_LIST_ACTIONS, {
        sessionId,
      });
      liveIds = new Set(result.actions.map((a) => a.actionId));
    } catch (err) {
      const message = errorMessage(err);
      // Older gateways without the method are a known forward-compat case;
      // skip pruning rather than surfacing a misleading toast.
      if (err instanceof GatewayRequestError && err.code === 'METHOD_NOT_FOUND') return;
      if (message === 'Not connected') return;
      console.warn('[chat-panel] chat.listActions failed:', err);
      return;
    }

    const { messages, pruned } = pruneStaleChatActions(this.messages, liveIds);
    if (pruned > 0) {
      this.messages = messages;
      this.surfaceToast(
        `ChatActionExpired: ${pruned} action${pruned === 1 ? '' : 's'} expired (gateway restart)`,
      );
    }
    // Symmetric refill: prune above only drops client-side stale ids; any
    // server-issued cards that landed during the disconnect window aren't on
    // the client yet. loadHistory() re-fetches messages from the gateway so
    // those cards (and any new assistant responses) become visible.
    void this.loadHistory();
  }

  // Reuses the cp-toast surface used by memorySavedToast and dispatches a
  // bubbling 'toast' CustomEvent for any global listener.
  private surfaceToast(message: string): void {
    this.memorySavedToast = message;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.memorySavedToast = null;
    }, 4000);
    this.dispatchEvent(
      new CustomEvent('toast', {
        detail: { kind: 'warn', message },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async loadHistory(sessionId = this.activeSessionId()) {
    try {
      const result = await gateway.request<ChatHistoryResult>(Methods.CHAT_HISTORY, {
        sessionId,
      });
      if (sessionId !== this.activeSessionId()) return;
      this.messages = result.messages;
      this.sessionCost = result.messages.reduce(
        (sum, message) => sum + (message.usage?.costUsd ?? 0),
        0,
      );
      this.scrollToBottom();
    } catch (err) {
      const message = errorMessage(err);
      const isOptionalHistoryError =
        message === 'Not connected' ||
        (err instanceof GatewayRequestError && err.code === 'METHOD_NOT_FOUND');
      if (isOptionalHistoryError) {
        // History is optional before the gateway is connected or when paired with an older gateway.
        if (sessionId !== this.activeSessionId()) return;
        this.messages = [];
        this.sessionCost = 0;
        return;
      }
      if (sessionId !== this.activeSessionId()) return;
      this.messages = [
        {
          id: `history-error-${Date.now()}`,
          role: 'system',
          content: `Could not load chat history: ${message}`,
          timestamp: new Date().toISOString(),
        },
      ];
      this.sessionCost = 0;
    }
  }

  private handleChatResponse(payload: ChatResponsePayload) {
    const next = applyChatPanelResponse(
      {
        messages: this.messages,
        streamingText: this.streamingText,
        streamingStatus: this.streamingStatus,
        streamingError: this.streamingError,
        sending: this.sending,
        sessionCost: this.sessionCost,
        usageOpen: this.usageOpen,
      },
      payload,
      this.activeSessionId(),
    );
    if (next.ignored) return;
    this.messages = [...next.messages];
    this.streamingText = next.streamingText;
    this.streamingStatus = next.streamingStatus;
    this.streamingError = next.streamingError;
    this.sending = next.sending;
    this.sessionCost = next.sessionCost;
    if (next.shouldLoadUsageContext) void this.loadUsageContext();
    if (next.shouldLoadSessions) void this.loadSessions();
    if (next.shouldScrollToBottom) this.scrollToBottom();
  }

  private showMemoryToast(filePath: string) {
    const filename = filePath.split('/').pop() ?? filePath;
    this.memorySavedToast = `Saved: ${filename}`;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.memorySavedToast = null;
    }, 3000);
  }

  private scrollToBottom() {
    this.updateComplete.then(() => {
      const el = this.querySelector('.cp-messages-end');
      el?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  private currentClientContext(contextOverride?: Partial<ChatClientContext>): ChatClientContext {
    const current = buildChatClientContext();
    return {
      ...current,
      ...contextOverride,
      query: {
        ...(current.query ?? {}),
        ...(contextOverride?.query ?? {}),
      },
      affordances: [...(current.affordances ?? []), ...(contextOverride?.affordances ?? [])],
    };
  }

  private async send() {
    const text = this.inputText.trim();
    if (!text || this.sending) return;
    this.inputText = '';
    await this.submitPrompt(text);
  }

  private async loadRuntime(reconnected = false) {
    try {
      const result = await gateway.request<CopilotStatusResult>(Methods.COPILOT_STATUS, {});
      this.syncRuntime(result.session);
      this.runtimeError = '';
      if (reconnected && result.session.status === 'running') this.runtimeNotice = 'Reconnected';
    } catch (err) {
      const message = errorMessage(err);
      if (
        message === 'Not connected' ||
        (err instanceof GatewayRequestError && err.code === 'METHOD_NOT_FOUND')
      )
        return;
      this.runtimeError = message;
    }
  }

  private async startRuntime(mode: 'start' | 'reconnect' = 'start') {
    this.runtimeLoading = true;
    this.runtimeError = '';
    try {
      if (mode === 'start') await this.saveRuntimeConfig(false, false);
      const result = await gateway.request<CopilotStartResult>(Methods.COPILOT_START, {
        mode,
        safetyTier: 'sandboxed',
      });
      this.syncRuntime(result.session);
      this.runtimeNotice = result.reconnected || result.reused ? 'Reconnected' : 'Started';
      await this.loadHistory(result.session.transcriptId);
    } catch (err) {
      this.runtimeError = errorMessage(err);
    } finally {
      this.runtimeLoading = false;
    }
  }

  private async stopRuntime() {
    this.runtimeLoading = true;
    this.runtimeError = '';
    try {
      const result = await gateway.request<CopilotStopResult>(Methods.COPILOT_STOP, {
        reason: 'operator-requested',
      });
      this.syncRuntime(result.session);
      this.runtimeNotice = 'Stopped';
    } catch (err) {
      this.runtimeError = errorMessage(err);
    } finally {
      this.runtimeLoading = false;
    }
  }

  private async openDangerousConfirmation() {
    try {
      await this.saveRuntimeConfig(false);
    } catch {
      // saveRuntimeConfig already surfaced runtimeError. Do not open a dangerous
      // launch confirmation for configuration that was not persisted.
      return;
    }
    this.dangerousTypedPhrase = '';
    this.dangerousConfirmationOpen = true;
  }

  private async startDangerousRuntime() {
    const binding = this.runtime?.dangerousLaunch;
    if (!binding) return;
    const params = dangerousStartParams(binding, this.dangerousTypedPhrase);
    if (!params) return;
    this.runtimeLoading = true;
    this.runtimeError = '';
    try {
      const result = await gateway.request<CopilotStartResult>(Methods.COPILOT_START, params);
      this.syncRuntime(result.session);
      this.runtimeNotice = 'Dangerous runtime started';
      this.dangerousConfirmationOpen = false;
    } catch (err) {
      this.runtimeError = errorMessage(err);
    } finally {
      this.runtimeLoading = false;
    }
  }

  private syncRuntime(session: CopilotRuntimeSession) {
    this.runtime = session;
    this.runtimeRunner = session.runner;
    this.runtimeModel = session.model;
    this.runtimeAutostart = session.autostart;
    void this.resolveRuntimeWorker(session);
    if (session.status === 'failed' || session.status === 'ambiguous') this.runtimeNotice = '';
  }

  private async resolveRuntimeWorker(session: CopilotRuntimeSession): Promise<void> {
    if (session.status !== 'running') {
      this.runtimeWorkerRefJson = '';
      this.runtimeWorkerSession = '';
      return;
    }
    const tmuxSession = session.tmuxTarget.split(':', 1)[0] ?? '';
    if (!tmuxSession || (this.runtimeWorkerSession === tmuxSession && this.runtimeWorkerRefJson)) {
      return;
    }
    if (this.runtimeWorkerLookup) return this.runtimeWorkerLookup;
    this.runtimeWorkerLookup = (async () => {
      const result = await gateway.request<TmuxWorkerListResult>(Methods.TMUX_WORKER_LIST, {});
      const worker = result.workers.find(
        (candidate) =>
          candidate.ref.session === tmuxSession &&
          (candidate.ref.windowName === 'agent' || candidate.ref.window === '0'),
      );
      if (!worker || this.runtime?.tmuxTarget !== session.tmuxTarget) return;
      this.runtimeWorkerSession = tmuxSession;
      this.runtimeWorkerRefJson = JSON.stringify(worker.ref);
    })()
      .catch((error) => {
        console.warn('[chat-panel] Co-Pilot terminal lookup failed:', error);
      })
      .finally(() => {
        this.runtimeWorkerLookup = undefined;
      });
    return this.runtimeWorkerLookup;
  }

  private async saveRuntimeConfig(showNotice = true, manageLoading = true) {
    if (manageLoading) this.runtimeLoading = true;
    this.runtimeError = '';
    try {
      const result = await gateway.request<CopilotConfigureResult>(Methods.COPILOT_CONFIGURE, {
        runner: this.runtimeRunner,
        model: this.runtimeModel,
        autostart: this.runtimeAutostart,
      });
      this.syncRuntime(result.session);
      if (showNotice) this.runtimeNotice = 'Configuration saved';
    } catch (err) {
      this.runtimeError = errorMessage(err);
      throw err;
    } finally {
      if (manageLoading) this.runtimeLoading = false;
    }
  }

  private handleRuntimePickerChange(event: CustomEvent<RunnerModelEffortChangeDetail>) {
    this.runtimeRunner = event.detail.runner;
    this.runtimeModel = event.detail.model;
  }

  public async submitPrompt(
    text: string,
    contextOverride?: Partial<ChatClientContext>,
    intent: ChatSendIntent = 'general',
  ) {
    const prompt = text.trim();
    if (!prompt || this.sending) return;

    if (prompt !== '/new' && this.activeSessionId() !== SHARED_SESSION_ID) {
      this.switchSession(SHARED_SESSION_ID, false);
      await this.loadHistory(SHARED_SESSION_ID);
    }

    this.sending = true;
    this.streamingText = '';
    this.streamingStatus = 'Working…';
    this.streamingError = '';

    if (prompt === '/new') {
      await this.handleNew();
      return;
    }

    // Optimistically add user message
    const tempMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: new Date().toISOString(),
    };
    this.messages = [...this.messages, tempMsg];
    this.scrollToBottom();

    const sessionId = this.activeSessionId();
    try {
      await gateway.request(Methods.CHAT_SEND, {
        sessionId,
        message: prompt,
        clientContext: this.currentClientContext(contextOverride),
        intent,
      });
    } catch (err) {
      this.sending = false;
      this.streamingText = '';
      this.streamingStatus = '';
      this.streamingError = errorMessage(err);
      if (sessionId === this.activeSessionId()) {
        this.messages = this.messages.filter((message) => message.id !== tempMsg.id);
      }
      console.error('[chat-panel] send error:', err);
    }
  }

  private handleStop() {
    this.abortStreamingSession(this.activeSessionId());
  }

  private abortStreamingSession(sessionId: string) {
    if (!this.sending) return;
    // Abort is best-effort: stale response filtering still protects the UI if the RPC races a route switch.
    void gateway.request(Methods.CHAT_ABORT, { sessionId }).catch((err) => {
      const message = errorMessage(err);
      if (message === 'Not connected') return;
      console.debug('[chat-panel] abort failed:', err);
    });
  }

  private async handleNew() {
    this.sending = true;
    const sessionId = this.activeSessionId();
    try {
      const result = await gateway.request<ChatNewResult>(Methods.CHAT_NEW, { sessionId });
      if (sessionId !== this.activeSessionId()) return;
      this.messages = [];
      this.sessionCost = 0;
      this.sending = false;
      void this.loadSessions();
      if (result.savedPath) {
        this.showMemoryToast(result.savedPath);
      }
    } catch (err) {
      if (sessionId !== this.activeSessionId()) return;
      this.sending = false;
      this.messages = [
        ...this.messages,
        {
          id: `new-error-${Date.now()}`,
          role: 'assistant',
          content: `Could not save and clear this chat: ${errorMessage(err)}`,
          timestamp: new Date().toISOString(),
        },
      ];
    }
  }

  private async toggleUsage() {
    const nextOpen = !this.usageOpen;
    this.usageOpen = nextOpen;
    if (nextOpen) {
      await this.loadUsageContext();
    }
  }

  private async loadUsageContext() {
    this.usageLoading = true;
    this.usageError = null;
    const sessionId = this.activeSessionId();
    try {
      const context = await gateway.request<ChatSessionContextResult>(
        Methods.CHAT_SESSION_CONTEXT,
        { sessionId },
      );
      if (sessionId !== this.activeSessionId()) return;
      this.usageContext = context;
    } catch (err) {
      if (sessionId !== this.activeSessionId()) return;
      this.usageError = errorMessage(err);
    } finally {
      if (sessionId === this.activeSessionId()) this.usageLoading = false;
    }
  }

  private clampDrawerHeight(height: number): number {
    return clampChatDrawerHeight(height, window.innerHeight, this.minDrawerHeight);
  }

  private startResize(e: PointerEvent) {
    if (this.fullscreen) return;
    e.preventDefault();
    this.resizing = true;
    this.resizeStartY = e.clientY;
    this.resizeStartHeight = this.drawerHeight;
    window.addEventListener('pointermove', this.onResizeMove);
    window.addEventListener('pointerup', this.onResizeEnd, { once: true });
  }

  private readonly onResizeMove = (e: PointerEvent) => {
    if (!this.resizing) return;
    const delta = this.resizeStartY - e.clientY;
    this.drawerHeight = this.clampDrawerHeight(this.resizeStartHeight + delta);
  };

  private readonly onResizeEnd = () => {
    this.stopResize();
  };

  private stopResize() {
    this.resizing = false;
    window.removeEventListener('pointermove', this.onResizeMove);
    window.removeEventListener('pointerup', this.onResizeEnd);
  }

  private toggleFullscreen() {
    this.fullscreen = !this.fullscreen;
  }

  private async createManualSession() {
    try {
      const result = await gateway.request<ChatSessionCreateResult>(
        Methods.CHAT_SESSION_CREATE,
        {},
      );
      this.switchSession(result.session.id);
      await this.loadSessions();
    } catch (err) {
      this.streamingError = `Could not create chat: ${errorMessage(err)}`;
    }
  }

  private async pinActiveSession() {
    const id = this.activeSessionId();
    if (id === SHARED_SESSION_ID || this.pinningActive) return;
    this.pinningActive = true;
    try {
      await gateway.request(Methods.CHAT_SESSION_PIN, { sessionId: id });
      await this.loadSessions();
      this.surfaceToast('Chat saved — will persist across reloads.');
    } catch (err) {
      this.streamingError = `Could not save chat: ${errorMessage(err)}`;
    } finally {
      this.pinningActive = false;
    }
  }

  private openHistory() {
    this.historyOpen = true;
    void this.loadSessions();
  }

  private closeHistory() {
    this.historyOpen = false;
  }

  private onHistorySelect(e: CustomEvent<{ sessionId: string }>) {
    this.historyOpen = false;
    this.switchSession(e.detail.sessionId);
  }

  private async onHistoryDelete(e: CustomEvent<{ sessionIds: string[] }>) {
    const ids = e.detail.sessionIds.filter((id) => id !== SHARED_SESSION_ID);
    if (!ids.length) return;
    try {
      await gateway.request(Methods.CHAT_SESSIONS_BULK_DELETE, { sessionIds: ids });
      if (ids.includes(this.activeSessionId())) this.switchSession(SHARED_SESSION_ID);
      await this.loadSessions();
    } catch (err) {
      this.streamingError = `Could not delete chats: ${errorMessage(err)}`;
    }
  }

  private async onHistoryPin(e: CustomEvent<{ sessionId: string }>) {
    try {
      await gateway.request(Methods.CHAT_SESSION_PIN, { sessionId: e.detail.sessionId });
      await this.loadSessions();
    } catch (err) {
      this.streamingError = `Could not save chat: ${errorMessage(err)}`;
    }
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.send();
    } else if (e.key === 'Escape') {
      this.dispatchEvent(new CustomEvent('close', { bubbles: true }));
    }
  }

  private async onActionConfirm(e: CustomEvent<{ actionId: string }>) {
    const card = e.target as
      | (HTMLElement & {
          markResolved?: (r: { ok: boolean; unavailable?: boolean; message?: string }) => void;
        })
      | null;
    const actionId = e.detail.actionId;
    if (!actionId) {
      card?.markResolved?.({ ok: false, message: 'Missing action id.' });
      return;
    }
    try {
      const result = await gateway.request<{
        ok: true;
        type: string;
        result?: Record<string, unknown>;
      }>(Methods.CHAT_CONFIRM_ACTION, {
        sessionId: this.activeSessionId(),
        actionId,
      });
      card?.markResolved?.({ ok: true });
      if (result.type === 'memory.update') {
        this.showMemoryToast('MEMORY.md');
      } else if (result.type === 'run.create' && typeof result.result?.runId === 'string') {
        // Defense-in-depth: gateway is trusted today, but a stray non-UUID would
        // route to a garbage URL and break the back button. Only navigate when
        // the id matches the canonical run-id shape.
        const runId = result.result.runId;
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
          location.hash = `run/${runId}`;
        } else {
          console.warn('[chat-panel] run.create returned non-UUID runId; ignoring nav', runId);
        }
      }
    } catch (err) {
      const message = errorMessage(err);
      // Server raises ChatActionRejectError with a typed reason; the gateway
      // surfaces it as a CHAT_ACTION_REJECT_<REASON> code on the WS error
      // frame. Match on the code so wording tweaks can't desync the UI.
      const code = err instanceof GatewayRequestError ? err.code : '';
      const unavailable = UNAVAILABLE_REJECT_CODES.has(code);
      card?.markResolved?.({ ok: false, unavailable, message });
      console.error('[chat-panel] action failed:', err);
    }
  }

  private async onNextStepSelect(e: CustomEvent<ChatNextStep>) {
    if (this.sending) return;
    const step = e.detail;
    const promptParam = step.params.prompt;
    const prompt =
      typeof promptParam === 'string' && promptParam.trim()
        ? promptParam.trim()
        : `Follow up on this Co-Pilot next step: ${step.label}`;
    await this.submitPrompt(
      prompt,
      { affordances: [`next-step:${step.id}`] },
      'diagnostic-readonly',
    );
  }

  render() {
    if (!this.open) return html``;

    const activeSessionId = this.activeSessionId();
    const view = chatPanelViewModel({
      sending: this.sending,
      streamingText: this.streamingText,
      streamingError: this.streamingError,
      activeSessionId,
      sessionSummaries: this.sessionSummaries,
    });
    const runtimeStatus = this.runtime?.status ?? 'unavailable';
    const runtimeStatusLabel = copilotRuntimeStatusLabel(runtimeStatus);

    return html`
      ${renderChatPanelStyles()}
      <div
        class="cp-drawer ${this.fullscreen ? 'fullscreen' : ''}"
        style="--cp-height:${this.fullscreen ? '100vh' : `${this.drawerHeight}px`}"
        @action-confirm=${this.onActionConfirm}
        @next-step-select=${this.onNextStepSelect}
      >
        <div class="cp-resize-handle" title="Resize chat" @pointerdown=${this.startResize}></div>
        <div class="cp-header">
          <span class="cp-title">✦ Co-Pilot</span>
          <div
            class="cp-session"
            title="One Co-Pilot chat per browser. Current screen context is attached to every message you send."
          >
            <span class="cp-session-kicker">Chat</span>
            <span class="cp-session-label"
              >${chatSessionDisplayName(activeSessionId)}${view.activePinned
                ? ''
                : ' · ephemeral'}</span
            >
            ${view.canPin
              ? html`
                  <button
                    class="cp-new-btn"
                    title="Save this chat so it persists after refresh / restart"
                    ?disabled=${this.pinningActive}
                    @click=${this.pinActiveSession}
                  >
                    ${this.pinningActive ? 'Saving…' : 'Save chat'}
                  </button>
                `
              : ''}
            <button class="cp-new-btn" title="Open chat history" @click=${this.openHistory}>
              History${view.historyCount ? ` (${view.historyCount})` : ''}
            </button>
          </div>
          ${this.observerNotifications.length
            ? html`
                <details
                  class="cp-observer"
                  title=${this.observerNotifications[0]?.summary ?? 'Recent observer notifications'}
                >
                  <summary>Alerts ${this.observerNotifications.length}</summary>
                  <div class="cp-observer-list">
                    ${this.observerNotifications.map(
                      (item) => html`
                        <div class="cp-observer-item">
                          <span class="cp-observer-meta"
                            >${item.severity.toUpperCase()} · ${item.type} · ${item.ts}</span
                          >
                          <span>${item.summary}</span>
                        </div>
                      `,
                    )}
                  </div>
                </details>
              `
            : ''}
          ${this.sending
            ? html`<button class="cp-stop-btn" @click=${this.handleStop} title="Stop generation">
                ■ Stop
              </button>`
            : ''}
          <button
            class="cp-icon-btn"
            @click=${this.toggleFullscreen}
            title=${this.fullscreen ? 'Restore chat size' : 'Expand chat'}
            aria-label=${this.fullscreen ? 'Restore chat size' : 'Expand chat'}
          >
            ${this.fullscreen ? '□' : '⛶'}
          </button>
          <button class="cp-new-btn" @click=${this.toggleUsage} title="Show chat context usage">
            Usage
          </button>
          <button
            class="cp-new-btn"
            @click=${this.createManualSession}
            title="Create a new manual chat"
          >
            New chat
          </button>
          <button
            class="cp-new-btn"
            @click=${this.handleNew}
            title="Save a memory note, then clear this chat"
          >
            Save & clear
          </button>
          <button
            class="cp-close-btn"
            @click=${() => this.dispatchEvent(new CustomEvent('close', { bubbles: true }))}
          >
            ×
          </button>
        </div>
        ${this.memorySavedToast ? html`<div class="cp-toast">${this.memorySavedToast}</div>` : ''}
        ${this.sessionCost > 0.5
          ? html`
              <div class="cp-cost-warning">
                Session cost: $${this.sessionCost.toFixed(2)} — consider Save & clear
              </div>
            `
          : ''}
        ${this.usageOpen
          ? html`
              <div class="cp-usage-panel">
                <div class="cp-usage-head">
                  <span class="cp-usage-meta">
                    ${this.usageContext
                      ? `generated ${this.usageContext.generatedAt} · ${this.usageContext.model.runtimeIdentity}`
                      : this.usageLoading
                        ? 'loading'
                        : 'not loaded'}
                  </span>
                  <button
                    class="cp-new-btn"
                    @click=${this.loadUsageContext}
                    ?disabled=${this.usageLoading}
                  >
                    Refresh
                  </button>
                </div>
                ${this.usageError
                  ? html`<div class="cp-usage-error">${this.usageError}</div>`
                  : this.usageContext
                    ? html`
                        <div class="cp-usage-grid">
                          <div class="cp-usage-card">
                            <div class="cp-usage-label">LATEST INPUT</div>
                            <div class="cp-usage-value">
                              ${formatChatInt(this.usageContext.usage.lastInputTokens)} tokens
                            </div>
                          </div>
                          <div class="cp-usage-card">
                            <div class="cp-usage-label">EST. REMAINING</div>
                            <div class="cp-usage-value">
                              ${formatChatInt(this.usageContext.contextWindow.remainingInputTokens)}
                              tokens
                            </div>
                          </div>
                          <div class="cp-usage-card">
                            <div class="cp-usage-label">WINDOW USED</div>
                            <div class="cp-usage-value">
                              ${this.usageContext.contextWindow.lastInputPct ?? 'unknown'}%
                            </div>
                          </div>
                          <div class="cp-usage-card">
                            <div class="cp-usage-label">MESSAGES</div>
                            <div class="cp-usage-value">
                              ${this.usageContext.messages.total}
                              (${this.usageContext.messages.user} user)
                            </div>
                          </div>
                          <div class="cp-usage-card">
                            <div class="cp-usage-label">TOTAL OUTPUT</div>
                            <div class="cp-usage-value">
                              ${formatChatInt(this.usageContext.usage.totalOutputTokens)} tokens
                            </div>
                          </div>
                          <div class="cp-usage-card">
                            <div class="cp-usage-label">SESSION COST</div>
                            <div class="cp-usage-value">
                              ${formatChatUsd(this.usageContext.usage.totalCostUsd)}
                            </div>
                          </div>
                          <div class="cp-usage-card">
                            <div class="cp-usage-label">COMPACTION</div>
                            <div class="cp-usage-value">${this.usageContext.compaction.status}</div>
                          </div>
                          <div class="cp-usage-card">
                            <div class="cp-usage-label">JUMPS LEFT</div>
                            <div class="cp-usage-value">
                              ${this.usageContext.compaction.jumpsUntilCompact ?? 'not tracked'}
                            </div>
                          </div>
                        </div>
                        <div class="cp-usage-note">${this.usageContext.contextWindow.note}</div>
                        <div class="cp-usage-note">${this.usageContext.compaction.note}</div>
                      `
                    : html``}
              </div>
            `
          : ''}
        <section class="cp-runtime" data-testid="copilot-runtime-card">
          <div class="cp-runtime-head">
            <span class="cp-runtime-status ${runtimeStatus}">${runtimeStatusLabel}</span>
            <span>${this.runtimeNotice}</span>
            <span class="cp-runtime-pressure ${this.runtime?.workload.severity ?? 'normal'}">
              Pressure ${this.runtime?.workload.severity ?? 'unknown'}
              ${this.runtime ? `· ${this.runtime.workload.totals.total} activities` : ''}
            </span>
          </div>
          ${this.runtime
            ? html`
                <div class="cp-runtime-grid">
                  <span>Runner</span><strong>${this.runtime.runner}</strong> <span>Model</span
                  ><strong>${this.runtime.model}</strong> <span>Tier</span
                  ><strong>${this.runtime.safetyTier}</strong> <span>tmux</span
                  ><strong>${this.runtime.tmuxTarget}</strong> <span>Checkout</span
                  ><strong>${this.runtime.checkout.path}</strong> <span>Branch</span
                  ><strong>${this.runtime.checkout.branch}</strong> <span>Dirty</span
                  ><strong>${this.runtime.checkout.dirtyFileCount}</strong> <span>Delivery</span
                  ><strong
                    >${this.runtime.lastDelivery.state
                      .slice(0, 1)
                      .toUpperCase()}${this.runtime.lastDelivery.state.slice(1)}</strong
                  >
                </div>
                ${this.runtime.workload.warning
                  ? html`<div class="cp-runtime-warning">${this.runtime.workload.warning}</div>`
                  : ''}
                ${this.runtime.terminalReason
                  ? html`<div class="cp-runtime-reason">${this.runtime.terminalReason}</div>`
                  : ''}
                <div class="cp-runtime-config">
                  <runner-model-effort-picker
                    .runner=${this.runtimeRunner}
                    .model=${this.runtimeModel}
                    .effort=${''}
                    .showEffort=${false}
                    .disabled=${this.runtimeLoading || runtimeStatus === 'running'}
                    @runner-model-effort-change=${this.handleRuntimePickerChange}
                  ></runner-model-effort-picker>
                  <label class="cp-runtime-autostart">
                    <input
                      type="checkbox"
                      .checked=${this.runtimeAutostart}
                      ?disabled=${this.runtimeLoading}
                      @change=${(event: Event) => {
                        if (event.target instanceof HTMLInputElement)
                          this.runtimeAutostart = event.target.checked;
                      }}
                    />
                    Start sandboxed with the Gateway
                  </label>
                  <button
                    class="cp-new-btn"
                    data-testid="copilot-save-config"
                    ?disabled=${this.runtimeLoading}
                    @click=${() => this.saveRuntimeConfig()}
                  >
                    Save configuration
                  </button>
                </div>
              `
            : html`<div class="cp-runtime-reason">Runtime status unavailable.</div>`}
          ${this.runtimeError ? html`<div class="cp-runtime-error">${this.runtimeError}</div>` : ''}
          <div class="cp-runtime-actions">
            ${runtimeStatus === 'running'
              ? html`
                  <button
                    class="cp-new-btn"
                    data-testid="copilot-reconnect"
                    ?disabled=${this.runtimeLoading}
                    @click=${() => this.startRuntime('reconnect')}
                  >
                    Reconnect
                  </button>
                  <button
                    class="cp-stop-btn"
                    data-testid="copilot-stop"
                    ?disabled=${this.runtimeLoading}
                    @click=${this.stopRuntime}
                  >
                    Stop runtime
                  </button>
                `
              : html`
                  <button
                    class="cp-new-btn"
                    data-testid="copilot-start-sandboxed"
                    ?disabled=${this.runtimeLoading}
                    @click=${() => this.startRuntime('start')}
                  >
                    Start Sandboxed
                  </button>
                  <button
                    class="cp-stop-btn"
                    data-testid="copilot-start-dangerous"
                    ?disabled=${this.runtimeLoading || !this.runtime}
                    @click=${this.openDangerousConfirmation}
                  >
                    Start Dangerous
                  </button>
                `}
          </div>
          ${this.dangerousConfirmationOpen && this.runtime
            ? html`
                <div class="cp-dangerous" data-testid="copilot-dangerous-confirmation">
                  <strong>Dangerous same-user execution</strong>
                  <p>${this.runtime.dangerousLaunch.warning}</p>
                  <p>Bound to ${dangerousLaunchSummary(this.runtime.dangerousLaunch)}</p>
                  <label>
                    Type ${this.runtime.dangerousLaunch.typedPhrase}
                    <input
                      .value=${this.dangerousTypedPhrase}
                      @input=${(event: InputEvent) => {
                        if (event.target instanceof HTMLInputElement)
                          this.dangerousTypedPhrase = event.target.value;
                      }}
                    />
                  </label>
                  <div class="cp-runtime-actions">
                    <button
                      class="cp-new-btn"
                      data-testid="copilot-dangerous-cancel"
                      @click=${() => (this.dangerousConfirmationOpen = false)}
                    >
                      Cancel
                    </button>
                    <button
                      class="cp-stop-btn"
                      data-testid="copilot-dangerous-confirm"
                      ?disabled=${this.dangerousTypedPhrase !==
                        this.runtime.dangerousLaunch.typedPhrase || this.runtimeLoading}
                      @click=${this.startDangerousRuntime}
                    >
                      Launch dangerous
                    </button>
                  </div>
                </div>
              `
            : ''}
        </section>
        ${runtimeStatus === 'running'
          ? html`
              <div class="cp-terminal" data-testid="copilot-terminal">
                ${this.runtimeWorkerRefJson
                  ? html`<terminal-view
                      .workerRefJson=${this.runtimeWorkerRefJson}
                      compact
                    ></terminal-view>`
                  : html`<div class="cp-terminal-loading">Connecting to the Co-Pilot tmux…</div>`}
              </div>
            `
          : html`
              <div class="cp-messages">
                ${this.messages.length === 0 && !view.isStreaming
                  ? html`<div class="cp-empty">Start the runtime to ask about your fleet.</div>`
                  : this.messages.map(
                      (msg) =>
                        html`<chat-message
                          .message=${msg}
                          .nextStepsDisabled=${this.sending}
                        ></chat-message>`,
                    )}
                ${view.isStreaming
                  ? html`
                      <div class="cp-streaming">
                        <div class="cp-streaming-status ${this.streamingError ? 'error' : ''}">
                          ${this.streamingStatus || 'Working…'}
                        </div>
                        <div class="cp-streaming-body ${this.streamingError ? 'error' : ''}">
                          ${this.streamingError || this.streamingText || 'Working…'}
                        </div>
                      </div>
                    `
                  : ''}
                <div class="cp-messages-end"></div>
              </div>
            `}
        <div class="cp-input-area">
          <textarea
            class="cp-input"
            placeholder="Ask about your fleet… (Enter to send, Shift+Enter for newline)"
            rows="1"
            .value=${this.inputText}
            @input=${(e: InputEvent) => {
              if (e.target instanceof HTMLTextAreaElement) this.inputText = e.target.value;
            }}
            @keydown=${this.onKeyDown}
            ?disabled=${this.sending || runtimeStatus !== 'running'}
          ></textarea>
          ${this.inputText.trim()
            ? html`
                <button
                  class="cp-reset-input-btn"
                  title="Reset input"
                  aria-label="Reset Co-Pilot input"
                  @click=${() => {
                    this.inputText = '';
                    void this.updateComplete.then(() => {
                      const input = this.querySelector('.cp-input');
                      if (input instanceof HTMLTextAreaElement) input.focus();
                    });
                  }}
                  ?disabled=${this.sending}
                >
                  ×
                </button>
              `
            : ''}
          <button
            class="cp-send-btn"
            @click=${this.send}
            ?disabled=${this.sending || !this.inputText.trim() || runtimeStatus !== 'running'}
          >
            ${this.sending ? '…' : '→'}
          </button>
        </div>
      </div>
      ${this.historyOpen
        ? html`
            <chat-history-modal
              .sessions=${view.historySessions}
              .activeSessionId=${activeSessionId}
              @close=${this.closeHistory}
              @select=${this.onHistorySelect}
              @delete=${this.onHistoryDelete}
              @pin=${this.onHistoryPin}
            ></chat-history-modal>
          `
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-panel': ChatPanel;
  }
}
