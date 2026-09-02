import { html, nothing } from 'lit';

import type { Run, TaskProgressStructured } from '@farmslot/protocol';
import { nestedLoopProgressLabel } from '@farmslot/protocol/checklist-target';

import { colors } from '../../styles/theme-tokens.js';

import { isInteractiveCompletionAwaitingOperator } from './run-detail-model.js';
import { formatDuration } from './run-utils.js';

export interface PipelineControlHandlers {
  pause: () => void | Promise<void>;
  resume: () => void | Promise<void>;
  cancel: () => void | Promise<void>;
}

export function renderReviewRecoveryStatus(run: Run) {
  const recovery = run.engineState?.publishGate?.reviewRecovery;
  if (!recovery || recovery.status === 'recovered') return nothing;
  return html`
    <div class="review-recovery ${recovery.status}" role="status">
      Review recovery: ${recovery.status}${recovery.lastError ? ` — ${recovery.lastError}` : ''}
    </div>
  `;
}

export function renderPipelineControls(
  run: Run,
  handlers: PipelineControlHandlers,
  opts: { cancelPending?: boolean } = {},
) {
  const status = run.status;
  const isRunning = ['monitoring', 'ci-watching', 'preparing', 'dispatching'].includes(status);
  const isPaused = status === 'paused';
  const awaitingOperator = isInteractiveCompletionAwaitingOperator(run);
  const isTerminal = ['done', 'failed', 'cancelled'].includes(status);

  return html`
    <div class="controls">
      ${opts.cancelPending ? html`<span class="ctrl-pending">Cancelling run…</span>` : nothing}
      ${!opts.cancelPending && awaitingOperator
        ? html`<span class="ctrl-pending">Awaiting operator action</span>`
        : !opts.cancelPending && isPaused
          ? html` <button class="ctrl-btn ctrl-resume" @click=${handlers.resume}>Resume</button> `
          : !opts.cancelPending && isRunning
            ? html` <button class="ctrl-btn ctrl-pause" @click=${handlers.pause}>Pause</button> `
            : nothing}
      ${!isTerminal
        ? html`
            <button
              class="ctrl-btn ctrl-cancel"
              ?disabled=${opts.cancelPending}
              @click=${handlers.cancel}
            >
              ${opts.cancelPending ? 'Cancelling…' : 'Cancel'}
            </button>
          `
        : nothing}
    </div>
  `;
}

export function renderRunPipelineSummary(run: Run) {
  const isTerminal = ['done', 'failed', 'cancelled'].includes(run.status);
  if (!isTerminal) return nothing;

  const m = run.metrics;
  const duration = m.durationMs ? formatDuration(m.durationMs) : '';
  const cost = m.costEstimate ? `$${m.costEstimate.toFixed(2)}` : '';
  const model = m.model ?? '';
  const runner = m.runner ?? '';
  const outcome = m.outcome ?? run.status;
  const outcomeColor =
    outcome === 'success'
      ? colors.statusOk
      : outcome === 'failure'
        ? colors.statusFail
        : colors.textMuted;

  return html`
    <div class="run-summary">
      <span class="summary-outcome" style="color: ${outcomeColor}">
        ${outcome === 'success' ? 'v' : outcome === 'failure' ? 'x' : '-'} ${outcome}
      </span>
      ${duration ? html`<span class="summary-item">${duration}</span>` : nothing}
      ${cost ? html`<span class="summary-item summary-cost">${cost}</span>` : nothing}
      ${model ? html`<span class="summary-item">${runner}/${model}</span>` : nothing}
      ${run.metrics.nudgeCount > 0
        ? html`<span class="summary-item summary-warn"
            >${run.metrics.nudgeCount} nudge${run.metrics.nudgeCount > 1 ? 's' : ''}</span
          >`
        : nothing}
    </div>
  `;
}

export function renderPipelineProgressPanel(
  progress: TaskProgressStructured,
  activeStep: 'monitor' | 'self-review' | 'ci-watch' | null,
  close: () => void,
  activeTaskBasename?: string | null,
) {
  const label = nestedLoopProgressLabel(activeStep, activeTaskBasename);
  return html`
    <div class="monitor-detail">
      <div class="monitor-detail-header">
        <span
          >${label} ${progress.completedSteps}/${progress.totalSteps}
          ${progress.currentPhase ? ` — ${progress.currentPhase}` : ''}
        </span>
        <button class="monitor-close" @click=${close}>x</button>
      </div>
      ${progress.phases.map((phase) => {
        const allDone = phase.completedSteps === phase.totalSteps;
        const hasRunning = phase.steps.some((step) => step.status === 'running');
        return html`
          <div class="phase">
            <div class="phase-header">
              <span
                style="color: ${hasRunning
                  ? '#3b82f6'
                  : allDone
                    ? colors.statusOk
                    : colors.textPrimary}"
              >
                ${phase.name}
              </span>
              <span class="phase-count">${phase.completedSteps}/${phase.totalSteps}</span>
            </div>
            ${phase.steps.map(
              (step) => html`
                <div class="substep ${step.status}">
                  <span class="substep-icon">
                    ${step.status === 'done' ? 'v' : step.status === 'running' ? '*' : '.'}
                  </span>
                  ${step.name}
                </div>
              `,
            )}
          </div>
        `;
      })}
    </div>
  `;
}
