import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  type ChatMessage,
  Methods,
  type NativeCommandReceipt,
  type NativeSessionCatalogResult,
  type NativeSessionCreateParams,
  type NativeSessionEvent,
  type NativeSessionInfo,
  type NativeSessionReadResult,
  type NativeSessionResponse,
  type NativeSessionSendResult,
} from '@farmslot/protocol';

import '../shared/runner-model-effort-picker.js';
import './chat-message.js';
import './native-workspace.js';

import { gateway } from '../../gateway-client.js';
import { safeLsGet, safeLsRemove, safeLsSet } from '../../utils/storage.js';
import type { RunnerModelEffortChangeDetail } from '../shared/runner-model-effort-picker.js';

import {
  appendNativePage,
  nativeCommandLockSettled,
  nativeDeliveryLabel,
  nativeTimeline,
  type NativeTranscript,
} from './native-session-model.js';
import { nativeSessionStyles } from './native-session-styles.js';
import { type NativeSessionApi } from './native-workspace.js';

type LocalCommand = { sessionId: string; generation: string; commandId: string; text: string };

@customElement('native-session-view')
export class NativeSessionView extends LitElement {
  @property({ attribute: false }) api: NativeSessionApi = gateway;
  /** Fixture clients are supplied before connection; production always follows gateway authentication. */
  @property({ type: Boolean }) fixture = false;
  @state() private catalog?: NativeSessionCatalogResult;
  @state() private sessions: NativeSessionInfo[] = [];
  @state() private session?: NativeSessionInfo;
  @state() private selectedId = '';
  @state() private creating = false;
  @state() private runner = '';
  @state() private model = '';
  @state() private mode: 'default' | 'plan' = 'default';
  @state() private cwd = '';
  @state() private customCwd = false;
  @state() private transcript: NativeTranscript = { events: [], cursor: 0 };
  @state() private receipts: NativeCommandReceipt[] = [];
  @state() private requests: NativeSessionEvent[] = [];
  @state() private draft = '';
  @state() private localCommand?: LocalCommand;
  @state() private connected = false;
  @state() private caughtUp = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private workspace = false;
  @state() private responseAttempts = new Set<string>();
  @state() private invalidDelivery = false;
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
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

  connectedCallback() {
    super.connectedCallback();
    this.connected = this.fixture || gateway.connectionState === 'connected';
    if (this.fixture) void this.connect();
    else {
      this.unsubscribe = gateway.onConnectionChange((status) => {
        this.connected = status === 'connected';
        if (this.connected) void this.connect();
        else {
          this.caughtUp = false;
          clearTimeout(this.timer);
        }
      });
      if (this.connected) void this.connect();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.revision++;
    clearTimeout(this.timer);
    this.unsubscribe?.();
  }

  private key(suffix: string) {
    return `farmslot-native:${this.storageScope}:${suffix}`;
  }

  private async connect() {
    const scope = this.fixture
      ? 'fixture'
      : `${gateway.gatewayUrl}:${gateway.authenticatedPrincipalId}`;
    if (scope !== this.storageScope) {
      this.storageScope = scope;
      this.revision++;
      this.selectedId = safeLsGet(this.key('selected')) ?? '';
      this.session = undefined;
      this.transcript = { events: [], cursor: 0 };
      this.requests = [];
      this.receipts = [];
      this.loadLocal();
    }
    await this.refreshSessions();
    this.schedule(0);
  }

  private loadLocal() {
    this.draft = safeLsGet(this.key(`draft:${this.selectedId}`)) ?? '';
    const raw = safeLsGet(this.key(`command:${this.selectedId}`));
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
    const revision = this.revision;
    try {
      const [catalog, result] = await Promise.all([
        this.api.request<NativeSessionCatalogResult>(Methods.NATIVE_SESSION_CATALOG, {}),
        this.api.request<{ sessions: NativeSessionInfo[] }>(Methods.NATIVE_SESSION_LIST, {}),
      ]);
      if (!this.isConnected || revision !== this.revision) return;
      this.catalog = catalog;
      this.sessions = [...result.sessions].reverse();
      if (!this.runner) {
        this.runner = catalog.runners[0]?.runner ?? '';
        this.model = catalog.runners[0]?.defaultModel ?? '';
      }
      if (!this.cwd) this.cwd = catalog.contexts[0]?.cwd ?? '';
      if (!this.selectedId) this.creating = true;
    } catch (error) {
      if (revision === this.revision) this.error = (error as Error).message;
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
          after: this.transcript.cursor,
          limit: 200,
        });
        if (!this.isConnected || revision !== this.revision) return;
        const timeline = this.renderRoot.querySelector('.timeline');
        const nearBottom =
          !timeline || timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
        this.transcript = appendNativePage(this.transcript, page);
        for (const event of page.events) {
          if (event.type === 'approval.resolved' && event.request) {
            safeLsRemove(this.key(`response:${event.sessionId}:${event.request.id}`));
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
            safeLsRemove(this.key(`command:${this.selectedId}`));
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
        this.error = (error as Error).message;
        this.caughtUp = false;
      }
    } finally {
      this.polling = false;
      this.schedule(this.caughtUp ? 1000 : 300);
    }
  }

