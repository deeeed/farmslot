import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  type ChatMessage,
  Methods,
  type NativeApprovalMode,
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
  type NativeSessionTargetParams,
  type NativeSessionTool,
  type NativeSessionTurnDiffResult,
  type NativeWorkerHistoryScope,
  viewListField,
  viewToggleMapField,
} from '@farmslot/protocol';
import {
  appendNativePage,
  NATIVE_FOLLOW_LATEST,
  nativeCommandLockSettled,
  nativeCommandText,
  type NativeConversationCache,
  nativeConversationOmissionNotice,
  type NativeConversationState,
  nativeDeliveryLabel,
  nativeEntryPreview,
  nativeFoldWatched,
  type NativeFollow,
  nativeFollowGrew,
  nativeFollowLabel,
  nativeFollowScrolled,
  nativeHistoryCanAct,
  nativeHistoryQuery,
  nativeImplementableKey,
  nativeImplementPrompt,
  nativeImplementSession,
  nativeMessageCancelable,
  nativeMessageDropped,
  type NativeMessagePreview,
  nativeMessagePreview,
  nativeMessageShown,
  nativeMessageToggleLabel,
  nativeObservationQuery,
  nativePlanCopyLabel,
  nativePlanOpen,
  nativePlanStepMark,
  nativeSendLabel,
  nativeSteerAvailable,
  nativeTimeline,
  type NativeTimelineEntry,
  type NativeTimelineRow,
  nativeTimelineRows,
  nativeToolDiffText,
  nativeToolDisclosureKey,
  type NativeTranscript,
  nativeWatchTools,
  type NativeWork,
  nativeWork,
  observeNativeConversation,
  type ResourceQuery,
  resourceQuery,
  SUPERSEDED_READ_GRACE_MS,
} from '@farmslot/protocol/client-cache';
import {
  catalogForNativeRunners,
  defaultModelForRunner,
  nativeLaunchChoices,
  nativeLaunchContextKey,
  nativeLaunchModel,
  nativeLaunchModelSelection,
  ReviewDispatchViewModel,
} from '@farmslot/review-dispatch';

import '../shared/review-dispatch-picker.js';
import './chat-message.js';
// Also registers <diff-review>, which shows a turn's file diffs.
import './native-workspace.js';
import './native-profiles.js';

