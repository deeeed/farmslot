import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';

import {
  type FamilyObservabilityArtifact,
  Methods,
  type RunCIWatchPokeResult,
  type RunStep,
} from '@farmslot/protocol';

import '../shared/media-lightbox.js';
import '../shared/step-artifacts.js';
import '../shared/slot-prepare-options.js';

import { gateway } from '../../gateway-client.js';
import { colors } from '../../styles/theme-tokens.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';

import { formatDuration, stepStatusColor } from './run-utils.js';
import { renderStepInspectorCiWatchBanner } from './step-inspector-ci-watch-renderer.js';
import {
  COMMAND_KEYS,
  COST_KEYS,
  DURATION_KEYS,
  extractStepCostInfo,
  HIDDEN_KEYS,
  LIST_KEYS,
  LOG_KEYS,
  OUTPUT_KEYS,
  type ReviewLoopAttempt,
  reviewLoopAttempts,
  stepArtifactsForRunStep,
  stepArtifactUrl,
  type StepCostInfo,
  stepDurationLabel,
  stepHasReviewLoop,
} from './step-inspector-model.js';
import { StepInspectorState } from './step-inspector-state.js';
import { stepInspectorStyles } from './step-inspector-styles.js';

@customElement('step-inspector')
export class StepInspector extends StepInspectorState {
  static styles = stepInspectorStyles;

