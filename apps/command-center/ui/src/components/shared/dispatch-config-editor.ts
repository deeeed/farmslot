import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type {
  DevInteractiveProfile,
  FlowType,
  ReviewDepthPolicy,
  ReviewLoopRequest,
  ReviewRunnerId,
  ReviewValidationDepth,
  TaskTemplateSelection,
  WorkerTemplateOption,
} from '@farmslot/protocol';
import { reviewValidationDepthForLoop, selectedTemplateMode } from '@farmslot/protocol';

import './runner-model-effort-picker.js';
import './slot-prepare-options.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import type { EffortLevel } from '../../utils/runner-options.js';
import { RUNNER_OPTIONS } from '../../utils/runner-options.js';

import type { RunnerModelEffortChangeDetail } from './runner-model-effort-picker.js';
import type { SlotPrepareOptionsChangeDetail } from './slot-prepare-options.js';

export interface DispatchPrepareProfileOption {
  name: string;
  label: string;
  description?: string;
  isDefault: boolean;
}

export interface DispatchConfigChangeDetail {
  runner?: string | null;
  model?: string | null;
  effort?: string | null;
  taskTemplateFileName?: string;
  taskTemplate?: TaskTemplateSelection | null;
  prepareProfile?: string | null;
  skipPrepare?: boolean;
  mode?: 'interactive' | 'autonomous' | null;
  devInteractiveProfile?: DevInteractiveProfile | null;
  reviewDepth?: ReviewDepthPolicy | null;
  pendingReviewPlan?: ReviewLoopRequest[] | null;
}

export interface DispatchConfigEditorControls {
  template?: boolean;
  runnerModelEffort?: boolean;
  prepareProfile?: boolean;
  interactiveProfile?: boolean;
  publicationReviews?: boolean;
  explicitModeFallback?: boolean;
}

const DEFAULT_CONTROLS: Required<DispatchConfigEditorControls> = {
  template: true,
  runnerModelEffort: true,
  prepareProfile: true,
  interactiveProfile: true,
  publicationReviews: true,
  explicitModeFallback: true,
};

@customElement('dispatch-config-editor')
export class DispatchConfigEditor extends LitElement {
  @property({ type: String }) flowType: FlowType | '' = '';
  @property({ type: String }) project = '';
  @property({ type: String }) runner = '';
  @property({ type: String }) model = '';
  @property({ type: String }) effort: EffortLevel = '';
  @property({ type: String }) mode: 'interactive' | 'autonomous' | '' = '';
  @property({ type: String }) devInteractiveProfile: DevInteractiveProfile | '' = '';
  @property({ attribute: false }) taskTemplate: TaskTemplateSelection | null = null;
  @property({ type: String }) selectedTaskTemplateFileName = '';
  @property({ attribute: false }) templateOptions: readonly WorkerTemplateOption[] = [];
  @property({ type: String }) prepareProfile = '';
  @property({ type: Boolean }) skipPrepare = false;
  @property({ type: String }) prepareVariant: 'profile' | 'dispatch' = 'profile';
  @property({ attribute: false }) prepareProfiles: readonly DispatchPrepareProfileOption[] = [];
  @property({ attribute: false }) pendingReviewPlan: readonly ReviewLoopRequest[] = [];
  @property({ attribute: false }) controls: DispatchConfigEditorControls = {};
  @property({ type: Boolean }) disabled = false;

  static styles = css`
    :host {
      display: block;
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
    }

    .surface {
      display: flex;
      flex-wrap: wrap;
      gap: ${unsafeCSS(spacing.xl)};
      align-items: flex-start;
    }

    .group {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.sm)};
      min-width: min(100%, 220px);
    }

    .group.wide {
      flex-basis: 100%;
      min-width: 100%;
    }

    .section-label {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .section-help {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      line-height: 1.4;
    }

    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .pill {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.lg)};
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      cursor: pointer;
      font: inherit;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      line-height: 1.4;
      padding: 3px 9px;
    }

    .pill:hover {
      border-color: ${unsafeCSS(colors.accent)}66;
      color: ${unsafeCSS(colors.textSecondary)};
    }

    .pill.selected {
      background: ${unsafeCSS(colors.accent)}22;
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.accent)};
    }

    .pill:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    .review-row {
      align-items: center;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.sm)};
      display: grid;
      gap: 8px;
      grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr) auto;
      padding: 8px;
    }
  `;

  private resolvedControls(): Required<DispatchConfigEditorControls> {
    return { ...DEFAULT_CONTROLS, ...this.controls };
  }