import { gateway } from '../../gateway-client.js';
import { GatewayRequestTimeoutError } from '../../gateway-request-timeout.js';
import {
  getResourceCache,
  getResourceNativeOwnerId,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../../resource-cache.js';
import { getState, subscribe } from '../../state.js';
import { copyTextToClipboard } from '../../utils/clipboard.js';
import { safeLsGet, safeLsRemove, safeLsSet } from '../../utils/storage.js';
import { buildHash, hashParams, navigateHash, parseHashRoute } from '../../utils/url-state.js';
import { browserViewState, viewBinding, ViewStateBindings } from '../../utils/view-state.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';
import { readStored } from '../shared/read-current.js';
import { heldDataIsSaved, isSupersededRead } from '../shared/resource-query-controller.js';

import { draftWithContext, takeNativeChatContext } from './native-chat-context.js';
import type { NativeProfileSelection } from './native-profiles.js';
import { renderNativeSessionHeader } from './native-session-header.js';
import {
  observeNativeConversationResource,
  observeNativeResource,
} from './native-session-observation.js';
import { renderNativeSessionRequest } from './native-session-request.js';
import { nativeSessionStyles } from './native-session-styles.js';
import {
  assertNativeWorkerViewPage,
  nativeWorkerAttemptKey,
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
  /** A preview that streams: history then follows this conversation cache instead of `read`. */
  conversations?: NativeConversationCache;
}

function timelineDistance(timeline: Element) {
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
}

const disclosureFields = {
  messages: viewListField('messages'),
  files: viewListField('turnFiles'),
  folds: viewToggleMapField('folds'),
};
function restoredFolds(values: Readonly<Record<string, boolean>>) {
  return new Map(
    Object.entries(values).flatMap(([key, open]) => {
      const value = Number(key);
      return Number.isSafeInteger(value) && value >= 0 ? [[value, open] as const] : [];
    }),
  );
}

@customElement('native-session-view')
export class NativeSessionView extends LitElement {
  @property({ attribute: false }) api: NativeSessionApi = gateway;
  /** Fixture reads are supplied before connection; production always follows gateway authentication. */
  @property({ attribute: false }) fixture?: NativeSessionFixture;
  @property({ attribute: false }) worker?: NativeWorkerViewTarget;
  /** A configured singleton uses this launch policy, with the same composer and receipts. */
  @property({ attribute: false }) ensureSession?: () => Promise<NativeSessionInfo>;
  @property({ type: Boolean }) fixedTarget = false;
  @property() initialSessionId = '';
  @property() navigationRoute: 'native' | 'terminal' | 'copilot' = 'native';
  @property() initialExecutionNodeId = '';
  private catalogCurrent = false;
  private creatingAttempt?: { token: symbol; target?: string };
  private recoveredFirstPrompt?: {
    sessionId: string;
    text: string;
    previous: string;
    visible: string;
  };
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
    return (
      this.executionPicker.selection!.model ??
      defaultModelForRunner(this.runner, this.executionPicker.catalog) ??
      ''
    );
  }
  private set model(value: string) {
    this.executionPicker.setModel(this.executionPicker.rows[0].id, value || null);
    this.requestUpdate();
  }
  @state() private mode: 'default' | 'plan' = 'default';
  @state() private approvalMode: NativeApprovalMode = 'ask';
  @state() private cwd = '';
  @state() private customCwd = false;
  @state() private prompt = '';
  private launchUrlRestored = false;
  private globalStop?: () => void;
  private get launchChoices() {
    return this.catalog
      ? nativeLaunchChoices(this.catalog, getState().globalFilters, getState().fleet?.slots ?? [])
      : [];
  }
  private get launchSelectionKey() {
    const key = this.customCwd
      ? `custom:${this.executionNodeId}`
      : nativeLaunchContextKey({ cwd: this.cwd, executionNodeId: this.executionNodeId });
    return this.launchChoices.some((choice) => choice.key === key) ? key : '';
  }
  private get defaultLaunchChoice() {
    return this.launchChoices.find(
      (choice) =>
        !choice.unavailableReason &&
        (!this.initialExecutionNodeId || choice.executionNodeId === this.initialExecutionNodeId),
    );
  }
  private get launchReady() {
    return (
      !!this.cwd.trim() &&
      this.launchChoices.some(
        (choice) =>
          choice.executionNodeId === this.executionNodeId &&
          !choice.unavailableReason &&
          (this.customCwd
            ? choice.kind === 'custom'
            : choice.kind === 'workspace' && choice.cwd === this.cwd),
      )
    );
  }
  private chooseLaunch(value: string) {
    const previousNode = this.executionNodeId;
    const choice = this.launchChoices.find((entry) => entry.key === value);
    if (!choice || choice.unavailableReason) return;
    this.customCwd = choice.kind === 'custom';
    this.executionNodeId = choice.executionNodeId;
    this.cwd = choice.cwd;
    this.error = '';
    if (previousNode !== this.executionNodeId) {
      this.profile = undefined;
      this.profileReady = true;
      this.profileNodeId = this.executionNodeId;
    }
    this.syncLaunchUrl();
  }
  private syncLaunchUrl() {
    if (
      this.worker ||
      this.selectedId ||
      this.fixture ||
      parseHashRoute().route !== this.navigationRoute
    )
      return;
    const params = hashParams();
    params.set('cwd', this.cwd);
    params.set('executionNodeId', this.executionNodeId);
    params.set('custom', String(this.customCwd));
    params.set('runner', this.runner);
    params.set('model', this.model);
    params.set('mode', this.mode);
    if (this.approvalMode === 'bypass') params.set('approvalMode', 'bypass');
    else params.delete('approvalMode');
    const effort = this.executionPicker.toSelection().effort;
    if (effort) params.set('effort', effort);
    else params.delete('effort');
    navigateHash(buildHash(this.navigationRoute, params), 'replace');
  }
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
  @state() private inventoryErrorCode?: string;
  @state() private catalogError = '';
  @state() private catalogErrorCode?: string;
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
  private historyTarget?: NativeSessionTargetParams;
  @state() private historyObservation: NativeConversationState = {
    status: 'loading',
  };
  private timelineEvents?: NativeSessionEvent[];
  private timelineEntries: ReturnType<typeof nativeTimeline> = [];
  /** Expanded message/command and tool keys, shared with the URL display-choice owner. */
  @state() private expandedMessages = new Set<string>();
  /** The proposed plan last copied, by entry key, and whether the copy worked. */
  @state() private planCopy?: { key: number; copied: boolean };
  /** Turn file diffs fetched, by `sequence:path`; a diff never changes, so each is fetched once. */
  @state() private turnDiffs = new Map<string, { diff?: string; error?: string }>();
  /** Turn files whose diff is open, by `sequence:path`. */
  @state() private openTurnFiles = new Set<string>();
  // A turn's changed files hide tests like every diff list. Native sessions carry no project,
  // so the default test globs apply.
  private readonly testFilter = new DiffTestFilterController(this);
  @state() private follow: NativeFollow = NATIVE_FOLLOW_LATEST;
  /** The selection the timeline DOM was last rendered for. */
  private renderedRevision = -1;

  private workEvents?: NativeSessionEvent[];
  private workState?: NativeWork;

  private timeline() {
    if (this.timelineEvents !== this.transcript.events) {
      this.timelineEvents = this.transcript.events;
      this.timelineEntries = nativeTimeline(this.transcript.events);
    }
    return this.timelineEntries;
  }

  /** The proposal Implement is offered on in this render (`nativeImplementableKey`). */
  private implementKey?: number;
  private rowsEntries?: NativeTimelineEntry[];
  private rows: NativeTimelineRow[] = [];
  private folds = new Map<number, Extract<NativeTimelineRow, { kind: 'work' }>>();
  private watchedTools = new Set<number>();
  /** Folds the reader opened or closed, by the key of the entry that ended the turn. */
  @state() private foldOpen = new Map<number, boolean>();

  private timelineRows() {
    const entries = this.timeline();
    if (this.rowsEntries !== entries) {
      this.rowsEntries = entries;
      this.rows = nativeTimelineRows(entries);
      this.folds = new Map(
        this.rows.flatMap((row) => (row.kind === 'work' ? [[row.key, row] as const] : [])),
      );
    }
    nativeWatchTools(
      this.rows,
      this.watchedTools,
      Boolean(this.fixture) || this.historyObservation.status === 'ready',
    );
    return this.rows;
  }

  private foldIsOpen(key: number) {
    const fold = this.folds.get(key);
    return this.foldOpen.get(key) ?? (fold ? nativeFoldWatched(fold, this.watchedTools) : true);
  }

  private work() {
    if (this.workEvents !== this.transcript.events) {
      this.workEvents = this.transcript.events;
      this.workState = nativeWork(this.transcript.events);
    }
    return this.workState;
  }

  private readonly displayChoices = new ViewStateBindings(this, [
    viewBinding(
      disclosureFields.folds,
      () => Object.fromEntries(this.foldOpen),
      (values) => {
        this.foldOpen = restoredFolds(values);
      },
    ),
    viewBinding(
      disclosureFields.messages,
      () => [...this.expandedMessages],
      (value) => {
        this.expandedMessages = new Set(value);
      },
    ),
    viewBinding(
      disclosureFields.files,
      () => [...this.openTurnFiles],
      (value) => {
        this.openTurnFiles = new Set(value);
      },
    ),
  ]);

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

  protected override updated(changed: PropertyValues): void {
    try {
      this.renderedRevision = this.revision;
      if (
        !this.fixture &&
        parseHashRoute().route === this.navigationRoute &&
        !this.worker &&
        !this.selectedId &&
        this.catalog &&
        !this.launchUrlRestored
      ) {
        this.launchUrlRestored = true;
        const params = hashParams();
        const requestedRunner = params.get('runner');
        if (
          requestedRunner &&
          this.catalog.runners.some((entry) => entry.runner === requestedRunner)
        )
          this.runner = requestedRunner;
        const requestedModel = params.get('model');
        const runner = this.executionPicker.catalog.runners.find(
          (entry) => entry.id === this.runner,
        );
        if (requestedModel) this.model = nativeLaunchModel(runner, requestedModel);
        this.mode = params.get('mode') === 'plan' ? 'plan' : 'default';
        this.approvalMode = params.get('approvalMode') === 'bypass' ? 'bypass' : 'ask';
        const effort = params.get('effort');
        const row = this.executionPicker.rows[0];
        if (effort && row && runner?.efforts.includes(effort))
          this.executionPicker.setEffort(row.id, effort);
      }

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
      if (
        (changed.has('profile') || changed.has('catalog') || changed.has('executionNodeId')) &&
        this.catalog
      ) {
        this.executionPicker.setCatalog(
          catalogForNativeRunners(
            this.catalog.runners.filter(
              (runner) => !this.profile || runner.runner === this.profile.runner,
            ),
            undefined,
            this.executionNodeId,
          ),
        );
        // Another node may not list the previous model or saved global default.
        const row = this.executionPicker.rows[0];
        if (
          changed.has('executionNodeId') &&
          row?.selection.model &&
          !nativeLaunchModelSelection(
            this.executionPicker.catalog.runners.find(
              (option) => option.id === row.selection.runner,
            ),
            row.selection.model,
            true,
          )
        ) {
          const runner = this.executionPicker.catalog.runners.find(
            (option) => option.id === row.selection.runner,
          );
          this.executionPicker.setModel(row.id, runner?.defaultModel ?? null);
        }
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
    } finally {
      this.dispatchEvent(
        new CustomEvent('native-command-readiness', { bubbles: true, composed: true }),
      );
    }
  }

  private get workerControl() {
    if (this.historyScope?.released) return undefined;
    return this.worker ? nativeWorkerViewControl(this.worker, this.session) : undefined;
  }

  private get inputAllowed() {
    return (
      this.historyCurrent &&
      !this.session?.approvalModePending &&
      (!this.worker || Boolean(this.workerControl))
    );
  }

  private get historyCurrent() {
    if (this.fixture) return this.caughtUp;
    const state = this.historyObservation;
    return (
      nativeHistoryCanAct(state, this.historyObservation.data, this.connected) &&
      state?.data?.session === this.session
    );
  }

  private observeHistory() {
    this.historyStop?.();
    this.historyStop = undefined;
    this.historyQuery = undefined;
    this.historyTarget = undefined;
    const conversations = this.fixture?.conversations;
    if (!this.selectedId || (this.fixture && !conversations)) return;
    const owner = conversations ? undefined : getResourceNativeOwnerId();
    if (!conversations && !owner) return;
    const revision = this.revision;
    const target: NativeSessionTargetParams = {
      sessionId: this.selectedId,
      executionNodeId: this.selectedNodeId,
      ...(this.worker ? { worker: nativeWorkerViewPin(this.worker) } : {}),
    };
    this.historyTarget = target;
    if (owner) this.historyQuery = nativeHistoryQuery(target, owner);
    const changed = (state: NativeConversationState) => {
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
        )
          this.releaseLocalCommand(receipt);
      }
      this.followTimeline(before);
    };
    this.historyStop = conversations
      ? observeNativeConversation({ conversations }, target, changed)
      : observeNativeConversationResource(target, changed);
  }

  /** Releases the sent message; one the host failed without submitting goes back to the composer. */
  private releaseLocalCommand(receipt?: NativeCommandReceipt) {
    const text = this.localCommand?.text;
    safeLsRemove(this.sessionKey(`command:${this.selectedId}`));
    this.localCommand = undefined;
    if (!text || !nativeMessageDropped(receipt)) return;
    this.draft = [text, this.draft.trim()].filter(Boolean).join('\n\n');
    safeLsSet(this.sessionKey(`draft:${this.selectedId}`), this.draft);
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

  private renderEntry(
    entry: NativeTimelineEntry,
    session: NativeSessionInfo,
    hidden = false,
    planOpen = true,
  ) {
    const proposal = entry.event.plan?.kind === 'proposal';
    return html`<article
      class="${entry.kind}${proposal ? ' proposal' : ''}"
      data-sequence=${entry.key}
      ?hidden=${hidden}
    >
      ${entry.kind === 'tool'
        ? html`<details
            .open=${this.expandedMessages.has(nativeToolDisclosureKey(entry.key))}
            @toggle=${(event: Event) => {
              const details = event.currentTarget as HTMLDetailsElement;
              const key = nativeToolDisclosureKey(entry.key);
              if (details.open === this.expandedMessages.has(key)) return;
              const next = new Set(this.expandedMessages);
              if (details.open) next.add(key);
              else next.delete(key);
              this.expandedMessages = next;
            }}
          >
            <summary>
              ${entry.text} ·
              ${entry.event.type === 'tool.started'
                ? 'Started'
                : (entry.event.tool?.status ?? 'Finished')}
            </summary>
            ${this.expandedMessages.has(nativeToolDisclosureKey(entry.key))
              ? this.renderToolBody(entry.event.tool)
              : nothing}
          </details>`
        : entry.kind === 'plan'
          ? this.renderPlan(entry, planOpen)
          : entry.kind === 'changes'
            ? this.renderTurnChanges(entry)
            : html`<span class="meta"
                  >${entry.kind === 'user'
                    ? 'You'
                    : entry.kind === 'assistant'
                      ? session.runner
                      : entry.event.at}</span
                >
                <div class="text">
                  ${entry.kind === 'assistant'
                    ? this.renderMarkdown(entry, entry.text)
                    : this.renderMessageBody(
                        entry.text,
                        nativeEntryPreview(entry),
                        entry.event.commandId ?? String(entry.key),
                      )}
                </div>
                ${entry.event.type === 'error' && entry.event.data
                  ? html`<details>
                      <summary>Error details</summary>
                      <pre>${JSON.stringify(entry.event.data, null, 2)}</pre>
                    </details>`
                  : nothing}`}
    </article>`;
  }

  private renderMarkdown(entry: NativeTimelineEntry, content: string) {
    return html`<chat-message
      .message=${{
        id: `${entry.event.sessionId}:${entry.key}`,
        role: 'assistant',
        content,
        timestamp: entry.event.at,
      } satisfies ChatMessage}
    ></chat-message>`;
  }

  /**
   * A checklist shows its steps while its turn runs, then folds to its progress unless the reader
   * watched it run. A proposed plan is a card: markdown, collapsed when long, with a copy action.
   */
  private renderPlan(entry: NativeTimelineEntry, open: boolean) {
    const plan = entry.event.plan!;
    if (plan.kind === 'checklist')
      return html`<details ?open=${open}>
        <summary>Plan · ${entry.text}</summary>
        ${plan.text
          ? html`<div class="text"><span class="body">${plan.text}</span></div>`
          : nothing}
        <ol class="plan-steps">
          ${plan.steps.map(
            (step) =>
              html`<li class=${step.status} data-mark=${nativePlanStepMark(step.status)}>
                ${step.text}
              </li>`,
          )}
        </ol>
      </details>`;
    const copied = this.planCopy?.key === entry.key ? this.planCopy.copied : undefined;
    return html`<span class="meta">Proposed plan</span>
      <div class="text">
        ${this.renderMessageBody(
          entry.text,
          nativeEntryPreview(entry),
          `plan:${entry.key}`,
          (text) => this.renderMarkdown(entry, text),
        )}
      </div>
      <button
        class="plan-copy"
        data-testid="native-plan-copy"
        @click=${() =>
          copyTextToClipboard(plan.text).then(
            () => (this.planCopy = { key: entry.key, copied: true }),
            () => (this.planCopy = { key: entry.key, copied: false }),
          )}
      >
        ${nativePlanCopyLabel(copied)}
      </button>
      ${this.implementKey === entry.key
        ? html`<button
            class="plan-copy"
            data-testid="native-plan-implement"
            ?disabled=${this.busy || !this.connected}
            @click=${() => void this.implement(plan.text)}
          >
            Implement
          </button>`
        : nothing}`;
  }

  /** What a turn changed in the working tree; each file opens its diff between the turn's checkpoints. */
  private renderTurnChanges(entry: NativeTimelineEntry) {
    const changes = entry.event.changes!;
    if (!changes.files.length) return html`<span class="meta">${entry.text}</span>`;
    const split = this.testFilter.split(
      changes.files.map((file) => ({
        file,
        path: file.path,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      })),
    );
    return html`<details>
      <summary>${entry.text}</summary>
      ${this.testFilter.renderControls(split.summary)}
      <ul class="turn-files">
        ${split.visible.map(({ file }) => {
          const key = `${entry.event.sequence}:${file.path}`;
          const opened = this.openTurnFiles.has(key);
          const fetched = this.turnDiffs.get(key);
          return html`<li>
            <button
              class="turn-file"
              data-testid="native-turn-file"
              aria-expanded=${opened ? 'true' : 'false'}
              @click=${(event: Event) =>
                void this.toggleInPlace(event.currentTarget, opened, () =>
                  this.toggleTurnDiff(entry.event.sequence, file.path),
                )}
            >
              ${file.status === 'added'
                ? 'Added'
                : file.status === 'deleted'
                  ? 'Deleted'
                  : 'Changed'}
              ${file.path}
              ${file.additions === undefined
                ? nothing
                : html`<span class="meta">+${file.additions} −${file.deletions}</span>`}
            </button>
            ${!opened
              ? nothing
              : fetched?.diff
                ? html`<diff-review .filename=${file.path} .diff=${fetched.diff}></diff-review>`
                : html`<p class="meta">
                    ${fetched?.error ??
                    (fetched?.diff === ''
                      ? 'No text changes (a binary or mode change).'
                      : 'Loading…')}
                  </p>`}
          </li>`;
        })}
      </ul>
    </details>`;
  }

  private toggleTurnDiff(sequence: number, path: string) {
    const key = `${sequence}:${path}`;
    const open = new Set(this.openTurnFiles);
    if (open.delete(key)) {
      this.openTurnFiles = open;
      return;
    }
    this.openTurnFiles = open.add(key);
    const session = this.session;
    // A fetched or pending diff is kept; a failed fetch is tried again when the file is reopened.
    const known = this.turnDiffs.get(key);
    if (!session || (known && !known.error)) return;
    const revision = this.revision;
    const settle = (value: { diff?: string; error?: string }) => {
      if (revision === this.revision) this.turnDiffs = new Map(this.turnDiffs).set(key, value);
    };
    this.turnDiffs = new Map(this.turnDiffs).set(key, {});
    const applyStored = (result: NativeSessionTurnDiffResult) => settle({ diff: result.diff });
    readStored<NativeSessionTurnDiffResult>(
      resourceQuery<NativeSessionTurnDiffResult>(Methods.NATIVE_SESSION_TURN_DIFF, {
        sessionId: session.id,
        executionNodeId: session.executionNodeId,
        sequence,
        path,
        ...(this.worker ? { worker: this.workerControl } : {}),
      }),
      applyStored,
    ).then(applyStored, (error: unknown) => settle({ error: (error as Error).message }));
  }

  /** A command shows what it ran and its last lines, its raw input and output one tap away. */
  private renderToolBody(tool: NativeSessionTool | undefined) {
    const raw = html`<pre>
${JSON.stringify(
        {
          ...(tool?.input !== undefined ? { input: tool.input } : {}),
          ...(tool?.output !== undefined ? { output: tool.output } : {}),
        },
        null,
        2,
      )}</pre
    >`;
    const command = nativeCommandText(tool);
    const diffs = this.testFilter.split(
      (tool?.diffs ?? []).map((diff) => ({ diff, path: diff.path, additions: 0, deletions: 0 })),
    );
    const changes = tool?.diffs?.length
      ? html`<section data-testid="native-tool-diffs">
          ${this.testFilter.renderControls(diffs.summary)}
          ${diffs.visible.map(
            ({ diff }) =>
              html`<diff-review
                .filename=${diff.path}
                .diff=${nativeToolDiffText(diff)}
                .newFile=${diff.oldText === null}
              ></diff-review>`,
          )}
        </section>`
      : nothing;
    return command
      ? html`<pre>${command}</pre>
          ${changes}
          <details>
            <summary>Raw input and output</summary>
            ${raw}
          </details>`
      : html`${changes}${raw}`;
  }

  /** `full` renders the whole text; a collapsed preview is always plain text. */
  private renderMessageBody(
    text: string,
    preview: NativeMessagePreview | undefined,
    key: string,
    full: (text: string) => unknown = (body) => html`<span class="body">${body}</span>`,
  ) {
    if (!preview) return full(text);
    const expanded = this.expandedMessages.has(key);
    return html`${expanded ? full(text) : html`<span class="body">${preview.text}</span>`}
      <button
        class="message-toggle"
        data-testid="native-message-toggle"
        aria-expanded=${expanded ? 'true' : 'false'}
        @click=${(event: Event) => {
          const toggle = () => {
            const next = new Set(this.expandedMessages);
            if (!next.delete(key)) next.add(key);
            this.expandedMessages = next;
          };
          void this.toggleInPlace(event.currentTarget, expanded, toggle);
        }}
      >
        ${nativeMessageToggleLabel(preview, expanded)}
      </button>`;
  }

  /**
   * Collapsing shrinks the content above its toggle; keep the toggle where the reader saw it.
   * At the top of the timeline there may not be enough content above to scroll back by: the
   * toggle then moves up only by the space that doesn't exist, and stays in view. Expanding
   * keeps the default, so the reader reads on from where the preview stopped.
   */
  private async toggleInPlace(target: EventTarget | null, collapsing: boolean, toggle: () => void) {
    const timeline = this.renderRoot.querySelector('.timeline');
    if (!collapsing || !(target instanceof Element) || !timeline) return toggle();
    const before = target.getBoundingClientRect().top;
    toggle();
    await this.updateComplete;
    if (target.isConnected) timeline.scrollTop += target.getBoundingClientRect().top - before;
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
    this.globalStop = subscribe(() => this.requestUpdate());
    const params = hashParams();
    if (this.initialExecutionNodeId) this.executionNodeId = this.initialExecutionNodeId;
    if (params.has('cwd')) {
      this.cwd = params.get('cwd') ?? '';
      this.executionNodeId = params.get('executionNodeId') ?? 'local';
      this.customCwd = params.get('custom') === 'true';
    }
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
    this.globalStop?.();
    this.unsubscribe?.();
    this.historyStop?.();
    this.ownerStop?.();
    this.inventoryStops.forEach((stop) => stop());
    this.inventoryStops = [];
  }

  private key(suffix: string) {
    return `${this.fixedTarget ? 'farmslot-copilot' : 'farmslot-native'}:${this.storageScope}:${suffix}`;
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

  private async connect() {
    const scope = this.fixture ? 'fixture' : (getResourceWorkspaceKey() ?? '');
    if (scope !== this.storageScope) {
      this.storageScope = scope;
      this.creatingAttempt = undefined;
      this.recoveredFirstPrompt = undefined;
      this.busy = false;
      this.readUnavailableSince = undefined;
      this.inventoryCurrent = false;
      this.inventoryUnsupported = false;
      this.catalogUnsupported = false;
      this.revision++;
      this.selectedId = this.fixture
        ? (safeLsGet(this.key('selected')) ?? '')
        : this.initialSessionId;
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
    if (this.fixedTarget) {
      if (this.selectedId !== this.initialSessionId)
        this.select(this.initialSessionId, this.initialExecutionNodeId || 'local');
      if (!this.selectedId) this.creating = true;
      this.observeHistory();
      return;
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
    if (!this.selectedId) this.prompt = safeLsGet(this.key('new-prompt')) ?? '';
    // Terminal text the reader added to this conversation before it opened: taken only once the
    // view reads the worker's own session (connect() first loads the standalone selection).
    const context =
      this.worker &&
      this.selectedId === this.worker.binding.sessionId &&
      this.selectedNodeId === this.worker.binding.executionNodeId &&
      takeNativeChatContext(nativeWorkerAttemptKey(this.worker));
    if (context) {
      this.draft = draftWithContext(this.draft, context);
      safeLsSet(this.sessionKey(`draft:${this.selectedId}`), this.draft);
    }
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
    if (this.fixedTarget && this.selectedId && !this.localCommand) {
      const pending = safeLsGet(this.key('new-prompt'));
      if (pending) {
        const previous = this.draft;
        this.draft = previous ? `${previous}\n\n${pending}` : pending;
        this.recoveredFirstPrompt = {
          sessionId: this.selectedId,
          text: pending,
          previous,
          visible: this.draft,
        };
        this.prompt = '';
        if (safeLsSet(this.sessionKey(`draft:${this.selectedId}`), this.draft))
          safeLsRemove(this.key('new-prompt'));
      }
    }
  }

  private async refreshSessions() {
    if (this.fixedTarget) {
      this.observeHistory();
      return;
    }
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
            this.inventoryErrorCode = state.error?.code;
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
            this.catalogErrorCode = state.error?.code;
            this.catalog = state.data;
            this.catalogCurrent = state.status === 'ready';
            if (this.catalog && !this.selectedId) this.creating = true;
            if (this.catalog)
              this.executionPicker.setCatalog(
                catalogForNativeRunners(this.catalog.runners, undefined, this.executionNodeId),
              );
            if (!this.cwd && !this.customCwd && this.catalog) {
              const choice = this.defaultLaunchChoice;
              if (choice) this.chooseLaunch(choice.key);
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
          this.executionPicker.setCatalog(
            catalogForNativeRunners(catalog.runners, undefined, this.executionNodeId),
          );
          this.error = 'Open this task conversation from its run.';
          return;
        }
      }
      this.unavailableNodes = result.unavailableExecutionNodes ?? [];
      this.executionPicker.setCatalog(
        catalogForNativeRunners(catalog.runners, undefined, this.executionNodeId),
      );
      if (!catalog.runners.some((option) => option.runner === this.runner)) {
        this.runner = catalog.runners[0]?.runner ?? '';
        this.model = catalog.runners[0]?.defaultModel ?? '';
      }
      if (!this.cwd && !this.customCwd) {
        const choice = this.defaultLaunchChoice;
        if (choice) this.chooseLaunch(choice.key);
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
    if (!this.fixture || this.fixture.conversations) {
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
          )
            this.releaseLocalCommand(receipt);
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

  /** Selects a session and keeps it in the page address, so a refresh reopens it. */
  private selectRouted(id: string, executionNodeId = 'local') {
    this.select(id, executionNodeId);
    if (this.worker || this.fixture || parseHashRoute().route !== this.navigationRoute) return;
    this.initialSessionId = id;
    this.initialExecutionNodeId = id ? executionNodeId : this.executionNodeId;
    const params = hashParams();
    if (id) {
      params.set('sessionId', id);
      params.set('executionNodeId', executionNodeId);
    } else {
      params.delete('sessionId');
      params.set('executionNodeId', this.executionNodeId);
    }
    navigateHash(buildHash(this.navigationRoute, params), 'replace');
  }

  private select(id: string, executionNodeId = 'local') {
    this.revision++;
    const params = typeof location === 'undefined' ? new URLSearchParams() : hashParams();
    const addressed =
      Boolean(this.worker) ||
      (params.get('sessionId') === id &&
        (params.get('executionNodeId') || 'local') === executionNodeId);
    this.expandedMessages = new Set(
      addressed ? browserViewState.get(disclosureFields.messages) : [],
    );
    this.planCopy = undefined;
    this.turnDiffs = new Map();
    this.openTurnFiles = new Set(addressed ? browserViewState.get(disclosureFields.files) : []);
    this.watchedTools = new Set();
    this.foldOpen = addressed
      ? restoredFolds(browserViewState.get(disclosureFields.folds))
      : new Map();
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
    if (this.fixedTarget && this.creatingAttempt && id) {
      this.creatingAttempt.target ??= id;
      if (this.creatingAttempt.target !== id) this.creatingAttempt = undefined;
    }
    this.busy = this.fixedTarget && Boolean(this.creatingAttempt);
    if (!this.worker) {
      safeLsSet(this.key('selected'), id);
      safeLsSet(this.key('selected-node'), executionNodeId);
    }
    this.loadLocal();
    if (this.fixedTarget && parseHashRoute().route === 'copilot') {
      const params = hashParams();
      if (id) {
        params.set('sessionId', id);
        params.set('executionNodeId', executionNodeId);
      } else {
        params.delete('sessionId');
        params.delete('executionNodeId');
      }
      navigateHash(buildHash('copilot', params), 'replace');
    }
    this.schedule(0);
  }

  private async setApprovalMode(approvalMode: NativeApprovalMode) {
    const session = this.session;
    if (!session || this.worker || this.busy || !this.historyCurrent || session.state !== 'idle')
      return;
    this.busy = true;
    this.error = '';
    const revision = this.revision;
    try {
      const result = await this.api.request<{ session: NativeSessionInfo }>(
        Methods.NATIVE_SESSION_SET_APPROVAL_MODE,
        { sessionId: session.id, executionNodeId: session.executionNodeId, approvalMode },
      );
      if (revision !== this.revision) return;
      this.session = result.session;
      this.schedule(0);
    } catch (error) {
      if (revision === this.revision) this.error = (error as Error).message;
    } finally {
      if (revision === this.revision) this.busy = false;
    }
  }

  private renderApprovalMode(session?: NativeSessionInfo) {
    if (this.fixedTarget)
      return html`<span class="meta">Tool policy follows the Co-Pilot launch confirmation.</span>`;
    if (this.worker) return nothing;
    const pending = session?.approvalModePending;
    const selected = pending ?? session?.approvalMode ?? this.approvalMode;
    return html`<label
        >Tool approvals<choice-picker
          overlay
          data-testid="native-approval-mode"
          .value=${live(selected)}
          ?disabled=${this.busy ||
          (session &&
            (!this.historyCurrent ||
              session.state !== 'idle' ||
              !session.capabilities.approvalModes))}
          @change=${(event: Event) => {
            const mode: NativeApprovalMode =
              (event.target as HTMLElement & { value: string }).value === 'bypass'
                ? 'bypass'
                : 'ask';
            if (session) void this.setApprovalMode(mode);
            else {
              this.approvalMode = mode;
              this.syncLaunchUrl();
            }
          }}
        >
          <option value="ask">Ask</option>
          <option value="bypass">Bypass / yolo</option>
        </choice-picker></label
      >
      ${session && pending
        ? html`<span class="meta">Approval change unconfirmed. Retry before sending.</span>
            <button
              data-testid="native-approval-retry"
              ?disabled=${this.busy || !this.historyCurrent || session.state !== 'idle'}
              @click=${() => void this.setApprovalMode(pending)}
            >
              Retry approval change
            </button>`
        : nothing}
      ${session && !session.capabilities.approvals
        ? html`<span class="meta">This runner's native tools do not request approval.</span>`
        : nothing}`;
  }

  private async create(resume?: NativeSessionInfo) {
    if (this.busy) return;
    const firstPrompt = resume ? '' : this.prompt.trim();
    if (this.fixedTarget && resume) return;
    if (!resume && (!firstPrompt || (!this.ensureSession && !this.launchReady))) return;
    if (
      this.worker ||
      !this.connected ||
      (resume && !this.historyCurrent) ||
      (!resume && !this.ensureSession && !this.fixture && !this.catalogCurrent)
    )
      return;
    if (
      !resume &&
      !this.ensureSession &&
      (!this.profileReady || (this.profile && this.profileNodeId !== this.executionNodeId))
    ) {
      this.error = 'Select a ready account profile for this node';
      return;
    }
    const target = this.catalog?.executionNodes?.find(
      (node) => node.executionNodeId === this.executionNodeId,
    );
    if (!resume && target?.unavailableReason) {
      this.error = target.unavailableReason;
      return;
    }
    const attempt = { token: Symbol('native first-message intent') };
    this.creatingAttempt = attempt;
    this.busy = true;
    this.error = '';
    let revision = this.revision;
    const creatingScope = this.storageScope;
    const creatingConnection = this.fixture ? undefined : gateway.resourceConnectionId;
    const params: NativeSessionCreateParams = resume
      ? {
          executionNodeId: resume.executionNodeId,
          runner: resume.runner,
          model: resume.model,
          mode: resume.mode,
          approvalMode: resume.approvalMode ?? 'ask',
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
          approvalMode: this.approvalMode,
          cwd: this.cwd,
          ...(this.profile
            ? { profileId: this.profile.id, accountContextId: this.profile.accountContextId }
            : {}),
        };
    try {
      const result = this.ensureSession
        ? { session: await this.ensureSession() }
        : await this.api.request<{ session: NativeSessionInfo }>(
            Methods.NATIVE_SESSION_CREATE,
            params,
          );
      if (
        !this.isConnected ||
        creatingScope !== this.storageScope ||
        (!this.fixture && creatingConnection !== gateway.resourceConnectionId)
      )
        return;
      // The singleton's status may bind this exact target before ensure's continuation.
      // That is the same creation, not permission to replay into another view or account.
      if (
        revision !== this.revision &&
        !(
          this.fixedTarget &&
          this.selectedId === result.session.id &&
          this.selectedNodeId === result.session.executionNodeId
        )
      )
        return;
      if (this.fixedTarget) this.select(result.session.id, result.session.executionNodeId);
      else this.selectRouted(result.session.id, result.session.executionNodeId);
      revision = this.revision;
      this.session = result.session;
      this.busy = true;
      if (firstPrompt) {
        const command: LocalCommand = {
          sessionId: result.session.id,
          executionNodeId: result.session.executionNodeId,
          generation: result.session.generation,
          commandId: crypto.randomUUID(),
          text: firstPrompt,
        };
        if (!safeLsSet(this.sessionKey(`command:${command.sessionId}`), JSON.stringify(command))) {
          this.draft = firstPrompt;
          this.error =
            'The session started. Browser storage is unavailable; send the prompt from this conversation.';
          return;
        }
        this.localCommand = command;
        const recovered = this.recoveredFirstPrompt;
        if (
          recovered?.sessionId === command.sessionId &&
          recovered.text === firstPrompt &&
          this.draft === recovered.visible
        ) {
          this.draft = recovered.previous;
          if (this.draft) safeLsSet(this.sessionKey(`draft:${command.sessionId}`), this.draft);
          else safeLsRemove(this.sessionKey(`draft:${command.sessionId}`));
          this.recoveredFirstPrompt = undefined;
        }
        this.prompt = '';
        safeLsRemove(this.key('new-prompt'));
        await this.deliver(command);
      }
      await this.refreshSessions();
    } catch (cause) {
      if (
        this.creatingAttempt === attempt &&
        this.isConnected &&
        creatingScope === this.storageScope &&
        (this.fixture || creatingConnection === gateway.resourceConnectionId)
      ) {
        revision = this.revision;
        this.error =
          cause instanceof GatewayRequestTimeoutError || !(cause instanceof Error)
            ? 'Session start was not confirmed. Check Sessions before trying again.'
            : cause.message;
      }
    } finally {
      if (this.creatingAttempt === attempt) {
        this.creatingAttempt = undefined;
        if (revision === this.revision) this.busy = false;
      }
    }
  }

  /** Move only unsent composer text when the operator changes launch targets. */
  public takeUnsentDraft(): string {
    const text = this.selectedId ? this.draft : this.prompt;
    if (this.selectedId) {
      this.draft = '';
      safeLsRemove(this.sessionKey(`draft:${this.selectedId}`));
    } else {
      this.prompt = '';
      safeLsRemove(this.key('new-prompt'));
    }
    return text;
  }
  public prepareUnsentDraft(text: string): void {
    if (!text) return;
    if (this.selectedId) {
      this.draft = text;
      safeLsSet(this.sessionKey(`draft:${this.selectedId}`), text);
    } else {
      this.prompt = text;
      safeLsSet(this.key('new-prompt'), text);
    }
  }

  /** Explicit caller intent, through the same persisted command path as the composer. */
  public get canSubmitPrompt(): boolean {
    return this.selectedId
      ? Boolean(this.session && this.canSend)
      : Boolean(this.connected && !this.busy && (this.ensureSession || this.launchReady));
  }

  public async submitPrompt(text: string): Promise<void> {
    if (!text.trim()) return;
    if (this.session && this.selectedId) {
      this.draft = text;
      safeLsSet(this.sessionKey(`draft:${this.selectedId}`), text);
      await this.send();
    } else {
      this.prompt = text;
      safeLsSet(this.key('new-prompt'), text);
      await this.create();
    }
  }

  private get canSend() {
    return (
      this.connected &&
      this.inputAllowed &&
      !this.invalidDelivery &&
      !this.busy &&
      !this.localCommand &&
      !!nativeSendLabel(this.session?.state)
    );
  }

  /** `steer`: the message joins the running turn when the host can take it there. */
  private async send(delivery?: 'steer') {
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
    await this.deliver(command, delivery);
  }

  /**
   * Implement: a new default-mode session like this one, whose first message is the plan. Its
   * delivery is kept like a typed message's, so it shows, and survives a refresh, in the new
   * session.
   */
  private async implement(plan: string) {
    const source = this.session;
    if (
      !source ||
      this.worker ||
      this.busy ||
      !this.connected ||
      !this.historyCurrent ||
      !this.inputAllowed ||
      this.localCommand
    )
      return;
    const revision = this.revision;
    this.busy = true;
    this.error = '';
    let created: NativeSessionInfo;
    try {
      ({ session: created } = await this.api.request<{ session: NativeSessionInfo }>(
        Methods.NATIVE_SESSION_CREATE,
        nativeImplementSession(source),
      ));
    } catch (error) {
      if (revision === this.revision) {
        this.error = `${(error as Error).message}. Check Sessions before implementing again.`;
        this.busy = false;
      }
      return;
    }
    if (revision !== this.revision || !this.isConnected) return;
    const command: LocalCommand = {
      sessionId: created.id,
      executionNodeId: created.executionNodeId,
      generation: created.generation,
      commandId: crypto.randomUUID(),
      text: nativeImplementPrompt(plan),
    };
    const stored = safeLsSet(this.sessionKey(`command:${created.id}`), JSON.stringify(command));
    this.selectRouted(created.id, created.executionNodeId);
    this.session = created;
    void this.refreshSessions();
    if (!stored) {
      // Nothing can track its delivery: leave the message for the reader to send.
      this.draft = command.text;
      this.error =
        'Browser storage is unavailable. Enable storage to preserve delivery receipts across refresh.';
      return;
    }
    await this.deliver(command);
  }

  /** Sends a command already kept as this session's pending message. */
  private async deliver(command: LocalCommand, delivery?: 'steer') {
    this.error = '';
    const revision = this.revision;
    try {
      await this.api.request<NativeSessionSendResult>(Methods.NATIVE_SESSION_SEND, {
        sessionId: command.sessionId,
        executionNodeId: command.executionNodeId,
        commandId: command.commandId,
        text: command.text,
        ...(delivery ? { delivery } : {}),
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
    method:
      | typeof Methods.NATIVE_SESSION_INTERRUPT
      | typeof Methods.NATIVE_SESSION_CLOSE
      | typeof Methods.NATIVE_SESSION_CANCEL,
    params: { commandId?: string } = {},
  ) {
    if (!this.session || this.busy || !this.connected || !this.inputAllowed) return;
    const revision = this.revision;
    this.busy = true;
    this.error = '';
    try {
      await this.api.request(method, {
        sessionId: this.session.id,
        executionNodeId: this.session.executionNodeId,
        ...params,
        ...(this.worker ? { worker: this.workerControl } : {}),
      });
    } catch (error) {
      if (revision === this.revision) this.error = (error as Error).message;
    } finally {
      if (revision === this.revision) this.busy = false;
      this.schedule(0);
    }
  }

  /** Edit: the host removes the queued message, and its release puts the text back here. */
  private async editQueued() {
    const commandId = this.localCommand?.commandId;
    const receipt = this.receipts.find((item) => item.commandId === commandId);
    if (commandId && nativeMessageCancelable(this.session, receipt))
      await this.sessionAction(Methods.NATIVE_SESSION_CANCEL, { commandId });
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

  private readSavedPage(after?: number): void {
    if (!this.historyTarget) return;
    const data = this.historyObservation.data;
    const start =
      after ??
      data?.omissions?.[0]?.after ??
      Math.max(data?.scope?.startAfter ?? 0, (data?.historyBefore ?? 200) - 200);
    void getResourceCache()
      ?.conversations?.readPage(this.historyTarget, start)
      .catch((error) => {
        this.error = error instanceof Error ? error.message : String(error);
      });
  }
  private renderSavedPage() {
    const history = this.historyObservation.history;
    if (!history) return nothing;
    return html`<dialog open class="saved-native-page" aria-label="Saved journal page">
      <button
        @click=${() =>
          this.historyTarget &&
          getResourceCache()?.conversations?.dismissHistory(this.historyTarget)}
      >
        Close saved output
      </button>
      <p>${history.loading ? 'Reading saved page…' : history.error || 'Saved output, read-only'}</p>
      ${history.page
        ? nativeTimeline(history.page.events).map(
            (entry) =>
              html`<article>
                <small>${entry.kind}</small>
                <pre>${entry.text}</pre>
              </article>`,
          )
        : nothing}
      ${history.page?.hasMore
        ? html`<button @click=${() => this.readSavedPage(history.page!.cursor)}>
            Next saved page
          </button>`
        : nothing}
    </dialog>`;
  }

  render() {
    const session = this.session;
    this.implementKey =
      session && !this.worker && this.historyCurrent && this.inputAllowed
        ? nativeImplementableKey(
            session,
            this.timelineRows(),
            this.requests,
            Boolean(this.localCommand),
          )
        : undefined;
    const lastReceipt = this.localCommand
      ? this.receipts.find((receipt) => receipt.commandId === this.localCommand?.commandId)
      : this.receipts.at(-1);
    const canResume =
      !this.worker &&
      !this.fixedTarget &&
      session &&
      session.capabilities.resume &&
      session.nativeSessionId &&
      ['closed', 'failed'].includes(session.state) &&
      (!session.processPid || session.processStopped);
    return html`
      <style>
        .saved-native-page {
          position: fixed;
          inset: 24px;
          z-index: 1000;
          overflow: auto;
          max-height: calc(100vh - 48px);
          max-width: calc(100vw - 48px);
          background: var(--fs-bg-surface, #181818);
          color: inherit;
        }
        .saved-native-page pre {
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .native-history-notice {
          min-height: 26px;
          max-height: 26px;
          overflow: hidden;
          font-size: 12px;
        }
      </style>
      ${this.renderSavedPage()}
      <div class="native-history-notice" role="status">
        ${nativeConversationOmissionNotice(this.historyObservation.data)}
        ${nativeConversationOmissionNotice(this.historyObservation.data)
          ? html`<button @click=${() => this.readSavedPage()}>Read saved output</button>`
          : nothing}
      </div>
      ${renderNativeSessionHeader({
        worker: this.worker,
        fixedTarget: this.fixedTarget,
        sessions: this.sessions,
        selectedId: this.selectedId,
        selectedNodeId: this.selectedNodeId,
        session,
        connected: this.connected,
        caughtUp: this.caughtUp,
        refreshingHistory: isSupersededRead(this.historyObservation.error),
        work: this.work(),
        busy: this.busy,
        workspace: this.workspace,
        workspaceAllowed: this.workspaceAllowed,
        taskHistory: this.taskHistory,
        fullscreen: this.fullscreen,
        toggleFullscreen: () => void this.toggleFullscreen(),
        requestCount: this.requests.length,
        sessionChoice: (item) => this.sessionChoice(item),
        select: (id, node = 'local') => this.selectRouted(id, node),
        readError: this.pollError || this.inventoryError || this.catalogError,
        readErrorCode: this.pollError
          ? this.historyObservation.error?.code
          : this.inventoryError
            ? this.inventoryErrorCode
            : this.catalogErrorCode,
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
          if (this.historyTarget) {
            cache.conversations?.retry(this.historyTarget);
            return;
          }
          const queries = [
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
      <div class="error launch-error" role=${this.error ? 'alert' : 'status'} aria-live="polite">
        ${this.error || nothing}
      </div>
      ${this.worker && (this.taskHistory || (this.session && !this.workerControl))
        ? html`<p class="meta" data-testid="native-worker-read-only">
            ${this.taskHistory
              ? 'This task history is read-only. Slot files reflect the current workspace.'
              : 'Input unavailable for this task. Use its task controls for recovery, or select the current worker.'}
          </p>`
        : nothing}
      ${this.creating
        ? html`<section class="new-session">
            <label class="launch-prompt"
              >What would you like to work on?
              <textarea
                data-testid="native-prompt"
                rows="7"
                .value=${this.prompt}
                ?disabled=${this.busy}
                @input=${(event: Event) => {
                  this.prompt = (event.target as HTMLTextAreaElement).value;
                  safeLsSet(this.key('new-prompt'), this.prompt);
                }}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                    event.preventDefault();
                    void this.create();
                  }
                }}
              ></textarea>
            </label>
            ${this.fixedTarget
              ? nothing
              : html`<div class="launch-controls">
                    <label
                      >Where to run<choice-picker
                        overlay
                        data-testid="native-context"
                        .value=${this.launchSelectionKey}
                        placeholder="Choose where to run"
                        ?disabled=${this.busy}
                        @change=${(event: Event) =>
                          this.chooseLaunch(
                            (event.target as HTMLElement & { value: string }).value,
                          )}
                      >
                        ${this.launchChoices.map(
                          (context, index, choices) =>
                            html` ${index === 0 ||
                              choices[index - 1].kind !== context.kind ||
                              choices[index - 1].project !== context.project ||
                              choices[index - 1].executionNodeId !== context.executionNodeId
                                ? html`<option disabled value=${`group:${index}`}>
                                    ${context.kind === 'custom'
                                      ? 'Custom directories'
                                      : (context.project ?? 'Workspaces')}
                                    · ${context.executionNodeId}
                                  </option>`
                                : nothing}
                              <option
                                value=${context.key}
                                ?disabled=${Boolean(context.unavailableReason)}
                              >
                                ${context.label} ·
                                ${context.cwd}${context.unavailableReason ||
                                this.unavailableNodes.some(
                                  (node) => node.executionNodeId === context.executionNodeId,
                                )
                                  ? ' · Unavailable'
                                  : ''}
                              </option>`,
                        )}
                      </choice-picker></label
                    >
                    ${this.customCwd
                      ? html`<label
                          >Directory on ${this.executionNodeId}<input
                            data-testid="native-cwd"
                            .value=${this.cwd}
                            ?disabled=${this.busy}
                            @input=${(event: Event) => {
                              this.cwd = (event.target as HTMLInputElement).value;
                              this.error = '';
                              this.syncLaunchUrl();
                            }}
                        /></label>`
                      : nothing}
                    <review-dispatch-picker
                      .viewModel=${this.executionPicker}
                      .discover=${false}
                      .disabled=${this.busy}
                      @review-dispatch-change=${() => {
                        this.mode = 'default';
                        this.error = '';
                        this.syncLaunchUrl();
                        this.requestUpdate();
                      }}
                    ></review-dispatch-picker>
                  </div>

                  ${this.renderApprovalMode()}
                  <details class="launch-advanced" data-testid="native-advanced">
                    <summary>Advanced</summary>
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
                            @native-profile-change=${(
                              event: CustomEvent<NativeProfileSelection>,
                            ) => {
                              const selected = event.detail;
                              if (selected.executionNodeId !== this.executionNodeId) return;
                              this.error = '';
                              this.profile = selected.profile;
                              this.profileReady = selected.ready;
                              this.profileNodeId = selected.executionNodeId;
                              if (selected.profile && selected.profile.runner !== this.runner) {
                                this.runner = selected.profile.runner;
                                this.model =
                                  this.catalog?.runners.find(
                                    (option) => option.runner === this.runner,
                                  )?.defaultModel ?? '';
                                this.mode = 'default';
                              }
                            }}
                          ></native-profiles>`,
                        )
                      : nothing}
                    <label
                      >Interaction mode<choice-picker
                        overlay
                        data-testid="native-mode"
                        .value=${this.mode}
                        ?disabled=${this.busy}
                        @change=${(e: Event) => {
                          this.mode =
                            (e.target as HTMLElement & { value: string }).value === 'plan'
                              ? 'plan'
                              : 'default';
                          this.error = '';
                          this.syncLaunchUrl();
                        }}
                      >
                        ${(
                          this.catalog?.runners.find((option) => option.runner === this.runner)
                            ?.modes ?? []
                        ).map(
                          (mode) =>
                            html`<option value=${mode} .selected=${mode === this.mode}>
                              ${mode === 'plan' ? 'Plan' : 'Default'}
                            </option>`,
                        )}
                      </choice-picker></label
                    >
                  </details>`}
            <div>
              <button
                class="primary"
                data-testid="native-create"
                ?disabled=${this.fixedTarget
                  ? !this.connected || this.busy || !this.prompt.trim() || !this.ensureSession
                  : Boolean(
                      this.catalog?.executionNodes?.find(
                        (node) => node.executionNodeId === this.executionNodeId,
                      )?.unavailableReason,
                    ) ||
                    !this.connected ||
                    (!this.fixture && !this.catalogCurrent) ||
                    this.busy ||
                    !this.launchReady ||
                    !this.prompt.trim() ||
                    !this.cwd.trim() ||
                    !this.runner ||
                    !this.profileReady}
                @click=${() => this.create()}
              >
                ${this.busy ? 'Starting…' : this.fixedTarget ? 'Send to Co-Pilot' : 'Start session'}
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
                ${this.renderApprovalMode(session)}
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
                    ${keyed(
                      `${this.selectedNodeId}:${this.selectedId}`,
                      repeat(
                        this.timelineRows(),
                        (row) => (row.kind === 'work' ? `work:${row.key}` : row.key),
                        (row) =>
                          row.kind === 'work'
                            ? html`<article class="work">
                                <button
                                  class="work-toggle"
                                  data-testid="native-work-fold"
                                  aria-expanded=${this.foldIsOpen(row.key) ? 'true' : 'false'}
                                  @click=${(event: Event) => {
                                    const open = this.foldIsOpen(row.key);
                                    const toggle = () => {
                                      this.foldOpen = new Map(this.foldOpen).set(row.key, !open);
                                    };
                                    void this.toggleInPlace(event.currentTarget, open, toggle);
                                  }}
                                >
                                  ${row.label}
                                </button>
                              </article>`
                            : this.renderEntry(
                                row.entry,
                                session,
                                row.fold !== undefined && !this.foldIsOpen(row.fold),
                                nativePlanOpen(row, this.watchedTools),
                              ),
                      ),
                    )}
                    ${this.localCommand &&
                    !nativeMessageShown(this.transcript.events, this.localCommand.commandId)
                      ? html`<article class="user">
                          <span class="meta">You · ${nativeDeliveryLabel(lastReceipt)}</span>
                          <div class="text">
                            ${this.renderMessageBody(
                              this.localCommand.text,
                              nativeMessagePreview(this.localCommand.text),
                              this.localCommand.commandId,
                            )}
                          </div>
                          ${nativeMessageCancelable(session, lastReceipt)
                            ? html`<button
                                class="message-toggle"
                                data-testid="native-edit"
                                ?disabled=${!this.connected || !this.inputAllowed || this.busy}
                                @click=${() => this.editQueued()}
                              >
                                Edit
                              </button>`
                            : nothing}
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
                        @click=${() => this.send()}
                      >
                        ${nativeSendLabel(session.state) ?? 'Send'}
                      </button>
                      ${session.capabilities.steer
                        ? html`<button
                            data-testid="native-steer"
                            title="Add this message to the running turn"
                            ?disabled=${!this.canSend ||
                            !this.draft.trim() ||
                            !nativeSteerAvailable(session, this.requests)}
                            @click=${() => this.send('steer')}
                          >
                            Steer
                          </button>`
                        : nothing}
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