  private select(id: string) {
    this.revision++;
    this.selectedId = id;
    this.creating = !id;
    this.session = undefined;
    this.transcript = { events: [], cursor: 0 };
    this.receipts = [];
    this.requests = [];
    this.caughtUp = false;
    this.error = '';
    this.busy = false;
    safeLsSet(this.key('selected'), id);
    this.loadLocal();
    this.schedule(0);
  }

  private async create(resume?: NativeSessionInfo) {
    this.busy = true;
    this.error = '';
    const revision = this.revision;
    const params: NativeSessionCreateParams = resume
      ? {
          runner: resume.runner,
          model: resume.model,
          mode: resume.mode,
          cwd: resume.cwd,
          resumeSessionId: resume.nativeSessionId,
        }
      : { runner: this.runner, model: this.model || undefined, mode: this.mode, cwd: this.cwd };
    try {
      const result = await this.api.request<{ session: NativeSessionInfo }>(
        Methods.NATIVE_SESSION_CREATE,
        params,
      );
      if (revision !== this.revision || !this.isConnected) return;
      this.select(result.session.id);
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
      generation: this.session.generation,
      commandId: crypto.randomUUID(),
      text: this.draft.trim(),
    };
    if (!safeLsSet(this.key(`command:${command.sessionId}`), JSON.stringify(command))) {
      this.error =
        'Browser storage is unavailable. Enable storage to preserve delivery receipts across refresh.';
      return;
    }
    this.localCommand = command;
    this.draft = '';
    safeLsRemove(this.key(`draft:${command.sessionId}`));
    this.error = '';
    const revision = this.revision;
    try {
      await this.api.request<NativeSessionSendResult>(Methods.NATIVE_SESSION_SEND, {
        sessionId: command.sessionId,
        commandId: command.commandId,
        text: command.text,
      });
    } catch (error) {
      if (revision === this.revision)
        this.error = `${(error as Error).message}. Delivery is unconfirmed; this message will not be resent.`;
    } finally {
      this.schedule(0);
    }
  }