  private emitChange(detail: DispatchConfigChangeDetail) {
    this.dispatchEvent(
      new CustomEvent<DispatchConfigChangeDetail>('dispatch-config-change', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private modeValue(): 'interactive' | 'autonomous' {
    if (this.resolvedControls().template && this.flowType && this.templateOptions.length > 0) {
      return selectedTemplateMode(
        this.flowType,
        this.templateOptions,
        this.templateFileName() ||
          this.templateOptions.find((option) => option.isDefault)?.fileName ||
          '',
      );
    }
    return this.mode || 'autonomous';
  }

  private templateFileName(): string {
    return this.selectedTaskTemplateFileName || this.taskTemplate?.fileName || '';
  }

  private setTemplate(fileName: string) {
    const selected = this.templateOptions.find((option) => option.fileName === fileName);
    this.emitChange({
      taskTemplateFileName: fileName,
      taskTemplate:
        selected && !selected.isDefault
          ? { fileName: selected.fileName, variant: selected.variant ?? null }
          : null,
      mode: null,
    });
  }

  private reviewPlanWith(next: readonly ReviewLoopRequest[]): {
    reviewDepth: ReviewDepthPolicy | null;
    pendingReviewPlan: ReviewLoopRequest[] | null;
  } {
    if (next.length === 0) return { reviewDepth: null, pendingReviewPlan: null };
    return {
      reviewDepth: {
        minimumIndependentReviews: 1,
        requireCrossRunner: next.some((loop) => loop.runner !== this.runner),
        extraLoopsRequested: next.length,
        requestedBy: 'dispatch',
      },
      pendingReviewPlan: [...next],
    };
  }

  private addReviewLoop(runner: ReviewLoopRequest['runner']) {
    const next = [...this.pendingReviewPlan, { order: this.pendingReviewPlan.length + 1, runner }];
    this.emitChange(this.reviewPlanWith(this.normalizeReviewPlan(next)));
  }

  private updateReviewLoop(
    index: number,
    patch: Partial<Pick<ReviewLoopRequest, 'runner' | 'validationDepth'>>,
  ) {
    const next = this.pendingReviewPlan.map((loop, currentIndex) =>
      currentIndex === index ? { ...loop, ...patch } : loop,
    );
    this.emitChange(this.reviewPlanWith(this.normalizeReviewPlan(next)));
  }

  private removeReviewLoop(index: number) {
    const next = this.pendingReviewPlan.filter((_, currentIndex) => currentIndex !== index);
    this.emitChange(this.reviewPlanWith(this.normalizeReviewPlan(next)));
  }

  private normalizeReviewPlan(plan: readonly ReviewLoopRequest[]): ReviewLoopRequest[] {
    return plan.slice(0, 5).map((loop, index, all) => ({
      order: index + 1,
      runner: loop.runner || 'same',
      validationDepth: loop.validationDepth ?? reviewValidationDepthForLoop(index, all.length),
    }));
  }

  private renderMode() {
    const controls = this.resolvedControls();
    if (!controls.explicitModeFallback || (controls.template && this.templateOptions.length > 1)) {
      return nothing;
    }
    const mode = this.modeValue();
    return html`<div class="group">
      <div class="section-label">Template</div>
      <div class="pill-row">
        ${(['autonomous', 'interactive'] as const).map(
          (option) =>
            html`<button
              class="pill ${mode === option ? 'selected' : ''}"
              type="button"
              ?disabled=${this.disabled}
              @click=${() => this.emitChange({ mode: option })}
            >
              ${option}
            </button>`,
        )}
      </div>
      <div class="section-help">
        Fallback only: project templates were not available, so this stores an explicit run mode.
      </div>
    </div>`;
  }

  private renderTaskTemplate() {
    if (!this.resolvedControls().template || this.templateOptions.length <= 1) return nothing;
    const selected = this.templateFileName();
    return html`<div class="group">
      <div class="section-label">Template</div>
      <div class="pill-row">
        ${this.templateOptions.map(
          (option) =>
            html`<button
              class="pill ${(selected ? selected === option.fileName : option.isDefault)
                ? 'selected'
                : ''}"
              type="button"
              title=${option.fileName}
              ?disabled=${this.disabled}
              @click=${() => this.setTemplate(option.fileName)}
            >
              ${option.isDefault ? 'default' : option.label}
            </button>`,
        )}
      </div>
      <div class="section-help">
        Project-owned worker template for the queued task. Interactive/autonomous behavior is
        derived from this selection.
      </div>
    </div>`;
  }

  private renderPrepareProfile() {
    if (!this.resolvedControls().prepareProfile || this.prepareProfiles.length === 0) {
      return nothing;
    }
    if (this.prepareVariant === 'dispatch') {
      return html`<div class="group">
        <div class="section-label">Prepare</div>
        <slot-prepare-options
          variant="dispatch"
          .project=${this.project}
          .prepareProfile=${this.prepareProfile}
          .skipPrepare=${this.skipPrepare}
          persist-prefs=${false}
          show-plan=${false}
          ?show-advanced=${false}
          @prepare-options-change=${(event: CustomEvent<SlotPrepareOptionsChangeDetail>) =>
            this.emitChange({
              skipPrepare: event.detail.skipPrepare,
              prepareProfile: event.detail.skipPrepare ? null : event.detail.prepareProfile,
            })}
        ></slot-prepare-options>
      </div>`;
    }
    return html`<div class="group">
      <div class="section-label">Prepare profile</div>
      <div class="pill-row">
        ${this.prepareProfiles.map(
          (profile) =>
            html`<button
              class="pill ${(
                this.prepareProfile ? this.prepareProfile === profile.name : profile.isDefault
              )
                ? 'selected'
                : ''}"
              type="button"
              title=${profile.description ?? profile.name}
              ?disabled=${this.disabled}
              @click=${() =>
                this.emitChange({ prepareProfile: profile.isDefault ? null : profile.name })}
            >
              ${profile.isDefault ? 'default' : profile.label}
            </button>`,
        )}
      </div>
    </div>`;
  }

