import { css, html, LitElement, nothing, type TemplateResult, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type {
  TaskChecklistTiming,
  TaskProgressStructured,
  TaskStepProgress,
} from '@farmslot/protocol';
import type { PipelineProgressStep } from '@farmslot/protocol/checklist-target';
import {
  type ChecklistProgressFallback,
  checklistProgressIsLive,
  type ChecklistProgressOptions,
  checklistProgressRow,
  type ChecklistProgressStep,
  checklistProgressView,
} from '@farmslot/review-dispatch';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import { OperationClock, operationPanelStyles, renderOperationPanel } from './operation-panel.js';
import {
  renderSubtaskBlock,
  subtaskBlockStyles,
  type SubtaskOpenScope,
  SubtaskOpenState,
} from './subtask-block.js';

/**
 * One step row, plus the child unit block when the step owns one (ADR-060).
 * Child rows render through the same function with `nested`, which stops at one
 * level — the projection is recursive, v1 rendering is not.
 *
 * Module-level rather than a method so it can be tested without a DOM: the
 * element itself cannot be instantiated in the node test runner.
 */
export function renderTrackerStepRow(
  step: TaskStepProgress,
  openScope: SubtaskOpenScope,
  nested = false,
  timing?: TaskChecklistTiming,
  nowMs?: number,
): TemplateResult {
  const row = checklistProgressRow(step, timing, nowMs);
  return html`
    <div class="substep ${step.status}">
      <span class="substep-icon">${row.icon}</span>
      <span class="substep-name">${step.name}</span>
      ${row.duration
        ? html`<span class="substep-duration" data-live=${row.live}>${row.duration}</span>`
        : nothing}
    </div>
    ${step.subtask && !nested
      ? renderSubtaskBlock(
          step.subtask,
          (childStep) =>
            renderTrackerStepRow(childStep, openScope, true, step.subtask?.progress.timing, nowMs),
          openScope,
        )
      : nothing}
  `;
}

export interface ChecklistRenderOptions extends ChecklistProgressOptions {
  runId?: string;
  runActive?: boolean;
  compact?: boolean;
  closable?: boolean;
  onClose?: () => void;
  openScope: SubtaskOpenScope;
}

/** The sole web checklist renderer, shared by the element and its contract tests. */
export function renderChecklistProgress(
  progress: TaskProgressStructured | undefined,
  options: ChecklistRenderOptions,
) {
  const view = checklistProgressView(progress, options);
  if (!view) return nothing;
  return html`<div class="monitor-detail" data-testid="checklist-progress">
    <div class="monitor-detail-header">
      <span>${view.heading}</span>
      ${options.closable
        ? html`<button
            class="monitor-close"
            aria-label="Close worker progress"
            @click=${options.onClose}
          >
            x
          </button>`
        : nothing}
    </div>
    ${progress && !options.compact
      ? renderOperationPanel(progress, options.runId, { runActive: options.runActive })
      : nothing}
    ${view.waiting
      ? html`<div class="waiting">${view.message}<br />Waiting for the worker checklist.</div>`
      : nothing}
    ${options.compact
      ? nothing
      : view.phases.map(
          (phase) =>
            html`<div class="phase">
              <div class="phase-header">
                <span
                  style="color:${phase.running
                    ? colors.accentHover
                    : phase.complete
                      ? colors.statusOk
                      : colors.textPrimary}"
                  >${phase.name}</span
                ><span class="phase-count">${phase.counts}</span>
              </div>
              ${phase.rows.map(({ step }) =>
                renderTrackerStepRow(
                  step,
                  options.openScope,
                  false,
                  progress?.timing,
                  options.nowMs,
                ),
              )}
            </div>`,
        )}
  </div>`;
}

