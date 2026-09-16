import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  type ChatMessage,
  Events,
  Methods,
  type NativeCommandReceipt,
  type NativeProfileInfo,
  type NativeSessionCatalogResult,
  type NativeSessionCreateParams,
  type NativeSessionEvent,
  type NativeSessionInfo,
  type NativeSessionListResult,
  type NativeSessionReadResult,
  type NativeSessionResponse,
  type NativeSessionSendResult,
  type NativeWorkerHistoryScope,
} from '@farmslot/protocol';

import '../shared/runner-model-effort-picker.js';
import './chat-message.js';
import './native-workspace.js';
import './native-profiles.js';

import { gateway } from '../../gateway-client.js';
import { safeLsGet, safeLsRemove, safeLsSet } from '../../utils/storage.js';
import type { RunnerModelEffortChangeDetail } from '../shared/runner-model-effort-picker.js';

import type { NativeProfileSelection } from './native-profiles.js';
import { renderNativeSessionHeader } from './native-session-header.js';
import {
  appendNativePage,
  nativeCommandLockSettled,
  nativeDeliveryLabel,
  nativeTimeline,
  type NativeTranscript,
} from './native-session-model.js';
import { renderNativeSessionRequest } from './native-session-request.js';
import { nativeSessionStyles } from './native-session-styles.js';
import {
  assertNativeWorkerViewPage,
  nativeWorkerViewControl,
  nativeWorkerViewKey,
  nativeWorkerViewPin,
  type NativeWorkerViewTarget,
} from './native-worker-target.js';
import { type NativeSessionApi } from './native-workspace.js';

type LocalCommand = {
  sessionId: string;
  executionNodeId?: string;
  generation: string;
  commandId: string;
  text: string;
};

