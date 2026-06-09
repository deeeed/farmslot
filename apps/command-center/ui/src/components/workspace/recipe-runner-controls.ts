import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { RecipeCommandParams, RecipeCommandResult } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import './recipe-output-panel.js';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { CopyFeedbackTimer } from '../shared/copy-feedback-model.js';

import type { RecipeOutputPanel } from './recipe-output-panel.js';

const COPY_COMMAND = 'copied';

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
  @property({ type: Boolean }) recordVideo = true;
  @property({ type: Boolean }) showPlayback = false;
  @property({ type: Boolean }) showArtifactAction = false;
  @property({ type: Boolean }) disabled = false;

  @state() private _running = false;
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

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._copyFeedbackTimer.clear();
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
      params.recordVideo = this.recordVideo;
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
          ${this.showPlayback
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
                  <span
                    title="Only project runners that opt into video recording receive this flag."
                    >(if supported)</span
                  >
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
