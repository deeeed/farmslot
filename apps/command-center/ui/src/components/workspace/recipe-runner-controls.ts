import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  DeviceInventoryParams,
  DeviceInventoryResult,
  RecipeCommandParams,
  RecipeCommandResult,
} from '@farmslot/protocol';
import {
  DEVICE_INVENTORY_PLATFORMS,
  Methods,
  RUNTIME_CAPABILITY_TARGET_KEYS,
} from '@farmslot/protocol';

import './recipe-output-panel.js';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { CopyFeedbackTimer } from '../shared/copy-feedback-model.js';

import type { RecipeOutputPanel } from './recipe-output-panel.js';
import { deviceTargetChoices, RECIPE_TARGET_OTHER } from './recipe-rerun-target.js';

const COPY_COMMAND = 'copied';

/** How often the device list is refreshed while the controls are on screen. */
const INVENTORY_POLL_MS = 30_000;

@customElement('recipe-runner-controls')
export class RecipeRunnerControls extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @property() runId = '';
  @property() slotId = '';
  @property() recipeArtifactPath = '';
  @property() recipeRunId = '';
  @property() runLabel = 'Replay live recipe';
  @property() eyebrow = 'Live replay';
  @property() description =
    'Runs without covering the stream. Watch the streaming panel live, follow logs below, then inspect the new attempt artifacts.';
  @property({ type: Number }) playbackSlowMs = 0;
  @property({ type: Boolean }) recordVideo = false;
  @property({ type: Boolean }) showPlayback = false;
  /** Device-identity key the re-target field edits (ADR-054 item 3). */
  @property() targetKey = 'simulator';
  /** Device identity for this replay; empty replays on the slot's own device. */
  @property() targetValue = '';
  /**
   * Provider platform for this replay; empty leaves the choice to the Gateway.
   *
   * Offered because `recipe.rerun` has always accepted it and a fleet can hold
   * both an iOS and an Android provider in one proof plan — the Gateway refuses
   * an ambiguous target, and this is what lets an operator resolve it.
   */
  @property() targetPlatform = '';
  @property({ type: Boolean }) showArtifactAction = false;
  @property({ type: Boolean }) disabled = false;

  @state() private _running = false;
  /** The machine's devices, or null until the first read answers. */
  @state() private _inventory: DeviceInventoryResult | null = null;
  @state() private _inventoryError = '';
  /** True while the operator is typing an identity the picker did not offer. */
  @state() private _typingIdentity = false;
  private _inventoryTimer: ReturnType<typeof setInterval> | null = null;
  @state() private _copyFeedback = '';
  @state() private _copyError = '';
  private readonly _copyFeedbackTimer = new CopyFeedbackTimer({
    copiedKey: () => this._copyFeedback,
    setCopiedKey: (key) => {
      this._copyFeedback = key;
    },
  });

  get running(): boolean {
    return this._running;
  }

  override connectedCallback() {
    super.connectedCallback();
    this._inventoryTimer = setInterval(() => void this._loadInventory(), INVENTORY_POLL_MS);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._copyFeedbackTimer.clear();
    if (this._inventoryTimer) clearInterval(this._inventoryTimer);
    this._inventoryTimer = null;
  }

  override updated(changed: Map<string, unknown>) {
    // The inventory is machine-scoped and the slot is what names the machine, so
    // it is re-read when the slot changes and never before one is set.
    if (changed.has('slotId')) {
      this._inventory = null;
      void this._loadInventory();
    }
  }

  /**
   * Read the devices this slot's machine has (MANUAL-000124).
   *
   * A failure is recorded and shown, not thrown: the free-text field is the
   * documented fallback for a machine whose inventory cannot be read, and the
   * Gateway still refuses an identity its own inventory contradicts.
   */
  private async _loadInventory() {
    if (!this.slotId) return;
    const slotId = this.slotId;
    try {
      const params: DeviceInventoryParams = { slotId };
      const result = await gateway.request<DeviceInventoryResult>(
        Methods.RESOURCE_DEVICE_INVENTORY,
        params,
      );
      if (this.slotId !== slotId) return;
      this._inventory = result;
      this._inventoryError = '';
    } catch (error) {
      if (this.slotId !== slotId) return;
      this._inventory = null;
      this._inventoryError = error instanceof Error ? error.message : String(error);
    }
  }

  private _setRunning(running: boolean) {
    if (this._running === running) return;
    this._running = running;
    this.dispatchEvent(
      new CustomEvent('running-change', {
        detail: running,
        bubbles: true,
        composed: true,
      }),
    );
  }

  async run() {
    if (this._running) return;
    await this.updateComplete;
    const panel = this.querySelector<RecipeOutputPanel>('recipe-output-panel');
    if (!panel) return;
    this._setRunning(true);
    try {
      await panel.rerun();
    } finally {
      if (!panel.running) this._setRunning(false);
    }
  }

  cancel() {
    this.querySelector<RecipeOutputPanel>('recipe-output-panel')?.cancel();
  }

  private async _copyCommand() {
    if (!this.runId || !this.slotId) return;
    this._copyError = '';
    try {
      const params: RecipeCommandParams = { runId: this.runId, slotId: this.slotId };
      if (this.recipeArtifactPath) params.recipeArtifactPath = this.recipeArtifactPath;
      if (this.recipeRunId) params.recipeRunId = this.recipeRunId;
      if (this.playbackSlowMs > 0) params.playbackSlowMs = this.playbackSlowMs;
      if (this.showArtifactAction) params.recordVideo = this.recordVideo;
      const result = await gateway.request<RecipeCommandResult>(Methods.RECIPE_COMMAND, params);
      await navigator.clipboard.writeText(result.command);
      this._copyFeedbackTimer.show(COPY_COMMAND);
    } catch (error) {
      this._copyError = error instanceof Error ? error.message : String(error);
    }
  }

  private _onRunningChange(event: CustomEvent<boolean>) {
    this._setRunning(event.detail);
  }

  override render() {
    const canRun = Boolean(this.runId && this.slotId && !this.disabled && !this._running);
    const canCopy = Boolean(this.runId && this.slotId && !this.disabled);
    const choices = deviceTargetChoices(this._inventory?.devices ?? [], this.targetKey);
    // Says which of the three the operator is looking at: a picker, a fallback
    // because the machine listed nothing for this key, or a fallback because the
    // inventory itself could not be read. Silence would make the last two look
    // like "this machine has no devices".
    const inventoryNote = this._inventoryError
      ? `Device list unavailable (${this._inventoryError}); type the identity.`
      : this._inventory && choices.length === 0
        ? `${this._inventory.machine} lists no ${this.targetKey}; type the identity.`
        : '';
    return html`
      <div
        style="display:flex; align-items:center; justify-content:space-between; gap:${spacing.sm}; flex-wrap:wrap; padding:${spacing.sm}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.md}; background:${colors.bgSurface};"
      >
        <div style="display:flex; flex-direction:column; gap:3px; min-width:220px;">
          <span
            style="font-size:${fonts.sizeXs}; text-transform:uppercase; letter-spacing:0.08em; color:${colors.textMuted};"
            >${this.eyebrow}</span
          >
          <span style="font-size:${fonts.sizeXs}; color:${colors.textSecondary};">
            ${this.description}
          </span>
          ${this._copyError
            ? html`<span style="font-size:${fonts.sizeXs}; color:${colors.statusWarn};"
                >Copy failed: ${this._copyError}</span
              >`
            : nothing}
        </div>
        <div style="display:flex; gap:${spacing.sm}; flex-wrap:wrap; align-items:center;">
          ${this.showPlayback
            ? html`
                <label
                  style="display:flex; align-items:center; gap:6px; color:${colors.textMuted}; font-size:${fonts.sizeXs};"
                >
                  Playback
                  <span
                    title="Only project runners that opt into playback slow-down receive this flag."
                    >(if supported)</span
                  >
                  <select
                    .value=${String(this.playbackSlowMs)}
                    ?disabled=${this._running || this.disabled}
                    style="background:${colors.bgCard}; color:${colors.textPrimary}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.sm}; padding:4px 6px; font-family:${fonts.mono};"
                    @change=${(event: Event) => {
                      this.playbackSlowMs = Number((event.target as HTMLSelectElement).value);
                    }}
                  >
                    <option value="0" ?selected=${this.playbackSlowMs === 0}>normal</option>
                    <option value="500" ?selected=${this.playbackSlowMs === 500}>slow 0.5s</option>
                    <option value="1000" ?selected=${this.playbackSlowMs === 1000}>slow 1s</option>
                    <option value="2000" ?selected=${this.playbackSlowMs === 2000}>slow 2s</option>
                    <option value="5000" ?selected=${this.playbackSlowMs === 5000}>demo 5s</option>
                  </select>
                </label>
              `
            : nothing}
          <label
            style="display:flex; align-items:center; gap:6px; color:${colors.textMuted}; font-size:${fonts.sizeXs};"
            title="Replay on another device without re-dispatching the run. Leave empty to use the slot's configured device."
          >
            Target
            <select
              data-testid="recipe-target-key"
              .value=${this.targetKey}
              ?disabled=${this._running || this.disabled}
              style="background:${colors.bgCard}; color:${colors.textPrimary}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.sm}; padding:4px 6px; font-family:${fonts.mono};"
              @change=${(event: Event) => {
                this.targetKey = (event.target as HTMLSelectElement).value;
                // An identity belongs to its key. Carrying `fs-4` from
                // `simulator` over to `adb_serial` would send a serial that
                // names nothing, and the inventory would refuse it.
                this.targetValue = '';
                this._typingIdentity = false;
              }}
            >
              ${RUNTIME_CAPABILITY_TARGET_KEYS.filter((key) => key !== 'platform').map(
                (key) =>
                  html`<option value=${key} ?selected=${this.targetKey === key}>${key}</option>`,
              )}
            </select>
            ${choices.length > 0 && !this._typingIdentity
              ? html`
                  <select
                    data-testid="recipe-target-identity"
                    ?disabled=${this._running || this.disabled}
                    style="background:${colors.bgCard}; color:${colors.textPrimary}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.sm}; padding:4px 6px; font-family:${fonts.mono}; max-width:260px;"
                    @change=${(event: Event) => {
                      const picked = (event.target as HTMLSelectElement).value;
                      if (picked === RECIPE_TARGET_OTHER) {
                        this._typingIdentity = true;
                        this.targetValue = '';
                        return;
                      }
                      this.targetValue = picked;
                    }}
                  >
                    <option value="" ?selected=${this.targetValue === ''}>slot default</option>
                    ${choices.map(
                      (choice) =>
                        html`<option
                          value=${choice.identity}
                          ?selected=${this.targetValue === choice.identity}
                        >
                          ${choice.label}
                        </option>`,
                    )}
                    <option value=${RECIPE_TARGET_OTHER}>Other…</option>
                  </select>
                `
              : html`
                  <input
                    data-testid="recipe-target-value"
                    type="text"
                    placeholder="slot default"
                    size="18"
                    .value=${this.targetValue}
                    ?disabled=${this._running || this.disabled}
                    style="background:${colors.bgCard}; color:${colors.textPrimary}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.sm}; padding:4px 6px; font-family:${fonts.mono};"
                    @input=${(event: Event) => {
                      this.targetValue = (event.target as HTMLInputElement).value;
                    }}
                  />
                  ${choices.length > 0
                    ? html`<button
                        data-testid="recipe-target-pick"
                        style="border:none; background:none; color:${colors.textMuted}; font-family:${fonts.mono}; font-size:${fonts.sizeXs}; cursor:pointer; text-decoration:underline;"
                        @click=${() => {
                          this._typingIdentity = false;
                          this.targetValue = '';
                        }}
                      >
                        pick
                      </button>`
                    : nothing}
                `}
            <select
              data-testid="recipe-target-platform"
              ?disabled=${this._running || this.disabled}
              style="background:${colors.bgCard}; color:${colors.textPrimary}; border:1px solid ${colors.bgCardHover}; border-radius:${radii.sm}; padding:4px 6px; font-family:${fonts.mono};"
              @change=${(event: Event) => {
                this.targetPlatform = (event.target as HTMLSelectElement).value;
              }}
            >
              <option value="" ?selected=${this.targetPlatform === ''}>any platform</option>
              ${DEVICE_INVENTORY_PLATFORMS.map(
                (platform) =>
                  html`<option value=${platform} ?selected=${this.targetPlatform === platform}>
                    ${platform}
                  </option>`,
              )}
            </select>
          </label>
          ${inventoryNote
            ? html`<span
                data-testid="recipe-target-inventory-note"
                style="font-size:${fonts.sizeXs}; color:${colors.textMuted};"
                >${inventoryNote}</span
              >`
            : nothing}
          ${this.showArtifactAction
            ? html`
                <label
                  style="display:flex; align-items:center; gap:6px; color:${colors.textMuted}; font-size:${fonts.sizeXs};"
                >
                  <input
                    type="checkbox"
                    .checked=${this.recordVideo}
                    ?disabled=${this._running || this.disabled}
                    @change=${(event: Event) => {
                      this.recordVideo = (event.target as HTMLInputElement).checked;
                    }}
                  />
                  Record video
                </label>
              `
            : nothing}
          ${this._running
            ? html`
                <button
                  style="border:1px solid ${colors.statusFail}66; border-radius:${radii.sm}; background:${colors.statusFail}18; color:${colors.statusFail}; font-family:${fonts.mono}; font-size:${fonts.sizeXs}; padding:6px 12px; cursor:pointer;"
                  @click=${this.cancel}
                >
                  Cancel
                </button>
              `
            : html`
                <button
                  data-testid="recipe-replay-run"
                  style="border:1px solid ${colors.accent}; border-radius:${radii.sm}; background:${colors.accent}; color:white; font-family:${fonts.mono}; font-size:${fonts.sizeXs}; font-weight:700; padding:6px 12px; cursor:pointer; opacity:${canRun
                    ? '1'
                    : '0.55'};"
                  ?disabled=${!canRun}
                  @click=${this.run}
                >
                  ${this.runLabel}
                </button>
              `}
          <button
            style="border:1px solid ${colors.bgCardHover}; border-radius:${radii.sm}; background:${colors.bgCard}; color:${colors.textPrimary}; font-family:${fonts.mono}; font-size:${fonts.sizeXs}; padding:6px 12px; cursor:pointer; opacity:${canCopy
              ? '1'
              : '0.55'};"
            ?disabled=${!canCopy}
            @click=${this._copyCommand}
          >
            ${this._copyFeedback === COPY_COMMAND ? 'Copied' : 'Copy command'}
          </button>
        </div>
        <div style="flex-basis:100%; margin-top:${spacing.xs};">
          <recipe-output-panel
            runId=${this.runId}
            slotId=${this.slotId}
            recipeArtifactPath=${this.recipeArtifactPath}
            recipeRunId=${this.recipeRunId}
            .targetKey=${this.targetKey}
            .targetValue=${this.targetValue}
            .targetPlatform=${this.targetPlatform}
            .playbackSlowMs=${this.playbackSlowMs}
            .recordVideo=${this.recordVideo}
            .showArtifactAction=${this.showArtifactAction}
            @running-change=${this._onRunningChange}
          ></recipe-output-panel>
        </div>
      </div>
    `;
  }
}
