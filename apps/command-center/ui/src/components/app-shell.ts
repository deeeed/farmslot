import { html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import QRCode from 'qrcode';

import type {
  ChatClientContext,
  ChatSendIntent,
  FleetSummary,
  GatewayStatusResult,
  GatewayUpdateStatus,
  GitHubRateLimitPayload,
  NodeInfo,
  NodesListResult,
  PairingCandidate,
  PairingCandidatesResult,
  PairingCreateResult,
  Run,
  SlotStatus,
  TmuxWorkerInventoryUpdatedPayload,
  TmuxWorkerListResult,
  TmuxWorkerSummary,
} from '@farmslot/protocol';
import { Events, isTerminalRunStatus, Methods } from '@farmslot/protocol';

import './shared/summary-bar.js';
import './shared/global-filter-bar.js';
import './shared/hydrating-placeholder.js';
import './shared/update-banner.js';
import './shared/whats-new-modal.js';
import './fleet-map/fleet-canvas.js';
import './terminal/split-view.js';
import './dispatch/dispatch-wizard.js';
import './backlog/backlog-panel.js';
import './roadmap/roadmap-panel.js';
import './work-graph/work-graph-panel.js';
import './pr-dashboard/pr-board.js';
import './decisions/decision-inbox.js';
import './slot-view/slot-view.js';
import './runs/run-list.js';
import './runs/run-detail.js';
import './runs/run-pipeline-mini.js';
import './runs/run-compare.js';
import './runs/family-observability.js';
import './intelligence-audit/intelligence-incidents-panel.js';
import './analytics/analytics-panel.js';
import './evals/eval-cockpit.js';
import './finetune/finetune-page.js';
import './device-grid/device-grid.js';
import './chat/chat-panel.js';
import './config/config-panel.js';
import './doctor/gateway-doctor.js';

import {
  COMMAND_CENTER_APP_VERSION,
  COMMAND_CENTER_RELEASE_NOTES,
  isVersionNewer,
} from '../build-info.js';
import type { ConnectionState } from '../gateway-client.js';
import { gateway } from '../gateway-client.js';
import {
  GATEWAY_CANDIDATES_STORAGE_KEY,
  GATEWAY_SOURCE_STORAGE_KEY,
  GATEWAY_URL_STORAGE_KEY,
  normalizeGatewayWebSocketUrl,
  resolveGatewayConnectionSource,
} from '../gateway-url.js';
import {
  type AppState,
  getState,
  type GlobalFilters,
  isFullyHydrated,
  subscribe,
} from '../state.js';
import { ALPHA_FEATURES_CHANGED, getAlphaFeaturesEnabled } from '../utils/alpha-features.js';
import {
  listPinnedSlots as listPinnedSlotPreferences,
  PINNED_SLOTS_CHANGED,
  type PinnedSlotPreference,
  unpinSlot,
} from '../utils/pinned-slots.js';

import type { ChatPanel } from './chat/chat-panel.js';
import {
  activeSidebarRuns,
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  isSidebarActiveRun,
  parseStoredSidebarWidth,
  SIDEBAR_WIDTH_PREF_KEY,
} from './app-shell-nav-model.js';
import { renderAppShellAuthStyles, renderAppShellStyles } from './app-shell-styles.js';

type Route =
  | 'onboarding'
  | 'fleet'
  | 'terminal'
  | 'devices'
  | 'dispatch'
  | 'roadmap'
  | 'backlog'
  | 'work-graphs'
  | 'prs'
  | 'decisions'
  | 'runs'
  | 'run'
  | 'family'
  | 'run-compare'
  | 'evals'
  | 'finetune'
  | 'intelligence'
  | 'analytics'
  | 'config'
  | 'doctor'
  | 'slot'
  | 'dev';

interface NavItem {
  route: Route;
  icon: string;
  label: string;
  maturity?: 'alpha';
}

interface CopilotPromptRequestDetail {
  prompt: string;
  intent?: ChatSendIntent;
  runId?: string;
  stepName?: string;
  sourceSurface?: string;
  contextOverride?: Partial<ChatClientContext>;
}

interface ImportMetaWithEnv extends ImportMeta {
  env: Record<string, string | undefined>;
}

const NAV_ITEMS: NavItem[] = [
  { route: 'onboarding', icon: '*', label: 'Setup' },
  { route: 'fleet', icon: '#', label: 'Fleet' },
  { route: 'terminal', icon: '>', label: 'Terminals' },
  { route: 'devices', icon: '=', label: 'Devices' },
  { route: 'dispatch', icon: '!', label: 'Dispatch' },
  { route: 'roadmap', icon: 'r', label: 'Roadmap', maturity: 'alpha' },
  { route: 'backlog', icon: '+', label: 'Backlog', maturity: 'alpha' },
  { route: 'work-graphs', icon: 'g', label: 'Graphs', maturity: 'alpha' },
  { route: 'prs', icon: '&', label: 'PRs' },
  { route: 'decisions', icon: '?', label: 'Decisions' },
  { route: 'runs', icon: '@', label: 'Runs' },
  { route: 'intelligence', icon: 'i', label: 'Intelligence', maturity: 'alpha' },
  { route: 'analytics', icon: '^', label: 'Analytics', maturity: 'alpha' },
  { route: 'evals', icon: '$', label: 'Evals', maturity: 'alpha' },
  { route: 'finetune', icon: '%', label: 'Finetune', maturity: 'alpha' },
  { route: 'config', icon: '~', label: 'Config' },
  { route: 'doctor', icon: '+', label: 'Doctor' },
];

// Alpha routes are hidden from the nav and blocked from direct hash
// navigation unless the operator has opted in (see ALPHA_FEATURES_STORAGE_KEY).
const ALPHA_ROUTES = new Set<Route>(
  NAV_ITEMS.filter((item) => item.maturity === 'alpha').map((item) => item.route),
);

const SIDEBAR_PREF_KEY = 'farmslot:sidebar-expanded';
// Remembers which remote SHA the operator dismissed, so a newer update re-shows.
const UPDATE_DISMISS_KEY = 'farmslot:update-banner-dismissed-sha';
const WHATS_NEW_SEEN_VERSION_KEY = 'farmslot:whats-new-seen-version';
// Re-poll gateway freshness hourly; the gateway itself caches the git fetch.
const UPDATE_POLL_MS = 60 * 60_000;
const ALPHA_COPY = 'Alpha surface — early, under-tested, and subject to change.';
type PairingTarget = Pick<PairingCandidate, 'gatewayUrl' | 'kind' | 'profileName'>;

const DEFAULT_PAIRING_PROFILE_NAME = 'Farmslot Remote';
const DEFAULT_LAN_PAIRING_PROFILE_NAME = 'Local LAN';

@customElement('farm-app')
export class FarmApp extends LitElement {
  @state() private route: Route = 'fleet';
  @state() private slotParam = '';
  @state() private runParam = '';
  @state() private familyParam = '';
  @state() private familyRunParam = '';
  @state() private configParam = '';
  @state() private compareIdA = '';
  @state() private compareIdB = '';
  @state() private summary: FleetSummary | null = null;
  @state() private fleetSlots: SlotStatus[] = [];
  @state() private connection: ConnectionState = 'disconnected';
  @state() private hydrated = false;
  @state() private githubQuota: GitHubRateLimitPayload | null = null;
  @state() private updateStatus: GatewayUpdateStatus | null = null;
  @state() private versionDetailsOpen = false;
  @state() private versionDetailsLoading = false;
  @state() private versionDetailsError = '';
  @state() private versionDetailsStatus: GatewayStatusResult | null = null;
  @state() private versionDetailsNodes: NodesListResult | null = null;
  @state() private versionDetailsCopied = false;
  @state() private whatsNewOpen = false;
  @state() private updateDismissedSha: string | null = localStorage.getItem(UPDATE_DISMISS_KEY);
  @state() private alphaEnabled = getAlphaFeaturesEnabled();
  @state() private decisionCount = 0;
  @state() private violationCount = 0;
  @state() private runs: Run[] = [];
  @state() private pinnedSlots: PinnedSlotPreference[] = [];
  @state() private globalFilters: GlobalFilters = { projects: [], machines: [] };
  @state() private tmuxWorkers: TmuxWorkerSummary[] = [];
  @state() private chatOpen = false;
  @state() private chatUnread = 0;
  @state() private _sidebarExpanded = false;
  @state() private _sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  @state() private _sidebarResizing = false;
  @state() private devHarnessLoaded = false;
  @state() private devCaptureMode = false;
  @state() private authMode: 'token' | 'password' = localStorage.getItem(
    'farmslot.gateway.password',
  )
    ? 'password'
    : 'token';
  @state() private authSecret =
    localStorage.getItem('farmslot.gateway.token') ??
    localStorage.getItem('farmslot.gateway.password') ??
    '';
  @state() private pairingOpen = false;
  @state() private pairingBusy = false;
  @state() private pairingProfileName = DEFAULT_PAIRING_PROFILE_NAME;
  @state() private pairingLanGatewayUrl = resolveDefaultPairingGatewayUrl();
  @state() private pairingRemoteGatewayUrl = resolveDefaultRemotePairingGatewayUrl();
  @state() private pairingDetectedTargets: PairingTarget[] = [];
  @state() private pairingCandidateStatus = '';
  @state() private pairingQrDataUrl = '';
  @state() private pairingExpiresAt = '';
  @state() private pairingProfileCount = 0;
  @state() private pairingError = '';
  @state() private onboardingConnectInput = '';
  @state() private onboardingError = '';
  private unsub?: () => void;
  private sidebarResizeStartX = 0;
  private sidebarResizeStartWidth = DEFAULT_SIDEBAR_WIDTH;
  private tmuxWorkerRefreshTimer?: ReturnType<typeof setInterval>;
  private unsubTmuxWorkerUpdated?: () => void;
  private unsubConnForUpdate?: () => void;
  private updatePollTimer?: ReturnType<typeof setInterval>;

  // Light DOM so Monaco/diff2html CSS from document.head reaches all children
  protected override createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this._sidebarExpanded = localStorage.getItem(SIDEBAR_PREF_KEY) === 'true';
    this._sidebarWidth = parseStoredSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_PREF_KEY));
    this.route = this.getRouteFromHash();
    window.addEventListener('hashchange', this.onHashChange);
    window.addEventListener('keydown', this.onGlobalKeyDown);
    window.addEventListener('pointermove', this.onSidebarResizeMove);
    window.addEventListener('pointerup', this.onSidebarResizeEnd);
    window.addEventListener('copilot-prompt-request', this.onCopilotPromptRequest as EventListener);
    window.addEventListener(PINNED_SLOTS_CHANGED, this.onPinnedSlotsChanged as EventListener);
    window.addEventListener(ALPHA_FEATURES_CHANGED, this.onAlphaFeaturesChanged as EventListener);
    this.pinnedSlots = listPinnedSlotPreferences();
    void this.refreshTmuxWorkers();
    this.tmuxWorkerRefreshTimer = setInterval(() => {
      void this.refreshTmuxWorkers();
    }, 10_000);
    this.unsubTmuxWorkerUpdated = gateway.subscribe<TmuxWorkerInventoryUpdatedPayload>(
      Events.TMUX_WORKER_INVENTORY_UPDATED,
      (payload) => {
        this.tmuxWorkers =
          payload.result.workers ?? payload.result.nodes.flatMap((node) => node.workers);
      },
    );
    // Update freshness needs an open socket, so check on each (re)connect plus a
    // slow background poll. checkForUpdate tolerates a closed socket on its own.
    this.unsubConnForUpdate = gateway.onConnectionChange((s) => {
      if (s === 'connected') void this.checkForUpdate();
    });
    void this.checkForUpdate();
    this.updatePollTimer = setInterval(() => {
      void this.checkForUpdate();
    }, UPDATE_POLL_MS);
    this.syncState(getState());
    this.unsub = subscribe((s) => this.syncState(s));
    this.maybeOpenWhatsNew();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.onHashChange);
    window.removeEventListener('keydown', this.onGlobalKeyDown);
    window.removeEventListener('pointermove', this.onSidebarResizeMove);
    window.removeEventListener('pointerup', this.onSidebarResizeEnd);
    window.removeEventListener(
      'copilot-prompt-request',
      this.onCopilotPromptRequest as EventListener,
    );
    window.removeEventListener(PINNED_SLOTS_CHANGED, this.onPinnedSlotsChanged as EventListener);
    window.removeEventListener(
      ALPHA_FEATURES_CHANGED,
      this.onAlphaFeaturesChanged as EventListener,
    );
    if (this.tmuxWorkerRefreshTimer) clearInterval(this.tmuxWorkerRefreshTimer);
    if (this.updatePollTimer) clearInterval(this.updatePollTimer);
    this.unsubTmuxWorkerUpdated?.();
    this.unsubConnForUpdate?.();
    this.unsub?.();
  }

  private onPinnedSlotsChanged = () => {
    this.pinnedSlots = listPinnedSlotPreferences();
    void this.refreshTmuxWorkers();
  };

  private onAlphaFeaturesChanged = (event: CustomEvent<{ enabled: boolean }>) => {
    this.alphaEnabled = event.detail.enabled;
    // Re-run the route guard: if the operator just hid alpha while sitting
    // on an alpha route, bounce them to fleet immediately, not on next nav.
    this.parseHash();
  };

  private async refreshTmuxWorkers(): Promise<void> {
    if (this.pinnedSlots.length === 0) {
      this.tmuxWorkers = [];
      return;
    }
    try {
      const result = await gateway.request<TmuxWorkerListResult>(Methods.TMUX_WORKER_LIST, {
        includeDisconnected: true,
      });
      this.tmuxWorkers = result.workers ?? result.nodes.flatMap((node) => node.workers);
    } catch (err) {
      // Worker telemetry is optional/recoverable. Keep pins visible, but downgrade activity to unknown.
      console.warn('[app-shell] pinned slot worker telemetry unavailable', err);
      this.tmuxWorkers = [];
    }
  }

  private async checkForUpdate(): Promise<void> {
    try {
      const result = await gateway.request<GatewayStatusResult>(Methods.GATEWAY_STATUS);
      this.updateStatus = result.update;
    } catch (err) {
      // Advisory only: a closed socket or timeout just means no fresh reading this
      // cycle. We deliberately keep the last updateStatus rather than clearing it —
      // an update that was available is still available while the gateway is briefly
      // unreachable, and nulling it would flicker the banner on every reconnect. The
      // next connect/poll re-checks and replaces it; never block the shell on this.
      console.warn('[app-shell] gateway update status unavailable', err);
    }
  }

  private renderUpdateBanner() {
    const s = this.updateStatus;
    if (!s || !s.updateAvailable) return nothing;
    if (s.remoteSha && s.remoteSha === this.updateDismissedSha) return nothing;
    return html`<update-banner
      .status=${s}
      @dismiss=${() => this.dismissUpdateBanner()}
    ></update-banner>`;
  }

  private maybeOpenWhatsNew(force = false) {
    const notes = COMMAND_CENTER_RELEASE_NOTES;
    if (!notes.items.length) return;
    const seenVersion = localStorage.getItem(WHATS_NEW_SEEN_VERSION_KEY);
    if (!force && !isVersionNewer(notes.version, seenVersion)) return;
    this.whatsNewOpen = true;
  }

  private dismissWhatsNew() {
    localStorage.setItem(WHATS_NEW_SEEN_VERSION_KEY, COMMAND_CENTER_RELEASE_NOTES.version);
    this.whatsNewOpen = false;
  }

  private renderWhatsNewModal() {
    return html`
      <whats-new-modal
        .open=${this.whatsNewOpen}
        .notes=${COMMAND_CENTER_RELEASE_NOTES}
        @dismiss=${() => this.dismissWhatsNew()}
      ></whats-new-modal>
    `;
  }

  private dismissUpdateBanner() {
    const sha = this.updateStatus?.remoteSha;
    if (sha) {
      this.updateDismissedSha = sha;
      localStorage.setItem(UPDATE_DISMISS_KEY, sha);
    } else {
      // No remote SHA to key dismissal on — hide for this session only.
      this.updateStatus = null;
    }
  }

  private renderVersionFooter() {
    const version = COMMAND_CENTER_APP_VERSION;
    const sha = this.updateStatus?.localSha;
    const branch = this.updateStatus?.branch;
    const identity = sha ? `${sha}${branch ? ` · ${branch}` : ''}` : '…';
    const title = `Command Center v${version}${sha ? ` · ${identity}` : ''}. Open version details.`;
    const line = this._sidebarExpanded ? `v${version} · ${identity}` : `v${version}`;

    return html`
      <button
        class="fa-version-footer ${this._sidebarExpanded ? '' : 'fa-version-footer--compact'}"
        title=${title}
        @click=${() => this.openVersionDetails()}
      >
        ${line}
      </button>
    `;
  }

  private async openVersionDetails(): Promise<void> {
    this.versionDetailsOpen = true;
    await this.refreshVersionDetails();
  }

  private async refreshVersionDetails(): Promise<void> {
    if (gateway.connectionState !== 'connected') {
      this.versionDetailsError = 'Waiting for gateway connection…';
      return;
    }
    this.versionDetailsLoading = true;
    this.versionDetailsError = '';
    this.versionDetailsCopied = false;
    try {
      const [status, nodes] = await Promise.all([
        gateway.request<GatewayStatusResult>(Methods.GATEWAY_STATUS, { refresh: true }, 30_000),
        gateway.request<NodesListResult>(Methods.NODES_LIST, {}, 10_000),
      ]);
      this.versionDetailsStatus = status;
      this.versionDetailsNodes = nodes;
    } catch (error) {
      this.versionDetailsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.versionDetailsLoading = false;
    }
  }

  private async copyVersionDiagnostics(): Promise<void> {
    const diagnostics = {
      commandCenter: {
        version: COMMAND_CENTER_APP_VERSION,
      },
      gateway: {
        url: gateway.gatewayUrl,
        status: this.versionDetailsStatus,
      },
      nodes: this.versionDetailsNodes,
      capturedAt: new Date().toISOString(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      this.versionDetailsCopied = true;
      this.versionDetailsError = '';
    } catch (error) {
      this.versionDetailsError = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private renderVersionDetailsModal() {
    if (!this.versionDetailsOpen) return nothing;
    const status = this.versionDetailsStatus;
    const nodes = this.versionDetailsNodes;
    const update = status?.update ?? this.updateStatus;
    const releaseState = resolveReleaseState(update);

    return html`
      <div class="fa-modal-backdrop" @click=${() => (this.versionDetailsOpen = false)}>
        <section class="fa-version-modal" @click=${(event: Event) => event.stopPropagation()}>
          <div class="fa-version-modal-head">
            <div>
              <div class="fa-version-kicker">Farmslot diagnostics</div>
              <h2>Version details</h2>
            </div>
            <button class="fa-modal-close" @click=${() => (this.versionDetailsOpen = false)}>
              Close
            </button>
          </div>
          <div class="fa-version-actions">
            <button
              @click=${() => this.refreshVersionDetails()}
              ?disabled=${this.versionDetailsLoading}
            >
              ${this.versionDetailsLoading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              @click=${() => this.copyVersionDiagnostics()}
              ?disabled=${this.versionDetailsLoading}
            >
              ${this.versionDetailsCopied ? 'Copied' : 'Copy diagnostics JSON'}
            </button>
            <a href="#doctor" @click=${() => (this.versionDetailsOpen = false)}>Open Doctor</a>
            ${COMMAND_CENTER_RELEASE_NOTES.items.length
              ? html`<button
                  @click=${() => {
                    this.versionDetailsOpen = false;
                    this.maybeOpenWhatsNew(true);
                  }}
                >
                  What's new
                </button>`
              : nothing}
          </div>
          ${this.versionDetailsError
            ? html`<div class="fa-version-error">${this.versionDetailsError}</div>`
            : nothing}
          <div class="fa-version-grid">
            ${this.renderVersionCard('Command Center UI', [
              ['version', COMMAND_CENTER_APP_VERSION],
              ['channel', releaseState],
              ['gateway', gateway.gatewayUrl],
            ])}
            ${this.renderVersionCard('Gateway', [
              ['version', status?.version ?? '…'],
              ['branch', update?.branch ?? '…'],
              ['local sha', update?.localSha || 'unknown'],
              ['remote sha', update?.remoteSha ?? 'unknown'],
              ['freshness', update?.error ?? updateFreshnessLabel(update)],
            ])}
            ${this.renderVersionCard('Protocol', [
              ['gateway protocol', nodes?.gatewayProtocolVersion ?? '…'],
              ['connected nodes', String(nodes?.nodes.length ?? 0)],
            ])}
          </div>
          <section class="fa-version-node-section">
            <h3>Connected nodes</h3>
            ${nodes?.nodes.length
              ? nodes.nodes.map((node) =>
                  this.renderNodeVersionRow(node, nodes.gatewayProtocolVersion),
                )
              : html`<div class="fa-version-empty">No connected nodes.</div>`}
          </section>
        </section>
      </div>
    `;
  }

  private renderVersionCard(title: string, rows: Array<[string, string]>) {
    return html`
      <section class="fa-version-card">
        <h3>${title}</h3>
        ${rows.map(
          ([label, value]) => html`
            <div class="fa-version-row">
              <span>${label}</span>
              <strong>${value}</strong>
            </div>
          `,
        )}
      </section>
    `;
  }

  private renderNodeVersionRow(node: NodeInfo, gatewayProtocolVersion: string) {
    const match = node.versionMatch ?? node.protocolVersion === gatewayProtocolVersion;
    return html`
      <div class="fa-node-version-row">
        <div>
          <strong>${node.machine}</strong>
          <span
            >pid ${node.pid} · connected ${new Date(node.connectedAt).toLocaleTimeString()}</span
          >
        </div>
        <span class="fa-node-version-pill ${match ? 'ok' : 'warn'}">
          node ${node.protocolVersion ?? 'unknown'} / gateway ${gatewayProtocolVersion}
        </span>
      </div>
    `;
  }

  private onGlobalKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.versionDetailsOpen) {
      this.versionDetailsOpen = false;
      return;
    }
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.toggleChat();
    }
  };

  private toggleChat() {
    this.chatOpen = !this.chatOpen;
    if (this.chatOpen) this.chatUnread = 0;
  }

  private onCopilotPromptRequest = (event: CustomEvent<CopilotPromptRequestDetail>) => {
    const detail = event.detail;
    if (!detail?.prompt) return;
    this.chatOpen = true;
    this.chatUnread = 0;
    void this.updateComplete.then(() => {
      const panel = this.querySelector('chat-panel') as ChatPanel | null;
      const contextOverride: Partial<ChatClientContext> = {
        ...(detail.contextOverride ?? {}),
        ...(detail.runId ? { selectedRunId: detail.runId } : {}),
        ...(detail.stepName ? { selectedStepName: detail.stepName } : {}),
        ...(detail.sourceSurface ? { surfaceId: detail.sourceSurface } : {}),
        affordances: [...(detail.contextOverride?.affordances ?? []), 'failure-diagnosis'],
      };
      void panel?.submitPrompt(detail.prompt, contextOverride, detail.intent ?? 'general');
    });
  };

  private toggleSidebar() {
    this._sidebarExpanded = !this._sidebarExpanded;
    localStorage.setItem(SIDEBAR_PREF_KEY, String(this._sidebarExpanded));
  }

  private onSidebarResizeStart = (e: PointerEvent) => {
    if (!this._sidebarExpanded) return;
    e.preventDefault();
    this._sidebarResizing = true;
    this.sidebarResizeStartX = e.clientX;
    this.sidebarResizeStartWidth = this._sidebarWidth;
  };

  private onSidebarResizeMove = (e: PointerEvent) => {
    if (!this._sidebarResizing) return;
    const next = clampSidebarWidth(
      this.sidebarResizeStartWidth + e.clientX - this.sidebarResizeStartX,
    );
    if (next === this._sidebarWidth) return;
    this._sidebarWidth = next;
    localStorage.setItem(SIDEBAR_WIDTH_PREF_KEY, String(next));
  };

  private onSidebarResizeEnd = () => {
    this._sidebarResizing = false;
  };

  private onHashChange = () => {
    this.parseHash();
  };

  private parseHash() {
    const raw = location.hash.replace('#', '') || this.defaultRouteForEmptyHash();
    const hash = raw.split('?')[0];
    this.devCaptureMode = this.isDevCaptureHash(raw);
    // Deep links to a hidden alpha route (including its 'violations' alias)
    // bounce to fleet instead — hiding the nav entry alone isn't enough.
    if (!this.alphaEnabled && (hash === 'violations' || ALPHA_ROUTES.has(hash as Route))) {
      this.route = 'fleet';
      history.replaceState(null, '', '#fleet');
      return;
    }
    if (hash === 'dev' || hash.startsWith('dev/')) {
      this.route = 'dev';
      void this.loadDevHarness();
      return;
    }
    if (hash === 'runs/compare') {
      this.route = 'run-compare';
      const qs = raw.includes('?') ? raw.split('?')[1] : '';
      const params = new URLSearchParams(qs);
      this.compareIdA = params.get('a') ?? '';
      this.compareIdB = params.get('b') ?? '';
      return;
    }
    if (hash.startsWith('run/')) {
      this.route = 'run';
      this.runParam = hash.slice(4);
      return;
    }
    if (hash.startsWith('family/')) {
      this.route = 'family';
      this.familyParam = hash.slice(7);
      const qs = raw.includes('?') ? raw.split('?')[1] : '';
      const params = new URLSearchParams(qs);
      this.familyRunParam = params.get('run') ?? '';
      return;
    }
    if (hash.startsWith('slot/')) {
      this.route = 'slot';
      const rest = hash.slice(5);
      this.slotParam = rest.endsWith('/workspace') ? rest.slice(0, -'/workspace'.length) : rest;
      return;
    }
    if (hash.startsWith('terminal/')) {
      this.route = 'terminal';
      this.slotParam = hash.slice(9);
      return;
    }
    if (hash.startsWith('config/')) {
      this.route = 'config';
      this.configParam = hash.slice(7);
      return;
    }
    if (hash === 'violations') {
      this.route = 'intelligence';
      history.replaceState(null, '', '#intelligence');
      return;
    }
    const valid: Route[] = [
      'onboarding',
      'fleet',
      'terminal',
      'devices',
      'dispatch',
      'roadmap',
      'backlog',
      'work-graphs',
      'prs',
      'decisions',
      'runs',
      'evals',
      'finetune',
      'intelligence',
      'analytics',
      'config',
      'doctor',
    ];
    this.route = valid.includes(hash as Route) ? (hash as Route) : 'fleet';
    // Deep links to Setup while a gateway is connected land on the fleet
    // instead — the page's job is already done.
    if (this.route === 'onboarding' && this.connection === 'connected') {
      this.route = 'fleet';
      history.replaceState(null, '', '#fleet');
    }
    this.slotParam = '';
    this.configParam = '';
  }

  private defaultRouteForEmptyHash(): Route {
    const env = (import.meta as ImportMetaWithEnv).env;
    const source = resolveGatewayConnectionSource(
      env.VITE_FARMSLOT_GATEWAY_URL,
      location,
      localStorage.getItem(GATEWAY_CANDIDATES_STORAGE_KEY),
      localStorage.getItem(GATEWAY_URL_STORAGE_KEY),
      localStorage.getItem(GATEWAY_SOURCE_STORAGE_KEY),
    );
    return source === 'implicit' ? 'onboarding' : 'fleet';
  }

  private getRouteFromHash(): Route {
    this.parseHash();
    return this.route;
  }

  private isDevCaptureHash(raw: string) {
    const hash = raw.split('?')[0];
    if (hash !== 'dev' && !hash.startsWith('dev/')) return false;
    const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
    const params = new URLSearchParams(query);
    return (
      params.get('capture') === '1' || params.get('demo') === '1' || params.get('focus') === '1'
    );
  }

  private navigate(route: Route) {
    location.hash = route;
  }

  private syncState(s: AppState) {
    this.summary = s.fleet?.summary ?? null;
    this.fleetSlots = s.fleet?.slots ?? [];
    // The Setup page exists to establish a connection — once one is live,
    // showing it again only confuses; move the operator to the fleet.
    if (s.connection === 'connected' && this.connection !== 'connected') {
      if (this.route === 'onboarding') this.navigate('fleet');
    }
    this.connection = s.connection;
    this.hydrated = isFullyHydrated(s.hydrated);
    this.githubQuota = s.githubQuota;
    this.decisionCount = s.decisions.length;
    this.violationCount = s.violations.length;
    this.runs = s.runs;
    this.globalFilters = s.globalFilters;
  }

  private submitGatewayAuth(event: Event) {
    event.preventDefault();
    const secret = this.authSecret.trim();
    if (!secret) return;
    gateway.setAuthCredentials(
      this.authMode === 'token' ? { token: secret } : { password: secret },
    );
    gateway.connect();
  }

  private openPairingPanel() {
    this.pairingOpen = true;
    this.pairingError = '';
    this.pairingCandidateStatus = '';
    this.pairingQrDataUrl = '';
    this.pairingExpiresAt = '';
    void this.refreshPairingCandidates();
  }

  private closePairingPanel() {
    this.pairingOpen = false;
  }

  private async refreshPairingCandidates() {
    try {
      const port =
        pairingCandidatePort(this.pairingLanGatewayUrl) ?? pairingCandidatePort(gateway.gatewayUrl);
      const result = await gateway.request<PairingCandidatesResult>(Methods.PAIRING_CANDIDATES, {
        ...(port ? { port } : {}),
      });
      this.pairingDetectedTargets = [...result.candidates]
        .sort((a, b) => pairingCandidateRank(a) - pairingCandidateRank(b))
        .map((candidate) => ({
          gatewayUrl: candidate.gatewayUrl,
          kind: candidate.kind,
          profileName: candidate.profileName,
        }));
      const hasTailscale = result.candidates.some((candidate) => candidate.kind === 'tailnet');
      this.pairingCandidateStatus = result.candidates.length
        ? `Auto-detected ${result.candidates.length} gateway URL${result.candidates.length === 1 ? '' : 's'}${hasTailscale ? ', including Tailscale' : ''}.`
        : 'No LAN/Tailscale gateway URLs auto-detected; use the fields below.';
      if (!this.pairingLanGatewayUrl.trim()) {
        this.pairingLanGatewayUrl =
          result.candidates.find((candidate) => candidate.kind === 'lan')?.gatewayUrl ?? '';
      }
    } catch (err) {
      this.pairingDetectedTargets = [];
      this.pairingCandidateStatus = `Could not auto-detect LAN/Tailscale URLs: ${err instanceof Error ? err.message : 'unknown error'}`;
    }
  }

  private async createCompanionPairing(event?: Event) {
    event?.preventDefault();
    const targets = [
      ...this.pairingDetectedTargets,
      {
        profileName: DEFAULT_LAN_PAIRING_PROFILE_NAME,
        gatewayUrl: this.pairingLanGatewayUrl.trim(),
      },
      {
        profileName: this.pairingProfileName.trim() || DEFAULT_PAIRING_PROFILE_NAME,
        gatewayUrl: this.pairingRemoteGatewayUrl.trim(),
      },
    ].filter((target, index, allTargets) => {
      if (!target.gatewayUrl) return false;
      return (
        allTargets.findIndex((candidate) => candidate.gatewayUrl === target.gatewayUrl) === index
      );
    });
    if (targets.length === 0) {
      this.pairingError =
        'Add at least one gateway URL, or configure VITE_FARMSLOT_PAIRING_GATEWAY_URL / VITE_FARMSLOT_REMOTE_GATEWAY_URL.';
      return;
    }
    const invalidTarget = targets.find(
      (target) => !target.gatewayUrl.startsWith('ws://') && !target.gatewayUrl.startsWith('wss://'),
    );
    if (invalidTarget) {
      this.pairingError = `${invalidTarget.profileName} URL must start with ws:// or wss://`;
      return;
    }

    this.pairingBusy = true;
    this.pairingError = '';
    this.pairingQrDataUrl = '';
    this.pairingExpiresAt = '';
    this.pairingProfileCount = 0;
    try {
      const results = await Promise.all(
        targets.map((target) =>
          gateway.request<PairingCreateResult>(Methods.PAIRING_CREATE, {
            gatewayUrl: target.gatewayUrl,
            profileName: target.profileName,
            ttlSeconds: 180,
          }),
        ),
      );
      const payload = {
        type: 'farmslot.gateway-pairing.v1',
        profiles: results.map((result) => ({
          url: result.url,
          code: result.code,
          profileName: result.profileName,
          expiresAt: result.expiresAt,
        })),
      };
      this.pairingQrDataUrl = await QRCode.toDataURL(JSON.stringify(payload), {
        errorCorrectionLevel: 'M',
        margin: 2,
        scale: 6,
      });
      this.pairingExpiresAt = results
        .map((result) => result.expiresAt)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
      this.pairingProfileCount = results.length;
    } catch (err) {
      this.pairingError = err instanceof Error ? err.message : 'Failed to create pairing QR';
    } finally {
      this.pairingBusy = false;
    }
  }

  private renderPinnedSlotsNav() {
    const pins = this.filteredPinnedSlots();
    const hiddenCount = this.pinnedSlots.length - pins.length;
    if (!this._sidebarExpanded) return nothing;
    return html`
      <div class="fa-active-runs" aria-label="Pinned slots">
        <div class="fa-active-runs-head">
          <span>Pinned slots</span>
          <span>${pins.length}${hiddenCount > 0 ? `/${this.pinnedSlots.length}` : ''}</span>
        </div>
        ${pins.length === 0
          ? html`<div class="fa-active-runs-empty">
              ${hiddenCount > 0 ? 'hidden by filters' : 'none'}
            </div>`
          : html`${pins.map((pin) => this.renderPinnedSlotShortcut(pin))}`}
      </div>
    `;
  }

  private filteredPinnedSlots(): PinnedSlotPreference[] {
    const { projects, machines } = this.globalFilters;
    if (projects.length === 0 && machines.length === 0) return this.pinnedSlots;
    return this.pinnedSlots.filter((pin) => {
      const slot = this.fleetSlots.find((candidate) => candidate.slot === pin.slotId);
      if (!slot) return false;
      if (projects.length > 0 && !projects.includes(slot.project)) return false;
      if (machines.length > 0 && !machines.includes(slot.machine)) return false;
      return true;
    });
  }

  private tmuxWorkerForSlot(slot: SlotStatus | undefined): TmuxWorkerSummary | null {
    if (!slot) return null;
    const workers = this.tmuxWorkers.filter(
      (worker) =>
        worker.linkedSlotId === slot.slot ||
        (worker.ref.nodeId === slot.machine && worker.ref.session === slot.slot),
    );
    return (
      workers.sort(
        (a, b) =>
          this.tmuxWorkerRank(b) - this.tmuxWorkerRank(a) ||
          (b.lastChangedAt ?? 0) - (a.lastChangedAt ?? 0),
      )[0] ?? null
    );
  }

  private tmuxWorkerRank(worker: TmuxWorkerSummary): number {
    const state = worker.status.state;
    const source = worker.status.source;
    const isRunnerSignal = source === 'hook' || source === 'statusline' || source === 'task-file';
    const signalScore = isRunnerSignal && !worker.status.stale ? 1000 : 0;
    const stateScore =
      state === 'active'
        ? 500
        : state === 'waiting'
          ? 400
          : state === 'stale'
            ? 300
            : state === 'idle'
              ? 100
              : 0;
    const attentionScore = worker.status.requiresAttention ? 800 : 0;
    const activePaneScore = worker.active ? 20 : 0;
    return signalScore + attentionScore + stateScore + activePaneScore;
  }

  private pinnedSlotWorkerStatus(worker: TmuxWorkerSummary | null): string {
    if (!worker) return 'unknown';
    const source = worker.status.source;
    const state = worker.status.state;
    const isRunnerSignal = source === 'hook' || source === 'statusline' || source === 'task-file';
    if (isRunnerSignal && !worker.status.stale && worker.status.confidence !== 'low') {
      return state ?? 'unknown';
    }
    if (source === 'tmux') {
      if (state === 'active' || state === 'waiting' || state === 'stale') return state;
      if (state === 'idle') return 'unknown';
    }
    return 'unknown';
  }

  private pinnedSlotWorkerColor(status: string): string {
    if (status === 'needs attention') return '#ffcc00';
    if (status === 'active') return '#00ff88';
    if (status === 'waiting') return '#ffcc00';
    if (status === 'idle') return '#8888a0';
    if (status === 'stale') return '#f97316';
    return '#777';
  }

  private pinnedSlotNeedsAttention(worker: TmuxWorkerSummary | null): boolean {
    return worker?.status.requiresAttention === true;
  }

  private pinnedSlotWorkerTitle(worker: TmuxWorkerSummary | null): string {
    if (!worker) return 'No structured runner signal for this slot';
    const signal = `${worker.status.source}/${worker.status.confidence}`;
    const attention = worker.status.requiresAttention
      ? ` · needs attention (${worker.status.attentionReason ?? 'runner stopped'})`
      : '';
    if (worker.status.source === 'tmux') {
      return `${worker.status.label} · ${signal} · tmux pane detected; no activity signal${attention}`;
    }
    if (worker.status.source === 'inferred') {
      return `${worker.status.label} · ${signal} · inferred, not a runner signal${attention}`;
    }
    return `${worker.status.label} · ${signal}${attention}`;
  }

  private pinnedSlotRun(
    slotId: string,
    currentRunId?: string | null,
    slotBusy = false,
  ): Run | null {
    if (currentRunId) {
      const current = this.runs.find((candidate) => candidate.id === currentRunId);
      // During a slot's run transition, current_run_id can still point at the
      // PREVIOUS (terminal) run while the slot is already busy preparing the
      // next one. Rendering that done run's "complete" pipeline on a busy slot
      // is misleading, so skip it and fall through to the active-run match.
      if (current && !(slotBusy && isTerminalRunStatus(current.status))) return current;
    }
    if (this.route === 'run') {
      const selected = this.runs.find(
        (candidate) => candidate.id === this.runParam && candidate.slotId === slotId,
      );
      if (selected) return selected;
    }
    return (
      this.runs.find((candidate) => candidate.slotId === slotId && isSidebarActiveRun(candidate)) ??
      null
    );
  }

  private renderPinnedSlotShortcut(pin: PinnedSlotPreference) {
    const slot = this.fleetSlots.find((candidate) => candidate.slot === pin.slotId);
    const run = this.pinnedSlotRun(pin.slotId, slot?.currentRunId, slot?.lifecycle === 'busy');
    const selected = this.route === 'slot' && pin.slotId === this.slotParam;
    const worker = this.tmuxWorkerForSlot(slot);
    const displayLabel = pin.label?.trim() || pin.slotId;
    const needsAttention = this.pinnedSlotNeedsAttention(worker);
    const workerStatus = needsAttention ? 'needs attention' : this.pinnedSlotWorkerStatus(worker);
    const statusColor = this.pinnedSlotWorkerColor(workerStatus);
    return html`
      <div class="fa-active-run-wrap">
        <a
          class="fa-active-run ${selected ? 'active' : ''} ${needsAttention
            ? 'needs-attention'
            : ''}"
          href=${`#slot/${pin.slotId}${run ? `?runId=${encodeURIComponent(run.id)}` : ''}`}
          title=${`${pin.slotId}${pin.label ? ` · ${pin.label}` : ''}${run ? ` · ${run.ticketOrPr}` : ''}`}
        >
          <div class="fa-active-run-top">
            <span class="fa-active-run-ticket">${displayLabel}</span>
            ${slot?.machine || pin.label
              ? html`<span class="fa-active-run-flow" style="--flow-color:#94a3b8"
                  >${pin.label ? pin.slotId : slot?.machine}</span
                >`
              : nothing}
          </div>
          <div class="fa-active-run-summary">
            ${run?.summary || run?.ticketOrPr || slot?.branch || 'Slot not in current fleet'}
          </div>
          <div class="fa-active-run-meta">
            <span
              class="fa-active-run-worker"
              style="--worker-color:${statusColor}"
              title=${this.pinnedSlotWorkerTitle(worker)}
            >
              <span class="fa-active-run-worker-dot"></span>${workerStatus}
            </span>
            ${worker
              ? html`<span>${worker.status.source}/${worker.status.confidence}</span>`
              : nothing}
            ${slot?.phase ? html`<span>${slot.phase}</span>` : nothing}
            ${slot?.branch ? html`<span>${slot.branch}</span>` : nothing}
            ${run ? html`<span>${run.status}</span>` : nothing}
          </div>
          ${run
            ? html`<run-pipeline-mini
                class="fa-pinned-run-pipeline"
                .run=${run}
                .flowType=${run.flowType}
              ></run-pipeline-mini>`
            : nothing}
        </a>
        <button
          class="fa-active-run-unpin"
          title=${`Unpin ${pin.slotId}`}
          aria-label=${`Unpin ${pin.slotId}`}
          @click=${(event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            unpinSlot(pin.slotId);
          }}
        >
          ×
        </button>
      </div>
    `;
  }

  private applyOnboardingConnection(event: Event) {
    event.preventDefault();
    const raw = this.onboardingConnectInput.trim();
    if (!raw) {
      this.onboardingError = 'Paste a connect URL or gateway URL first.';
      return;
    }

    const hashIndex = raw.indexOf('#');
    if (raw.startsWith('#') || hashIndex >= 0) {
      const hash = raw.startsWith('#') ? raw : raw.slice(hashIndex);
      if (!hash.includes('connect=')) {
        this.onboardingError =
          'Connect URLs must include a #connect= or #doctor?connect= fragment.';
        return;
      }
      location.hash = hash.startsWith('#doctor') ? hash : `#doctor?${hash.slice(1)}`;
      location.reload();
      return;
    }

    try {
      const normalized = normalizeGatewayWebSocketUrl(raw);
      localStorage.setItem(GATEWAY_URL_STORAGE_KEY, normalized);
      localStorage.setItem(GATEWAY_CANDIDATES_STORAGE_KEY, JSON.stringify([normalized]));
      localStorage.setItem(GATEWAY_SOURCE_STORAGE_KEY, 'stored');
      location.hash = 'doctor';
      location.reload();
    } catch (err) {
      this.onboardingError = err instanceof Error ? err.message : 'Invalid gateway URL.';
    }
  }

  private renderOnboardingScreen() {
    return html`
      <section class="onboarding-shell">
        <div class="onboarding-hero">
          <div class="onboarding-kicker">First connection</div>
          <h1>Connect Command Center to a Farmslot gateway</h1>
          <p>
            No saved gateway connection was found in this browser. Start a local gateway, paste a
            generated connect URL, or continue manually if you already know where your gateway runs.
          </p>
        </div>

        <div class="onboarding-grid">
          <article class="onboarding-card">
            <h2>1. Install Farmslot</h2>
            <p>Use the one-line installer on the machine that should run the gateway.</p>
            <pre>
curl -fsSL https://raw.githubusercontent.com/deeeed/farmslot/main/install.sh | bash</pre
            >
          </article>

          <article class="onboarding-card">
            <h2>2. Start the gateway</h2>
            <p>From your checkout or workspace, start the local Command Center gateway.</p>
            <pre>farmslot up</pre>
            <p>For a repo checkout, the developer shortcut is:</p>
            <pre>bash scripts/dev.sh</pre>
          </article>

          <article class="onboarding-card onboarding-card-wide">
            <h2>3. Connect this browser</h2>
            <p>Paste the connect URL from <code>farmslot up</code>, or paste a gateway URL.</p>
            <form
              class="onboarding-connect"
              @submit=${(event: Event) => this.applyOnboardingConnection(event)}
            >
              <input
                placeholder="https://farmslot.io/#connect=... or ws://localhost:7777"
                .value=${this.onboardingConnectInput}
                @input=${(event: InputEvent) => {
                  this.onboardingConnectInput = (event.target as HTMLInputElement).value;
                  this.onboardingError = '';
                }}
              />
              <button type="submit">Connect</button>
            </form>
            ${this.onboardingError
              ? html`<div class="onboarding-error">${this.onboardingError}</div>`
              : nothing}
            <div class="onboarding-actions">
              <a href="#doctor">Open doctor</a>
              <a href="#fleet">Continue to fleet</a>
            </div>
          </article>
        </div>
      </section>
    `;
  }

  private renderAuthScreen() {
    const authError = gateway.authError;
    return html`
      ${renderAppShellAuthStyles()}
      <form class="auth-card" @submit=${(event: Event) => this.submitGatewayAuth(event)}>
        <div class="auth-title">Gateway authentication required</div>
        <div class="auth-copy">
          This Command Center controls terminals and workers. Enter the gateway token or password to
          continue. The secret is stored only in this browser profile local storage.
        </div>
        ${authError
          ? html`<div class="auth-error">${authError.message}</div>`
          : html`<div class="auth-error">Gateway rejected unauthenticated access.</div>`}
        <div class="auth-modes">
          ${(['token', 'password'] as const).map(
            (mode) => html`
              <button
                class="auth-mode ${this.authMode === mode ? 'active' : ''}"
                type="button"
                @click=${() => {
                  this.authMode = mode;
                }}
              >
                ${mode}
              </button>
            `,
          )}
        </div>
        <input
          class="auth-input"
          type="password"
          autocomplete="current-password"
          .value=${this.authSecret}
          placeholder="Gateway ${this.authMode}"
          @input=${(event: InputEvent) => {
            this.authSecret = (event.target as HTMLInputElement).value;
          }}
        />
        <button class="auth-submit" type="submit" ?disabled=${!this.authSecret.trim()}>
          Connect
        </button>
      </form>
    `;
  }

  private renderContent() {
    switch (this.route) {
      case 'onboarding':
        return this.renderOnboardingScreen();
      case 'fleet':
        return html`<fleet-canvas></fleet-canvas>`;
      case 'terminal':
        return html`<terminal-split-view .initialSlot=${this.slotParam}></terminal-split-view>`;
      case 'devices':
        return html`<device-grid></device-grid>`;
      case 'dispatch':
        return html`<dispatch-wizard></dispatch-wizard>`;
      case 'roadmap':
        return html`<roadmap-panel></roadmap-panel>`;
      case 'backlog':
        return html`<backlog-panel></backlog-panel>`;
      case 'work-graphs':
        return html`<work-graph-panel></work-graph-panel>`;
      case 'prs':
        return html`<pr-board></pr-board>`;
      case 'decisions':
        return html`<decision-inbox></decision-inbox>`;
      case 'runs':
        return html`<run-list></run-list>`;
      case 'run':
        return html`<run-detail .runId=${this.runParam}></run-detail>`;
      case 'family':
        return html`<family-observability
          .familyId=${this.familyParam}
          .initialRunId=${this.familyRunParam}
        ></family-observability>`;
      case 'run-compare':
        return html`<run-compare
          .runIdA=${this.compareIdA}
          .runIdB=${this.compareIdB}
        ></run-compare>`;
      case 'evals':
        return html`<eval-cockpit></eval-cockpit>`;
      case 'finetune':
        return html`<finetune-page></finetune-page>`;
      case 'intelligence':
        return html`<intelligence-incidents-panel></intelligence-incidents-panel>`;
      case 'analytics':
        return html`<analytics-panel></analytics-panel>`;
      case 'config':
        return html`<config-panel .initialPath=${this.configParam}></config-panel>`;
      case 'doctor':
        return html`<gateway-doctor></gateway-doctor>`;
      case 'slot':
        return html`<slot-view
          .slotId=${this.slotParam}
          @slot-back=${() => this.navigate('fleet')}
        ></slot-view>`;
      case 'dev':
        if (!this.devHarnessLoaded) {
          void this.loadDevHarness();
          return html`<hydrating-placeholder label="Loading dev harness"></hydrating-placeholder>`;
        }
        return html`<dev-harness></dev-harness>`;
    }
  }

  private renderMainContent() {
    const item = NAV_ITEMS.find((navItem) => navItem.route === this.route);
    if (item?.maturity !== 'alpha') {
      return html`<div class="fa-content">${this.renderContent()}</div>`;
    }
    return html`
      <div class="fa-content fa-content--stacked">
        <div class="fa-route-alpha-banner" title=${ALPHA_COPY}>
          <span>ALPHA</span>
          <strong>${item.label}</strong>
          <em>${ALPHA_COPY}</em>
        </div>
        <div class="fa-screen-body">${this.renderContent()}</div>
      </div>
    `;
  }

  private renderPairingPanel() {
    if (!this.pairingOpen) return '';
    return html`
      <div class="pairing-overlay" @click=${() => this.closePairingPanel()}>
        <form
          class="pairing-card"
          @submit=${(event: Event) => this.createCompanionPairing(event)}
          @click=${(event: Event) => event.stopPropagation()}
        >
          <div class="pairing-header">
            <div>
              <div class="pairing-title">Gateway connection</div>
              <div class="pairing-copy">
                Review the current browser connection, then generate a short-lived QR code for
                Companion. The mobile app exchanges it once for the selected gateway URL and auth
                credential.
              </div>
            </div>
            <button class="pairing-close" type="button" @click=${() => this.closePairingPanel()}>
              ×
            </button>
          </div>

          ${this.pairingError ? html`<div class="pairing-error">${this.pairingError}</div>` : ''}
          ${this.pairingCandidateStatus
            ? html`<div class="pairing-copy">${this.pairingCandidateStatus}</div>`
            : ''}
          ${this.pairingDetectedTargets.length
            ? html`
                <div class="pairing-detected">
                  <span>Auto-included profiles</span>
                  ${this.pairingDetectedTargets.map(
                    (target) => html`
                      <div class="pairing-detected-row">
                        <strong>${target.profileName}</strong>
                        <code>${target.gatewayUrl}</code>
                      </div>
                    `,
                  )}
                </div>
              `
            : ''}

          <div class="pairing-status-grid">
            <div>
              <span>Status</span>
              <strong
                >${this.connection}${this.connection === 'connected' && !this.hydrated
                  ? ' / hydrating'
                  : ''}</strong
              >
            </div>
            <div>
              <span>Browser gateway</span>
              <strong>${gateway.gatewayUrl}</strong>
            </div>
            <div>
              <span>Browser auth</span>
              <strong
                >${gateway.authCredentialKind === 'none'
                  ? 'none'
                  : gateway.authCredentialKind}</strong
              >
            </div>
          </div>

          <label class="pairing-label" for="pairing-lan-gateway-url">LAN gateway URL</label>
          <input
            id="pairing-lan-gateway-url"
            class="pairing-input"
            placeholder="Set VITE_FARMSLOT_PAIRING_GATEWAY_URL"
            .value=${this.pairingLanGatewayUrl}
            @input=${(event: InputEvent) => {
              this.pairingLanGatewayUrl = (event.target as HTMLInputElement).value;
            }}
          />

          <label class="pairing-label" for="pairing-remote-profile-name">Remote profile name</label>
          <input
            id="pairing-remote-profile-name"
            class="pairing-input"
            .value=${this.pairingProfileName}
            @input=${(event: InputEvent) => {
              this.pairingProfileName = (event.target as HTMLInputElement).value;
            }}
          />

          <label class="pairing-label" for="pairing-remote-gateway-url"
            >Remote gateway URL (optional)</label
          >
          <input
            id="pairing-remote-gateway-url"
            class="pairing-input"
            placeholder="Set VITE_FARMSLOT_REMOTE_GATEWAY_URL"
            .value=${this.pairingRemoteGatewayUrl}
            @input=${(event: InputEvent) => {
              this.pairingRemoteGatewayUrl = (event.target as HTMLInputElement).value;
            }}
          />

          <button class="pairing-submit" type="submit" ?disabled=${this.pairingBusy}>
            ${this.pairingBusy ? 'Generating…' : 'Generate QR'}
          </button>

          ${this.pairingQrDataUrl
            ? html`
                <div class="pairing-qr-wrap">
                  <img class="pairing-qr" src=${this.pairingQrDataUrl} alt="Companion pairing QR" />
                  <div class="pairing-expiry">
                    ${this.pairingProfileCount} profile${this.pairingProfileCount === 1 ? '' : 's'}
                    · expires ${new Date(this.pairingExpiresAt).toLocaleTimeString()}
                  </div>
                </div>
              `
            : html`
                <div class="pairing-empty">
                  Scan this QR from Companion Settings → Pair from QR.
                </div>
              `}
        </form>
      </div>
    `;
  }

  private async loadDevHarness() {
    if (this.devHarnessLoaded) return;
    await import('../dev/dev-harness.js');
    this.devHarnessLoaded = true;
  }

  render() {
    if (this.connection === 'auth_required' && this.route !== 'onboarding') {
      return html`${this.renderAuthScreen()} ${this.renderWhatsNewModal()}`;
    }
    const activeRunCount = activeSidebarRuns(this.runs, Number.MAX_SAFE_INTEGER).length;
    if (this.route === 'dev' && this.devCaptureMode) {
      return html`
        ${renderAppShellStyles(this._sidebarExpanded, this._sidebarWidth, this._sidebarResizing)}
        <div class="fa-main fa-main--capture">
          <div class="fa-content">${this.renderContent()}</div>
        </div>
      `;
    }

    return html`
      ${renderAppShellStyles(this._sidebarExpanded, this._sidebarWidth, this._sidebarResizing)}
      <nav>
        <button
          class="fa-nav-toggle"
          title="${this._sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}"
          @click=${() => this.toggleSidebar()}
        >
          ${this._sidebarExpanded ? '\u00AB' : '\u00BB'}
        </button>
        ${NAV_ITEMS.filter(
          (item) =>
            (item.route !== 'onboarding' || this.connection !== 'connected') &&
            (item.maturity !== 'alpha' || this.alphaEnabled),
        ).map(
          (item) => html`
            <a
              class="fa-nav-btn ${this.route === item.route ? 'active' : ''} ${item.maturity ===
              'alpha'
                ? 'fa-nav-btn--alpha'
                : ''}"
              href="#${item.route}"
              title="${item.label}"
            >
              <span class="fa-nav-icon">${item.icon}</span>${this._sidebarExpanded
                ? html`<span class="fa-nav-label">${item.label}</span>`
                : ''}
              ${item.maturity === 'alpha' && this._sidebarExpanded
                ? html`<span class="fa-alpha-badge" title=${ALPHA_COPY}>ALPHA</span>`
                : nothing}
              ${item.route === 'decisions' && this.decisionCount > 0
                ? html`<span class="fa-badge-count">${this.decisionCount}</span>`
                : ''}
              ${item.route === 'intelligence' && this.violationCount > 0
                ? html`<span class="fa-badge-count">${this.violationCount}</span>`
                : ''}
              ${item.route === 'runs' && activeRunCount > 0
                ? html`<span class="fa-badge-count">${activeRunCount}</span>`
                : ''}
            </a>
            ${item.route === 'runs' ? this.renderPinnedSlotsNav() : nothing}
          `,
        )}
        <div class="fa-sidebar-resize" @pointerdown=${this.onSidebarResizeStart}></div>
        <div style="flex:1"></div>
        ${this.renderVersionFooter()}
        <button
          class="fa-nav-btn ${this.chatOpen ? 'active' : ''}"
          title="Co-Pilot (Cmd+K)"
          style="position:relative"
          @click=${this.toggleChat}
        >
          ✦${this.chatUnread > 0 && !this.chatOpen
            ? html`<span
                style="position:absolute;top:2px;right:2px;background:#ff4444;color:#fff;border-radius:50%;width:14px;height:14px;font-size:9px;display:flex;align-items:center;justify-content:center;line-height:1"
                >${this.chatUnread > 9 ? '9+' : this.chatUnread}</span
              >`
            : ''}
        </button>
        ${location.hostname === 'localhost'
          ? html`
              <a
                class="fa-nav-btn ${this.route === 'dev' ? 'active' : ''}"
                href="#dev"
                title="Dev Harness"
              >
                ~
              </a>
            `
          : ''}
      </nav>
      <div class="fa-main">
        ${this.renderUpdateBanner()}
        <fleet-summary-bar
          .summary=${this.summary}
          .connection=${this.connection}
          .hydrated=${this.hydrated}
          .quota=${this.githubQuota}
          .gatewayUrl=${gateway.gatewayUrl}
          .authMode=${gateway.authCredentialKind}
          @connection-details=${() => this.openPairingPanel()}
        >
        </fleet-summary-bar>
        <global-filter-bar .slots=${this.fleetSlots}> </global-filter-bar>
        ${this.renderMainContent()}
      </div>
      <chat-panel
        .open=${this.chatOpen}
        @close=${() => {
          this.chatOpen = false;
          this.chatUnread = 0;
        }}
        @notification=${() => {
          if (!this.chatOpen) this.chatUnread++;
        }}
      ></chat-panel>
      ${this.renderPairingPanel()} ${this.renderVersionDetailsModal()} ${this.renderWhatsNewModal()}
    `;
  }
}

