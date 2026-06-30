import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityGetResult,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
  FamilyObservabilityStep,
  Run,
  RunGetResult,
  RunListResult,
  RunStep,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import '../shared/hydrating-placeholder.js';
import '../shared/step-artifacts.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, isHydrating, subscribe } from '../../state.js';
import { colors } from '../../styles/theme-tokens.js';
import { gatewayHttpOrigin } from '../../utils/gateway-origin.js';
import { runArtifactUrl } from '../workspace/workspace-artifacts.js';

import { runCompareStyles } from './run-compare-styles.js';
import {
  formatDuration,
  isSameFamilyComparisonPair,
  routeForRun,
  runDisplayColor,
  runDisplayLabel,
  runStatusColor,
  sortRunsForFamilyView,
  stepStatusColor,
} from './run-utils.js';

const GATEWAY_BASE = gatewayHttpOrigin();
const RAW_PREVIEW_LIMIT = 1800;
const ARTIFACT_PREVIEW_LIMIT = 8;

function gradeColor(semantic: string): string {
  switch (semantic) {
    case 'good':
      return colors.statusOk;
    case 'ok':
      return colors.statusWarn;
    case 'bad':
      return colors.statusFail;
    default:
      return colors.textMuted;
  }
}

@customElement('run-compare')
export class RunCompare extends LitElement {
  @property() runIdA = '';
  @property() runIdB = '';
  @state() private runA: Run | null = null;
  @state() private runB: Run | null = null;
  @state() private siblings: Run[] = [];
  @state() private hydrating = false;
  @state() private familySnapshot: FamilyObservabilitySnapshot | null = null;
  @state() private familySnapshotError = '';
  @state() private directRunFetchError = '';
  @state() private selectedStepName = '';
  private snapshotFamilyId = '';
  private directRunA: Run | null = null;
  private directRunB: Run | null = null;
  private fetchAttemptedA = '';
  private fetchAttemptedB = '';
  private unsub?: () => void;

  static styles = runCompareStyles;

  connectedCallback() {
    super.connectedCallback();
    this.syncRuns(getState());
    this.unsub = subscribe((s) => this.syncRuns(s));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
  }

  protected override updated(changed: Map<string, unknown>) {
    if (changed.has('runIdA') || changed.has('runIdB')) {
      this.syncRuns(getState());
    }
  }

  private syncRuns(s: AppState) {
    const stateRunA = s.runs.find((r) => r.id === this.runIdA) ?? null;
    const stateRunB = s.runs.find((r) => r.id === this.runIdB) ?? null;
    this.runA = stateRunA ?? (this.directRunA?.id === this.runIdA ? this.directRunA : null);
    this.runB = stateRunB ?? (this.directRunB?.id === this.runIdB ? this.directRunB : null);
    this.hydrating = isHydrating(s, 'runs');
    if (!this.runA && this.runIdA && !this.hydrating && this.fetchAttemptedA !== this.runIdA) {
      this.fetchAttemptedA = this.runIdA;
      void this.fetchDirectRun('a', this.runIdA);
    }
    if (!this.runB && this.runIdB && !this.hydrating && this.fetchAttemptedB !== this.runIdB) {
      this.fetchAttemptedB = this.runIdB;
      void this.fetchDirectRun('b', this.runIdB);
    }
    if (this.runA && this.runB && this.runA.familyId === this.runB.familyId) {
      void this.fetchSiblings(this.runA.familyId, [this.runA.id, this.runB.id]);
      void this.fetchFamilySnapshot(this.runA.familyId);
      if (!this.selectedStepName) this.selectedStepName = this.defaultStepName();
    } else {
      this.siblings = [];
      this.familySnapshot = null;
      this.snapshotFamilyId = '';
    }
  }

