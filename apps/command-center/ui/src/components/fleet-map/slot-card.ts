import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { Run, SlotStatus, TaskProgressStructured } from '@farmslot/protocol';

import '../shared/status-badge.js';
import './slot-headroom-dot.js';

import { getProjectSlotTrackingConfigs } from '../../state.js';
import {
  colors,
  fonts,
  lifecycleColor,
  radii,
  shadows,
  spacing,
} from '../../styles/theme-tokens.js';
import { runStatusColor } from '../runs/run-utils.js';

import { slotBranchDisplay } from './slot-branch-display.js';

@customElement('slot-card')
export class SlotCard extends LitElement {
  @property({ attribute: false }) slotData!: SlotStatus;
  @property({ type: Boolean }) nodeOnline = false;
  @property({ attribute: false }) progress?: TaskProgressStructured;
  @property({ attribute: false }) linkedRun?: Run;
  @property({ attribute: false }) thumbnailData?: { data: string; ts: number };
  @property({ type: Boolean }) expanded = false;
  @property({ type: Number }) pendingDecisions = 0;

  static styles = css`
    :host {
      display: block;
    }
    .card {
      background: ${unsafeCSS(colors.bgCard)};
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.lg)};
      border-left: 3px solid transparent;
      box-shadow: ${unsafeCSS(shadows.card)};
      cursor: pointer;
      transition:
        background 0.15s,
        border-color 0.15s;
      min-width: 180px;
    }
    .card:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .card.working {
      border-left-width: 4px;
      animation: work-pulse 2.5s ease-in-out infinite;
    }
    .card.node-offline {
      opacity: 0.45;
      filter: grayscale(0.9);
    }
    .card.node-offline:hover {
      opacity: 0.6;
    }
    @keyframes work-pulse {
      0%,
      100% {
        box-shadow:
          ${unsafeCSS(shadows.card)},
          0 0 0 0 rgba(245, 158, 11, 0);
      }
      50% {
        box-shadow:
          ${unsafeCSS(shadows.card)},
          0 0 14px 3px rgba(245, 158, 11, 0.28);
      }
    }
    .working-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #f59e0b;
      margin-left: auto;
      animation: dot-blink 1.2s ease-in-out infinite;
    }
    @keyframes dot-blink {
      0%,
      100% {
        opacity: 1;
        transform: scale(1);
      }
      50% {
        opacity: 0.4;
        transform: scale(0.7);
      }
    }
    .slot-id {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
      margin-bottom: 4px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .lifecycle {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 1px 6px;
      border-radius: ${unsafeCSS(radii.sm)};
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }
    .meta {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textSecondary)};
      line-height: 1.5;
    }
    .meta .branch {
      color: ${unsafeCSS(colors.accent)};
    }
    .meta .branch.main,
    .meta .branch.tracking {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .meta .branch.stale {
      color: ${unsafeCSS(colors.accent)};
    }
    .meta .task {
      color: ${unsafeCSS(colors.lifecycleBusy)};
    }
    .meta .runner {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .presence-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .agent-indicator {
      display: inline-block;
      margin-left: 4px;
    }
    .agent-indicator.working {
      animation: spin 1.5s linear infinite;
    }
    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
    .terminal-btn {
      background: none;
      border: none;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
      border-radius: 3px;
    }
    .terminal-btn:hover,
    .actions-btn:hover {
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
    }
    .actions-btn {
      background: none;
      border: none;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
      border-radius: 3px;
    }
    .mini-progress {
      margin-top: ${unsafeCSS(spacing.md)};
    }
    .mini-progress-bar {
      height: 3px;
      background: ${unsafeCSS(colors.bgSurface)};
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 3px;
    }
    .mini-progress-fill {
      height: 100%;
      background: ${unsafeCSS(colors.accent)};
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .mini-progress-label {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 9px;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .mini-progress-phase {
      color: ${unsafeCSS(colors.accent)};
    }
    .run-badge {
      margin-top: ${unsafeCSS(spacing.md)};
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 9px;
      color: ${unsafeCSS(colors.textMuted)};
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 3px;
      background: ${unsafeCSS(colors.bgSurface)};
    }
    .run-badge:hover {
      background: ${unsafeCSS(colors.accent)}15;
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .pr-health {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: ${unsafeCSS(spacing.md)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 9px;
    }
    .pr-health-badge {
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
    .pr-health-badge.conflict {
      background: ${unsafeCSS(colors.statusFail)}22;
      color: ${unsafeCSS(colors.statusFail)};
    }
    .pr-health-badge.ci-pass {
      background: ${unsafeCSS(colors.statusOk)}22;
      color: ${unsafeCSS(colors.statusOk)};
    }
    .pr-health-badge.ci-fail {
      background: ${unsafeCSS(colors.statusFail)}22;
      color: ${unsafeCSS(colors.statusFail)};
    }
    .pr-health-badge.ci-pending {
      background: ${unsafeCSS(colors.statusWarn)}22;
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .run-badge-status {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .run-summary {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 9px;
      color: ${unsafeCSS(colors.textSecondary)};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      margin-top: 2px;
    }
    .card.expandable {
      border-bottom-color: ${unsafeCSS(colors.accent)}44;
    }
    .card.expandable.is-expanded {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .expand-chevron {
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
      transition: transform 0.15s;
    }
    .expand-chevron.open {
      transform: rotate(90deg);
    }
    .card-body {
      display: flex;
      gap: ${unsafeCSS(spacing.md)};
    }
    .thumbnail {
      flex-shrink: 0;
      width: 60px;
      border-radius: ${unsafeCSS(radii.sm)};
      overflow: hidden;
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    .thumbnail.loaded {
      opacity: 1;
    }
    .thumbnail img {
      width: 100%;
      height: auto;
      display: block;
      border-radius: ${unsafeCSS(radii.sm)};
    }
    .card-content {
      flex: 1;
      min-width: 0;
    }
    .decision-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      margin-top: ${unsafeCSS(spacing.md)};
      padding: 2px 7px;
      border-radius: 3px;
      background: ${unsafeCSS(colors.statusWarn)}22;
      border: 1px solid ${unsafeCSS(colors.statusWarn)}55;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 9px;
      font-weight: 700;
      color: ${unsafeCSS(colors.statusWarn)};
      cursor: pointer;
      animation: decision-pulse 2s ease-in-out infinite;
    }
    .decision-badge:hover {
      background: ${unsafeCSS(colors.statusWarn)}33;
    }
    @keyframes decision-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.65;
      }
    }
  `;

