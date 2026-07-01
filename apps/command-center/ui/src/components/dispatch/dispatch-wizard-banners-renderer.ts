import { html, nothing } from 'lit';

import type { FlowType, ProfileFitSuggestion, Run } from '@farmslot/protocol';

import { groupPriorRunsByFamily } from './dispatch-wizard-helpers.js';

export interface ComparisonModeIndicatorRenderContext {
  comparisonLane: boolean;
  familyId: string;
  parentRunId: string;
  variantPreview: string;
  branchHint: string | null;
  exitComparisonMode: () => void;
}

export function renderComparisonModeIndicator(ctx: ComparisonModeIndicatorRenderContext) {
  if (!ctx.comparisonLane) return nothing;
  return html`
    <div class="comparison-mode-banner">
      <div class="comparison-mode-title">Comparison fork mode</div>
      <div class="comparison-mode-meta">
        <span><span class="cm-label">family</span> ${ctx.familyId.slice(0, 8)}</span>
        <span><span class="cm-label">parent run</span> ${ctx.parentRunId.slice(0, 8)}</span>
        <span><span class="cm-label">variant</span> ${ctx.variantPreview || '(empty)'}</span>
        ${ctx.branchHint
          ? html`<span><span class="cm-label">branch</span> ${ctx.branchHint}</span>`
          : nothing}
      </div>
      <button
        class="comparison-mode-exit"
        @click=${() => ctx.exitComparisonMode()}
        title="Drop comparison-lane context and dispatch as a fresh root run instead"
      >
        Exit comparison mode
      </button>
    </div>
  `;
}

export interface ReplayEntryPointRenderContext {
  flowType: FlowType | null;
  openEvals: () => void;
}

export function renderReplayEntryPoint(ctx: ReplayEntryPointRenderContext) {
  if (ctx.flowType !== 'fix-bug' && ctx.flowType !== 'dev') return nothing;
  return html`
    <div class="start-ref-panel">
      <div class="start-ref-head">
        <div>
          <div class="section-label">Replay / eval</div>
          <div class="start-ref-copy">
            To redispatch previous work from its original base commit, use #evals. It creates a
            Reference package plus artifact-only Candidate runs instead of a plain dispatch run.
          </div>
        </div>
        <button class="start-ref-clear" @click=${() => ctx.openEvals()}>Open #evals</button>
      </div>
      <div class="start-ref-steps">
        <span class="on">1. choose Reference prior run / PR / package</span>
        <span class="on">2. choose Candidate runner/model/template</span>
        <span class="on">3. run artifact-only and compare packages</span>
      </div>
      <div class="start-ref-help">
        Dispatch remains for new work. Replay comparison uses eval semantics so the original and
        rerun are isolated and comparable.
      </div>
    </div>
  `;
}

export interface PriorRunsBannerRenderContext {
  comparisonLane: boolean;
  priorRuns: readonly Run[];
  pickerOpen: boolean;
  pickerSearch: string;
  ticketId: string;
  forkFromPriorRun: (run: Run) => void;
  setPickerOpen: (open: boolean) => void;
  setPickerSearch: (value: string) => void;
}

export function renderPriorRunsBanner(ctx: PriorRunsBannerRenderContext) {
  if (ctx.comparisonLane || ctx.priorRuns.length === 0) return nothing;
  const groups = groupPriorRunsByFamily(ctx.priorRuns);
  const totalRuns = ctx.priorRuns.length;
  return html`
    <div class="prior-runs-banner">
      <div class="prior-runs-banner-title">
        ${totalRuns} prior run${totalRuns === 1 ? '' : 's'} for ${ctx.ticketId.trim()} — run another
        same-family candidate
      </div>
      <div class="prior-runs-copy">
        Pick the run to compare against. Dispatch will keep the same family and create a
        comparison-lane sibling with its own runner/model/slot.
      </div>
      <button
        class="prior-runs-open"
        data-testid="dispatch-compare-picker-open"
        @click=${() => ctx.setPickerOpen(true)}
      >
        Choose run to compare… (${totalRuns})
      </button>
      ${[...groups.entries()]
        .slice(0, 2)
        .map(([familyId, runs]) => renderPriorRunsFamily(ctx, familyId, runs.slice(0, 2)))}
      ${renderPriorRunsPickerModal(ctx)}
    </div>
  `;
}

function renderPriorRunsPickerModal(ctx: PriorRunsBannerRenderContext) {
  if (!ctx.pickerOpen) return nothing;
  const query = ctx.pickerSearch.trim().toLowerCase();
  const filtered = query
    ? ctx.priorRuns.filter((run) => priorRunSearchText(run).includes(query))
    : ctx.priorRuns;
  return html`
    <div class="compare-picker-backdrop" @click=${() => ctx.setPickerOpen(false)}>
      <div class="compare-picker-modal" @click=${(event: Event) => event.stopPropagation()}>
        <div class="compare-picker-head">
          <div>
            <div class="compare-picker-title">Choose comparison baseline</div>
            <div class="compare-picker-subtitle">
              ${ctx.ticketId.trim()} · ${ctx.priorRuns.length} prior
              run${ctx.priorRuns.length === 1 ? '' : 's'}
            </div>
          </div>
          <button class="compare-picker-close" @click=${() => ctx.setPickerOpen(false)}>×</button>
        </div>
        <input
          class="compare-picker-search"
          data-testid="dispatch-compare-run-search"
          placeholder="Search family, run id, lane, variant, runner, model, status, summary…"
          .value=${ctx.pickerSearch}
          @input=${(event: InputEvent) =>
            ctx.setPickerSearch((event.target as HTMLInputElement).value)}
        />
        <div class="compare-picker-list">
          ${filtered.length === 0
            ? html`<div class="compare-picker-empty">No prior runs match this search.</div>`
            : filtered.map((run) => renderPriorRunPickerRow(ctx, run))}
        </div>
      </div>
    </div>
  `;
}

