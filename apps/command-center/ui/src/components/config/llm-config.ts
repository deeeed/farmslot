import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  LLMAuthListResult,
  LLMAuthLoginProgress,
  LLMAuthLoginResult,
  LLMAuthRefreshResult,
  LLMAuthTestResult,
  LLMConfigGetResult,
  LLMTiersResult,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';
import { Events as ProtocolEvents } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

interface ProviderCard {
  name: string;
  label: string;
  hasKey: boolean;
  source: string; // 'store' | 'env' | 'openclaw' | 'none'
  /** Profile id of the active stored credential, if any (any credential type). */
  storedProfileId?: string;
  /** Stored credential type: 'api_key' | 'token' | 'oauth'. */
  storedType?: string;
  /** Count of additional stored profiles for this provider beyond the active one (so the card can hint at them). */
  otherProfileCount?: number;
  /** Env var that supplies the key when source is 'env'. */
  envVarName?: string;
  /** Access-token expiry (ms epoch) for the active OAuth credential. */
  oauthExpires?: number;
  oauthEmail?: string;
  oauthHasRefresh?: boolean;
}

@customElement('llm-config')
export class LLMConfig extends LitElement {
  @state() private _config: LLMConfigGetResult | null = null;
  @state() private _providers: ProviderCard[] = [];
  @state() private _tiers: Record<string, Record<string, string>> = {};
  @state() private _loading = true;
  @state() private _testing: string | null = null;
  @state() private _testResult: LLMAuthTestResult | null = null;
  @state() private _keyInput: Record<string, string> = {};
  @state() private _importHost = '';
  @state() private _importUser = '';
  @state() private _importStatus = '';
  @state() private _importOverwrite = false;
  @state() private _refreshing: string | null = null;
  @state() private _refreshStatus: Record<string, string> = {};
  @state() private _loginProvider: string | null = null;
  @state() private _loginStatus: string = '';
  @state() private _loginUrl: string = '';
  // Latches true the moment the login flow settles (success / fail / timeout)
  // so the OAuth Sign-In section keeps rendering the final status until the
  // user explicitly dismisses it. Without this, a failure / timeout would
  // hide the section the instant `_loginProvider` is cleared, swallowing the
  // error message before the user could read it.
  @state() private _loginCompleted: boolean = false;
  private _loginUnsubscribe: (() => void) | null = null;