  render() {
    const s = this.slotData;
    if (!s) return html``;

    const lc = lifecycleColor(s.lifecycle);
    const isWorking = s.lifecycle === 'busy' && s.phase === 'working';
    const hasActiveRun = !!this.linkedRun && s.lifecycle === 'busy';
    const hasExpandableRun = hasActiveRun;
    const legacyIdentity = !!s.currentRunId && !s.currentFamilyId;
    const branch = slotBranchDisplay(s, getProjectSlotTrackingConfigs());
    const branchLabel = branch.label;
    const branchClass =
      branch.tone === 'baseline'
        ? 'branch main'
        : branch.tone === 'tracking'
          ? 'branch tracking'
          : 'branch stale';

    return html`
      <div
        class="card ${isWorking ? 'working' : ''} ${hasExpandableRun ? 'expandable' : ''} ${this
          .expanded
          ? 'is-expanded'
          : ''} ${!this.nodeOnline ? 'node-offline' : ''}"
        style="border-left-color: ${lc};"
        @click=${() => {
          if (hasExpandableRun) {
            this.dispatchEvent(
              new CustomEvent('slot-expand', {
                detail: { slotId: s.slot },
                bubbles: true,
                composed: true,
              }),
            );
          } else {
            this.dispatchEvent(
              new CustomEvent('slot-selected', {
                detail: { slotId: s.slot },
                bubbles: true,
                composed: true,
              }),
            );
          }
        }}
      >
        <div class="slot-id">
          <span
            class="presence-dot"
            title="${this.nodeOnline ? 'node online' : 'node offline'}"
            style="background: ${this.nodeOnline
              ? colors.statusOk
              : colors.statusUnknown}; display:inline-block; vertical-align:middle; margin-right:4px;"
          ></span
          >${s.slot}
        </div>
        <div class="header">
          <span
            class="lifecycle"
            style="background: ${lc}${isWorking ? '30' : '18'}; color: ${lc}; ${isWorking
              ? `border: 1px solid ${lc}55;`
              : ''}"
            >${s.phase ? `${s.lifecycle} (${s.phase})` : s.lifecycle}</span
          >
          ${isWorking ? html`<span class="working-dot" title="Agent actively working"></span>` : ''}
          <button
            class="terminal-btn"
            title="Open terminal"
            @click=${(e: Event) => {
              e.stopPropagation();
              this.dispatchEvent(
                new CustomEvent('slot-terminal', {
                  detail: { slotId: s.slot },
                  bubbles: true,
                  composed: true,
                }),
              );
            }}
          >
            &gt;_
          </button>
          <button
            class="actions-btn"
            title="Slot actions (refresh, recycle, release...)"
            @click=${(e: Event) => {
              e.stopPropagation();
              this.dispatchEvent(
                new CustomEvent('slot-actions-open', {
                  detail: { slotId: s.slot },
                  bubbles: true,
                  composed: true,
                }),
              );
            }}
          >
            &#x22EF;
          </button>
          ${s.hostLoad
            ? html`<slot-headroom-dot .headroom=${s.hostLoad.headroom}></slot-headroom-dot>`
            : ''}
          ${hasExpandableRun
            ? html`<span class="expand-chevron ${this.expanded ? 'open' : ''}">&#x25B8;</span>`
            : ''}
        </div>
        <div class="card-body">
          ${this.thumbnailData
            ? html`
                <div
                  class="thumbnail loaded"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    location.hash = `slot/${s.slot}`;
                  }}
                >
                  <img
                    src="data:image/png;base64,${this.thumbnailData.data}"
                    alt="Device preview"
                  />
                </div>
              `
            : ''}
          <div class="card-content">
            <div class="meta">
              ${branchLabel ? html`<div class="${branchClass}">${branchLabel}</div>` : ''}
              ${s.taskId ? html`<div class="task">${this._formatTaskId(s.taskId)}</div>` : ''}
              ${s.currentLane
                ? html`<div class="runner">
                    lane:${s.currentLane}${s.currentVariant ? ` · ${s.currentVariant}` : ''}
                  </div>`
                : ''}
              ${s.currentFamilyId
                ? html`<div class="runner">family:${s.currentFamilyId.slice(0, 8)}</div>`
                : ''}
              ${s.runner
                ? html`<div class="runner">
                    ${s.runner}${s.model ? `/${s.model}` : ''}
                    <span class="agent-indicator ${s.agent === 'working' ? 'working' : ''}"
                      >${s.agent === 'working' ? '*' : '-'}</span
                    >
                  </div>`
                : ''}
            </div>
            ${this.pendingDecisions > 0
              ? html`
                  <div
                    class="decision-badge"
                    title="${this.pendingDecisions} pending decision${this.pendingDecisions > 1
                      ? 's'
                      : ''} — click to review"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      location.hash = 'decisions';
                    }}
                  >
                    ! ${this.pendingDecisions} decision${this.pendingDecisions > 1 ? 's' : ''}
                  </div>
                `
              : ''}
            ${legacyIdentity
              ? html`
                  <div
                    class="decision-badge"
                    title="Legacy slot identity: current run exists but family/lane/variant were not persisted yet."
                  >
                    legacy identity
                  </div>
                `
              : ''}
            ${s.prHealth ? this.renderPrHealth(s.prHealth) : ''}
            ${this.progress && (isWorking || hasActiveRun)
              ? this.renderMiniProgress(this.progress)
              : ''}
            ${hasActiveRun ? this.renderRunBadge(this.linkedRun!) : ''}
          </div>
        </div>
      </div>
    `;
  }

  private _formatTaskId(taskId: string): string {
    // "EXAMPLE-APP-41279-0330-1530" → "PR #41279"
    // "EXAMPLE-APP-41279" → "PR #41279"
    // "PROJ-2636" → "PROJ-2636"
    const prMatch = taskId.match(/[A-Z]+-(\d{4,6})(?:-\d{4}-\d{4})?$/);
    if (prMatch) return `PR #${prMatch[1]}`;
    // Jira-style: already short
    if (/^[A-Z]+-\d+$/.test(taskId)) return taskId;
    // Fallback: truncate long prefixes
    return taskId.length > 20 ? '...' + taskId.slice(-16) : taskId;
  }

  private renderRunBadge(run: Run) {
    const sc = runStatusColor(run.status);
    const currentStep = run.steps.find((s) => s.status === 'running');
    return html`
      <div
        class="run-badge"
        title="${run.summary ?? 'Click to view run'}"
        @click=${(e: Event) => {
          e.stopPropagation();
          location.hash = ['done', 'failed', 'cancelled'].includes(run.status)
            ? `family/${run.familyId}?run=${encodeURIComponent(run.id)}`
            : `run/${run.id}`;
        }}
      >
        <span class="run-badge-status" style="background:${sc}"></span>
        RUN ${run.id.slice(0, 4)}
        ${currentStep?.name ?? run.status}${currentStep?.detail ? ` · ${currentStep.detail}` : ''}
      </div>
      <div class="run-summary">
        <a
          href="#runs?family=${encodeURIComponent(run.familyId)}"
          style="color:${colors.accent}; text-decoration:none"
          @click=${(e: Event) => e.stopPropagation()}
        >
          family ${run.familyId.slice(0, 8)}
        </a>
      </div>
      ${run.summary ? html`<div class="run-summary">${run.summary}</div>` : ''}
    `;
  }

  private renderPrHealth(ph: NonNullable<SlotStatus['prHealth']>) {
    const ciClass =
      ph.ciFailed > 0
        ? 'ci-fail'
        : ph.ciPassed === ph.ciTotal && ph.ciTotal > 0
          ? 'ci-pass'
          : 'ci-pending';
    const ciLabel =
      ph.ciFailed > 0
        ? `${ph.ciFailed} failed`
        : ph.ciPassed === ph.ciTotal && ph.ciTotal > 0
          ? 'CI pass'
          : `${ph.ciPending} pending`;
    return html`
      <div class="pr-health">
        ${ph.conflict ? html`<span class="pr-health-badge conflict">CONFLICT</span>` : ''}
        <span class="pr-health-badge ${ciClass}">${ciLabel}</span>
        <span style="color:${colors.textMuted}">PR #${ph.pr}</span>
      </div>
    `;
  }

  private renderMiniProgress(p: TaskProgressStructured) {
    const pct = p.totalSteps > 0 ? Math.round((p.completedSteps / p.totalSteps) * 100) : 0;
    const label = p.currentPhase
      ? html`<span class="mini-progress-phase">${p.currentPhase}</span>
          ${p.completedSteps}/${p.totalSteps}`
      : html`${p.completedSteps}/${p.totalSteps} done`;
    return html`
      <div class="mini-progress">
        <div class="mini-progress-bar">
          <div class="mini-progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="mini-progress-label">${label}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-card': SlotCard;
  }
}