@customElement('native-session-view')
export class NativeSessionView extends LitElement {
  @property({ attribute: false }) api: NativeSessionApi = gateway;
  /** Fixture clients are supplied before connection; production always follows gateway authentication. */
  @property({ type: Boolean }) fixture = false;
  @property({ attribute: false }) worker?: NativeWorkerViewTarget;
  @state() private catalog?: NativeSessionCatalogResult;
  @state() private sessions: NativeSessionInfo[] = [];
  @state() private session?: NativeSessionInfo;
  @state() private selectedId = '';
  @state() private selectedNodeId = 'local';
  @state() private executionNodeId = 'local';
  @state() private unavailableNodes: NonNullable<
    NativeSessionListResult['unavailableExecutionNodes']
  > = [];
  @state() private creating = false;
  @state() private profile?: NativeProfileInfo;
  @state() private profileReady = true;
  private profileNodeId = 'local';
  @state() private runner = '';
  @state() private model = '';
  @state() private mode: 'default' | 'plan' = 'default';
  @state() private cwd = '';
  @state() private customCwd = false;
  @state() private transcript: NativeTranscript = { events: [], cursor: 0 };
  @state() private historyScope?: NativeWorkerHistoryScope;
  @state() private receipts: NativeCommandReceipt[] = [];
  @state() private requests: NativeSessionEvent[] = [];
  @state() private draft = '';
  @state() private localCommand?: LocalCommand;
  @state() private connected = false;
  @state() private caughtUp = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private pollError = '';
  @state() private workspace = false;
  @state() private fullscreen = false;
  private readonly fullscreenChanged = () => {
    this.fullscreen = this.matches(':fullscreen');
  };
  private async toggleFullscreen() {
    try {
      if (this.matches(':fullscreen')) await document.exitFullscreen();
      else await this.requestFullscreen();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  @state() private responseAttempts = new Set<string>();
  @state() private invalidDelivery = false;
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private nodeUnsubscribers: Array<() => void> = [];
  private inventoryTimer?: ReturnType<typeof setTimeout>;
  private inventoryRevision = 0;
  private storageScope = '';
  private polling = false;
  private timelineEvents?: NativeSessionEvent[];
  private timelineEntries: ReturnType<typeof nativeTimeline> = [];

  private timeline() {
    if (this.timelineEvents !== this.transcript.events) {
      this.timelineEvents = this.transcript.events;
      this.timelineEntries = nativeTimeline(this.transcript.events);
    }
    return this.timelineEntries;
  }

  static styles = nativeSessionStyles;

  protected updated(changed: PropertyValues) {
    if (!changed.has('worker') || !this.isConnected) return;
    const previous = changed.get('worker') as NativeWorkerViewTarget | undefined;
    if (
      this.worker &&
      (!previous || nativeWorkerViewKey(previous) !== nativeWorkerViewKey(this.worker))
    )
      this.select(this.worker.binding.sessionId, this.worker.binding.executionNodeId);
    else if (this.worker && previous?.binding.generation !== this.worker.binding.generation)
      this.schedule(0);
    else if (!this.worker && previous) void this.connect();
  }

  private get workerControl() {
    if (this.historyScope?.released) return undefined;
    return this.worker ? nativeWorkerViewControl(this.worker, this.session) : undefined;
  }

  private get inputAllowed() {
    return !this.worker || Boolean(this.workerControl);
  }

  private get taskHistory() {
    return Boolean(
      this.worker &&
      (this.worker.readOnly ||
        this.worker.binding.closedAt ||
        this.worker.binding.releasedAt ||
        this.historyScope?.released),
    );
  }

  private get workspaceAllowed() {
    return !this.worker || (!this.taskHistory && Boolean(this.workerControl));
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('fullscreenchange', this.fullscreenChanged);
    this.connected = this.fixture || gateway.connectionState === 'connected';
    if (this.fixture) void this.connect();
    else {
      this.nodeUnsubscribers = [Events.NODE_CONNECTED, Events.NODE_DISCONNECTED].map((event) =>
        gateway.subscribe(event, () => {
          clearTimeout(this.inventoryTimer);
          this.inventoryTimer = setTimeout(() => void this.refreshSessions(), 100);
        }),
      );
      this.unsubscribe = gateway.onConnectionChange((status) => {
        this.connected = status === 'connected';
        if (this.connected) void this.connect();
        else {
          this.caughtUp = false;
          clearTimeout(this.timer);
          clearTimeout(this.inventoryTimer);
          this.inventoryRevision++;
        }
      });
      if (this.connected) void this.connect();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('fullscreenchange', this.fullscreenChanged);
    this.revision++;
    clearTimeout(this.timer);
    clearTimeout(this.inventoryTimer);
    this.nodeUnsubscribers.forEach((unsubscribe) => unsubscribe());
    this.nodeUnsubscribers = [];
    this.unsubscribe?.();
  }

  private key(suffix: string) {
    return `farmslot-native:${this.storageScope}:${suffix}`;
  }

  private sessionKey(suffix: string) {
    if (this.worker) return this.key(`worker:${nativeWorkerViewKey(this.worker)}:${suffix}`);
    return this.key(
      this.selectedNodeId === 'local'
        ? suffix
        : `node:${encodeURIComponent(this.selectedNodeId)}:${suffix}`,
    );
  }

  private sessionChoice(session: Pick<NativeSessionInfo, 'id' | 'executionNodeId'>) {
    return session.executionNodeId === 'local'
      ? session.id
      : JSON.stringify([session.executionNodeId, session.id]);
  }

  private contextChoice(context: { executionNodeId?: string; cwd: string }) {
    return !context.executionNodeId || context.executionNodeId === 'local'
      ? context.cwd
      : JSON.stringify([context.executionNodeId, context.cwd]);
  }

  private async connect() {
    const scope = this.fixture
      ? 'fixture'
      : `${gateway.gatewayUrl}:${gateway.authenticatedPrincipalId}`;
    if (scope !== this.storageScope) {
      this.storageScope = scope;
      this.revision++;
      this.selectedId = safeLsGet(this.key('selected')) ?? '';
      this.selectedNodeId = safeLsGet(this.key('selected-node')) ?? 'local';
      this.session = undefined;
      this.sessions = [];
      this.catalog = undefined;
      this.responseAttempts = new Set();
      this.transcript = { events: [], cursor: 0 };
      this.historyScope = undefined;
      this.requests = [];
      this.receipts = [];
      this.loadLocal();
    }
    if (this.worker) {
      this.select(this.worker.binding.sessionId, this.worker.binding.executionNodeId);
      return;
    }
    await this.refreshSessions();
    this.schedule(0);
  }

  private loadLocal() {
    this.draft = safeLsGet(this.sessionKey(`draft:${this.selectedId}`)) ?? '';
    const raw = safeLsGet(this.sessionKey(`command:${this.selectedId}`));
    this.localCommand = undefined;
    this.invalidDelivery = false;
    if (raw) {
      try {
        const value: unknown = JSON.parse(raw);
        if (
          value &&
          typeof value === 'object' &&
          'sessionId' in value &&
          value.sessionId === this.selectedId &&
          (('executionNodeId' in value ? value.executionNodeId : undefined) ?? 'local') ===
            this.selectedNodeId &&
          'generation' in value &&
          typeof value.generation === 'string' &&
          'commandId' in value &&
          typeof value.commandId === 'string' &&
          'text' in value &&
          typeof value.text === 'string'
        )
          this.localCommand = value as LocalCommand;
        else {
          this.invalidDelivery = true;
          this.error =
            'Saved delivery receipt is invalid. Use another session to avoid duplicate delivery.';
        }
      } catch {
        this.invalidDelivery = true;
        this.error =
          'Saved delivery receipt could not be read. Use another session to avoid duplicate delivery.';
      }
    }
  }

  private async refreshSessions() {
    if (this.worker) {
      this.schedule(0);
      return;
    }
    // Connection status represents transport loss; reconnect reloads inventory.
    if (!this.connected) return;
    // Inventory belongs to the principal, independent of the selected conversation.
    // Selecting New while the catalog loads must not discard the only catalog response.
    const storageScope = this.storageScope;
    const inventoryRevision = ++this.inventoryRevision;
    try {
      const [catalog, result] = await Promise.all([
        this.api.request<NativeSessionCatalogResult>(Methods.NATIVE_SESSION_CATALOG, {}),
        this.api.request<NativeSessionListResult>(Methods.NATIVE_SESSION_LIST, {}),
      ]);
      if (
        !this.isConnected ||
        !this.connected ||
        storageScope !== this.storageScope ||
        inventoryRevision !== this.inventoryRevision
      )
        return;
      this.catalog = catalog;
      this.sessions = result.sessions.filter((session) => !session.workerManaged).reverse();
      if (
        result.sessions.some(
          (session) =>
            session.workerManaged &&
            session.id === this.selectedId &&
            session.executionNodeId === this.selectedNodeId,
        )
      )
        this.select('');
      this.unavailableNodes = result.unavailableExecutionNodes ?? [];
      if (!this.runner) {
        this.runner = catalog.runners[0]?.runner ?? '';
        this.model = catalog.runners[0]?.defaultModel ?? '';
      }
      if (!this.cwd && !this.customCwd) {
        this.cwd = catalog.contexts[0]?.cwd ?? '';
        this.executionNodeId = catalog.contexts[0]?.executionNodeId ?? 'local';
      }
      if (!this.selectedId) this.creating = true;
    } catch (error) {
      if (
        this.connected &&
        storageScope === this.storageScope &&
        inventoryRevision === this.inventoryRevision
      )
        this.error = (error as Error).message;
    }
  }

  private schedule(delay = 1000) {
    clearTimeout(this.timer);
    if (this.isConnected && this.connected) this.timer = setTimeout(() => void this.poll(), delay);
  }

  private async poll() {
    if (this.polling || !this.selectedId || !this.connected) {
      this.schedule();
      return;
    }
    const revision = this.revision;
    this.polling = true;
    try {
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = await this.api.request<NativeSessionReadResult>(Methods.NATIVE_SESSION_READ, {
          sessionId: this.selectedId,
          executionNodeId: this.selectedNodeId,
          ...(this.worker ? { worker: nativeWorkerViewPin(this.worker) } : {}),
          ...(this.worker && !this.historyScope ? {} : { after: this.transcript.cursor }),
          limit: 200,
        });
        if (!this.isConnected || revision !== this.revision) return;
        if (
          page.session.id !== this.selectedId ||
          page.session.executionNodeId !== this.selectedNodeId
        )
          throw new Error('Native replay returned another session or execution node');
        if (this.worker) {
          assertNativeWorkerViewPage(this.worker, page);
          const scope = page.scope!;
          if (
            this.historyScope &&
            (scope.startAfter !== this.historyScope.startAfter ||
              scope.endAt < this.historyScope.endAt ||
              (this.historyScope.released &&
                (!scope.released || scope.endAt !== this.historyScope.endAt)))
          )
            throw new Error('Task history boundaries changed');
          if (!this.historyScope) this.transcript = { events: [], cursor: scope.startAfter };
          this.historyScope = scope;
        }
        this.pollError = '';
        const timeline = this.renderRoot.querySelector('.timeline');
        const nearBottom =
          !timeline || timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
        this.transcript = appendNativePage(this.transcript, page);
        for (const event of page.events) {
          if (event.type === 'approval.resolved' && event.request) {
            safeLsRemove(this.sessionKey(`response:${event.sessionId}:${event.request.id}`));
            const attempts = new Set(this.responseAttempts);
            attempts.delete(event.request.id);
            this.responseAttempts = attempts;
          }
        }
        this.session = page.session;
        this.receipts = page.commands;
        this.requests = page.pendingRequests;
        this.caughtUp = !page.hasMore;
        if (this.localCommand) {
          const receipt = page.commands.find(
            (command) =>
              command.commandId === this.localCommand?.commandId &&
              command.generation === this.localCommand?.generation,
          );
          if (
            nativeCommandLockSettled(
              this.localCommand,
              page.session.generation,
              receipt,
              this.transcript.events,
            )
          ) {
            safeLsRemove(this.sessionKey(`command:${this.selectedId}`));
            this.localCommand = undefined;
          }
        }
        await this.updateComplete;
        if (nearBottom) {
          const element = this.renderRoot.querySelector('.timeline');
          if (element) element.scrollTop = element.scrollHeight;
        }
        if (!page.hasMore) break;
      }
    } catch (error) {
      if (revision === this.revision) {
        this.pollError = (error as Error).message;
        this.caughtUp = false;
      }
    } finally {
      this.polling = false;
      this.schedule(this.caughtUp ? 1000 : 300);
    }
  }

  private select(id: string, executionNodeId = 'local') {
    this.revision++;
    this.selectedId = id;
    this.selectedNodeId = executionNodeId;
    this.responseAttempts = new Set();
    this.creating = !id;
    this.profile = undefined;
    this.profileReady = true;
    this.session = undefined;
    this.transcript = { events: [], cursor: 0 };
    this.historyScope = undefined;
    this.receipts = [];
    this.requests = [];
    this.caughtUp = false;
    this.error = '';
    this.pollError = '';
    this.busy = false;
    if (!this.worker) {
      safeLsSet(this.key('selected'), id);
      safeLsSet(this.key('selected-node'), executionNodeId);
    }
    this.loadLocal();
    this.schedule(0);
  }

  private async create(resume?: NativeSessionInfo) {
    if (this.worker) return;
    if (
      !resume &&
      (!this.profileReady || (this.profile && this.profileNodeId !== this.executionNodeId))
    ) {
      this.error = 'Select a ready account profile for this node';
      return;
    }
    this.busy = true;
    this.error = '';
    const revision = this.revision;
    const params: NativeSessionCreateParams = resume
      ? {
          executionNodeId: resume.executionNodeId,
          runner: resume.runner,
          model: resume.model,
          mode: resume.mode,
          cwd: resume.cwd,
          resumeSessionId: resume.nativeSessionId,
          ...(resume.profileId
            ? { profileId: resume.profileId, accountContextId: resume.accountContextId }
            : {}),
        }
      : {
          executionNodeId: this.executionNodeId,
          runner: this.runner,
          model: this.model || undefined,
          mode: this.mode,
          cwd: this.cwd,
          ...(this.profile
            ? { profileId: this.profile.id, accountContextId: this.profile.accountContextId }
            : {}),
        };
    try {
      const result = await this.api.request<{ session: NativeSessionInfo }>(
        Methods.NATIVE_SESSION_CREATE,
        params,
      );
      if (revision !== this.revision || !this.isConnected) return;
      this.select(result.session.id, result.session.executionNodeId);
      this.session = result.session;
      await this.refreshSessions();
    } catch (error) {
      if (revision === this.revision)
        this.error = `${(error as Error).message}. Check Sessions before creating another session.`;
    } finally {
      if (revision === this.revision) this.busy = false;
    }
  }

  private get canSend() {
    return (
      this.connected &&
      this.inputAllowed &&
      this.caughtUp &&
      !this.invalidDelivery &&
      !this.busy &&
      !this.localCommand &&
      this.session?.state === 'idle' &&
      !this.receipts.some(
        (receipt) =>
          receipt.generation === this.session?.generation &&
          ['pending', 'unknown', 'accepted'].includes(receipt.state),
      )
    );
  }

  private async send() {
    if (!this.canSend || !this.draft.trim() || !this.session) return;
    const command: LocalCommand = {
      sessionId: this.session.id,
      executionNodeId: this.session.executionNodeId,
      generation: this.session.generation,
      commandId: crypto.randomUUID(),
      text: this.draft.trim(),
    };
    if (!safeLsSet(this.sessionKey(`command:${command.sessionId}`), JSON.stringify(command))) {
      this.error =
        'Browser storage is unavailable. Enable storage to preserve delivery receipts across refresh.';
      return;
    }
    this.localCommand = command;
    this.draft = '';
    safeLsRemove(this.sessionKey(`draft:${command.sessionId}`));
    this.error = '';
    const revision = this.revision;
    try {
      await this.api.request<NativeSessionSendResult>(Methods.NATIVE_SESSION_SEND, {
        sessionId: command.sessionId,
        executionNodeId: command.executionNodeId,
        commandId: command.commandId,
        text: command.text,
        ...(this.worker ? { worker: this.workerControl } : {}),
      });
    } catch (error) {
      if (revision === this.revision)
        this.error = `${(error as Error).message}. Delivery is unconfirmed; this message will not be resent.`;
    } finally {
      this.schedule(0);
    }
  }

  private async sessionAction(method: string) {
    if (!this.session || this.busy || !this.connected || !this.inputAllowed) return;
    const revision = this.revision;
    this.busy = true;
    this.error = '';
    try {
      await this.api.request(method, {
        sessionId: this.session.id,
        executionNodeId: this.session.executionNodeId,
        ...(this.worker ? { worker: this.workerControl } : {}),
      });
    } catch (error) {
      if (revision === this.revision) this.error = (error as Error).message;
    } finally {
      if (revision === this.revision) this.busy = false;
      this.schedule(0);
    }
  }

  private async respond(event: NativeSessionEvent, response: NativeSessionResponse) {
    const request = event.request;
    if (
      !request ||
      !this.session ||
      event.sessionId !== this.session.id ||
      event.generation !== this.session.generation ||
      this.responseDisabled(event)
    )
      return;
    const attempt = this.sessionKey(`response:${event.sessionId}:${request.id}`);
    if (!safeLsSet(attempt, 'attempted')) {
      this.error = 'Browser storage is unavailable. Enable it before answering.';
      return;
    }
    this.responseAttempts = new Set([...this.responseAttempts, request.id]);
    const revision = this.revision;
    this.error = '';
    try {
      await this.api.request(Methods.NATIVE_SESSION_RESPOND, {
        sessionId: event.sessionId,
        executionNodeId: this.session.executionNodeId,
        requestId: request.id,
        ...response,
        ...(this.worker ? { worker: this.workerControl } : {}),
      });
    } catch (error) {
      if (revision === this.revision)
        this.error = `${(error as Error).message}. The answer will not be resent.`;
    } finally {
      this.schedule(0);
    }
  }

  private responseDisabled(event: NativeSessionEvent) {
    return (
      !this.connected ||
      !this.inputAllowed ||
      !this.caughtUp ||
      event.generation !== this.session?.generation ||
      !!event.responseState ||
      this.responseAttempts.has(event.request?.id ?? '') ||
      !!safeLsGet(this.sessionKey(`response:${event.sessionId}:${event.request?.id}`))
    );
  }

  private answer(event: NativeSessionEvent, form: HTMLFormElement) {
    const data = new FormData(form);
    const answers: Record<string, string[]> = {};
    for (const question of event.request?.questions ?? []) {
      const values = data.getAll(question.id).map(String).filter(Boolean);
      const free = String(data.get(`free:${question.id}`) ?? '').trim();
      answers[question.id] = free ? [free] : values;
      if (!answers[question.id].length) {
        this.error = 'Answer every question before sending.';
        return;
      }
    }
    void this.respond(event, { answers });
  }

  private renderRequest(event: NativeSessionEvent) {
    return renderNativeSessionRequest({
      event,
      disabled: this.responseDisabled(event),
      session: this.session,
      connected: this.connected,
      answer: (form) => this.answer(event, form),
      respond: (response) => {
        void this.respond(event, response);
      },
    });
  }

  render() {
    const session = this.session;
    const lastReceipt = this.localCommand
      ? this.receipts.find((receipt) => receipt.commandId === this.localCommand?.commandId)
      : this.receipts.at(-1);
    const canResume =
      !this.worker &&
      session &&
      session.capabilities.resume &&
      session.nativeSessionId &&
      ['closed', 'failed'].includes(session.state) &&
      (!session.processPid || session.processStopped);
    return html`
      ${renderNativeSessionHeader({
        worker: this.worker,
        sessions: this.sessions,
        selectedId: this.selectedId,
        selectedNodeId: this.selectedNodeId,
        session,
        connected: this.connected,
        caughtUp: this.caughtUp,
        busy: this.busy,
        workspace: this.workspace,
        workspaceAllowed: this.workspaceAllowed,
        taskHistory: this.taskHistory,
        fullscreen: this.fullscreen,
        toggleFullscreen: () => void this.toggleFullscreen(),
        requestCount: this.requests.length,
        sessionChoice: (item) => this.sessionChoice(item),
        select: (id, node) => this.select(id, node),
        refresh: () => {
          this.error = '';
          void this.refreshSessions();
          this.schedule(0);
        },
        toggleWorkspace: () => {
          this.workspace = !this.workspace;
        },
      })}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${this.pollError ? html`<div class="error" role="alert">${this.pollError}</div>` : nothing}
      ${this.worker && !this.inputAllowed
        ? html`<p class="meta" data-testid="native-worker-read-only">
            ${this.taskHistory
              ? 'This task history is read-only. Slot files reflect the current workspace.'
              : 'Input unavailable for this task. Use its task controls for recovery, or select the current worker.'}
          </p>`
        : nothing}
      ${this.unavailableNodes.map(
        (node) =>
          html`<p class="error" role="status">
            ${node.executionNodeId}: ${node.message}. Session inventory is incomplete.
          </p>`,
      )}
      ${this.creating
        ? html`<section class="new-session">
            <p>Start an agent workspace using an installed runner and its own account.</p>
            <runner-model-effort-picker
              .catalog=${this.profile
                ? (this.catalog?.runners ?? []).filter(
                    (option) => option.runner === this.profile!.runner,
                  )
                : (this.catalog?.runners ?? [])}
              .runner=${this.runner}
              .model=${this.model}
              .showEffort=${false}
              .disabled=${this.busy}
              @runner-model-effort-change=${(event: CustomEvent<RunnerModelEffortChangeDetail>) => {
                this.runner = event.detail.runner;
                this.model = event.detail.model;
                this.mode = 'default';
              }}
            ></runner-model-effort-picker>
            <label
              >Working directory<select
                data-testid="native-context"
                .value=${this.customCwd
                  ? '__custom__'
                  : this.contextChoice({ cwd: this.cwd, executionNodeId: this.executionNodeId })}
                ?disabled=${this.busy}
                @change=${(e: Event) => {
                  const previousNode = this.executionNodeId;
                  const value = (e.target as HTMLSelectElement).value;
                  this.customCwd = value === '__custom__';
                  if (this.customCwd) {
                    this.cwd = '';
                    this.executionNodeId = 'local';
                  } else {
                    const context = this.catalog?.contexts.find(
                      (item) => this.contextChoice(item) === value,
                    );
                    if (context) {
                      this.cwd = context.cwd;
                      this.executionNodeId = context.executionNodeId ?? 'local';
                    }
                  }
                  if (previousNode !== this.executionNodeId) {
                    this.profile = undefined;
                    this.profileReady = true;
                    this.profileNodeId = this.executionNodeId;
                  }
                }}
              >
                ${(this.catalog?.contexts ?? []).map(
                  (context) =>
                    html`<option
                      value=${this.contextChoice(context)}
                      .selected=${!this.customCwd &&
                      this.contextChoice(context) ===
                        this.contextChoice({
                          cwd: this.cwd,
                          executionNodeId: this.executionNodeId,
                        })}
                    >
                      ${context.label}${context.project ? ` · ${context.project}` : ''} ·
                      ${context.executionNodeId ?? 'local'} · ${context.cwd}
                    </option>`,
                )}
                <option value="__custom__" .selected=${this.customCwd}>
                  Other local directory
                </option>
              </select></label
            >
            ${this.customCwd
              ? html`<label
                  >Local directory<input
                    data-testid="native-cwd"
                    .value=${this.cwd}
                    ?disabled=${this.busy}
                    @input=${(e: Event) => (this.cwd = (e.target as HTMLInputElement).value)}
                /></label>`
              : nothing}
            ${this.catalog?.contexts.some(
              (context) =>
                (context.executionNodeId ?? 'local') === this.executionNodeId &&
                context.supportsProfiles,
            )
              ? keyed(
                  this.revision,
                  html`<native-profiles
                    .api=${this.api}
                    .executionNodeId=${this.executionNodeId}
                    .runner=${this.runner}
                    .disabled=${this.busy || !this.connected}
                    @native-profile-change=${(event: CustomEvent<NativeProfileSelection>) => {
                      const selected = event.detail;
                      if (selected.executionNodeId !== this.executionNodeId) return;
                      this.profile = selected.profile;
                      this.profileReady = selected.ready;
                      this.profileNodeId = selected.executionNodeId;
                      if (selected.profile && selected.profile.runner !== this.runner) {
                        this.runner = selected.profile.runner;
                        this.model =
                          this.catalog?.runners.find((option) => option.runner === this.runner)
                            ?.defaultModel ?? '';
                        this.mode = 'default';
                      }
                    }}
                  ></native-profiles>`,
                )
              : nothing}
            <label
              >Interaction mode<select
                data-testid="native-mode"
                .value=${this.mode}
                ?disabled=${this.busy}
                @change=${(e: Event) =>
                  (this.mode = (e.target as HTMLSelectElement).value as 'default' | 'plan')}
              >
                ${(
                  this.catalog?.runners.find((option) => option.runner === this.runner)?.modes ?? []
                ).map(
                  (mode) =>
                    html`<option value=${mode} .selected=${mode === this.mode}>
                      ${mode === 'plan' ? 'Plan' : 'Default'}
                    </option>`,
                )}
              </select></label
            >
            <p class="meta">
              Model choices are configured suggestions. Your runner account determines access and
              billing. The selected machine runs the session using its configured owner's account.
            </p>
            <div>
              <button
                class="primary"
                data-testid="native-create"
                ?disabled=${!this.connected ||
                this.busy ||
                !this.cwd.trim() ||
                !this.runner ||
                !this.profileReady}
                @click=${() => this.create()}
              >
                ${this.busy ? 'Starting…' : 'Start session'}
              </button>
            </div>
          </section>`
        : session
          ? html`
              <div class="identity">
                <strong
                  >${session.runner} · ${session.model ?? 'Runner default'} ·
                  ${session.mode}</strong
                ><span class="meta"
                  >${session.cwd}${session.profileId ? ` · Profile ${session.profileId}` : ''}</span
                >
                <details>
                  <summary>Session details</summary>
                  <div class="meta">
                    Session ${session.id}<br />Conversation ${session.nativeSessionId}<br />Version
                    ${session.version}<br />${session.executionNodeId} · ${session.accountContextId}
                  </div>
                </details>
              </div>
              <div
                class="layout ${this.workspace && this.workspaceAllowed
                  ? 'workspace-visible'
                  : 'conversation-only'}"
              >
                <section class="conversation">
                  <div class="timeline" aria-label="Agent conversation">
                    ${repeat(
                      this.timeline(),
                      (entry) => entry.key,
                      (entry) =>
                        html`<article class=${entry.kind} data-sequence=${entry.key}>
                          ${entry.kind === 'tool'
                            ? html`<details>
                                <summary>
                                  ${entry.text} ·
                                  ${entry.event.type === 'tool.started'
                                    ? 'Started'
                                    : (entry.event.tool?.status ?? 'Finished')}
                                </summary>
                                <pre>
${JSON.stringify(
                                    {
                                      ...(entry.event.tool?.input !== undefined
                                        ? { input: entry.event.tool.input }
                                        : {}),
                                      ...(entry.event.tool?.output !== undefined
                                        ? { output: entry.event.tool.output }
                                        : {}),
                                    },
                                    null,
                                    2,
                                  )}</pre
                                >
                              </details>`
                            : html`<span class="meta"
                                  >${entry.kind === 'user'
                                    ? 'You'
                                    : entry.kind === 'assistant'
                                      ? session.runner
                                      : entry.event.at}</span
                                >
                                <div class="text">
                                  ${entry.kind === 'assistant'
                                    ? html`<chat-message
                                        .message=${{
                                          id: `${entry.event.sessionId}:${entry.key}`,
                                          role: 'assistant',
                                          content: entry.text,
                                          timestamp: entry.event.at,
                                        } satisfies ChatMessage}
                                      ></chat-message>`
                                    : entry.text}
                                </div>
                                ${entry.event.type === 'error' && entry.event.data
                                  ? html`<details>
                                      <summary>Error details</summary>
                                      <pre>${JSON.stringify(entry.event.data, null, 2)}</pre>
                                    </details>`
                                  : nothing}`}
                        </article>`,
                    )}
                    ${this.localCommand &&
                    !this.transcript.events.some(
                      (event) =>
                        event.commandId === this.localCommand?.commandId &&
                        ['command.submitted', 'command.accepted'].includes(event.type),
                    )
                      ? html`<article class="user">
                          <span class="meta">You · Delivery unconfirmed</span>
                          <div class="text">${this.localCommand.text}</div>
                        </article>`
                      : nothing}
                    ${!this.transcript.events.length
                      ? html`<p class="empty">
                          ${this.caughtUp ? 'Send a task to begin.' : 'Loading conversation…'}
                        </p>`
                      : nothing}
                  </div>
                  <div class="composer">
                    ${this.receipts.some(
                      (receipt) =>
                        receipt.generation !== session.generation &&
                        ['pending', 'unknown', 'accepted'].includes(receipt.state),
                    )
                      ? html`<p class="meta">
                          An earlier generation has an unconfirmed outcome. It was not replayed on
                          resume.
                        </p>`
                      : nothing}
                    <div class="requests" role="region" aria-label="Pending runner requests">
                      <span class="sr-only" role="status" aria-live="polite"
                        >${this.requests.length
                          ? `${this.requests.length} runner request${this.requests.length === 1 ? '' : 's'} awaiting your response`
                          : ''}</span
                      >
                      ${repeat(
                        this.requests,
                        (event) => event.request?.id,
                        (event) => this.renderRequest(event),
                      )}
                    </div>
                    ${session.capabilities.resumeUnavailableReason
                      ? html`<p class="meta">${session.capabilities.resumeUnavailableReason}</p>`
                      : session.recovery
                        ? html`<p class="meta">${session.recovery}</p>`
                        : nothing}
                    <label
                      >Message<textarea
                        data-testid="native-message"
                        ?disabled=${!this.inputAllowed}
                        .value=${this.draft}
                        @input=${(e: Event) => {
                          this.draft = (e.target as HTMLTextAreaElement).value;
                          safeLsSet(this.sessionKey(`draft:${this.selectedId}`), this.draft);
                        }}
                        @keydown=${(e: KeyboardEvent) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            void this.send();
                          }
                        }}
                      ></textarea>
                    </label>
                    <div class="actions">
                      <button
                        class="primary"
                        data-testid="native-send"
                        ?disabled=${!this.canSend || !this.draft.trim()}
                        @click=${this.send}
                      >
                        Send
                      </button>
                      <button
                        data-testid="native-stop"
                        ?disabled=${!this.connected ||
                        !this.inputAllowed ||
                        this.busy ||
                        !session.capabilities.interrupt ||
                        !['running', 'waiting'].includes(session.state)}
                        @click=${() => this.sessionAction(Methods.NATIVE_SESSION_INTERRUPT)}
                      >
                        Stop
                      </button>
                      ${!['closed', 'failed'].includes(session.state)
                        ? html`<button
                            data-testid="native-close"
                            ?disabled=${!this.connected || this.busy || !this.inputAllowed}
                            @click=${() => this.sessionAction(Methods.NATIVE_SESSION_CLOSE)}
                          >
                            Close session
                          </button>`
                        : nothing}
                      ${canResume
                        ? html`<button
                            data-testid="native-resume"
                            ?disabled=${!this.connected || this.busy}
                            @click=${() => this.create(session)}
                          >
                            Resume conversation
                          </button>`
                        : nothing}
                      <span class="meta" data-testid="native-delivery"
                        >${lastReceipt || this.localCommand
                          ? nativeDeliveryLabel(lastReceipt)
                          : 'Ctrl/⌘ + Enter to send'}</span
                      >
                    </div>
                  </div>
                </section>
                ${this.workspace && this.workspaceAllowed
                  ? html`<native-workspace
                      .sessionId=${session.id}
                      .executionNodeId=${session.executionNodeId}
                      .api=${this.api}
                      .worker=${this.worker ? nativeWorkerViewPin(this.worker) : undefined}
                    ></native-workspace>`
                  : nothing}
              </div>
            `
          : html`<p class="empty">
              ${this.selectedId
                ? 'Loading saved session…'
                : 'Connect to the gateway to choose a runner.'}
            </p>`}
    `;
  }
}