  static override styles = css`
    :host {
      display: block;
      padding: ${unsafeCSS(spacing.lg)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
    }
    h2 {
      margin: 0 0 ${unsafeCSS(spacing.md)} 0;
      font-size: 1.1rem;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    h3 {
      margin: ${unsafeCSS(spacing.lg)} 0 ${unsafeCSS(spacing.sm)} 0;
      font-size: 0.95rem;
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .provider-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: ${unsafeCSS(spacing.md)};
    }
    .provider-card {
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.md)};
    }
    .provider-card.active {
      border-color: ${unsafeCSS(colors.accent)};
    }
    .provider-name {
      font-weight: bold;
      margin-bottom: ${unsafeCSS(spacing.xs)};
    }
    .provider-status {
      font-size: 0.8rem;
      margin-bottom: ${unsafeCSS(spacing.sm)};
    }
    .status-ok {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .status-none {
      color: ${unsafeCSS(colors.textMuted)};
    }

    .key-row {
      display: flex;
      gap: ${unsafeCSS(spacing.xs)};
      margin-bottom: ${unsafeCSS(spacing.xs)};
    }
    .key-input {
      flex: 1;
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textPrimary)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.sm)};
      padding: 4px 8px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 0.8rem;
    }
    button {
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textPrimary)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.sm)};
      padding: 4px 12px;
      cursor: pointer;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 0.8rem;
    }
    button:hover {
      border-color: ${unsafeCSS(colors.accent)};
    }
    button.primary {
      background: ${unsafeCSS(colors.accent)};
      color: white;
      border-color: ${unsafeCSS(colors.accent)};
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-row {
      display: flex;
      gap: ${unsafeCSS(spacing.xs)};
    }

    .test-result {
      margin-top: ${unsafeCSS(spacing.xs)};
      font-size: 0.8rem;
      padding: 4px 8px;
      border-radius: ${unsafeCSS(radii.sm)};
    }
    .test-ok {
      background: rgba(0, 255, 136, 0.1);
      color: ${unsafeCSS(colors.statusOk)};
    }
    .test-fail {
      background: rgba(255, 68, 68, 0.1);
      color: ${unsafeCSS(colors.statusFail)};
    }

    .tier-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
      margin-top: ${unsafeCSS(spacing.sm)};
    }
    .tier-table th,
    .tier-table td {
      padding: 4px 8px;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      text-align: left;
    }
    .tier-table th {
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .import-section {
      margin-top: ${unsafeCSS(spacing.lg)};
      padding: ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgCard)};
      border-radius: ${unsafeCSS(radii.md)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    }
    .import-row {
      display: flex;
      gap: ${unsafeCSS(spacing.xs)};
      align-items: center;
      margin-top: ${unsafeCSS(spacing.xs)};
    }
    .import-status {
      font-size: 0.8rem;
      margin-top: ${unsafeCSS(spacing.xs)};
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this._loadData();
  }

  private async _loadData() {
    this._loading = true;
    try {
      const [configRes, authRes, tiersRes] = await Promise.all([
        gateway.request(Methods.LLM_CONFIG_GET, {}) as Promise<LLMConfigGetResult>,
        gateway.request(Methods.LLM_AUTH_LIST, {}) as Promise<LLMAuthListResult>,
        gateway.request(Methods.LLM_TIERS, {}) as Promise<LLMTiersResult>,
      ]);
      this._config = configRes;
      this._tiers = tiersRes.tiers;

      const knownProviders = ['openai-codex', 'openai', 'anthropic', 'google'];
      this._providers = knownProviders.map((name) => {
        const storedProfiles = authRes.profiles.filter((p) => p.provider === name && p.hasKey);
        const hasProfile = storedProfiles.length > 0;
        const hasEnv = authRes.envProviders.includes(name);
        const hasClaw = authRes.openclawProviders.includes(name);
        // Resolution priority mirrors gateway resolveAuth: store > env > openclaw.
        // Within store, prefer OAuth (richer metadata, supports refresh) and the
        // latest expiry; fall back to the first non-oauth profile if no oauth exists.
        const oauthProfile = storedProfiles
          .filter((p) => p.type === 'oauth')
          .sort((a, b) => (b.expires ?? 0) - (a.expires ?? 0))[0];
        const activeProfile = oauthProfile ?? storedProfiles[0];
        // TODO: render one card per profile rather than picking the freshest
        // and hinting at the rest. For now we pick latest-expiry and surface
        // a "+N other profiles" badge so users know stale ones are still
        // around — the gateway-side Refresh fans out by provider prefix and
        // hits all of them, but the operator can only manage them via CLI.
        const otherProfileCount = activeProfile ? Math.max(0, storedProfiles.length - 1) : 0;
        return {
          name,
          label:
            name === 'openai-codex' ? 'OpenAI Codex' : name.charAt(0).toUpperCase() + name.slice(1),
          hasKey: hasProfile || hasEnv || hasClaw,
          // Match gateway resolveAuth() precedence (auth-resolve.ts):
          // farmslot store → openclaw → env → none. The previous UI ordering
          // (env before openclaw) misled operators when both existed: card
          // showed "env" while the gateway was actually using openclaw.
          source: hasProfile ? 'store' : hasClaw ? 'openclaw' : hasEnv ? 'env' : 'none',
          storedProfileId: activeProfile?.profileId,
          storedType: activeProfile?.type,
          otherProfileCount,
          oauthExpires: oauthProfile?.expires,
          oauthEmail: oauthProfile?.email,
          oauthHasRefresh: oauthProfile?.hasRefresh,
        };
      });
    } catch (err) {
      console.error('[llm-config] load failed:', err);
    }
    this._loading = false;
  }

  private async _setProvider(provider: string) {
    await gateway.request(Methods.LLM_CONFIG_SET, { defaultProvider: provider });
    this._config = { ...this._config!, defaultProvider: provider };
  }

  private async _addKey(provider: string) {
    const key = this._keyInput[provider];
    if (!key) return;
    await gateway.request(Methods.LLM_AUTH_ADD, { provider, type: 'api_key', credential: key });
    this._keyInput = { ...this._keyInput, [provider]: '' };
    await this._loadData();
  }

  private async _testProvider(provider: string) {
    this._testing = provider;
    this._testResult = null;
    const tier = this._config?.intelligenceModel ?? 'fast';
    try {
      this._testResult = (await gateway.request(Methods.LLM_AUTH_TEST, {
        provider,
        model: tier,
      })) as LLMAuthTestResult;
    } catch (err) {
      // Surface the tier we actually attempted, not a hardcoded 'fast', so
      // the failure card matches what the user sees on the success path.
      this._testResult = { ok: false, provider, model: tier, error: (err as Error).message };
    }
    this._testing = null;
  }

  private async _importLocal() {
    this._importStatus = 'Importing from local OpenClaw...';
    try {
      const res = await gateway.request(Methods.LLM_AUTH_IMPORT, {
        overwrite: this._importOverwrite,
      });
      this._importStatus = this._summariseImport(
        res as {
          imported: number;
          profiles: string[];
          skippedExisting?: string[];
          overwritten?: string[];
        },
      );
      await this._loadData();
    } catch (err) {
      this._importStatus = `Error: ${(err as Error).message}`;
    }
  }

  private async _importRemote() {
    if (!this._importHost) return;
    this._importStatus = `Importing from ${this._importHost}...`;
    try {
      const res = await gateway.request(Methods.LLM_AUTH_IMPORT, {
        source: 'remote',
        host: this._importHost,
        sshUser: this._importUser,
        overwrite: this._importOverwrite,
      });
      this._importStatus = this._summariseImport(
        res as {
          imported: number;
          profiles: string[];
          skippedExisting?: string[];
          overwritten?: string[];
        },
      );
      await this._loadData();
    } catch (err) {
      this._importStatus = `Error: ${(err as Error).message}`;
    }
  }

  private _summariseImport(res: {
    imported: number;
    profiles: string[];
    skippedExisting?: string[];
    overwritten?: string[];
  }): string {
    const parts = [`${res.imported} profile(s) imported`];
    if (res.overwritten?.length) parts.push(`${res.overwritten.length} overwritten`);
    if (res.skippedExisting?.length)
      parts.push(
        `${res.skippedExisting.length} skipped (already exist — enable Overwrite to replace)`,
      );
    return parts.join(', ');
  }

  private async _refreshProvider(provider: string, profileId: string | undefined) {
    this._refreshing = provider;
    try {
      if (!profileId) {
        this._refreshStatus = { ...this._refreshStatus, [provider]: 'No OAuth profile to refresh' };
        return;
      }
      // Scope to the exact profile rendered on this card. Sending {} would
      // fan out to every OAuth profile in the local store — rotating
      // unrelated tokens (other accounts on the same provider, other
      // providers entirely) and surfacing failures the operator never
      // asked for.
      const res = (await gateway.request(Methods.LLM_AUTH_REFRESH, {
        profileId,
      })) as LLMAuthRefreshResult;
      const matching = res.outcomes.filter((o) => o.profileId === profileId);
      if (matching.length === 0) {
        this._refreshStatus = {
          ...this._refreshStatus,
          [provider]: `No outcome returned for ${profileId}`,
        };
      } else {
        const ok = matching.filter((o) => o.ok);
        const fail = matching.filter((o) => !o.ok);
        const parts = [];
        if (ok.length)
          parts.push(
            `refreshed ${profileId} (new expiry ${ok[0].expiresAfter ? new Date(ok[0].expiresAfter).toISOString().slice(0, 16).replace('T', ' ') : '?'})`,
          );
        if (fail.length) parts.push(`failed: ${fail.map((f) => f.error).join('; ')}`);
        this._refreshStatus = { ...this._refreshStatus, [provider]: parts.join(' — ') };
      }
      await this._loadData();
    } catch (err) {
      this._refreshStatus = {
        ...this._refreshStatus,
        [provider]: `Error: ${(err as Error).message}`,
      };
    }
    this._refreshing = null;
  }

  private async _loginProviderStart(provider: string, profileId?: string) {
    if (this._loginUnsubscribe) {
      this._loginUnsubscribe();
      this._loginUnsubscribe = null;
    }
    this._loginProvider = provider;
    this._loginCompleted = false;
    this._loginStatus = 'Starting OAuth flow...';
    this._loginUrl = '';

    this._loginUnsubscribe = gateway.subscribe<LLMAuthLoginProgress>(
      ProtocolEvents.LLM_AUTH_LOGIN_PROGRESS,
      (progress) => {
        if (progress.provider !== provider) return;
        if (progress.url) this._loginUrl = progress.url;
        if (progress.message) this._loginStatus = progress.message;
      },
    );

    try {
      // Server-side OAuth login waits up to OAUTH_LOGIN_TIMEOUT_MS (5 min)
      // for the browser callback. Match that cap on the client request so
      // a normal human login isn't aborted at the default 15s and so we
      // don't unsubscribe from progress events while the gateway is still
      // holding port 1455. Add a small buffer to cover the WS round-trip.
      const LOGIN_REQUEST_TIMEOUT_MS = 5 * 60 * 1000 + 30_000;
      const res = (await gateway.request(
        Methods.LLM_AUTH_LOGIN,
        { provider, ...(profileId ? { profileId } : {}) },
        LOGIN_REQUEST_TIMEOUT_MS,
      )) as LLMAuthLoginResult;
      if (res.ok) {
        this._loginStatus = `Signed in as ${res.email ?? res.profileId ?? 'OAuth profile'}`;
        await this._loadData();
      } else {
        this._loginStatus = `Failed: ${res.error}`;
      }
    } catch (err) {
      this._loginStatus = `Failed: ${(err as Error).message}`;
    }
    this._loginUnsubscribe?.();
    this._loginUnsubscribe = null;
    // Keep _loginProvider set so the OAuth Sign-In section stays rendered
    // showing the final status. _loginCompleted gates the disabled state on
    // the per-provider Sign in button + reveals the Dismiss button.
    this._loginCompleted = true;
  }

  private _dismissLoginResult() {
    this._loginProvider = null;
    this._loginCompleted = false;
    this._loginStatus = '';
    this._loginUrl = '';
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._loginUnsubscribe?.();
    this._loginUnsubscribe = null;
  }

  override render() {
    if (this._loading) return html`<div>Loading LLM config...</div>`;

    return html`
      <h2>LLM Provider Settings</h2>