  private async fetchDirectRun(side: 'a' | 'b', runId: string): Promise<void> {
    try {
      const result = await gateway.request<RunGetResult>(Methods.RUN_GET, { runId });
      if (side === 'a') {
        if (this.runIdA !== runId) return;
        this.directRunA = result.run;
      } else {
        if (this.runIdB !== runId) return;
        this.directRunB = result.run;
      }
      this.directRunFetchError = '';
      this.syncRuns(getState());
    } catch (err) {
      // Direct fetch is a recoverable deep-link fallback: the route can still
      // render once the normal runs snapshot hydrates, so surface the error
      // instead of throwing away the whole comparison page.
      this.directRunFetchError = `Run ${runId.slice(0, 8)} could not be loaded directly: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[run-compare] ${this.directRunFetchError}`);
    }
  }

  private async fetchSiblings(familyId: string, exclude: string[]) {
    try {
      const res = await gateway.request<RunListResult>(Methods.RUN_LIST, { familyId });
      this.siblings = sortRunsForFamilyView(
        (res.runs ?? []).filter((r) => !exclude.includes(r.id)),
      );
    } catch (err) {
      console.warn(
        `[run-compare] failed to fetch siblings for ${familyId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.siblings = [];
    }
  }

  private async fetchFamilySnapshot(familyId: string) {
    if (this.snapshotFamilyId === familyId && this.familySnapshot) return;
    this.snapshotFamilyId = familyId;
    this.familySnapshotError = '';
    try {
      const result = await gateway.request<FamilyObservabilityGetResult>(
        Methods.FAMILY_OBSERVABILITY_GET,
        { familyId },
      );
      this.familySnapshot = result.snapshot;
      if (!this.selectedStepName) this.selectedStepName = this.defaultStepName();
    } catch (err) {
      this.familySnapshot = null;
      this.familySnapshotError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[run-compare] failed to fetch family observability for ${familyId}: ${this.familySnapshotError}`,
      );
    }
  }

  private get allStepNames(): string[] {
    const names = new Set<string>();
    for (const s of this.runA?.steps ?? []) names.add(s.name);
    for (const s of this.runB?.steps ?? []) names.add(s.name);
    for (const s of this.summaryA?.steps ?? []) names.add(s.stepName);
    for (const s of this.summaryB?.steps ?? []) names.add(s.stepName);
    return [...names];
  }

  private get summaryA(): FamilyObservabilityRunSummary | null {
    return this.familySnapshot?.runs.find((r) => r.runId === this.runIdA) ?? null;
  }

  private get summaryB(): FamilyObservabilityRunSummary | null {
    return this.familySnapshot?.runs.find((r) => r.runId === this.runIdB) ?? null;
  }

  private get familyRuns(): Run[] {
    const byId = new Map<string, Run>();
    for (const run of [this.runA, this.runB, ...this.siblings]) {
      if (run) byId.set(run.id, run);
    }
    return sortRunsForFamilyView([...byId.values()]);
  }

  private runOptionLabel(run: Run): string {
    return [
      run.variant || run.metrics.runner || run.id.slice(0, 8),
      run.status,
      run.slotId ?? 'slot unknown',
      run.prNumber ? `PR #${run.prNumber}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  private selectRun(side: 'a' | 'b', runId: string): void {
    const nextA = side === 'a' ? runId : this.runIdA;
    const nextB = side === 'b' ? runId : this.runIdB;
    if (!nextA || !nextB || nextA === nextB) return;
    location.hash = `runs/compare?a=${encodeURIComponent(nextA)}&b=${encodeURIComponent(nextB)}`;
  }

  private defaultStepName(): string {
    const preferred = ['monitor', 'self-review', 'complete', 'dispatch'];
    const names = this.allStepNames;
    return preferred.find((name) => names.includes(name)) ?? names[0] ?? '';
  }

  private artifactUrl(artifact: FamilyObservabilityArtifact): string {
    return runArtifactUrl(GATEWAY_BASE, artifact.runId, artifact);
  }

  private stepSummary(
    run: FamilyObservabilityRunSummary | null,
    stepName: string,
  ): FamilyObservabilityStep | null {
    return run?.steps.find((s) => s.stepName === stepName) ?? null;
  }

  private runStep(run: Run | null, stepName: string): RunStep | undefined {
    return run?.steps.find((s) => s.name === stepName);
  }

  private rawPreview(value: unknown): string {
    if (value == null) return '';
    const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!raw) return '';
    return raw.length > RAW_PREVIEW_LIMIT
      ? `${raw.slice(0, RAW_PREVIEW_LIMIT)}
… truncated (${raw.length - RAW_PREVIEW_LIMIT} chars)`
      : raw;
  }

  private evidenceForRun(run: FamilyObservabilityRunSummary | null): FamilyObservabilityArtifact[] {
    if (!run) return [];
    return (this.familySnapshot?.evidence ?? run.artifacts ?? [])
      .filter((a) => a.runId === run.runId || a.sourceRunId === run.runId)
      .slice(0, ARTIFACT_PREVIEW_LIMIT);
  }

  private openStepArtifact(
    event: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
  ): void {
    const artifact = event.detail.artifacts[event.detail.index];
    if (!artifact) return;
    window.open(this.artifactUrl(artifact), '_blank', 'noopener');
  }

  render() {
    if (!this.runA || !this.runB) {
      // Hydrating covers two cases: fresh mount (runs slice empty) and
      // reconnect (previous runs snapshot retained but compare IDs absent
      // until the new snapshot lands). Don't flash a "not found" error
      // while the slice is still settling.
      if (this.hydrating) {
        return html`
          <div
            class="back"
            @click=${() => {
              location.hash = 'runs';
            }}
          >
            &lt; Back to runs
          </div>
          <farm-hydrating message="Loading runs…"></farm-hydrating>
        `;
      }
      return html`
        <div
          class="back"
          @click=${() => {
            location.hash = 'runs';
          }}
        >
          &lt; Back to runs
        </div>
        <div class="empty">${this.directRunFetchError || 'One or both runs not found'}</div>
      `;
    }
    const familyMismatch = this.runA.familyId !== this.runB.familyId;
    const laneMismatch = this.runA.lane !== this.runB.lane;
    const validSameFamilyComparison = isSameFamilyComparisonPair(this.runA, this.runB);
    const comparisonMismatch = !validSameFamilyComparison;
    const showCompareCaution = familyMismatch || comparisonMismatch;

    return html`
      <div
        class="back"
        @click=${() => {
          location.hash = 'runs';
        }}
      >
        &lt; Back to runs
      </div>
      <h2>Run Comparison</h2>
      ${!familyMismatch
        ? html`<div class="empty" style="text-align:left; margin-bottom: 12px;">
            <a
              href="#runs?family=${encodeURIComponent(this.runA.familyId)}"
              style="color:${colors.accent}; text-decoration:none"
              >View family runs</a
            >
            ·
            <a
              href="#family/${this.runA.familyId}"
              style="color:${colors.accent}; text-decoration:none"
              >Open retrospective</a
            >${this.siblings.length
              ? html` · Siblings:
                ${this.siblings.map(
                  (s, i) =>
                    html`${i ? html` · ` : nothing}<a
                        href=${`#${routeForRun(s)}`}
                        style="color:${colors.accent}; text-decoration:none"
                        >${s.ticketOrPr}${s.variant ? `/${s.variant}` : ''}</a
                      >`,
                )}`
              : nothing}
          </div>`
        : nothing}
      ${showCompareCaution
        ? html`
            <div class="empty" style="text-align:left; margin-bottom: 12px;">
              Compare caution: ${familyMismatch ? ' different families;' : ''}
              ${laneMismatch && !validSameFamilyComparison ? ' different lanes;' : ''}
              ${comparisonMismatch ? ' not a recognized same-family comparison pair.' : ''}
            </div>
          `
        : nothing}
      ${!familyMismatch && this.siblings.length > 0
        ? html`
            <div class="empty" style="text-align:left; margin-bottom: 12px;">
              ${this.siblings.length} more sibling run${this.siblings.length !== 1 ? 's' : ''} in
              this family.
            </div>
          `
        : nothing}
      ${!familyMismatch ? this.renderRunPickers() : nothing}
      <div class="columns">${this.renderHeader(this.runA)} ${this.renderHeader(this.runB)}</div>
      <div class="steps-section section-card">
        <div class="section-title">Step-by-step comparison</div>
        <div class="section-hint">
          Select a step to compare status, timing, raw inputs/outputs, artifacts, missing data, and
          learnings side-by-side.
        </div>
        ${this.allStepNames.map((name) => this.renderStepRow(name))}
      </div>
      ${this.renderSelectedStepDrilldown()} ${this.renderEvidenceAndRecipe()}
    `;
  }

  private renderRunPickers() {
    const runs = this.familyRuns;
    if (runs.length < 2) return nothing;
    return html`
      <div class="picker-grid">
        ${this.renderRunPicker('a', this.runIdA, this.runIdB, runs)}
        ${this.renderRunPicker('b', this.runIdB, this.runIdA, runs)}
      </div>
    `;
  }

  private renderRunPicker(side: 'a' | 'b', selectedId: string, otherId: string, runs: Run[]) {
    return html`
      <div class="picker-card">
        <label>${side === 'a' ? 'Left run' : 'Right run'}</label>
        <select
          class="run-picker"
          .value=${selectedId}
          @change=${(event: Event) =>
            this.selectRun(side, (event.target as HTMLSelectElement).value)}
        >
          ${runs.map(
            (run) => html`
              <option
                value=${run.id}
                ?selected=${run.id === selectedId}
                ?disabled=${run.id === otherId && run.id !== selectedId}
              >
                ${this.runOptionLabel(run)}
              </option>
            `,
          )}
        </select>
      </div>
    `;
  }

  private renderHeader(run: Run) {
    const fc = runDisplayColor(run);
    const sc = runStatusColor(run.status);
    const otherRun = run === this.runA ? this.runB : this.runA;
    const isDiffModel = otherRun && run.metrics.model !== otherRun.metrics.model;
    const isDiffOutcome = otherRun && run.metrics.outcome !== otherRun.metrics.outcome;

    return html`
      <div class="col-header">
        <div class="col-title">
          <span
            class="ticket"
            @click=${() => {
              location.hash = routeForRun(run);
            }}
            >${run.ticketOrPr}</span
          >
          <span class="badge flow-badge" style="background:${fc}">${runDisplayLabel(run)}</span>
          <span class="badge status-badge" style="border-color:#64748b; color:#64748b"
            >${run.lane}</span
          >
          ${run.variant
            ? html`<span class="badge status-badge" style="border-color:#818cf8; color:#818cf8"
                >${run.variant}</span
              >`
            : nothing}
          <span class="badge status-badge" style="border-color:${sc}; color:${sc}"
            >${run.status}</span
          >
        </div>
        <div class="meta-grid">
          <span class="meta-label">ID</span>
          <span class="meta-value">${run.id.slice(0, 8)}</span>
          <span class="meta-label">Family</span>
          <span class="meta-value">${run.familyId.slice(0, 8)}</span>
          <span class="meta-label">Family root</span>
          <span class="meta-value">${run.familyRootTicketOrPr ?? '-'}</span>
          <span class="meta-label">Project</span>
          <span class="meta-value">${run.project}</span>
          <span class="meta-label">Slot</span>
          <span class="meta-value">${run.slotId ?? '-'}</span>
          <span class="meta-label">Model</span>
          <span class="meta-value ${isDiffModel ? 'diff' : ''}"
            >${run.metrics.runner ?? ''}/${run.metrics.model ?? '-'}</span
          >
          <span class="meta-label">Duration</span>
          <span class="meta-value">${formatDuration(run.metrics.durationMs) || '-'}</span>
          <span class="meta-label">Nudges</span>
          <span class="meta-value">${run.metrics.nudgeCount}</span>
          <span class="meta-label">Outcome</span>
          <span class="meta-value ${isDiffOutcome ? 'diff' : ''}"
            >${run.metrics.outcome ?? '-'}</span
          >
          <span class="meta-label">Grade</span>
          <span class="meta-value">
            ${run.humanGrade
              ? html`
                  <span
                    class="grade-inline"
                    style="background:${gradeColor(
                      run.humanGrade.recipe_semantic,
                    )}22; color:${gradeColor(run.humanGrade.recipe_semantic)}"
                    >${run.humanGrade.recipe_semantic}</span
                  >
                `
              : '-'}
          </span>
        </div>
      </div>
    `;
  }

  private renderStepRow(stepName: string) {
    const stepA = this.runStep(this.runA, stepName);
    const stepB = this.runStep(this.runB, stepName);
    const isDiff = Boolean(
      stepA && stepB && (stepA.status !== stepB.status || stepA.durationMs !== stepB.durationMs),
    );
    const selected = this.selectedStepName === stepName;

    return html`
      <div
        class="step-row clickable ${selected ? 'selected' : ''}"
        @click=${() => {
          this.selectedStepName = stepName;
        }}
      >
        ${this.renderStepCell(stepName, stepA, isDiff)}
        ${this.renderStepCell(stepName, stepB, isDiff)}
      </div>
    `;
  }

  private renderStepCell(name: string, step: RunStep | undefined, isDiff: boolean) {
    if (!step) {
      return html`<div class="step-cell missing">
        <span class="step-name">${name}</span> <span>--</span>
      </div>`;
    }
    const sc = stepStatusColor(step.status);
    return html`
      <div class="step-cell">
        <span class="step-name">${name}</span>
        <span class="step-status" style="color:${sc}">${step.status}</span>
        <span class="step-duration">${formatDuration(step.durationMs)}</span>
        ${isDiff ? html`<span class="step-diff-marker">*</span>` : nothing}
      </div>
    `;
  }

  private renderSelectedStepDrilldown() {
    const stepName = this.selectedStepName || this.defaultStepName();
    if (!stepName) return nothing;
    return html`
      <div class="section-card">
        <div class="section-title">Step drill-down · ${stepName}</div>
        <div class="drill-grid">
          ${this.renderStepDrillCard(this.runA, this.summaryA, stepName)}
          ${this.renderStepDrillCard(this.runB, this.summaryB, stepName)}
        </div>
      </div>
    `;
  }

  private renderStepDrillCard(
    run: Run | null,
    summary: FamilyObservabilityRunSummary | null,
    stepName: string,
  ) {
    const step = this.runStep(run, stepName);
    const richStep = this.stepSummary(summary, stepName);
    if (!run) return html`<div class="drill-card muted">Run not loaded.</div>`;
    const raw = [
      step?.detail
        ? `detail:
${step.detail}`
        : '',
      step?.inputs
        ? `inputs:
${this.rawPreview(step.inputs)}`
        : '',
      step?.outputs
        ? `outputs:
${this.rawPreview(step.outputs)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return html`
      <div class="drill-card">
        <div class="drill-card-title">
          <span>${run.variant ?? run.metrics.runner ?? run.id.slice(0, 8)}</span>
          ${step
            ? html`<span class="step-status" style="color:${stepStatusColor(step.status)}"
                >${step.status}</span
              >`
            : html`<span class="muted">missing</span>`}
        </div>
        ${richStep
          ? html`
              <step-artifacts
                .stepName=${richStep.stepName}
                .status=${richStep.status}
                .durationMs=${richStep.durationMs}
                .detail=${richStep.detail}
                .artifacts=${richStep.artifacts ?? []}
                .learnings=${richStep.learnings ?? []}
                .missingData=${richStep.missingData ?? []}
                .artifactUrl=${(a: FamilyObservabilityArtifact) => this.artifactUrl(a)}
                @step-artifact-click=${(
                  e: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
                ) => this.openStepArtifact(e)}
              ></step-artifacts>
            `
          : html`<div class="muted">No provenance-rich step data available yet.</div>`}
        ${raw ? html`<div class="raw-block" style="margin-top:8px;">${raw}</div>` : nothing}
      </div>
    `;
  }

  private renderEvidenceAndRecipe() {
    if (this.familySnapshotError) {
      return html`<div class="section-card">
        <div class="section-title">Evidence and recipe</div>
        <div class="muted">Family observability unavailable: ${this.familySnapshotError}</div>
      </div>`;
    }
    if (!this.familySnapshot) {
      return html`<div class="section-card">
        <div class="section-title">Evidence and recipe</div>
        <div class="muted">Loading evidence provenance…</div>
      </div>`;
    }
    return html`
      <div class="section-card">
        <div class="section-title">Evidence and recipe comparison</div>
        <div class="evidence-grid">
          ${this.renderRunEvidenceRecipe(this.runA, this.summaryA)}
          ${this.renderRunEvidenceRecipe(this.runB, this.summaryB)}
        </div>
      </div>
    `;
  }

  private renderRunEvidenceRecipe(run: Run | null, summary: FamilyObservabilityRunSummary | null) {
    if (!run || !summary)
      return html`<div class="drill-card muted">No family summary for this run.</div>`;
    const evidence = this.evidenceForRun(summary);
    const recipePreview = summary.recipeJson ? this.rawPreview(summary.recipeJson) : '';
    const reportPreview = summary.workerReport ? this.rawPreview(summary.workerReport) : '';
    return html`
      <div class="drill-card">
        <div class="drill-card-title">
          <span>${run.variant ?? run.id.slice(0, 8)}</span>
          <a class="inline-link" href=${`#family/${summary.familyId}?run=${summary.runId}`}
            >open lane</a
          >
        </div>
        <div class="mini-metrics">
          <span class="meta-label">Recipe</span
          ><span
            >${summary.recipeQuality.semantic}${summary.recipeQuality.score != null
              ? ` · ${summary.recipeQuality.score}`
              : ''}</span
          >
          <span class="meta-label">Self-review</span
          ><span
            >${summary.selfReview.verdict ?? '—'}${summary.selfReview.issues.length
              ? ` · ${summary.selfReview.issues.length} issue(s)`
              : ''}</span
          >
          <span class="meta-label">Evidence</span
          ><span>${evidence.length} shown · ${summary.artifacts.length} run artifacts</span>
          <span class="meta-label">Diff</span
          ><span
            >${summary.diffStat.available
              ? `${summary.diffStat.files} files · +${summary.diffStat.additions} -${summary.diffStat.deletions}`
              : 'unavailable'}</span
          >
        </div>
        <step-artifacts
          .stepName=${'Evidence artifacts'}
          .status=${evidence.length ? 'done' : 'skipped'}
          .artifacts=${evidence}
          .learnings=${[]}
          .missingData=${evidence.length ? [] : ['No evidence artifacts found for this run.']}
          .artifactUrl=${(a: FamilyObservabilityArtifact) => this.artifactUrl(a)}
          @step-artifact-click=${(
            e: CustomEvent<{ artifacts: FamilyObservabilityArtifact[]; index: number }>,
          ) => this.openStepArtifact(e)}
        ></step-artifacts>
        ${recipePreview
          ? html`<div class="section-hint" style="margin-top:10px;">Recipe JSON</div>
              <div class="raw-block">${recipePreview}</div>`
          : nothing}
        ${reportPreview
          ? html`<div class="section-hint" style="margin-top:10px;">Worker report</div>
              <div class="raw-block">${reportPreview}</div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-compare': RunCompare;
  }
}