  render() {
    if (!this.step) return nothing;
    const s = this.step;
    const sc = stepStatusColor(s.status);
    const duration = this._stepDurationLabel(s);

    const stepArtifacts = this._stepArtifacts();
    // Filter `artifacts` from outputs when we render them via the dedicated
    // step-artifacts panel — avoids duplicating the same list twice in the
    // inspector.
    const skipArtifactsKey = stepArtifacts.length > 0;
    const inputs = s.inputs
      ? Object.entries(s.inputs).filter(
          ([k]) => !HIDDEN_KEYS.has(k) && !COMMAND_KEYS.has(k) && !LOG_KEYS.has(k),
        )
      : [];
    const outputs = s.outputs
      ? Object.entries(s.outputs).filter(
          ([k]) =>
            !HIDDEN_KEYS.has(k) &&
            !COMMAND_KEYS.has(k) &&
            !LOG_KEYS.has(k) &&
            k !== 'profile' &&
            !(skipArtifactsKey && k === 'artifacts'),
        )
      : [];
    const profileSummary =
      s.name === 'prepare'
        ? prepareProfileSummary((s.outputs as Record<string, unknown> | undefined)?.profile)
        : '';
    const commands = s.outputs
      ? Object.entries(s.outputs).filter(([k, v]) => COMMAND_KEYS.has(k) && typeof v === 'string')
      : [];
    const logPaths = s.outputs ? Object.entries(s.outputs).filter(([k]) => LOG_KEYS.has(k)) : [];

    // Extract cost info for prominent display
    const costInfo = this._extractCostInfo(s);

    return html`
      <div class="inspector">
        <div class="header">
          <span class="step-name">${s.name}</span>
          <span class="status" style="background:${sc}22; color:${sc}">${s.status}</span>
          ${duration ? html`<span class="duration">${duration}</span>` : nothing}
          ${this.allowReplay
            ? html`
                <button class="retry-btn" @click=${this._onReplay}>Retry from here</button>
                ${s.name === 'prepare'
                  ? html`
                      <slot-prepare-options
                        variant="replay"
                        .project=${this.run?.project ?? ''}
                        persist-prefs=${false}
                        show-plan=${false}
                        ?show-advanced=${false}
                        compact
                        @profile-action=${(event: CustomEvent<{ prepareProfile: string }>) =>
                          this._onReplayWithProfile(event.detail.prepareProfile)}
                        @skip-prepare-action=${this._onReplaySkipPrepare}
                      ></slot-prepare-options>
                    `
                  : nothing}
              `
            : nothing}
          ${s.status === 'failed' && this.run
            ? html`
                <button class="retry-btn diagnose-btn" @click=${this._onDiagnoseFailure}>
                  Diagnose
                </button>
              `
            : nothing}
          <button class="close" @click=${this._onClose}>x</button>
        </div>

        ${commands.length > 0
          ? html` ${commands.map(([k, v]) => this._renderCommand(k, v as string))} `
          : nothing}
        ${logPaths.length > 0
          ? html` ${logPaths.map(([k, v]) => this._renderLogPaths(k, v))} `
          : nothing}
        ${this._renderCIWatchBanner(s)} ${this._renderReviewLoopSummary(s)}
        ${this._renderTaskProgress()}
        ${costInfo
          ? html`
              <div class="cost-summary">
                <div>
                  <div class="cost-label">Cost</div>
                  <div class="cost-value">${costInfo.cost}</div>
                </div>
                ${costInfo.tokens
                  ? html`
                      <div>
                        <div class="cost-label">Tokens</div>
                        <div class="cost-detail">${costInfo.tokens}</div>
                      </div>
                    `
                  : nothing}
                ${costInfo.model
                  ? html`
                      <div>
                        <div class="cost-label">Model</div>
                        <div class="cost-detail">${costInfo.model}</div>
                      </div>
                    `
                  : nothing}
                ${costInfo.extra
                  ? html`
                      <div>
                        <div class="cost-label">Session</div>
                        <div class="cost-detail">${costInfo.extra}</div>
                      </div>
                    `
                  : nothing}
              </div>
            `
          : nothing}
        ${stepArtifacts.length > 0
          ? html`
              <step-artifacts
                .stepName=${'Artifacts'}
                .status=${s.status}
                .artifacts=${stepArtifacts}
                .artifactUrl=${this._artifactUrl}
                .defaultOpen=${true}
                @step-artifact-click=${(
                  e: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
                ) => this._onStepArtifactClick(e)}
              ></step-artifacts>
            `
          : nothing}

        <div class="section-title">Timing</div>
        ${s.startedAt
          ? html`
              <div class="kv-row">
                <span class="kv-key">startedAt</span>
                <span class="kv-value">${s.startedAt}</span>
              </div>
            `
          : nothing}
        ${s.completedAt
          ? html`
              <div class="kv-row">
                <span class="kv-key">completedAt</span>
                <span class="kv-value">${s.completedAt}</span>
              </div>
            `
          : nothing}
        ${s.durationMs != null
          ? html`
              <div class="kv-row">
                <span class="kv-key">duration</span>
                <span class="kv-value v-duration">${formatDuration(s.durationMs)}</span>
              </div>
            `
          : s.status === 'running' && s.startedAt
            ? html`
                <div class="kv-row">
                  <span class="kv-key">elapsed</span>
                  <span class="kv-value v-duration"
                    >${formatDuration(
                      Math.max(0, this._tickNow - new Date(s.startedAt).getTime()),
                    )}</span
                  >
                </div>
              `
            : nothing}
        ${inputs.length > 0
          ? html`
              <div class="section-title">Inputs</div>
              ${inputs.map(([k, v]) => this._renderRow(k, v))}
            `
          : nothing}
        ${outputs.length > 0 || profileSummary
          ? html`
              <div class="section-title">Outputs</div>
              ${profileSummary ? this._renderRow('profile', profileSummary) : nothing}
              ${outputs.map(([k, v]) => this._renderRow(k, v))}
            `
          : nothing}
        ${s.detail
          ? html`
              <div class="detail ${s.status === 'failed' ? 'detail-fail' : 'detail-running'}">
                ${s.detail}
              </div>
            `
          : nothing}
      </div>

      <media-lightbox
        .items=${this._lightboxItems}
        .open=${this._lightboxOpen}
        .selectedIndex=${this._lightboxIndex}
        @lightbox-close=${() => this._closeLightbox()}
        @lightbox-navigate=${(e: CustomEvent) => this._navigateLightbox(e.detail.index)}
      ></media-lightbox>
    `;
  }

  private _renderRow(key: string, value: unknown) {
    return html`
      <div class="kv-row">
        <span class="kv-key">${key}</span>
        <span class="kv-value">${this._renderValue(key, value)}</span>
      </div>
    `;
  }