      <div class="provider-grid">${this._providers.map((p) => this._renderProviderCard(p))}</div>

      <h3>Tier Mapping</h3>
      ${this._renderTierTable()}

      <h3>Import from OpenClaw</h3>
      <div class="import-section">
        <label
          style="display:flex;gap:0.5rem;align-items:center;font-size:0.85rem;margin-bottom:0.5rem"
        >
          <input
            type="checkbox"
            .checked=${this._importOverwrite}
            @change=${(e: Event) => {
              this._importOverwrite = (e.target as HTMLInputElement).checked;
            }}
          />
          Overwrite existing profiles (replaces local copies that share an id)
        </label>
        <div class="btn-row">
          <button @click=${this._importLocal}>Import Local</button>
        </div>
        <div class="import-row">
          <input
            class="key-input"
            placeholder="hostname (e.g. runner.local)"
            .value=${this._importHost}
            @input=${(e: Event) => {
              this._importHost = (e.target as HTMLInputElement).value;
            }}
          />
          <input
            class="key-input"
            style="max-width:120px"
            placeholder="ssh user"
            .value=${this._importUser}
            @input=${(e: Event) => {
              this._importUser = (e.target as HTMLInputElement).value;
            }}
          />
          <button @click=${this._importRemote} ?disabled=${!this._importHost}>Import Remote</button>
        </div>
        ${this._importStatus
          ? html`<div class="import-status">${this._importStatus}</div>`
          : nothing}
      </div>

