import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { TaskPhaseProgress, TaskProgressStructured } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

interface Step {
  text: string;
  done: boolean;
}

function parseSteps(markdown: string): Step[] {
  const steps: Step[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]')) {
      steps.push({ text: trimmed.slice(5).trim(), done: true });
    } else if (trimmed.startsWith('- [ ]')) {
      steps.push({ text: trimmed.slice(5).trim(), done: false });
    }
  }
  return steps;
}

const STATUS_ICONS: Record<string, string> = {
  done: '\u2713', // checkmark
  running: '\u25b8', // right-pointing triangle
  pending: '\u25cb', // circle
  skipped: '\u2013', // en-dash
};

@customElement('progress-tracker')
export class ProgressTracker extends LitElement {
  @property() markdown = '';
  @property({ type: Boolean }) compact = false;
  @property({ type: Object }) structured?: TaskProgressStructured;

  @state() private _expandedPhases: Set<string> = new Set();
  private _prevCurrentPhase: string | null = null;

  static styles = css`
    :host {
      display: block;
      font-family: ${unsafeCSS(fonts.mono)};
    }

    .progress-bar-container {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
    }

    .progress-track {
      flex: 1;
      height: 6px;
      background: ${unsafeCSS(colors.bgCard)};
      border-radius: 3px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: ${unsafeCSS(colors.accent)};
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .progress-label {
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textSecondary)};
      white-space: nowrap;
    }

    /* --- Flat step list --- */

    .step-list {
      margin-top: ${unsafeCSS(spacing.lg)};
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.sm)};
    }

    .step {
      display: flex;
      align-items: flex-start;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-left: 2px solid transparent;
      border-radius: ${unsafeCSS(radii.sm)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      line-height: 1.4;
    }

    .step.current {
      border-left-color: ${unsafeCSS(colors.accent)};
      background: ${unsafeCSS(colors.accent)}0a;
    }

    .step-check {
      flex-shrink: 0;
      width: 16px;
      text-align: center;
    }

    .step-check.done {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .step-check.pending {
      color: ${unsafeCSS(colors.textMuted)};
    }

    .step-text {
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .step.done .step-text {
      color: ${unsafeCSS(colors.textMuted)};
    }

    /* --- Structured phase accordion --- */

    .phase-list {
      margin-top: ${unsafeCSS(spacing.lg)};
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.sm)};
    }

    .phase {
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgCard)};
      overflow: hidden;
    }

    .phase-header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      cursor: pointer;
      user-select: none;
    }
    .phase-header:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }

    .phase-arrow {
      flex-shrink: 0;
      width: 10px;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
    }

    .phase-name {
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .phase-mini-bar {
      width: 40px;
      height: 3px;
      background: ${unsafeCSS(colors.bgSurface)};
      border-radius: 2px;
      overflow: hidden;
      flex-shrink: 0;
    }

    .phase-mini-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    .phase-count {
      color: ${unsafeCSS(colors.textMuted)};
      flex-shrink: 0;
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }

    .phase.complete .phase-name {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .phase.active .phase-name {
      color: ${unsafeCSS(colors.accent)};
    }

    .phase-steps {
      display: flex;
      flex-direction: column;
      padding: 0 ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.sm)};
      padding-left: ${unsafeCSS(spacing.xl)};
      gap: 2px;
    }

    .s-step {
      display: flex;
      align-items: flex-start;
      gap: ${unsafeCSS(spacing.sm)};
      padding: 2px 0;
      font-size: ${unsafeCSS(fonts.sizeSm)};
      line-height: 1.4;
    }

    .s-step-icon {
      flex-shrink: 0;
      width: 14px;
      text-align: center;
    }

    .s-step-icon.done {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .s-step-icon.running {
      color: ${unsafeCSS(colors.accent)};
    }
    .s-step-icon.pending {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .s-step-icon.skipped {
      color: ${unsafeCSS(colors.textMuted)};
    }

    .s-step-name {
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .s-step.done .s-step-name {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .s-step.running .s-step-name {
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .s-step.running {
      border-left: 2px solid ${unsafeCSS(colors.accent)};
      padding-left: ${unsafeCSS(spacing.sm)};
      margin-left: -${unsafeCSS(spacing.sm)};
    }

    @keyframes pulse-accent {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.4;
      }
    }

    .s-step-icon.running {
      animation: pulse-accent 1.5s ease-in-out infinite;
    }
  `;

