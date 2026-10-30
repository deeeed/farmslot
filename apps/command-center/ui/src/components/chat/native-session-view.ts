import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  type ChatMessage,
  Methods,
  type NativeCommandReceipt,
  type NativeProfileInfo,
  type NativeSessionCatalogResult,
  type NativeSessionCreateParams,
  type NativeSessionEvent,
  type NativeSessionInfo,
  type NativeSessionListResult,
  type NativeSessionReadParams,
  type NativeSessionReadResult,
  type NativeSessionResponse,
  type NativeSessionSendResult,
  type NativeWorkerHistoryScope,
} from '@farmslot/protocol';
import {
  appendNativePage,
  NATIVE_FOLLOW_LATEST,
  nativeCommandLockSettled,
  nativeDeliveryLabel,
  type NativeFollow,
  nativeFollowGrew,
  nativeFollowLabel,
  nativeFollowScrolled,
  nativeHistoryCanAct,
  nativeHistoryQuery,
  nativeObservationQuery,
  nativeTimeline,
  type NativeTranscript,
  type ResourceQuery,
  type ResourceQueryState,
  SUPERSEDED_READ_GRACE_MS,
} from '@farmslot/protocol/client-cache';
import { catalogForNativeRunners, ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import '../shared/review-dispatch-picker.js';
import './chat-message.js';
import './native-workspace.js';
import './native-profiles.js';

import { gateway } from '../../gateway-client.js';
import {
  getResourceCache,
  getResourceNativeOwnerId,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../../resource-cache.js';
import { safeLsGet, safeLsRemove, safeLsSet } from '../../utils/storage.js';
import { buildHash, hashParams, parseHashRoute } from '../../utils/url-state.js';
import { heldDataIsSaved, isSupersededRead } from '../shared/resource-query-controller.js';

import type { NativeProfileSelection } from './native-profiles.js';
import { renderNativeSessionHeader } from './native-session-header.js';
import { observeNativeResource } from './native-session-observation.js';
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

/** Static preview reads that dev harnesses inject in place of the shared resource cache. */
export interface NativeSessionFixture {
  catalog(): Promise<NativeSessionCatalogResult>;
  list(): Promise<NativeSessionListResult>;
  read(params: NativeSessionReadParams): Promise<NativeSessionReadResult>;
}

function timelineDistance(timeline: Element) {
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
}

@customElement('native-session-view')
export class NativeSessionView extends LitElement {
  @property({ attribute: false }) api: NativeSessionApi = gateway;
  /** Fixture reads are supplied before connection; production always follows gateway authentication. */
  @property({ attribute: false }) fixture?: NativeSessionFixture;
  @property({ attribute: false }) worker?: NativeWorkerViewTarget;
  @property() initialSessionId = '';
  @property() initialExecutionNodeId = '';
  private catalogCurrent = false;
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
  private executionPicker = new ReviewDispatchViewModel({ context: { allowedActions: ['chat'] } });
  private get runner() {
    return this.executionPicker.selection!.runner;
  }
  private set runner(value: string) {
    this.executionPicker.setRunner(this.executionPicker.rows[0].id, value);
    this.requestUpdate();
  }
  private get model() {
    return this.executionPicker.selection!.model ?? '';
  }
  private set model(value: string) {
    this.executionPicker.setModel(this.executionPicker.rows[0].id, value || null);
    this.requestUpdate();
  }
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
  @state() private inventoryError = '';
  @state() private catalogError = '';
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
  private readUnavailableSince?: number;
  private savedHistoryBoundary?: ReturnType<typeof setTimeout>;
  private inventoryCurrent = false;
  @state() private inventoryUnsupported = false;
  @state() private catalogUnsupported = false;
  private unsubscribe?: () => void;
  private inventoryRevision = 0;
  private storageScope = '';
  private polling = false;
  private historyStop?: () => void;
  private inventoryStops: Array<() => void> = [];
  private ownerStop?: () => void;
  private historyQuery?: ResourceQuery<NativeSessionReadResult>;
  @state() private historyObservation: ResourceQueryState<NativeSessionReadResult> = {
    status: 'loading',
  };
  private timelineEvents?: NativeSessionEvent[];
  private timelineEntries: ReturnType<typeof nativeTimeline> = [];
  @state() private follow: NativeFollow = NATIVE_FOLLOW_LATEST;
  /** The selection the timeline DOM was last rendered for. */
  private renderedRevision = -1;

  private timeline() {
    if (this.timelineEvents !== this.transcript.events) {
      this.timelineEvents = this.transcript.events;
      this.timelineEntries = nativeTimeline(this.transcript.events);
    }
    return this.timelineEntries;
  }

  static styles = nativeSessionStyles;

  protected willUpdate() {
    if (!this.connected || this.pollError || this.inventoryError || this.catalogError)
      this.readUnavailableSince ??= Date.now();
    else if (
      isSupersededRead(this.historyObservation.error) ||
      (this.worker
        ? this.historyObservation.status === 'ready'
        : this.inventoryCurrent &&
          this.catalogCurrent &&
          (!this.selectedId || this.historyObservation.status === 'ready'))
    )
      this.readUnavailableSince = undefined;
    clearTimeout(this.savedHistoryBoundary);
    const observation = this.historyObservation;
    if (
      this.connected &&
      observation.status === 'stale' &&
      observation.data !== undefined &&
      observation.observedAt !== undefined &&
      isSupersededRead(observation.error) &&
      !heldDataIsSaved(observation, this.connected)
    ) {
      // Re-evaluate action controls once when held history becomes saved. Age ticks stay in the row.
      this.savedHistoryBoundary = setTimeout(
        () => {
          if (this.isConnected) this.requestUpdate();
        },
        observation.observedAt + SUPERSEDED_READ_GRACE_MS - Date.now(),
      );
    }
  }

  protected updated(changed: PropertyValues) {
    this.renderedRevision = this.revision;
    if (
      changed.has('initialSessionId') &&
      changed.get('initialSessionId') &&
      !this.initialSessionId &&
      this.connected &&
      !this.worker
    )
      this.select('');
    if (
      (changed.has('initialSessionId') || changed.has('initialExecutionNodeId')) &&
      this.initialSessionId &&
      this.initialExecutionNodeId &&
      this.connected &&
      !this.worker &&
      (this.selectedId !== this.initialSessionId ||
        this.selectedNodeId !== this.initialExecutionNodeId)
    )
      this.select(this.initialSessionId, this.initialExecutionNodeId);
    if ((changed.has('profile') || changed.has('catalog')) && this.catalog) {
      this.executionPicker.setCatalog(
        catalogForNativeRunners(
          this.catalog.runners.filter(
            (runner) => !this.profile || runner.runner === this.profile.runner,
          ),
        ),
      );
    }
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
    return this.historyCurrent && (!this.worker || Boolean(this.workerControl));
  }

  private get historyCurrent() {
    if (this.fixture) return this.caughtUp;
    const state = this.historyQuery && getResourceCache()?.read(this.historyQuery);
    return (
      nativeHistoryCanAct(state, this.historyObservation.data, this.connected) &&
      state?.data?.session === this.session
    );
  }

  private observeHistory() {
    this.historyStop?.();
    this.historyStop = undefined;
    this.historyQuery = undefined;
    if (!this.selectedId || this.fixture) return;
    const owner = getResourceNativeOwnerId();
    if (!owner) return;
    const revision = this.revision;
    const query = nativeHistoryQuery(
      {
        sessionId: this.selectedId,
        executionNodeId: this.selectedNodeId,
        ...(this.worker ? { worker: nativeWorkerViewPin(this.worker) } : {}),
      },
      owner,
    );
    this.historyQuery = query;
    this.historyStop = observeNativeResource(query, (state) => {
      if (!this.isConnected || revision !== this.revision) return;
      const before = this.timeline().length;
      this.historyObservation = state;
      const page = state.data;
      this.session = page?.session;
      this.transcript = { events: page?.events ?? [], cursor: page?.cursor ?? 0 };
      this.historyScope = page?.scope;
      this.receipts = page?.commands ?? [];
      this.requests = page?.pendingRequests ?? [];
      this.caughtUp = state.status === 'ready' && !!page && !page.hasMore;
      this.pollError = isSupersededRead(state.error) ? '' : (state.error?.message ?? '');
      if (page && this.caughtUp)
        for (const event of page.events) {
          if (event.type === 'approval.resolved' && event.request) {
            safeLsRemove(this.sessionKey(`response:${event.sessionId}:${event.request.id}`));
            this.responseAttempts = new Set(
              [...this.responseAttempts].filter((id) => id !== event.request?.id),
            );
          }
        }
      if (this.caughtUp && page && this.localCommand) {
        const receipt = page.commands.find(
          (item) =>
            item.commandId === this.localCommand?.commandId &&
            item.generation === this.localCommand?.generation,
        );
        if (
          nativeCommandLockSettled(this.localCommand, page.session.generation, receipt, page.events)
        ) {
          safeLsRemove(this.sessionKey(`command:${this.selectedId}`));
          this.localCommand = undefined;
        }
      }
      this.followTimeline(before);
    });
  }

  /** A reader at the end keeps new output in view; one who scrolled up counts what arrived. */
  private followTimeline(before: number) {
    // The DOM still shows the last render: opening an entry may have moved the reader off the end.
    const timeline = this.renderRoot.querySelector('.timeline');
    if (timeline && this.renderedRevision === this.revision)
      this.follow = nativeFollowScrolled(this.follow, timelineDistance(timeline));
    this.follow = nativeFollowGrew(this.follow, this.timeline().length - before);
    if (this.follow.following) void this.updateComplete.then(() => this.scrollTimelineToEnd());
  }

  private readonly timelineScrolled = (event: Event) => {
    this.follow = nativeFollowScrolled(
      this.follow,
      timelineDistance(event.currentTarget as Element),
    );
  };

  private renderJumpLatest() {
    const label = nativeFollowLabel(this.follow);
    return label
      ? html`<button
          class="jump-latest"
          data-testid="native-jump-latest"
          @click=${() => {
            this.follow = NATIVE_FOLLOW_LATEST;
            this.scrollTimelineToEnd();
          }}
        >
          ${label}
        </button>`
      : nothing;
  }

  private scrollTimelineToEnd() {
    const timeline = this.renderRoot.querySelector('.timeline');
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
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
    this.connected = Boolean(this.fixture) || gateway.connectionState === 'connected';
    if (!this.fixture) {
      this.ownerStop = subscribeResourceCache(() => {
        void this.connect();
      });
      void this.connect();
    }
    if (this.fixture) void this.connect();
    else {
      this.unsubscribe = gateway.onConnectionChange((status) => {
        this.connected = status === 'connected';
        if (this.connected) void this.connect();
        else {
          this.caughtUp = false;
          clearTimeout(this.timer);
          this.inventoryRevision++;
        }
      });
      if (this.connected) void this.connect();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.savedHistoryBoundary);
    document.removeEventListener('fullscreenchange', this.fullscreenChanged);
    this.revision++;
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.historyStop?.();
    this.ownerStop?.();
    this.inventoryStops.forEach((stop) => stop());
    this.inventoryStops = [];
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
    const scope = this.fixture ? 'fixture' : (getResourceWorkspaceKey() ?? '');
    if (scope !== this.storageScope) {
      this.storageScope = scope;
      this.readUnavailableSince = undefined;
      this.inventoryCurrent = false;
      this.inventoryUnsupported = false;
      this.catalogUnsupported = false;
      this.revision++;
      this.selectedId = safeLsGet(this.key('selected')) ?? '';
      this.selectedNodeId = safeLsGet(this.key('selected-node')) ?? 'local';
      this.session = undefined;
      this.sessions = [];
      this.catalog = undefined;
      this.responseAttempts = new Set();
      this.transcript = { events: [], cursor: 0 };
      this.follow = NATIVE_FOLLOW_LATEST;
      this.historyScope = undefined;
      this.requests = [];
      this.receipts = [];
      this.loadLocal();
    }
    if (this.worker) {
      this.select(this.worker.binding.sessionId, this.worker.binding.executionNodeId);
      return;
    }
    if (
      this.initialSessionId &&
      this.initialExecutionNodeId &&
      (this.selectedId !== this.initialSessionId ||
        this.selectedNodeId !== this.initialExecutionNodeId)
    )
      this.select(this.initialSessionId, this.initialExecutionNodeId);
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
    if (!this.fixture) {
      this.inventoryStops.forEach((stop) => stop());
      this.inventoryStops = [];
      if (this.worker) {
        this.observeHistory();
        return;
      }
      const owner = getResourceNativeOwnerId();
      if (!owner) return;
      this.inventoryStops.push(
        observeNativeResource(
          nativeObservationQuery<NativeSessionListResult>(Methods.NATIVE_SESSION_LIST, {}, owner),
          (state) => {
            this.inventoryCurrent = state.status === 'ready';
            this.inventoryUnsupported = state.status === 'unsupported';
            this.inventoryError = state.error?.message ?? '';
            const sessions = state.data?.sessions ?? [];
            this.sessions = sessions
              .filter((session) => !session.workerManaged)
              .slice()
              .reverse();
            this.unavailableNodes = state.data?.unavailableExecutionNodes ?? [];
            if (
              sessions.some(
                (session) =>
                  session.workerManaged &&
                  session.id === this.selectedId &&
                  session.executionNodeId === this.selectedNodeId,
              )
            ) {
              this.select('');
              if (this.initialSessionId) this.error = 'Open this task conversation from its run.';
            }
          },
        ),
      );
      this.inventoryStops.push(
        observeNativeResource(
          nativeObservationQuery<NativeSessionCatalogResult>(
            Methods.NATIVE_SESSION_CATALOG,
            {},
            owner,
          ),
          (state) => {
            this.catalogUnsupported = state.status === 'unsupported';
            this.catalogError = state.error?.message ?? '';
            this.catalog = state.data;
            this.catalogCurrent = state.status === 'ready';
            if (this.catalog)
              this.executionPicker.setCatalog(catalogForNativeRunners(this.catalog.runners));
            if (!this.cwd && !this.customCwd && this.catalog) {
              this.cwd = this.catalog.contexts[0]?.cwd ?? '';
              this.executionNodeId = this.catalog.contexts[0]?.executionNodeId ?? 'local';
            }
          },
        ),
      );
      return;
    }
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
      const [catalog, result] = await Promise.all([this.fixture.catalog(), this.fixture.list()]);
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
      ) {
        this.select('');
        if (this.initialSessionId) {
          this.unavailableNodes = result.unavailableExecutionNodes ?? [];
          this.executionPicker.setCatalog(catalogForNativeRunners(catalog.runners));
          this.error = 'Open this task conversation from its run.';
          return;
        }
      }
      this.unavailableNodes = result.unavailableExecutionNodes ?? [];
      this.executionPicker.setCatalog(catalogForNativeRunners(catalog.runners));
      if (!catalog.runners.some((option) => option.runner === this.runner)) {
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

  private schedule(delay = 0) {
    if (!this.fixture) {
      this.observeHistory();
      return;
    }
    clearTimeout(this.timer);
    if (this.isConnected && this.connected) this.timer = setTimeout(() => void this.poll(), delay);
  }

  private async poll() {
    const fixture = this.fixture;
    if (!fixture) return;
    if (this.polling || !this.selectedId || !this.connected) {
      this.schedule();
      return;
    }
    const revision = this.revision;
    this.polling = true;
    try {
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = await fixture.read({
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
        const before = this.timeline().length;
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
            receipt?.queued ||
            receipt?.accepted ||
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
        this.followTimeline(before);
        await this.updateComplete;
        if (!page.hasMore) break;
      }
    } catch (error) {
      if (revision === this.revision) {
        this.pollError = (error as Error).message;
        this.caughtUp = false;
      }
    } finally {
      this.polling = false;
      // Fixture previews drain on explicit events only; production observes the shared cache.
    }
  }

  private select(id: string, executionNodeId = 'local') {
    this.revision++;
    this.follow = NATIVE_FOLLOW_LATEST;
    this.selectedId = id;
    this.selectedNodeId = executionNodeId;
    this.responseAttempts = new Set();
    this.creating = !id;
    this.profile = undefined;
    this.profileReady = true;
    this.session = undefined;
    this.transcript = { events: [], cursor: 0 };
    this.historyScope = undefined;
    this.historyObservation = { status: 'loading' };
    this.receipts = [];
    this.requests = [];
    this.caughtUp = false;
    this.error = '';
    this.pollError = '';
    this.readUnavailableSince = undefined;
    this.busy = false;
    if (!this.worker) {
      safeLsSet(this.key('selected'), id);
      safeLsSet(this.key('selected-node'), executionNodeId);
    }
    this.loadLocal();
    this.schedule(0);
  }

  private async create(resume?: NativeSessionInfo) {
    if (
      this.worker ||
      !this.connected ||
      (resume && !this.historyCurrent) ||
      (!resume && !this.fixture && !this.catalogCurrent)
    )
      return;
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
          effort: this.executionPicker.toSelection().effort ?? undefined,
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
      !this.invalidDelivery &&
      !this.busy &&
      !this.localCommand &&
      ['idle', 'running', 'waiting'].includes(this.session?.state ?? '')
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

  private async sessionAction(
    method: typeof Methods.NATIVE_SESSION_INTERRUPT | typeof Methods.NATIVE_SESSION_CLOSE,
  ) {
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
      !this.requests.some(
        (current) =>
          current.request?.id === event.request?.id && current.generation === event.generation,
      ) ||
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
        refreshingHistory: isSupersededRead(this.historyObservation.error),
        busy: this.busy,
        workspace: this.workspace,
        workspaceAllowed: this.workspaceAllowed,
        taskHistory: this.taskHistory,
        fullscreen: this.fullscreen,
        toggleFullscreen: () => void this.toggleFullscreen(),
        requestCount: this.requests.length,
        sessionChoice: (item) => this.sessionChoice(item),
        select: (id, node = 'local') => {
          this.select(id, node);
          if (this.worker || this.fixture || parseHashRoute().route !== 'native') return;
          this.initialSessionId = id;
          this.initialExecutionNodeId = node;
          const params = hashParams();
          if (id) {
            params.set('sessionId', id);
            params.set('executionNodeId', node);
          } else {
            params.delete('sessionId');
            params.delete('executionNodeId');
          }
          history.replaceState(null, '', buildHash('native', params));
        },
        readError: this.pollError || this.inventoryError || this.catalogError,
        unavailableSince: this.readUnavailableSince,
        observedAt: this.historyObservation.observedAt,
        historyObservation: this.historyObservation,
        unsupported:
          this.historyObservation.status === 'unsupported' ||
          this.inventoryUnsupported ||
          this.catalogUnsupported,
        refresh: () => {
          const cache = getResourceCache();
          const owner = getResourceNativeOwnerId();
          if (!cache || !owner) return;
          const queries = this.historyQuery
            ? [this.historyQuery]
            : [
                nativeObservationQuery(Methods.NATIVE_SESSION_LIST, {}, owner),
                nativeObservationQuery(Methods.NATIVE_SESSION_CATALOG, {}, owner),
              ];
          void Promise.all(
            queries.filter((query) => cache.read(query).error).map((query) => cache.retry(query)),
          ).catch((cause) => {
            this.error = cause instanceof Error ? cause.message : String(cause);
          });
        },
        toggleWorkspace: () => {
          this.workspace = !this.workspace;
        },
      })}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
      ${this.worker && (this.taskHistory || (this.session && !this.workerControl))
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
            <review-dispatch-picker
              .viewModel=${this.executionPicker}
              .discover=${false}
              .disabled=${this.busy}
              @review-dispatch-change=${() => {
                this.mode = 'default';
                this.requestUpdate();
              }}
            ></review-dispatch-picker>
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
                (!this.fixture && !this.catalogCurrent) ||
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
                  <div
                    class="timeline"
                    aria-label="Agent conversation"
                    @scroll=${this.timelineScrolled}
                  >
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
                                    : html`<span class="body">${entry.text}</span>`}
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
                          <div class="text">
                            <span class="body">${this.localCommand.text}</span>
                          </div>
                        </article>`
                      : nothing}
                    ${!this.transcript.events.length
                      ? html`<p class="empty">
                          ${this.caughtUp ? 'Send a task to begin.' : 'Loading conversation…'}
                        </p>`
                      : nothing}
                    <div class="jump-anchor">${this.renderJumpLatest()}</div>
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
                        ${session.state === 'idle' ? 'Send' : 'Queue message'}
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
                            ?disabled=${!this.connected || !this.historyCurrent || this.busy}
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
