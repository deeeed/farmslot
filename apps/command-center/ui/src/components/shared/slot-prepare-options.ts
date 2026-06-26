import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { SlotHealth } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import {
  type PrepareProfileOption,
  projectPrepareProfiles,
} from '../dispatch/dispatch-wizard-draft.js';
import { requestProjectConfigs } from '../dispatch/dispatch-wizard-loaders.js';

import {
  buildSlotPreparePlan,
  DEFAULT_SLOT_PREPARE_OPTIONS,
  loadSlotPreparePrefs,
  reconcilePrepareProfile,
  saveSlotPreparePrefs,
  type SlotPrepareOptionsState,
  type SlotPreparePlan,
  suggestPrepareRecovery,
} from './slot-prepare-options-model.js';

export type SlotPrepareOptionsVariant = 'operator' | 'dispatch' | 'replay';

export interface SlotPrepareOptionsChangeDetail extends SlotPrepareOptionsState {
  plan: SlotPreparePlan | null;
  skipPrepare?: boolean;
}

@customElement('slot-prepare-options')
export class SlotPrepareOptions extends LitElement {
  @property() project = '';
  @property() variant: SlotPrepareOptionsVariant = 'operator';
  @property({ attribute: false }) profiles: PrepareProfileOption[] = [];
  @property() prepareProfile = DEFAULT_SLOT_PREPARE_OPTIONS.prepareProfile;
  @property({ type: Boolean }) strictProfile = DEFAULT_SLOT_PREPARE_OPTIONS.strictProfile;
  @property({ type: Boolean }) forcePrepare = DEFAULT_SLOT_PREPARE_OPTIONS.forcePrepare;
  @property({ type: Boolean }) skipPrepare = false;
  @property({ type: Boolean, attribute: 'persist-prefs' }) persistPrefs = true;
  @property({ type: Boolean, attribute: 'show-plan' }) showPlan = true;
  @property({ type: Boolean }) showAdvanced = true;
  @property({ type: Boolean }) compact = false;
  @property({ type: Boolean }) disabled = false;
  @property() lastError = '';
  @property() runBranch = '';
  @property() slotBranch = '';
  @property({ attribute: false }) slotHealth: SlotHealth | null = null;

  @state() private _advancedOpen = false;
  @state() private _profilesLoadedFor = '';
  @state() private _projectConfigs: Awaited<ReturnType<typeof requestProjectConfigs>> = [];