  render() {
    if (this.structured) {
      return this.renderStructured(this.structured);
    }
    return this.renderFlat();
  }

  willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has('structured') && this.structured) {
      const cur = this.structured.currentPhase;
      if (cur && cur !== this._prevCurrentPhase) {
        this._expandedPhases.add(cur);
        this._prevCurrentPhase = cur;
      }
    }
  }

  private _togglePhase(name: string) {
    const next = new Set(this._expandedPhases);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    this._expandedPhases = next;
  }

  private renderFlat() {
    const steps = parseSteps(this.markdown);
    if (steps.length === 0) return html``;

    const completed = steps.filter((s) => s.done).length;
    const total = steps.length;
    const pct = Math.round((completed / total) * 100);
    const currentIdx = steps.findIndex((s) => !s.done);

    return html`
      <div class="progress-bar-container">
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="progress-label">${completed}/${total} steps</span>
      </div>
      ${this.compact
        ? nothing
        : html`
            <div class="step-list">
              ${steps.map(
                (step, i) => html`
                  <div class="step ${step.done ? 'done' : ''} ${i === currentIdx ? 'current' : ''}">
                    <span class="step-check ${step.done ? 'done' : 'pending'}"
                      >${step.done ? '[x]' : '[ ]'}</span
                    >
                    <span class="step-text">${step.text}</span>
                  </div>
                `,
              )}
            </div>
          `}
    `;
  }

  private renderStructured(s: TaskProgressStructured) {
    const pct = s.totalSteps > 0 ? Math.round((s.completedSteps / s.totalSteps) * 100) : 0;

    const label = s.currentPhase
      ? `${s.currentPhase} ${s.completedSteps}/${s.totalSteps}`
      : `${s.completedSteps}/${s.totalSteps} done`;

    return html`
      <div class="progress-bar-container">
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="progress-label">${label}</span>
      </div>
      ${this.compact
        ? nothing
        : html`
            <div class="phase-list">
              ${s.phases.map((phase) => this._renderPhase(phase, s.currentPhase))}
            </div>
          `}
    `;
  }

  private _renderPhase(phase: TaskPhaseProgress, currentPhase: string | null) {
    const isComplete = phase.completedSteps === phase.totalSteps;
    const isActive = phase.name === currentPhase;
    const isExpanded = this._expandedPhases.has(phase.name);
    const phasePct = phase.totalSteps > 0 ? (phase.completedSteps / phase.totalSteps) * 100 : 0;
    const barColor = isComplete ? colors.statusOk : isActive ? colors.accent : colors.textMuted;

    return html`
      <div class="phase ${isComplete ? 'complete' : ''} ${isActive ? 'active' : ''}">
        <div class="phase-header" @click=${() => this._togglePhase(phase.name)}>
          <span class="phase-arrow">${isExpanded ? '\u25BE' : '\u25B8'}</span>
          <span class="phase-name">${phase.name}</span>
          <div class="phase-mini-bar">
            <div class="phase-mini-fill" style="width:${phasePct}%; background:${barColor}"></div>
          </div>
          <span class="phase-count">${phase.completedSteps}/${phase.totalSteps}</span>
        </div>
        ${isExpanded
          ? html`
              <div class="phase-steps">
                ${phase.steps.map(
                  (step) => html`
                    <div class="s-step ${step.status}">
                      <span class="s-step-icon ${step.status}">${STATUS_ICONS[step.status]}</span>
                      <span class="s-step-name">${step.name}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'progress-tracker': ProgressTracker;
  }
}
