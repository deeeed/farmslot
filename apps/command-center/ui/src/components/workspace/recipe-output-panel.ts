// recipe-output-panel.ts — Recipe rerun execution with streaming output
// Extracted from review-workspace.ts for maintainability.

import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { RecipeCancelResult, RecipeRerunParams, ScriptActionResult } from '@farmslot/protocol';
import { Events, Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts } from '../../styles/theme-tokens.js';

export const RECIPE_OUTPUT_MAX_LINES = 500;
/** recipe.rerun should return immediately; allow headroom for gateway validation only. */
export const RECIPE_RERUN_START_TIMEOUT_MS = 30_000;

interface RecipeOutputState {
  requestId: string;
  lines: string[];
  running: boolean;
  exitCode?: number;
  error?: string;
  artifactRoot?: string;
}

export interface RecipeCompleteDetail {
  requestId: string;
  exitCode: number;
  error?: string;
  artifactRoot?: string;
}

@customElement('recipe-output-panel')
export class RecipeOutputPanel extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @property() runId = '';
  @property() slotId = '';
  @property() recipeArtifactPath = '';
  @property() recipeRunId = '';
  @property({ type: Number }) playbackSlowMs = 0;
  @property({ type: Boolean }) recordVideo = false;
  @property({ type: Boolean }) showArtifactAction = false;

  @state() private _output: RecipeOutputState | null = null;
  private _unsubs: Array<() => void> = [];
  private _starting = false;

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubs.forEach((fn) => fn());
    this._unsubs = [];
  }

  get running(): boolean {
    return this._output?.running ?? false;
  }

  async rerun() {
    if (this._starting || this._output?.running || !this.slotId) return;
    this._starting = true;

    // Clean up any previous subscriptions
    this._unsubs.forEach((fn) => fn());
    this._unsubs = [];

    // Subscribe BEFORE firing the request to avoid missing fast completions.
    // Buffer early events, replay when requestId is known from the response.
    let requestId: string | null = null;
    const earlyEvents: Array<{ type: 'output' | 'complete'; data: unknown }> = [];

    const handleOutput = (data: { requestId: string; data: string }) => {
      if (requestId === null) {
        earlyEvents.push({ type: 'output', data });
        return;
      }
      if (data.requestId !== requestId) return;
      const newLines = [...this._output!.lines, ...data.data.split('\n')];
      this._output = {
        ...this._output!,
        lines:
          newLines.length > RECIPE_OUTPUT_MAX_LINES
            ? newLines.slice(-RECIPE_OUTPUT_MAX_LINES)
            : newLines,
      };
    };
    const handleComplete = (data: {
      requestId: string;
      exitCode: number;
      error?: string;
      artifactRoot?: string;
    }) => {
      if (requestId === null) {
        earlyEvents.push({ type: 'complete', data });
        return;
      }
      if (data.requestId !== requestId) return;
      this._output = {
        ...this._output!,
        running: false,
        exitCode: data.exitCode,
        error: data.error,
        artifactRoot: data.artifactRoot,
      };
      this.dispatchEvent(new CustomEvent('running-change', { detail: false }));
      this.dispatchEvent(
        new CustomEvent<RecipeCompleteDetail>('recipe-complete', {
          detail: {
            requestId: data.requestId,
            exitCode: data.exitCode,
            error: data.error,
            artifactRoot: data.artifactRoot,
          },
          bubbles: true,
          composed: true,
        }),
      );
      this._unsubs.forEach((fn) => fn());
      this._unsubs = [];
    };

    const unsubOutput = gateway.subscribe(Events.SCRIPT_OUTPUT, handleOutput);
    const unsubComplete = gateway.subscribe(Events.SCRIPT_COMPLETE, handleComplete);
    this._unsubs = [unsubOutput, unsubComplete];

    this._output = {
      requestId: '',
      lines: ['Connecting to gateway and starting recipe replay...'],
      running: true,
    };
    this.dispatchEvent(new CustomEvent('running-change', { detail: true }));

    try {
      const params: RecipeRerunParams = { runId: this.runId, slotId: this.slotId };
      if (this.recipeArtifactPath) params.recipeArtifactPath = this.recipeArtifactPath;
      if (this.recipeRunId) params.recipeRunId = this.recipeRunId;
      if (this.playbackSlowMs > 0) params.playbackSlowMs = this.playbackSlowMs;
      if (this.showArtifactAction) params.recordVideo = this.recordVideo;
      const result = (await gateway.request(
        Methods.RECIPE_RERUN,
        params,
        RECIPE_RERUN_START_TIMEOUT_MS,
      )) as ScriptActionResult;
      requestId = result.requestId;
      this._output = {
        requestId,
        lines: ['Recipe replay accepted — streaming live output below...'],
        running: true,
      };
      this._starting = false;
      // Replay buffered early events
      for (const evt of earlyEvents) {
        if (evt.type === 'output') handleOutput(evt.data as { requestId: string; data: string });
        else
          handleComplete(
            evt.data as {
              requestId: string;
              exitCode: number;
              error?: string;
              artifactRoot?: string;
            },
          );
      }
    } catch (err) {
      this._starting = false;
      console.error('Failed to start recipe rerun:', err);
      this._output = {
        requestId: '',
        lines: [`Error: ${(err as Error).message}`],
        running: false,
        exitCode: 1,
        error: (err as Error).message,
      };
      this.dispatchEvent(new CustomEvent('running-change', { detail: false }));
      this._unsubs.forEach((fn) => fn());
      this._unsubs = [];
    }
  }

  private _requestArtifactView() {
    if (!this._output?.requestId) return;
    this.dispatchEvent(
      new CustomEvent<RecipeCompleteDetail>('recipe-artifacts-request', {
        detail: {
          requestId: this._output.requestId,
          exitCode: this._output.exitCode ?? 0,
          error: this._output.error,
          artifactRoot: this._output.artifactRoot,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  async cancel() {
    if (!this._output?.running || !this._output.requestId || !this.slotId) return;
    try {
      const result = (await gateway.request(Methods.RECIPE_CANCEL, {
        slotId: this.slotId,
        requestId: this._output.requestId,
      })) as RecipeCancelResult;
      if (!result.cancelled && result.reason) {
        this._output = { ...this._output, lines: [...this._output.lines, `⚠ ${result.reason}`] };
      }
    } catch (err) {
      console.error('Failed to cancel recipe:', err);
    }
  }

  override updated() {
    const el = this.querySelector<HTMLElement>('.recipe-output-scroll');
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
      el.scrollTop = el.scrollHeight;
    }
  }

  override render() {
    if (!this._output) return nothing;
    return html`
      <div style="display:flex;flex-direction:column;gap:4px;">
        <div
          style="font-size:${fonts.sizeXs};text-transform:uppercase;letter-spacing:0.08em;color:${colors.textMuted};"
        >
          Live output
          ${this._output.running
            ? html`<span style="color:${colors.accent};margin-left:8px;">running</span>`
            : nothing}
        </div>
        <div
          class="recipe-output-scroll"
          style="max-height:280px;min-height:120px;overflow-y:auto;background:${colors.bgBase};border:1px solid ${colors.bgCardHover};border-radius:4px;padding:8px 10px;font-family:${fonts.mono};font-size:${fonts.sizeXs};line-height:1.5;white-space:pre-wrap;color:${colors.textSecondary}"
        >
          ${this._output.lines.length === 0 && this._output.running
            ? 'Starting recipe...'
            : nothing}
          ${this._output.lines.map((l) => html`<div>${l}</div>`)}
          ${this._output.error
            ? html`
                <div style="margin-top:4px;color:${colors.statusFail};font-weight:600">
                  ${this._output.error}
                </div>
              `
            : nothing}
          ${this._output.exitCode !== undefined
            ? html`
                <div
                  style="margin-top:4px;color:${this._output.exitCode === 0
                    ? colors.statusOk
                    : colors.statusFail};font-weight:600"
                >
                  Exit code: ${this._output.exitCode}
                </div>
                <div
                  style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:${colors.textMuted}"
                >
                  <span>Run: ${this._output.requestId || 'unknown'}</span>
                  ${this.showArtifactAction && this._output.requestId
                    ? html`
                        <button
                          style="border:1px solid ${colors.accent}66;border-radius:4px;background:${colors.accent}18;color:${colors.accent};font-family:${fonts.mono};font-size:${fonts.sizeXs};padding:2px 8px;cursor:pointer;"
                          @click=${this._requestArtifactView}
                        >
                          View artifacts
                        </button>
                      `
                    : nothing}
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }
}