function pairingCandidatePort(url: string): number | undefined {
  try {
    const port = Number(new URL(url).port);
    return Number.isFinite(port) && port > 0 ? port : undefined;
  } catch {
    // Editable/manual URLs may be incomplete while typing; no port hint is fine.
    return undefined;
  }
}

function pairingCandidateRank(candidate: Pick<PairingCandidate, 'kind'>): number {
  return candidate.kind === 'tailnet' ? 0 : 1;
}

function resolveDefaultPairingGatewayUrl(): string {
  const env = (import.meta as ImportMetaWithEnv).env;
  return env.VITE_FARMSLOT_PAIRING_GATEWAY_URL ?? '';
}

function resolveDefaultRemotePairingGatewayUrl(): string {
  const env = (import.meta as ImportMetaWithEnv).env;
  if (env.VITE_FARMSLOT_REMOTE_GATEWAY_URL) return env.VITE_FARMSLOT_REMOTE_GATEWAY_URL;
  return '';
}

function resolveReleaseState(update: GatewayUpdateStatus | null | undefined): string {
  if (!update) return 'unknown';
  if (update.error) return 'unknown';
  if (update.commitsAhead > 0) return 'UNSTABLE local ahead';
  if (update.branch !== 'main') return `UNSTABLE ${update.branch}`;
  if (update.updateAvailable) return `dev main (${update.commitsBehind} behind)`;
  return 'dev main';
}

function updateFreshnessLabel(update: GatewayUpdateStatus | null | undefined): string {
  if (!update) return 'checking…';
  if (update.updateAvailable) {
    return `${update.commitsBehind} commit(s) behind origin/${update.branch}`;
  }
  if (update.commitsAhead > 0) {
    return `${update.commitsAhead} commit(s) ahead of origin/${update.branch}`;
  }
  return update.lastChecked
    ? `up to date (${new Date(update.lastChecked).toLocaleTimeString()})`
    : 'up to date';
}

declare global {
  interface HTMLElementTagNameMap {
    'farm-app': FarmApp;
  }
}