  private _renderTaskProgress() {
    const tp = this.taskProgress;
    if (!tp?.totalSteps) return nothing;
    const pct = Math.max(0, Math.min(100, (tp.completedSteps / tp.totalSteps) * 100));
    return html`
      <div class="section-title">Task Progress</div>
      <div class="task-progress">
        <div class="task-progress-summary">
          <span
            >${tp.completedSteps}/${tp.totalSteps}${tp.currentPhase
              ? ` — ${tp.currentPhase}`
              : ''}</span
          >
          <span>${Math.round(pct)}%</span>
        </div>
        <div class="task-progress-bar">
          <div class="task-progress-fill" style="width:${pct}%"></div>
        </div>
        ${tp.phases.map(
          (phase) => html`
            <div class="task-phase">
              <div class="task-phase-title">
                <span>${phase.name}</span>
                <span>${phase.completedSteps}/${phase.totalSteps}</span>
              </div>
              ${phase.steps.map(
                (step) => html`
                  <div class="task-progress-step ${step.status}">
                    ${step.status === 'done' ? 'v' : step.status === 'running' ? '*' : '.'}
                    ${step.name}
                  </div>
                `,
              )}
            </div>
          `,
        )}
      </div>
    `;
  }

  private _renderReviewLoopSummary(step: RunStep) {
    if (!stepHasReviewLoop(step)) return nothing;
    const out = (step.outputs ?? {}) as Record<string, unknown>;
    const timeline = Array.isArray(out.timeline) ? (out.timeline as Record<string, unknown>[]) : [];
    const attempts = reviewLoopAttempts(step);
    return html`
      <div class="section-title">Review Loop</div>
      <div class="review-loop">
        ${timeline.length
          ? html`<div class="review-loop-segments">
              ${timeline.map((segment) => this._renderReviewTimelineSegment(segment))}
            </div>`
          : nothing}
        ${attempts.map((attempt, index) => this._renderReviewAttempt(attempt, index))}
      </div>
    `;
  }

  private _renderReviewTimelineSegment(segment: Record<string, unknown>) {
    const kind = typeof segment.kind === 'string' ? segment.kind : 'review';
    const duration =
      typeof segment.durationMs === 'number' ? formatDuration(segment.durationMs) : '';
    const label = kind === 'worker-fix' ? 'fix' : kind === 're-review' ? 're-review' : 'review';
    return html`<span class="review-loop-segment ${kind === 'worker-fix' ? 'fix' : ''}"
      >${label}${duration ? ` ${duration}` : ''}</span
    >`;
  }