  static override styles = css`
    :host {
      display: block;
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .spo-wrap {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.sm)};
    }
    .spo-label {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .spo-pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .spo-pill {
      padding: 5px 12px;
      border-radius: ${unsafeCSS(radii.sm)};
      border: 1px solid #2a2a44;
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }
    .spo-pill:hover:not(:disabled) {
      border-color: ${unsafeCSS(colors.accent)}66;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .spo-pill.selected {
      border-color: ${unsafeCSS(colors.accent)};
      background: ${unsafeCSS(colors.accent)}18;
      color: ${unsafeCSS(colors.accent)};
      font-weight: 700;
    }
    .spo-pill:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .spo-help,
    .spo-plan-line {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 11px;
      line-height: 1.45;
    }
    .spo-plan {
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.bgCard)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .spo-plan-mode {
      color: ${unsafeCSS(colors.accent)};
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .spo-warn {
      color: ${unsafeCSS(colors.statusWarn)};
      font-size: 11px;
      line-height: 1.4;
    }
    .spo-advanced-toggle {
      border: none;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 11px;
      cursor: pointer;
      padding: 0;
      text-align: left;
    }
    .spo-advanced-toggle:hover {
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .spo-advanced {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-left: 2px;
    }
    .spo-check {
      display: flex;
      align-items: center;
      gap: 8px;
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: 11px;
      cursor: pointer;
    }
    .spo-check input {
      accent-color: ${unsafeCSS(colors.accent)};
    }
    .spo-recovery {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 2px;
    }
    .spo-recovery-btn {
      border: 1px solid ${unsafeCSS(colors.statusWarn)}44;
      background: ${unsafeCSS(colors.statusWarn)}18;
      color: ${unsafeCSS(colors.statusWarn)};
      border-radius: ${unsafeCSS(radii.sm)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 11px;
      padding: 4px 8px;
      cursor: pointer;
    }
    .spo-recovery-btn.secondary {
      border-color: #2a2a44;
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .spo-error {
      color: ${unsafeCSS(colors.statusWarn)};
      font-size: 11px;
      line-height: 1.45;
    }
    :host([compact]) .spo-help {
      display: none;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    if (this.project) void this._ensureProfiles();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has('project') && this.project) {
      void this._ensureProfiles();
    }
    if (
      changed.has('prepareProfile') ||
      changed.has('strictProfile') ||
      changed.has('forcePrepare') ||
      changed.has('runBranch') ||
      changed.has('slotBranch') ||
      changed.has('slotHealth')
    ) {
      this._emitChange();
    }
  }

  private async _ensureProfiles() {
    if (!this.project || this._profilesLoadedFor === this.project) return;
    this._profilesLoadedFor = this.project;
    try {
      this._projectConfigs = await requestProjectConfigs();
      const profiles = projectPrepareProfiles(this._projectConfigs, this.project);
      if (profiles.length > 0) {
        this.profiles = profiles;
      }
      if (this.persistPrefs && this.variant === 'operator') {
        const prefs = loadSlotPreparePrefs(this.project);
        this.prepareProfile = reconcilePrepareProfile(
          this.profiles,
          prefs.prepareProfile ?? this.prepareProfile,
        );
        if (typeof prefs.strictProfile === 'boolean') this.strictProfile = prefs.strictProfile;
        if (typeof prefs.forcePrepare === 'boolean') this.forcePrepare = prefs.forcePrepare;
        this._emitChange();
      }
    } catch (err) {
      console.warn('[slot-prepare-options] profile load failed:', err);
    }
  }

  private _plan(): SlotPreparePlan | null {
    if (!this.showPlan || this.variant !== 'operator') return null;
    if (!this.runBranch && !this.slotBranch) return null;
    return buildSlotPreparePlan({
      runBranch: this.runBranch,
      slotBranch: this.slotBranch,
      slotHealth: this.slotHealth,
      strictProfile: this.strictProfile,
      prepareProfile: this.prepareProfile,
      forcePrepare: this.forcePrepare,
    });
  }

  private _emitChange(overrides: Partial<SlotPrepareOptionsChangeDetail> = {}) {
    const detail: SlotPrepareOptionsChangeDetail = {
      prepareProfile: this.prepareProfile,
      strictProfile: this.strictProfile,
      forcePrepare: this.forcePrepare,
      plan: this._plan(),
      ...(this.variant === 'dispatch' ? { skipPrepare: this.skipPrepare } : {}),
      ...overrides,
    };
    if (this.persistPrefs && this.variant === 'operator' && this.project) {
      saveSlotPreparePrefs(this.project, detail);
    }
    this.dispatchEvent(
      new CustomEvent<SlotPrepareOptionsChangeDetail>('prepare-options-change', {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }

  private _isProfileSelected(profile: PrepareProfileOption): boolean {
    if (this.skipPrepare) return false;
    return this.prepareProfile ? this.prepareProfile === profile.name : profile.isDefault;
  }

  private _setProfile(name: string) {
    if (this.disabled) return;
    if (this.variant === 'replay') {
      this.dispatchEvent(
        new CustomEvent<{ prepareProfile: string }>('profile-action', {
          bubbles: true,
          composed: true,
          detail: { prepareProfile: name },
        }),
      );
      return;
    }
    if (this.variant === 'dispatch') {
      const profile = this.profiles.find((entry) => entry.name === name);
      this._emitChange({
        prepareProfile: profile?.isDefault ? '' : name,
        skipPrepare: false,
      });
      return;
    }
    if (this.prepareProfile === name) return;
    this.prepareProfile = name;
    this._emitChange();
  }

  private _setDispatchSkipPrepare() {
    if (this.disabled) return;
    this._emitChange({ skipPrepare: true });
  }

  private _setDispatchFullPrepare() {
    if (this.disabled) return;
    this._emitChange({ prepareProfile: '', skipPrepare: false });
  }

  private _emitSkipPrepareAction() {
    if (this.disabled) return;
    this.dispatchEvent(new CustomEvent('skip-prepare-action', { bubbles: true, composed: true }));
  }

  private _setStrictProfile(value: boolean) {
    if (this.disabled || this.strictProfile === value) return;
    this.strictProfile = value;
    this._emitChange();
  }

  private _setForcePrepare(value: boolean) {
    if (this.disabled || this.forcePrepare === value) return;
    this.forcePrepare = value;
    this._emitChange();
  }

  private _emitRecovery(profile: string | null, strictProfile: boolean) {
    this.dispatchEvent(
      new CustomEvent<{ prepareProfile: string; strictProfile: boolean }>('recovery-retry', {
        bubbles: true,
        composed: true,
        detail: {
          prepareProfile: profile ?? this.prepareProfile,
          strictProfile,
        },
      }),
    );
  }

  override render() {
    const profiles = this.profiles.length > 0 ? this.profiles : [];
    const plan = this._plan();
    const label =
      this.variant === 'dispatch'
        ? 'Prepare'
        : this.variant === 'replay'
          ? 'Retry prepare profile'
          : 'Prepare profile';
    const recovery =
      this.variant === 'operator' && this.lastError
        ? suggestPrepareRecovery(
            this.lastError,
            this.prepareProfile,
            this._projectConfigs,
            this.project,
          )
        : { profile: null, label: '' };

    return html`
      <div class="spo-wrap">
        <div class="spo-label">${label}</div>
        <div class="spo-pill-row">
          ${this.variant === 'dispatch' && profiles.length === 0
            ? html`
                <button
                  class="spo-pill ${!this.skipPrepare ? 'selected' : ''}"
                  ?disabled=${this.disabled}
                  @click=${this._setDispatchFullPrepare}
                >
                  Full Prepare
                </button>
              `
            : profiles.map(
                (profile) => html`
                  <button
                    class="spo-pill ${this._isProfileSelected(profile) ? 'selected' : ''}"
                    ?disabled=${this.disabled}
                    title=${profile.label}
                    @click=${() => this._setProfile(profile.name)}
                  >
                    ${profile.name}${profile.isDefault ? ' ★' : ''}
                  </button>
                `,
              )}
          ${this.variant === 'dispatch'
            ? html`
                <button
                  class="spo-pill ${this.skipPrepare ? 'selected' : ''}"
                  ?disabled=${this.disabled}
                  title="Run no preparation at all — operator owns slot state"
                  @click=${this._setDispatchSkipPrepare}
                >
                  Skip Prepare
                </button>
              `
            : nothing}
          ${this.variant === 'replay'
            ? html`
                <button
                  class="spo-pill"
                  ?disabled=${this.disabled}
                  title="Replay with no preparation at all — no health gating, you own slot state"
                  @click=${this._emitSkipPrepareAction}
                >
                  Skip Prepare
                </button>
              `
            : nothing}
        </div>
        ${this.variant === 'operator' && !this.compact
          ? html`<div class="spo-help">
              Default follows project prepare.default (★). Strict mode fails fast instead of
              silently escalating to a heavier profile.
            </div>`
          : nothing}
        ${plan
          ? html`
              <div class="spo-plan">
                <div class="spo-plan-mode">
                  ${plan.mode === 'bind-only' ? 'Bind only' : 'Checkout'}
                </div>
                ${plan.lines.map((line) => html`<div class="spo-plan-line">${line}</div>`)}
                ${plan.warnings.map((warning) => html`<div class="spo-warn">${warning}</div>`)}
              </div>
            `
          : nothing}
        ${this.variant === 'operator' && this.showAdvanced
          ? html`
              <button
                class="spo-advanced-toggle"
                @click=${() => (this._advancedOpen = !this._advancedOpen)}
              >
                ${this._advancedOpen ? '▾' : '▸'} Advanced
              </button>
              ${this._advancedOpen
                ? html`
                    <div class="spo-advanced">
                      <label class="spo-check">
                        <input
                          type="checkbox"
                          .checked=${this.strictProfile}
                          ?disabled=${this.disabled}
                          @change=${(event: Event) =>
                            this._setStrictProfile((event.target as HTMLInputElement).checked)}
                        />
                        Strict profile (no silent fallback)
                      </label>
                      <label class="spo-check">
                        <input
                          type="checkbox"
                          .checked=${this.forcePrepare}
                          ?disabled=${this.disabled}
                          @change=${(event: Event) =>
                            this._setForcePrepare((event.target as HTMLInputElement).checked)}
                        />
                        Force checkout (skip bind-only fast path)
                      </label>
                    </div>
                  `
                : nothing}
            `
          : nothing}
        ${this.variant === 'operator' && this.lastError
          ? html`
              <div class="spo-error">${this.lastError}</div>
              <div class="spo-recovery">
                ${recovery.profile
                  ? html`
                      <button
                        class="spo-recovery-btn"
                        @click=${() => this._emitRecovery(recovery.profile, this.strictProfile)}
                      >
                        ${recovery.label}
                      </button>
                    `
                  : nothing}
                ${recovery.label && !recovery.profile
                  ? html`
                      <button
                        class="spo-recovery-btn"
                        @click=${() => this._emitRecovery(this.prepareProfile, false)}
                      >
                        ${recovery.label}
                      </button>
                    `
                  : nothing}
                <button
                  class="spo-recovery-btn secondary"
                  ?disabled=${this.disabled}
                  @click=${() => this._emitRecovery(this.prepareProfile, this.strictProfile)}
                >
                  Retry same settings
                </button>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-prepare-options': SlotPrepareOptions;
  }
}
