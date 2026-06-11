import { html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import QRCode from 'qrcode';

import type {
  ChatClientContext,
  ChatSendIntent,
  FleetSummary,
  GitHubRateLimitPayload,
  PairingCreateResult,
  Run,
  SlotStatus,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import './shared/summary-bar.js';
import './shared/global-filter-bar.js';
import './shared/hydrating-placeholder.js';
import './fleet-map/fleet-canvas.js';
import './terminal/split-view.js';
import './dispatch/dispatch-wizard.js';
import './backlog/backlog-panel.js';
import './pr-dashboard/pr-board.js';
import './decisions/decision-inbox.js';
import './slot-view/slot-view.js';
import './runs/run-list.js';
import './runs/run-detail.js';
import './runs/run-compare.js';
import './runs/family-observability.js';
import './intelligence-audit/intelligence-incidents-panel.js';
import './evals/eval-cockpit.js';
import './finetune/finetune-page.js';
import './device-grid/device-grid.js';
import './chat/chat-panel.js';
import './config/config-panel.js';

import type { ConnectionState } from '../gateway-client.js';
import { gateway } from '../gateway-client.js';
import { type AppState, getState, isFullyHydrated, subscribe } from '../state.js';

import type { ChatPanel } from './chat/chat-panel.js';
import {
  formatElapsed,
  runDisplayColor,
  runDisplayLabel,
  runStatusColor,
  stepStatusColor,
} from './runs/run-utils.js';
import {
  activeSidebarRuns,
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  parseStoredSidebarWidth,
  SIDEBAR_WIDTH_PREF_KEY,
  sidebarPreviewSteps,
  sidebarRunRoute,
  sidebarRunSummary,
} from './app-shell-nav-model.js';
import { renderAppShellAuthStyles, renderAppShellStyles } from './app-shell-styles.js';

type Route =
  | 'fleet'
  | 'terminal'
  | 'devices'
  | 'dispatch'
  | 'backlog'
  | 'prs'
  | 'decisions'
  | 'runs'
  | 'run'
  | 'family'
  | 'run-compare'
  | 'evals'
  | 'finetune'
  | 'intelligence'
  | 'config'
  | 'slot'
  | 'dev';

interface NavItem {
  route: Route;
  icon: string;
  label: string;
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
  { route: 'fleet', icon: '#', label: 'Fleet' },
  { route: 'terminal', icon: '>', label: 'Terminals' },
  { route: 'devices', icon: '=', label: 'Devices' },
  { route: 'dispatch', icon: '!', label: 'Dispatch' },
  { route: 'backlog', icon: '+', label: 'Backlog' },
  { route: 'prs', icon: '&', label: 'PRs' },
  { route: 'decisions', icon: '?', label: 'Decisions' },
  { route: 'runs', icon: '@', label: 'Runs' },
  { route: 'intelligence', icon: 'i', label: 'Intelligence' },
  { route: 'evals', icon: '$', label: 'Evals' },
  { route: 'finetune', icon: '%', label: 'Finetune' },
  { route: 'config', icon: '~', label: 'Config' },
];

const SIDEBAR_PREF_KEY = 'farmslot:sidebar-expanded';
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
  @state() private decisionCount = 0;
  @state() private violationCount = 0;
  @state() private runs: Run[] = [];
  @state() private chatOpen = false;
  @state() private chatUnread = 0;
  @state() private _sidebarExpanded = false;
  @state() private _sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  @state() private _sidebarResizing = false;
  @state() private devHarnessLoaded = false;
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
  @state() private pairingQrDataUrl = '';
  @state() private pairingExpiresAt = '';
  @state() private pairingProfileCount = 0;
  @state() private pairingError = '';
  private unsub?: () => void;
  private sidebarResizeStartX = 0;
  private sidebarResizeStartWidth = DEFAULT_SIDEBAR_WIDTH;

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
    this.syncState(getState());
    this.unsub = subscribe((s) => this.syncState(s));
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
    this.unsub?.();
  }

  private onGlobalKeyDown = (e: KeyboardEvent) => {
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
    const raw = location.hash.replace('#', '') || 'fleet';
    const hash = raw.split('?')[0];
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
      'fleet',
      'terminal',
      'devices',
      'dispatch',
      'backlog',
      'prs',
      'decisions',
      'runs',
      'evals',
      'finetune',
      'intelligence',
      'config',
    ];
    this.route = valid.includes(hash as Route) ? (hash as Route) : 'fleet';
    this.slotParam = '';
    this.configParam = '';
  }

  private getRouteFromHash(): Route {
    this.parseHash();
    return this.route;
  }

  private navigate(route: Route) {
    location.hash = route;
  }

  private syncState(s: AppState) {
    this.summary = s.fleet?.summary ?? null;
    this.fleetSlots = s.fleet?.slots ?? [];
    this.connection = s.connection;
    this.hydrated = isFullyHydrated(s.hydrated);
    this.githubQuota = s.githubQuota;
    this.decisionCount = s.decisions.length;
    this.violationCount = s.violations.length;
    this.runs = s.runs;
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
    this.pairingQrDataUrl = '';
    this.pairingExpiresAt = '';
  }

  private closePairingPanel() {
    this.pairingOpen = false;
  }

  private async createCompanionPairing(event?: Event) {
    event?.preventDefault();
    const targets = [
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

  private renderActiveRunsNav() {
    const activeRuns = activeSidebarRuns(this.runs);
    const totalActiveRuns = activeSidebarRuns(this.runs, Number.MAX_SAFE_INTEGER).length;
    if (!this._sidebarExpanded) return nothing;
    return html`
      <div class="fa-active-runs" aria-label="Active runs">
        <div class="fa-active-runs-head">
          <span>Active runs</span>
          <span>${totalActiveRuns}</span>
        </div>
        ${activeRuns.length === 0
          ? html`<div class="fa-active-runs-empty">none</div>`
          : html`${activeRuns.map((run) => this.renderActiveRunShortcut(run))}
            ${totalActiveRuns > activeRuns.length
              ? html`<a class="fa-active-runs-more" href="#runs"
                  >+${totalActiveRuns - activeRuns.length} more</a
                >`
              : nothing}`}
      </div>
    `;
  }

  private renderActiveRunShortcut(run: Run) {
    const route = sidebarRunRoute(run);
    const selected =
      (this.route === 'slot' && run.slotId === this.slotParam) ||
      (this.route === 'run' && run.id === this.runParam);
    const flowColor = runDisplayColor(run);
    const statusColor = runStatusColor(run.status);
    const steps = sidebarPreviewSteps(run.steps);
    const summary = sidebarRunSummary(run);
    return html`
      <a
        class="fa-active-run ${selected ? 'active' : ''}"
        href=${route}
        title=${`${run.ticketOrPr} · ${summary}`}
      >
        <div class="fa-active-run-top">
          <span class="fa-active-run-ticket">${run.ticketOrPr}</span>
          <span class="fa-active-run-flow" style="--flow-color:${flowColor}"
            >${runDisplayLabel(run)}</span
          >
        </div>
        <div class="fa-active-run-summary">${summary}</div>
        <div class="fa-active-run-meta">
          <span style="color:${statusColor}">${run.status}</span>
          ${run.slotId ? html`<span>${run.slotId}</span>` : html`<span>no slot</span>`}
          <span>${formatElapsed(run.createdAt)}</span>
        </div>
        ${steps.length
          ? html`<div class="fa-active-run-steps">
              ${steps.map(
                (step) =>
                  html`<span
                    class="fa-active-run-step"
                    style="--step-color:${stepStatusColor(step.status)}"
                    title=${`${step.name}: ${step.status}`}
                  ></span>`,
              )}
            </div>`
          : nothing}
      </a>
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
      case 'fleet':
        return html`<fleet-canvas></fleet-canvas>`;
      case 'terminal':
        return html`<terminal-split-view .initialSlot=${this.slotParam}></terminal-split-view>`;
      case 'devices':
        return html`<device-grid></device-grid>`;
      case 'dispatch':
        return html`<dispatch-wizard></dispatch-wizard>`;
      case 'backlog':
        return html`<backlog-panel></backlog-panel>`;
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
      case 'config':
        return html`<config-panel .initialPath=${this.configParam}></config-panel>`;
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
    if (this.connection === 'auth_required') return this.renderAuthScreen();
    const activeRunCount = activeSidebarRuns(this.runs, Number.MAX_SAFE_INTEGER).length;

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
        ${NAV_ITEMS.map(
          (item) => html`
            <a
              class="fa-nav-btn ${this.route === item.route ? 'active' : ''}"
              href="#${item.route}"
              title="${item.label}"
            >
              ${item.icon}${this._sidebarExpanded
                ? html`<span class="fa-nav-label">${item.label}</span>`
                : ''}
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
            ${item.route === 'runs' ? this.renderActiveRunsNav() : nothing}
          `,
        )}
        <div class="fa-sidebar-resize" @pointerdown=${this.onSidebarResizeStart}></div>
        <div style="flex:1"></div>
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
        <div class="fa-content">${this.renderContent()}</div>
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
      ${this.renderPairingPanel()}
    `;
  }
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

declare global {
  interface HTMLElementTagNameMap {
    'farm-app': FarmApp;
  }
}
