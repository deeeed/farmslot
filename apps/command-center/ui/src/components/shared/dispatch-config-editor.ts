import { css, html, LitElement, nothing, type PropertyValues, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type {
  DevInteractiveProfile,
  FlowType,
  ResourcePostureWaitPolicy,
  ReviewContinuationContext,
  ReviewMode,
  ReviewPolicy,
  ReviewRequestContext,
  ReviewSelection,
  ReviewSequence,
  TaskTemplateSelection,
  WorkerTemplateOption,
} from '@farmslot/protocol';
import { RESOURCE_POSTURE_WAIT_POLICIES, selectedTemplateMode } from '@farmslot/protocol';
import { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import './review-dispatch-picker.js';
import './slot-prepare-options.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import type { EffortLevel } from '../../utils/runner-options.js';

import type { ReviewDispatchChangeDetail } from './review-dispatch-picker.js';
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
  reviewPolicy?: ReviewPolicy | null;
  reviewSequence?: ReviewSequence | null;
  reviewMode?: ReviewMode | null;
  reviewContext?: ReviewRequestContext | null;
  reviewSequenceContext?: ReviewRequestContext | null;
  /** ADR-054 dispatch preset for every durable wait of the created run. */
  waitPolicy?: ResourcePostureWaitPolicy | null;
}

export interface DispatchConfigEditorControls {
  template?: boolean;
  runnerModelEffort?: boolean;
  prepareProfile?: boolean;
  interactiveProfile?: boolean;
  publicationReviews?: boolean;
  explicitModeFallback?: boolean;
  waitPolicy?: boolean;
}

/**
 * `waitPolicy` defaults off: only backlog dispatch settings persist it today
 * (ADR-054 deliverable 3), so surfaces that do not write it must not offer a
 * control whose selection would be silently dropped.
 */
const DEFAULT_CONTROLS: Required<DispatchConfigEditorControls> = {
  template: true,
  runnerModelEffort: true,
  prepareProfile: true,
  interactiveProfile: true,
  publicationReviews: true,
  explicitModeFallback: true,
  waitPolicy: false,
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
  @property() reviewMode: ReviewMode = 'cold';
  @property({ attribute: false }) reviewContext?: ReviewRequestContext;
  @property({ attribute: false }) reviewLineages: readonly ReviewContinuationContext[] = [];
  @property({ attribute: false }) reviewDefaults?: Partial<ReviewSelection>;
  @property({ attribute: false }) reviewSequenceContext?: ReviewRequestContext;
  @property({ attribute: false }) reviewSequence: ReviewSequence = [];
  @property({ type: String }) waitPolicy: ResourcePostureWaitPolicy | '' = '';
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
    if (this.mode) return this.mode;
    if (this.resolvedControls().template && this.flowType && this.templateOptions.length > 0) {
      return selectedTemplateMode(
        this.flowType,
        this.templateOptions,
        this.templateFileName() ||
          this.templateOptions.find((option) => option.isDefault)?.fileName ||
          '',
      );
    }
    return 'autonomous';
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

  private setMode(mode: 'interactive' | 'autonomous') {
    const matchingTemplates = this.templateOptions.filter(
      (option) =>
        selectedTemplateMode(this.flowType || null, this.templateOptions, option.fileName) === mode,
    );
    const template = matchingTemplates.find((option) => option.isDefault) ?? matchingTemplates[0];
    if (template) {
      this.setTemplate(template.fileName);
      return;
    }
    this.emitChange({ mode });
  }

  private executionPicker = new ReviewDispatchViewModel({
    context: { allowedActions: ['dispatch'] },
  });
  private reviewPicker = new ReviewDispatchViewModel({
    context: { allowedActions: ['dispatch'], allowSequence: true, allowEmpty: true },
    sequence: [],
  });

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has('reviewLineages')) {
      this.executionPicker.setContext({
        ...this.executionPicker.context,
        reviewContext: this.reviewContext,
        reviewLineages: this.reviewLineages,
      });
      this.reviewPicker.setContext({
        ...this.reviewPicker.context,
        reviewContext: this.reviewSequenceContext,
        reviewLineages: this.reviewLineages,
      });
    }
    if (changed.has('reviewDefaults'))
      this.reviewPicker.setContext({ ...this.reviewPicker.context, defaults: this.reviewDefaults });
    if (
      changed.has('runner') ||
      changed.has('model') ||
      changed.has('effort') ||
      changed.has('reviewMode') ||
      changed.has('reviewContext')
    ) {
      this.executionPicker.setContext({
        ...this.executionPicker.context,
        reviewContext: this.reviewContext,
      });
      this.executionPicker.setSequence([
        {
          runner: this.runner || this.executionPicker.selection!.runner,
          model: this.model || null,
          effort: this.effort || null,
          mode: this.reviewMode,
        },
      ]);
    }
    if (changed.has('reviewSequence') || changed.has('reviewSequenceContext')) {
      this.reviewPicker.setContext({
        ...this.reviewPicker.context,
        reviewContext: this.reviewSequenceContext,
      });
      this.reviewPicker.setSequence(this.reviewSequence);
    }
  }

  get validationErrors(): readonly string[] {
    return [...this.executionPicker.errors, ...this.reviewPicker.errors];
  }

  private renderMode() {
    const controls = this.resolvedControls();
    if (!controls.explicitModeFallback) return nothing;
    const mode = this.modeValue();
    return html`<div class="group">
      <div class="section-label">Run mode</div>
      <div class="pill-row">
        ${(['autonomous', 'interactive'] as const).map(
          (option) =>
            html`<button
              class="pill ${mode === option ? 'selected' : ''}"
              type="button"
              ?disabled=${this.disabled}
              @click=${() => this.setMode(option)}
            >
              ${option}
            </button>`,
        )}
      </div>
      <div class="section-help">
        ${this.templateOptions.length > 0
          ? 'Selects the matching project-owned worker template.'
          : 'Project templates are unavailable, so this stores an explicit run mode.'}
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
    )
      return nothing;
    return html`<div class="group wide">
      <div class="section-label">Publication reviews</div>
      <review-dispatch-picker
        .viewModel=${this.reviewPicker}
        .review=${true}
        .disabled=${this.disabled}
        @review-dispatch-change=${() =>
          this.emitChange({
            ...this.reviewPicker.toDispatchOptions(),
            reviewPolicy: this.reviewPicker.toDispatchOptions().reviewPolicy ?? null,
            reviewSequenceContext: this.reviewPicker.toReviewContext() ?? null,
          })}
      ></review-dispatch-picker>
    </div>`;
  }

  /**
   * ADR-054 dispatch preset. `project-default` is deliberately absent: the
   * protocol excludes it from wait policies because deferring to the lower
   * precedence levels is exactly what leaving this unset already means.
   */
  private renderWaitPolicy() {
    if (!this.resolvedControls().waitPolicy) return nothing;
    return html`<div class="group">
      <div class="section-label">Wait policy</div>
      <div class="pill-row">
        <button
          class="pill ${this.waitPolicy ? '' : 'selected'}"
          type="button"
          data-testid="dispatch-wait-policy-unset"
          ?disabled=${this.disabled}
          @click=${() => this.emitChange({ waitPolicy: null })}
        >
          unset
        </button>
        ${RESOURCE_POSTURE_WAIT_POLICIES.map(
          (policy) =>
            html`<button
              class="pill ${this.waitPolicy === policy ? 'selected' : ''}"
              type="button"
              data-testid="dispatch-wait-policy-${policy}"
              ?disabled=${this.disabled}
              @click=${() => this.emitChange({ waitPolicy: policy })}
            >
              ${policy}
            </button>`,
        )}
      </div>
      <div class="section-help">
        Presets the resource-posture choice for every durable wait of the dispatched run. Unset
        defers to the project and framework defaults.
      </div>
    </div>`;
  }

  private renderExecution() {
    if (!this.resolvedControls().runnerModelEffort) return nothing;
    return html`<review-dispatch-picker
      .viewModel=${this.executionPicker}
      .review=${this.flowType === 'review-pr'}
      .disabled=${this.disabled}
      @review-dispatch-change=${(event: CustomEvent<ReviewDispatchChangeDetail>) => {
        const selection = event.detail.selection!;
        this.emitChange({
          runner: selection.runner,
          model: selection.model,
          effort: selection.effort,
          reviewMode: selection.mode,
          reviewContext: this.executionPicker.toReviewContext() ?? null,
        });
      }}
    ></review-dispatch-picker>`;
  }

  render() {
    return html`<div class="surface">
      ${this.renderTaskTemplate()} ${this.renderMode()} ${this.renderExecution()}
      ${this.renderPrepareProfile()} ${this.renderInteractiveProfile()} ${this.renderWaitPolicy()}
      ${this.renderPublicationReviews()}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dispatch-config-editor': DispatchConfigEditor;
  }
}