      ${this._loginProvider
        ? html`
            <h3>OAuth Sign-In: ${this._loginProvider}</h3>
            <div class="import-section">
              ${this._loginUrl
                ? html`
                    <div class="import-status">
                      Open this URL in your browser to authorize:
                      <div style="margin-top:0.4rem">
                        <a
                          href=${this._loginUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          style="color:${colors.accent};word-break:break-all"
                          >${this._loginUrl}</a
                        >
                      </div>
                    </div>
                  `
                : nothing}
              ${this._loginStatus
                ? html`<div class="import-status">${this._loginStatus}</div>`
                : nothing}
              ${this._loginCompleted
                ? html`
                    <div class="btn-row" style="margin-top:0.5rem">
                      <button @click=${() => this._dismissLoginResult()}>Dismiss</button>
                    </div>
                  `
                : nothing}
            </div>
          `
        : nothing}
    `;
  }

  private _formatExpiry(ms: number): { text: string; expired: boolean; expiringSoon: boolean } {
    const now = Date.now();
    const deltaMs = ms - now;
    const expired = deltaMs <= 0;
    const expiringSoon = !expired && deltaMs < 24 * 60 * 60 * 1000;
    const absHours = Math.abs(deltaMs) / (60 * 60 * 1000);
    const absDays = absHours / 24;
    const dateStr = new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
    if (expired) {
      const ago = absDays >= 1 ? `${Math.floor(absDays)}d` : `${Math.floor(absHours)}h`;
      return { text: `EXPIRED ${ago} ago — ${dateStr}`, expired, expiringSoon: false };
    }
    const left = absDays >= 1 ? `${Math.floor(absDays)}d` : `${Math.floor(absHours)}h`;
    return { text: `expires in ${left} (${dateStr})`, expired: false, expiringSoon };
  }

  private _renderProviderCard(p: ProviderCard) {
    const isActive = this._config?.defaultProvider === p.name;
    const expiryInfo = p.oauthExpires !== undefined ? this._formatExpiry(p.oauthExpires) : null;
    const supportsOAuthLogin = p.name === 'openai-codex';
    return html`
      <div class="provider-card ${isActive ? 'active' : ''}">
        <div class="provider-name">
          ${p.label}
          ${isActive ? html`<span style="color:${colors.accent}">(active)</span>` : nothing}
        </div>
        <div class="provider-status ${p.hasKey ? 'status-ok' : 'status-none'}">
          ${p.hasKey ? `Key: ${p.source}` : 'No key configured'}
        </div>
        ${p.storedProfileId
          ? html`
              <div style="font-size:0.75rem;color:${colors.textMuted};margin:0.15rem 0">
                Profile: <code>${p.storedProfileId}</code> (${p.storedType})${p.otherProfileCount &&
                p.otherProfileCount > 0
                  ? html` <span style="opacity:0.7">+${p.otherProfileCount} other</span>`
                  : nothing}
              </div>
            `
          : nothing}
        ${p.storedType === 'oauth'
          ? html`
              <div style="font-size:0.75rem;color:${colors.textMuted};margin:0.15rem 0">
                ${p.oauthEmail ? html`<div>${p.oauthEmail}</div>` : nothing}
                ${expiryInfo
                  ? html`
                      <div
                        style="color:${expiryInfo.expired
                          ? colors.statusFail
                          : expiryInfo.expiringSoon
                            ? colors.statusWarn
                            : colors.textMuted}"
                      >
                        ${expiryInfo.text}
                      </div>
                    `
                  : nothing}
                ${!p.oauthHasRefresh
                  ? html`<div style="color:${colors.statusWarn}">
                      No refresh token — re-sign in required
                    </div>`
                  : nothing}
              </div>
            `
          : nothing}
        <div class="key-row">
          <input
            class="key-input"
            type="password"
            placeholder="sk-... or API key"
            .value=${this._keyInput[p.name] ?? ''}
            @input=${(e: Event) => {
              this._keyInput = {
                ...this._keyInput,
                [p.name]: (e.target as HTMLInputElement).value,
              };
            }}
          />
          <button @click=${() => this._addKey(p.name)} ?disabled=${!this._keyInput[p.name]}>
            Save
          </button>
        </div>
        <div class="btn-row">
          ${!isActive
            ? html`<button class="primary" @click=${() => this._setProvider(p.name)}>
                Set Active
              </button>`
            : nothing}
          <button @click=${() => this._testProvider(p.name)} ?disabled=${this._testing === p.name}>
            ${this._testing === p.name ? 'Testing...' : 'Test'}
          </button>
          ${p.oauthHasRefresh
            ? html`
                <button
                  @click=${() => this._refreshProvider(p.name, p.storedProfileId)}
                  ?disabled=${this._refreshing === p.name}
                >
                  ${this._refreshing === p.name ? 'Refreshing...' : 'Refresh OAuth'}
                </button>
              `
            : nothing}
          ${supportsOAuthLogin
            ? html`
                <button
                  @click=${() => this._loginProviderStart(p.name, p.storedProfileId)}
                  ?disabled=${this._loginProvider === p.name && !this._loginCompleted}
                >
                  ${this._loginProvider === p.name && !this._loginCompleted
                    ? 'Signing in...'
                    : p.storedType === 'oauth'
                      ? 'Re-sign in'
                      : 'Sign in'}
                </button>
              `
            : nothing}
        </div>
        ${this._refreshStatus[p.name]
          ? html` <div class="test-result test-ok">${this._refreshStatus[p.name]}</div> `
          : nothing}
        ${this._testResult?.provider === p.name
          ? html`
              <div class="test-result ${this._testResult.ok ? 'test-ok' : 'test-fail'}">
                ${this._testResult.ok
                  ? html`OK — ${this._testResult.responsePreview}
                      (${this._testResult.usage?.durationMs}ms)
                      <div style="margin-top:0.2rem;font-size:0.7rem">
                        Source: <code>${this._testResult.source}</code>
                      </div>
                      ${this._testResult.source === 'cli'
                        ? html`
                            <div
                              style="margin-top:0.2rem;font-size:0.7rem;color:${colors.statusWarn}"
                            >
                              ⚠ No stored key/profile matched — the gateway fell back to the local
                              Claude CLI. This works only on machines where you've run
                              <code>claude auth</code> interactively, and uses your CLI session, not
                              a managed credential. Add an API key or sign in via OAuth to make this
                              provider portable.
                            </div>
                          `
                        : nothing}`
                  : html`Failed: ${this._testResult.error}`}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private _renderTierTable() {
    const tierNames = Object.keys(this._tiers);
    if (!tierNames.length) {
      return html`<div style="font-size:0.8rem;color:${colors.textMuted}">No tier data</div>`;
    }
    const providers = Object.keys(this._tiers[tierNames[0]] ?? {});

    return html`
      <table class="tier-table">
        <thead>
          <tr>
            <th>Tier</th>
            ${providers.map((p) => html`<th>${p}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${tierNames.map(
            (tier) => html`
              <tr>
                <td><strong>${tier}</strong></td>
                ${providers.map((p) => html`<td>${this._tiers[tier]?.[p] ?? '—'}</td>`)}
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'llm-config': LLMConfig;
  }
}