  private _renderReviewAttempt(attempt: ReviewLoopAttempt, index: number) {
    const { verdict, unresolvedCount: unresolved, issues, completedAt, loopNumber } = attempt;
    const color =
      verdict === 'pass'
        ? colors.statusOk
        : verdict === 'issues'
          ? colors.statusWarn
          : verdict === 'failed'
            ? colors.statusFail
            : colors.textMuted;
    return html`
      ${attempt.fixDeltaPath !== null
        ? html`<div class="review-loop-fix">
            worker fix applied${attempt.fixDeltaPath ? ` · ${attempt.fixDeltaPath}` : ''}
          </div>`
        : nothing}
      <div class="review-loop-row ${verdict}">
        <div class="review-loop-badge" style="color:${color}">
          ${verdict === 'pass' ? 'pass' : verdict === 'issues' ? 'issues' : verdict}
        </div>
        <div class="review-loop-body">
          <div>
            Review attempt ${index + 1}${loopNumber !== index + 1 ? ` (loop ${loopNumber})` : ''}
            ${unresolved ? ` — ${unresolved} unresolved` : ' — no unresolved findings'}
          </div>
          ${completedAt
            ? html`<div class="review-loop-meta">completed ${completedAt}</div>`
            : nothing}
          ${issues.map(
            (issue) => html`
              <div class="review-loop-issue">
                <span class="review-loop-file"
                  >${issue.file}${issue.line ? `:${issue.line}` : ''}</span
                >
                — ${issue.description}
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private _onDiagnoseFailure() {
    if (!this.step || !this.run) return;
    const prompt = [
      `Why did step "${this.step.name}" fail in run ${this.run.id}?`,
      `Ticket or PR: ${this.run.ticketOrPr}`,
      `Flow: ${this.run.flowType}`,
      this.run.slotId ? `Slot: ${this.run.slotId}` : '',
      this.step.detail ? `Step detail: ${this.step.detail}` : '',
      'Call propose_run_recovery for this run and step first.',
      'Show the proposal finding, evidence, confidence, inference notes, and read-only next steps.',
    ]
      .filter(Boolean)
      .join('\n');

    this.dispatchEvent(
      new CustomEvent('copilot-prompt-request', {
        detail: {
          prompt,
          intent: 'diagnostic-readonly',
          runId: this.run.id,
          stepName: this.step.name,
          sourceSurface: 'run-detail',
          contextOverride: {
            selectedRunId: this.run.id,
            selectedStepName: this.step.name,
            surfaceId: 'run-detail',
            affordances: ['failed-step-diagnosis', 'recovery-proposal'],
          },
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  updated() {
    const stepName = this.step?.name ?? '';
    if (stepName !== this._prevStepName) {
      this._prevStepName = stepName;
      this._prevLastOutput = '';
    }
    const lastOutput = (this.step?.outputs as Record<string, unknown> | undefined)?.lastOutput;
    if (typeof lastOutput === 'string' && lastOutput !== this._prevLastOutput) {
      this._prevLastOutput = lastOutput;
      const el = this.renderRoot.querySelector('.v-output');
      if (el) el.scrollTop = el.scrollHeight;
    }
    this._syncTickTimer();
    this._syncPokeState();
  }

  private _syncPokeState() {
    if (!this._poking || this._lastPokePollCount == null) return;
    const pollCount = (this.step?.outputs as Record<string, unknown> | undefined)?.pollCount;
    if (typeof pollCount === 'number' && pollCount > this._lastPokePollCount) {
      this._poking = false;
      this._lastPokePollCount = null;
    }
  }

  private _syncTickTimer() {
    const active = this.step?.status === 'running' && !!this.step.startedAt;
    if (active && this._tickTimer == null) {
      this._tickTimer = window.setInterval(() => {
        this._tickNow = Date.now();
      }, 1000);
    } else if (!active && this._tickTimer != null) {
      window.clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._tickTimer != null) {
      window.clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._pokeStatusTimer != null) {
      window.clearTimeout(this._pokeStatusTimer);
      this._pokeStatusTimer = null;
    }
  }

  private _renderLogPaths(key: string, value: unknown) {
    const paths =
      key === 'relatedLogs' && Array.isArray(value)
        ? value.map(String)
        : typeof value === 'string'
          ? [value]
          : [];
    if (paths.length === 0) return nothing;
    const label = key === 'failedLogPath' ? 'Failed Log' : 'Related Logs';
    const labelClass = key === 'failedLogPath' ? 'command-label-failed' : 'command-label-launch';
    return html`
      ${paths.map(
        (p) => html`
          <div class="step-command">
            <span class="command-label ${labelClass}">${label}</span>
            <code class="command-text" title="${p}">${p}</code>
            <button class="copy-btn" @click=${() => navigator.clipboard.writeText(p)}>Copy</button>
          </div>
        `,
      )}
    `;
  }

  private _renderCommand(key: string, value: string) {
    const labelClass =
      key === 'failedCommand'
        ? 'command-label-failed'
        : key === 'launchCommand'
          ? 'command-label-launch'
          : 'command-label-rerun';
    const label = key === 'cliCommand' ? 'Debug' : key === 'failedCommand' ? 'Failed' : 'Launch';
    return html`
      <div class="step-command">
        <span class="command-label ${labelClass}">${label}</span>
        <code class="command-text" title="${value}">${value}</code>
        <button class="copy-btn" @click=${() => navigator.clipboard.writeText(value)}>Copy</button>
      </div>
    `;
  }

  private _renderValue(key: string, v: unknown): unknown {
    if (v === null || v === undefined) return html`<span class="v-bool-false">-</span>`;

    // Booleans → checkmark / cross
    if (typeof v === 'boolean') {
      return v
        ? html`<span class="v-bool-true">v</span>`
        : html`<span class="v-bool-false">x</span>`;
    }

    // Cost keys → highlighted
    if (COST_KEYS.has(key) && typeof v === 'number') {
      return html`<span class="v-cost">$${v.toFixed(2)}</span>`;
    }

    // Duration keys → formatted
    if (DURATION_KEYS.has(key) && typeof v === 'number') {
      return html`<span class="v-duration">${formatDuration(v)}</span>`;
    }

    // Numbers
    if (typeof v === 'number') {
      return html`<span class="v-number">${v.toLocaleString()}</span>`;
    }

    // Arrays → compact list
    if (Array.isArray(v) && LIST_KEYS.has(key)) {
      if (v.length === 0) return html`<span class="v-bool-false">none</span>`;
      return html`<div class="v-list">${v.map((item) => this._renderListItem(key, item))}</div>`;
    }

    // Small arrays (< 5 items of primitives)
    if (Array.isArray(v) && v.length < 5 && v.every((i) => typeof i !== 'object')) {
      return v.join(', ');
    }

    // Objects → formatted JSON (compact)
    if (typeof v === 'object' && v !== null) {
      // Small objects inline
      const json = JSON.stringify(v);
      if (json.length < 80) return json;
      return html`<div class="v-object">${JSON.stringify(v, null, 2)}</div>`;
    }

    // Output blocks → preformatted
    if (OUTPUT_KEYS.has(key) && typeof v === 'string') {
      return html`<pre class="v-output">${v}</pre>`;
    }

    return String(v);
  }

  private _renderListItem(key: string, item: unknown) {
    if (typeof item !== 'object' || item === null) {
      return html`<div class="v-list-item">${String(item)}</div>`;
    }

    const obj = item as Record<string, unknown>;

    // Artifacts: path + purpose + size
    if (key === 'artifacts' && obj.path) {
      const size = obj.sizeBytes ? `${((obj.sizeBytes as number) / 1024).toFixed(0)}KB` : '';
      const purposeColor =
        obj.purpose === 'report'
          ? colors.accent
          : obj.purpose === 'recipe'
            ? colors.statusWarn
            : obj.purpose === 'screenshot'
              ? '#93c5fd'
              : colors.textMuted;
      return html`
        <div class="v-list-item">
          <span class="v-list-badge" style="background:${purposeColor}22; color:${purposeColor}"
            >${obj.purpose}</span
          >
          <span>${(obj.path as string).split('/').pop()}</span>
          ${size
            ? html`<span style="color:${colors.textMuted}; font-size:9px">${size}</span>`
            : nothing}
        </div>
      `;
    }

    // SubSteps: name + outcome + duration
    if (key === 'subSteps' && obj.name) {
      const outcomeColor =
        obj.outcome === 'ok'
          ? colors.statusOk
          : obj.outcome === 'failed'
            ? colors.statusFail
            : colors.textMuted;
      return html`
        <div class="v-list-item">
          <span style="color:${outcomeColor}">${obj.outcome === 'ok' ? 'v' : 'x'}</span>
          <span>${obj.name}</span>
          ${obj.durationMs
            ? html`<span style="color:${colors.textMuted}"
                >${formatDuration(obj.durationMs as number)}</span
              >`
            : nothing}
        </div>
      `;
    }

    // Candidates: slotId + score
    if (key === 'candidates' && obj.slotId) {
      return html`
        <div class="v-list-item">
          <span>${obj.slotId}</span>
          <span style="color:${colors.textMuted}">score=${obj.score}</span>
        </div>
      `;
    }

    // Issues: file + description
    if (key === 'issues' && obj.file) {
      return html`
        <div class="v-list-item">
          <span style="color:${colors.statusWarn}">!</span>
          <span style="color:${colors.accent}">${obj.file}${obj.line ? `:${obj.line}` : ''}</span>
          <span>${obj.description}</span>
        </div>
      `;
    }

    // Generic object in list
    const json = JSON.stringify(obj);
    if (json.length < 100) return html`<div class="v-list-item">${json}</div>`;
    return html`<div class="v-object">${JSON.stringify(obj, null, 2)}</div>`;
  }

  private _renderCIWatchBanner(step: RunStep) {
    return renderStepInspectorCiWatchBanner(step, {
      tickNow: this._tickNow,
      poking: this._poking,
      pokeStatus: this._pokeStatus,
      onPokeNow: () => this._onPokeNow(),
    });
  }

  private async _onPokeNow() {
    if (!this.step || !this.run || this._poking) return;
    const runId = this.run.id;
    const beforePoll = (this.step.outputs as Record<string, unknown> | undefined)?.pollCount;
    this._lastPokePollCount = typeof beforePoll === 'number' ? beforePoll : null;
    this._poking = true;
    this._setPokeStatus(null);
    try {
      const res = (await gateway.request(Methods.RUN_CI_WATCH_POKE, {
        runId,
      })) as RunCIWatchPokeResult;
      if (res.ok) {
        this._setPokeStatus(true, res.woken ? 'Woken — polling now' : 'No active poll to wake');
      } else {
        this._poking = false;
        this._setPokeStatus(false, res.reason);
      }
    } catch (err) {
      this._poking = false;
      this._setPokeStatus(false, (err as Error).message || 'Poke failed');
    }
  }

  private _setPokeStatus(ok: boolean | null, msg?: string) {
    if (this._pokeStatusTimer != null) {
      window.clearTimeout(this._pokeStatusTimer);
      this._pokeStatusTimer = null;
    }
    if (ok === null) {
      this._pokeStatus = null;
      return;
    }
    this._pokeStatus = { ok, msg: msg ?? '' };
    this._pokeStatusTimer = window.setTimeout(() => {
      this._pokeStatus = null;
      this._pokeStatusTimer = null;
    }, 5000);
  }

  private _stepDurationLabel(step: RunStep): string {
    return stepDurationLabel(step, this._tickNow);
  }

  private _extractCostInfo(step: RunStep): StepCostInfo | null {
    return extractStepCostInfo(step, this.run);
  }

  private _stepArtifacts(): FamilyObservabilityArtifact[] {
    return stepArtifactsForRunStep(this.step, this.run);
  }

  private _artifactUrl = (a: FamilyObservabilityArtifact): string => {
    return stepArtifactUrl(a);
  };

  private _updateArtifactHash(item: LightboxItem | null): void {
    const raw = location.hash.replace(/^#/, '');
    const qIdx = raw.indexOf('?');
    const base = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const params = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : '');
    if (item) {
      if (this.run?.id) params.set('artifactRun', this.run.id);
      params.set('artifact', item.path);
    } else {
      params.delete('artifactRun');
      params.delete('artifact');
    }
    const qs = params.toString();
    const next = `#${base}${qs ? `?${qs}` : ''}`;
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  private _closeLightbox(): void {
    this._lightboxOpen = false;
    this._updateArtifactHash(null);
  }

  private _navigateLightbox(index: number): void {
    this._lightboxIndex = index;
    this._updateArtifactHash(this._lightboxItems[index] ?? null);
  }
  private _onStepArtifactClick(
    e: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
  ) {
    const { artifacts, index } = e.detail;
    this._lightboxItems = artifacts.map((a) => ({
      url: this._artifactUrl(a),
      path: a.path,
      purpose: a.purpose,
    }));
    this._lightboxIndex = index;
    this._lightboxOpen = true;
    this._updateArtifactHash(this._lightboxItems[index] ?? null);
  }

  private _onReplay() {
    if (!this.step) return;
    this.dispatchEvent(
      new CustomEvent('step-replay', {
        bubbles: true,
        composed: true,
        detail: { stepName: this.step.name },
      }),
    );
  }

  private _onReplayWithProfile(prepareProfile: string) {
    this.dispatchEvent(
      new CustomEvent('step-replay', {
        detail: { stepName: this.step?.name, prepareProfile },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onReplaySkipPrepare() {
    if (!this.step) return;
    this.dispatchEvent(
      new CustomEvent('step-replay', {
        bubbles: true,
        composed: true,
        detail: { stepName: this.step.name, skipPrepare: true },
      }),
    );
  }

  private _onClose() {
    this.dispatchEvent(new CustomEvent('inspector-close', { bubbles: true, composed: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'step-inspector': StepInspector;
  }
}

function prepareProfileSummary(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const profile = value as {
    selected?: string;
    requested?: string;
    fallbacks?: Array<{ from: string; to: string; reason: string }>;
  };
  if (!profile.selected) return '';
  let summary = profile.selected;
  if (profile.requested && profile.requested !== profile.selected) {
    summary += ` (requested ${profile.requested})`;
  }
  for (const fb of profile.fallbacks ?? []) {
    summary += ` · ${fb.from}→${fb.to}: ${fb.reason}`;
  }
  return summary;
}