  private async sessionAction(method: string) {
    if (!this.session || this.busy || !this.connected) return;
    const revision = this.revision;
    this.busy = true;
    this.error = '';
    try {
      await this.api.request(method, { sessionId: this.session.id });
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
    const attempt = this.key(`response:${event.sessionId}:${request.id}`);
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
        requestId: request.id,
        ...response,
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
      !this.caughtUp ||
      event.generation !== this.session?.generation ||
      !!event.responseState ||
      this.responseAttempts.has(event.request?.id ?? '') ||
      !!safeLsGet(this.key(`response:${event.sessionId}:${event.request?.id}`))
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
    const request = event.request;
    if (!request) return nothing;
    const disabled = this.responseDisabled(event);
    return html`<div class="request" data-request-id=${request.id}>
      <h3>${request.title}</h3>
      ${request.detail ? html`<pre>${request.detail}</pre>` : nothing}
      ${request.tool
        ? html`<div data-testid="native-request-tool">
            <strong>${request.tool.name}</strong>
            <pre>${JSON.stringify(request.tool.input, null, 2)}</pre>
          </div>`
        : nothing}
      ${event.type === 'approval.requested' && event.data
        ? html`<details open>
            <summary>Action details</summary>
            <pre>${JSON.stringify(event.data, null, 2)}</pre>
          </details>`
        : nothing}
      ${event.type === 'question.requested'
        ? html`<form
            @submit=${(e: SubmitEvent) => {
              e.preventDefault();
              this.answer(event, e.currentTarget as HTMLFormElement);
            }}
          >
            ${(request.questions ?? []).map(
              (question) =>
                html`<fieldset ?disabled=${disabled}>
                  <legend>${question.prompt}</legend>
                  ${question.options.map(
                    (option) =>
                      html`<label
                        ><input
                          type=${question.multiSelect ? 'checkbox' : 'radio'}
                          name=${question.id}
                          value=${option.label}
                        />${option.label}${option.description
                          ? ` · ${option.description}`
                          : ''}</label
                      >`,
                  )}
                  <label
                    >Custom answer<input
                      type="text"
                      name=${`free:${question.id}`}
                      aria-label=${`Custom answer: ${question.prompt}`}
                  /></label>
                </fieldset>`,
            )}<button ?disabled=${disabled || !this.session?.capabilities.questions} type="submit">
              Send answers
            </button>
          </form>`
        : html`<div class="actions">
            <button
              data-testid="native-approve"
              ?disabled=${disabled || !this.session?.capabilities.approvals}
              @click=${() => this.respond(event, { decision: 'approve' })}
            >
              Approve
            </button>
            <button
              data-testid="native-deny"
              ?disabled=${disabled || !this.session?.capabilities.approvals}
              @click=${() => this.respond(event, { decision: 'deny' })}
            >
              Deny
            </button>
          </div>`}
      ${disabled && this.connected
        ? html`<p class="meta">
            Response pending or outcome unknown. Reconnecting never resends an answer.
          </p>`
        : nothing}
    </div>`;
  }

  render() {
    const session = this.session;
    const lastReceipt = this.localCommand
      ? this.receipts.find((receipt) => receipt.commandId === this.localCommand?.commandId)
      : this.receipts.at(-1);
    const canResume =
      session &&
      session.capabilities.resume &&
      session.nativeSessionId &&
      ['closed', 'failed'].includes(session.state) &&
      (!session.processPid || session.processStopped);
    return html`
      <div class="bar">
        <label class="inline"
          >Session<select
            data-testid="native-session-select"
            @change=${(e: Event) => this.select((e.target as HTMLSelectElement).value)}
          >
            <option value="" .selected=${!this.selectedId}>New session</option>
            ${this.sessions.map(
              (item) =>
                html`<option value=${item.id} .selected=${item.id === this.selectedId}>
                  ${item.runner} · ${item.model ?? 'default'} · ${item.cwd.split('/').at(-1)} ·
                  ${item.id.slice(0, 8)} · ${item.state}
                </option>`,
            )}
          </select></label
        >
        <button data-testid="native-new" ?disabled=${this.busy} @click=${() => this.select('')}>
          New session
        </button>
        <button
          data-testid="native-refresh"
          ?disabled=${!this.connected}
          @click=${() => {
            this.error = '';
            void this.refreshSessions();
            this.schedule(0);
          }}
        >
          Refresh sessions
        </button>
        ${session
          ? html`<button
              aria-pressed=${this.workspace}
              data-testid="native-workspace-toggle"
              @click=${() => (this.workspace = !this.workspace)}
            >
              ${this.workspace ? 'Conversation' : 'Files / Changes'}${this.requests.length
                ? ` · ${this.requests.length} waiting`
                : ''}
            </button>`
          : nothing}
        <span
          class="status"
          role="status"
          data-state=${this.connected ? (session?.state ?? '') : 'disconnected'}
          >${!this.connected
            ? 'Disconnected. Draft and session preserved.'
            : session
              ? `${session.state}${this.caughtUp ? '' : ' · Replaying history'}`
              : ''}</span
        >
      </div>
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${this.creating
        ? html`<section class="new-session">
            <p>Start an agent workspace using an installed runner and its own account.</p>
            <runner-model-effort-picker
              .catalog=${this.catalog?.runners ?? []}
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
                .value=${this.customCwd ? '__custom__' : this.cwd}
                ?disabled=${this.busy}
                @change=${(e: Event) => {
                  const value = (e.target as HTMLSelectElement).value;
                  this.customCwd = value === '__custom__';
                  this.cwd = this.customCwd ? '' : value;
                }}
              >
                ${(this.catalog?.contexts ?? []).map(
                  (context) =>
                    html`<option
                      value=${context.cwd}
                      .selected=${!this.customCwd && context.cwd === this.cwd}
                    >
                      ${context.label}${context.project ? ` · ${context.project}` : ''} ·
                      ${context.cwd}
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
              billing. This workspace is local to the configured owner.
            </p>
            <div>
              <button
                class="primary"
                data-testid="native-create"
                ?disabled=${!this.connected || this.busy || !this.cwd.trim() || !this.runner}
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
                ><span class="meta">${session.cwd}</span>
                <details>
                  <summary>Session details</summary>
                  <div class="meta">
                    Session ${session.id}<br />Conversation ${session.nativeSessionId}<br />Version
                    ${session.version}<br />${session.executionNodeId} · ${session.accountContextId}
                  </div>
                </details>
              </div>
              <div class="layout ${this.workspace ? 'workspace-visible' : 'conversation-only'}">
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
                        .value=${this.draft}
                        @input=${(e: Event) => {
                          this.draft = (e.target as HTMLTextAreaElement).value;
                          safeLsSet(this.key(`draft:${this.selectedId}`), this.draft);
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
                            ?disabled=${!this.connected || this.busy}
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
                ${this.workspace
                  ? html`<native-workspace
                      .sessionId=${session.id}
                      .api=${this.api}
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
