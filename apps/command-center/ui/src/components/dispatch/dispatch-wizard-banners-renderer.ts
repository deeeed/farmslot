import { html, nothing } from 'lit';

import type { FlowType, ProfileFitSuggestion, Run } from '@farmslot/protocol';

import { groupPriorRunsByFamily } from './dispatch-wizard-helpers.js';

export interface ComparisonModeIndicatorRenderContext {
  comparisonLane: boolean;
  familyId: string;
  parentRunId: string;
  variantPreview: string;
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
  ticketId: string;
  forkFromPriorRun: (run: Run) => void;
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
      ${[...groups.entries()].map(([familyId, runs]) => renderPriorRunsFamily(ctx, familyId, runs))}
    </div>
  `;
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
  return html`
    <button
      class="prior-run-row"
      @click=${() => ctx.forkFromPriorRun(run)}
      title="Run another comparison candidate in this existing family (parentRunId=${run.id.slice(
        0,
        8,
      )})"
    >
      <span class="prior-run-cell">${run.lane}${run.variant ? `/${run.variant}` : ''}</span>
      <span class="prior-run-cell muted"
        >${run.metrics?.runner ?? '?'}/${run.metrics?.model ?? '?'}</span
      >
      <span class="prior-run-cell muted">${run.status}</span>
      <span class="prior-run-cell muted">${run.createdAt.slice(0, 16).replace('T', ' ')}</span>
      <span class="prior-run-cell summary">${run.summary ?? ''}</span>
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