function priorRunSearchText(run: Run): string {
  return [
    run.id,
    run.familyId,
    run.parentRunId,
    run.ticketOrPr,
    run.project,
    run.flowType,
    run.status,
    run.lane,
    run.variant,
    run.metrics?.runner,
    run.metrics?.model,
    run.summary,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function renderPriorRunsFamily(
  ctx: PriorRunsBannerRenderContext,
  familyId: string,
  runs: readonly Run[],
) {
  return html`
    <div class="prior-runs-family">
      <div class="prior-runs-family-label">
        family ${familyId.slice(0, 8)} · ${runs.length} run${runs.length === 1 ? '' : 's'}
      </div>
      ${runs.map((run) => renderPriorRunRow(ctx, run))}
    </div>
  `;
}

function renderPriorRunRow(ctx: PriorRunsBannerRenderContext, run: Run) {
  return renderPriorRunCard(ctx, run, 'prior-run-row');
}

function renderPriorRunPickerRow(ctx: PriorRunsBannerRenderContext, run: Run) {
  return renderPriorRunCard(ctx, run, 'prior-run-row compare-picker-row');
}

function renderPriorRunCard(ctx: PriorRunsBannerRenderContext, run: Run, className: string) {
  return html`
    <button
      class=${className}
      data-testid="dispatch-compare-run-card"
      @click=${() => {
        ctx.forkFromPriorRun(run);
        ctx.setPickerOpen(false);
      }}
      title="Run another comparison candidate in this existing family (parentRunId=${run.id.slice(
        0,
        8,
      )})"
    >
      <span class="prior-run-main">
        <span class="prior-run-title">
          Compare against ${run.lane}${run.variant ? `/${run.variant}` : ''} run
        </span>
        <span class="prior-run-meta">
          family ${(run.familyId ?? run.id).slice(0, 8)} · run ${run.id.slice(0, 8)} ·
          ${run.metrics?.runner ?? '?'}/${run.metrics?.model ?? '?'} · ${run.status} ·
          ${run.createdAt.slice(0, 16).replace('T', ' ')}
        </span>
        ${run.summary ? html`<span class="prior-run-summary">${run.summary}</span>` : nothing}
      </span>
      <span class="prior-run-cta">Use as baseline →</span>
    </button>
  `;
}

export interface VariantInputRenderContext {
  comparisonLane: boolean;
  variantCollision: boolean;
  variantInput: string;
  setVariantInput: (value: string) => void;
}

export interface ProfileFitBannerRenderContext {
  profileFit: ProfileFitSuggestion | null;
  prepareProfile: string;
  applySuggestedPrepareProfile: (profile: string) => void;
}

export function renderProfileFitBanner(ctx: ProfileFitBannerRenderContext) {
  const suggestion = ctx.profileFit;
  if (!suggestion) return nothing;
  const suggestedProfile = suggestion.suggestedPrepareProfile;
  return html`
    <div class="profile-fit-banner">
      <div class="profile-fit-title">Prepare profile suggestion</div>
      <div class="profile-fit-copy">
        ${suggestion.rationale} Suggested profile:
        <strong>${suggestedProfile}</strong>
        ${suggestion.validationPlan?.length
          ? html` — validation plan: ${suggestion.validationPlan.length} step(s)`
          : nothing}
      </div>
      ${ctx.prepareProfile === suggestedProfile
        ? nothing
        : html`
            <button
              class="profile-fit-apply"
              @click=${() => ctx.applySuggestedPrepareProfile(suggestedProfile)}
            >
              Use ${suggestedProfile}
            </button>
          `}
    </div>
  `;
}

export function renderVariantInput(ctx: VariantInputRenderContext) {
  if (!ctx.comparisonLane || !ctx.variantCollision) return nothing;
  return html`
    <div class="variant-input-row">
      <div class="section-label">Variant tag (must be unique within family)</div>
      <input
        class="variant-input"
        type="text"
        .value=${ctx.variantInput}
        @input=${(event: InputEvent) =>
          ctx.setVariantInput((event.target as HTMLInputElement).value)}
        placeholder="e.g. claude-sonnet-recipe-fix"
      />
      <div class="variant-input-hint">
        Same runner+model collides with an existing sibling — pick a unique tag (auto-suggested) so
        the duplicate-run guard accepts the new fork.
      </div>
    </div>
  `;
}