  private renderInteractiveProfile() {
    if (
      !this.resolvedControls().interactiveProfile ||
      this.flowType !== 'dev' ||
      this.modeValue() !== 'interactive'
    ) {
      return nothing;
    }
    const value = this.devInteractiveProfile || 'lightweight';
    return html`<div class="group">
      <div class="section-label">Interactive dev</div>
      <div class="pill-row">
        ${(['lightweight', 'reviewed'] as const).map(
          (profile) =>
            html`<button
              class="pill ${value === profile ? 'selected' : ''}"
              type="button"
              ?disabled=${this.disabled}
              @click=${() => this.emitChange({ devInteractiveProfile: profile })}
            >
              ${profile}
            </button>`,
        )}
      </div>
    </div>`;
  }

  private renderPublicationReviews() {
    if (
      !this.resolvedControls().publicationReviews ||
      (this.flowType !== 'fix-bug' &&
        !(this.flowType === 'dev' && this.modeValue() === 'autonomous'))
    ) {
      return nothing;
    }
    const loops = this.normalizeReviewPlan(this.pendingReviewPlan);
    const runnerOptions: Array<ReviewLoopRequest['runner']> = [
      'same',
      ...(RUNNER_OPTIONS as ReviewRunnerId[]),
    ];
    return html`<div class="group wide">
      <div class="section-label">Publication reviews</div>
      ${loops.length
        ? html`<div class="group">
            ${loops.map(
              (loop, index) =>
                html`<div class="review-row">
                  <span>${index + 1}</span>
                  <div class="pill-row">
                    ${runnerOptions.map(
                      (runner) =>
                        html`<button
                          class="pill ${loop.runner === runner ? 'selected' : ''}"
                          type="button"
                          ?disabled=${this.disabled}
                          @click=${() => this.updateReviewLoop(index, { runner })}
                        >
                          ${runner}
                        </button>`,
                    )}
                  </div>
                  <div class="pill-row">
                    ${(['static-code', 'full-live'] as ReviewValidationDepth[]).map(
                      (depth) =>
                        html`<button
                          class="pill ${loop.validationDepth === depth ? 'selected' : ''}"
                          type="button"
                          ?disabled=${this.disabled}
                          @click=${() => this.updateReviewLoop(index, { validationDepth: depth })}
                        >
                          ${depth}
                        </button>`,
                    )}
                  </div>
                  <button
                    class="pill"
                    type="button"
                    ?disabled=${this.disabled}
                    @click=${() => this.removeReviewLoop(index)}
                  >
                    Remove
                  </button>
                </div>`,
            )}
          </div>`
        : html`<div class="section-help">No extra publication review loops configured.</div>`}
      <div class="pill-row">
        <button
          class="pill"
          type="button"
          ?disabled=${this.disabled || loops.length >= 5}
          @click=${() => this.addReviewLoop('same')}
        >
          Add independent review
        </button>
        <button
          class="pill"
          type="button"
          ?disabled=${this.disabled || loops.length >= 5}
          @click=${() => this.addReviewLoop('codex')}
        >
          Add independent review (runner diversity)
        </button>
      </div>
    </div>`;
  }

  private renderRunnerModelEffort() {
    if (!this.resolvedControls().runnerModelEffort) return nothing;
    return html`<runner-model-effort-picker
      .runner=${this.runner}
      .model=${this.model}
      .effort=${this.effort}
      .allowDefault=${true}
      .disabled=${this.disabled}
      @runner-model-effort-change=${(event: CustomEvent<RunnerModelEffortChangeDetail>) =>
        this.emitChange({
          runner: event.detail.runner || null,
          model: event.detail.model || null,
          effort: event.detail.effort || null,
        })}
    ></runner-model-effort-picker>`;
  }

  render() {
    return html`<div class="surface">
      ${this.renderTaskTemplate()} ${this.renderMode()} ${this.renderRunnerModelEffort()}
      ${this.renderPrepareProfile()} ${this.renderInteractiveProfile()}
      ${this.renderPublicationReviews()}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dispatch-config-editor': DispatchConfigEditor;
  }
}