@customElement('progress-tracker')
export class ProgressTracker extends LitElement {
  private readonly _operationClock = new OperationClock(
    this,
    () => this.structured,
    () => checklistProgressIsLive(this.structured),
  );
  private readonly subtaskOpen = new SubtaskOpenState();
  @property({ attribute: false }) openScope?: SubtaskOpenScope;
  @property() markdown = '';
  @property({ type: Boolean }) compact = false;
  @property({ attribute: false }) structured?: TaskProgressStructured;
  @property({ attribute: false }) steps?: readonly ChecklistProgressStep[];
  @property({ attribute: false }) fallback?: ChecklistProgressFallback;
  @property({ attribute: false }) activeStep: PipelineProgressStep = null;
  @property() activeTaskBasename?: string;
  @property() runId?: string;
  @property({ type: Boolean }) runActive = false;
  @property({ type: Boolean }) closable = false;

  static styles = [
    css`
      :host {
        display: block;
        font-family: ${unsafeCSS(fonts.mono)};
      }
      .monitor-detail {
        margin-top: ${unsafeCSS(spacing.md)};
        background: ${unsafeCSS(colors.bgCard)};
        border-radius: ${unsafeCSS(radii.md)};
        padding: ${unsafeCSS(spacing.md)};
        cursor: default;
      }
      .monitor-detail-header {
        font-size: ${unsafeCSS(fonts.sizeSm)};
        font-weight: 600;
        color: ${unsafeCSS(colors.textSecondary)};
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: ${unsafeCSS(spacing.sm)};
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .monitor-close {
        background: none;
        border: none;
        color: ${unsafeCSS(colors.textSecondary)};
        cursor: pointer;
        font-family: inherit;
        font-size: 12px;
        padding: 0 4px;
      }
      .monitor-close:hover {
        color: ${unsafeCSS(colors.textPrimary)};
      }
      .phase {
        margin-bottom: ${unsafeCSS(spacing.lg)};
      }
      .phase-header {
        font-size: ${unsafeCSS(fonts.sizeSm)};
        font-weight: 600;
        color: ${unsafeCSS(colors.textPrimary)};
        margin-bottom: 2px;
        display: flex;
        justify-content: space-between;
      }
      .phase-count {
        color: ${unsafeCSS(colors.textSecondary)};
        font-weight: 400;
      }
      .substep {
        font-size: ${unsafeCSS(fonts.sizeSm)};
        color: ${unsafeCSS(colors.textPrimary)};
        border-left: 2px solid transparent;
        padding: 4px 8px;
        line-height: 1.5;
        overflow-wrap: anywhere;
        display: flex;
        align-items: flex-start;
        gap: ${unsafeCSS(spacing.sm)};
      }
      .substep-icon {
        width: 12px;
        text-align: center;
        flex-shrink: 0;
      }
      .substep-name {
        flex: 1;
        min-width: 0;
      }
      .substep-duration {
        color: ${unsafeCSS(colors.textSecondary)};
        white-space: nowrap;
        font-weight: 400;
        font-variant-numeric: tabular-nums;
      }
      .substep.done .substep-icon {
        color: ${unsafeCSS(colors.statusOk)};
      }
      .substep.running .substep-icon {
        color: ${unsafeCSS(colors.accentHover)};
      }
      .substep.done,
      .substep.skipped {
        color: ${unsafeCSS(colors.textSecondary)};
      }
      .substep.running {
        border-left-color: ${unsafeCSS(colors.accentHover)};
        background: ${unsafeCSS(colors.bgSurface)};
        border-radius: ${unsafeCSS(radii.sm)};
        font-weight: 600;
      }

      .waiting {
        color: ${unsafeCSS(colors.textSecondary)};
        font-size: ${unsafeCSS(fonts.sizeSm)};
      }
    `,
    operationPanelStyles,
    subtaskBlockStyles,
  ];

  render() {
    return renderChecklistProgress(this.structured, {
      markdown: this.markdown,
      steps: this.steps,
      fallback: this.fallback,
      activeStep: this.activeStep,
      activeTaskBasename: this.activeTaskBasename,
      runId: this.runId,
      runActive: this.runActive,
      compact: this.compact,
      closable: this.closable,
      openScope: this.openScope ?? this.subtaskOpen.scope(this.runId),
      onClose: () =>
        this.dispatchEvent(new CustomEvent('progress-close', { bubbles: true, composed: true })),
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'progress-tracker': ProgressTracker;
  }
}
