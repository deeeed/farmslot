import { html, nothing } from 'lit';

import type { FlowType, ProfileFitSuggestion, Run } from '@farmslot/protocol';

import '../runs/run-pipeline-mini.js';

import {
  formatCreatedAt,
  runDisplayColor,
  runDisplayLabel,
  runStatusColor,
} from '../runs/run-utils.js';

import {
  comparePickerFamilyChipLabel,
  familyRunsForComparePicker,
  summarizeComparePickerFamilyLane,
} from './dispatch-wizard-helpers.js';

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

export interface CompareRunPickerModalContext {
  open: boolean;
  runs: readonly Run[];
  pickerSearch: string;
  title: string;
  subtitle: string;
  emptyMessage: string;
  onSelectRun: (run: Run) => void;
  setPickerOpen: (open: boolean) => void;
  setPickerSearch: (value: string) => void;
}

export function renderCompareRunPickerModal(ctx: CompareRunPickerModalContext) {
  if (!ctx.open) return nothing;
  const query = ctx.pickerSearch.trim().toLowerCase();
  const filtered = query
    ? ctx.runs.filter((run) => compareRunSearchText(run).includes(query))
    : ctx.runs;
  return html`
    <div
      class="compare-modal-backdrop"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label=${ctx.title}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          ctx.setPickerOpen(false);
        }
      }}
      @click=${() => ctx.setPickerOpen(false)}
    >
      <div class="compare-modal" @click=${(event: Event) => event.stopPropagation()}>
        <div class="compare-modal-head">
          <div>
            <div class="compare-modal-title">${ctx.title}</div>
            <div class="compare-modal-subtitle">${ctx.subtitle}</div>
          </div>
          <button class="compare-modal-close" @click=${() => ctx.setPickerOpen(false)}>×</button>
        </div>
        <input
          class="compare-modal-search"
          data-testid="dispatch-compare-run-search"
          placeholder="Search ticket, family, run id, lane, variant, runner, model, status, summary…"
          .value=${ctx.pickerSearch}
          @input=${(event: InputEvent) =>
            ctx.setPickerSearch((event.target as HTMLInputElement).value)}
        />
        <div class="compare-modal-list">
          ${filtered.length === 0
            ? html`<div class="compare-modal-empty">${ctx.emptyMessage}</div>`
            : filtered.map((run) => renderCompareRunPickerRow(ctx, run))}
        </div>
      </div>
    </div>
  `;
}

function compareRunSearchText(run: Run): string {
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
    run.slotId,
    run.metrics?.runner,
    run.metrics?.model,
    run.summary,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

const MAX_FAMILY_CHIPS = 5;

function renderCompareRunPickerRow(ctx: CompareRunPickerModalContext, run: Run) {
  const familyRuns = familyRunsForComparePicker(run, ctx.runs);
  const lane = summarizeComparePickerFamilyLane(run, familyRuns);
  const flowColor = runDisplayColor(run);
  const statusColor = runStatusColor(run.status);
  const visibleFamilyRuns = familyRuns.slice(0, MAX_FAMILY_CHIPS);
  const hiddenFamilyCount = Math.max(0, familyRuns.length - visibleFamilyRuns.length);
  return html`
    <div
      class="compare-run-item"
      data-testid="dispatch-compare-run-card"
      role="button"
      tabindex="0"
      title="Use run ${run.id.slice(0, 8)} as the comparison baseline"
      @click=${() => {
        ctx.onSelectRun(run);
        ctx.setPickerOpen(false);
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          ctx.onSelectRun(run);
          ctx.setPickerOpen(false);
        }
      }}
    >
      <div class="compare-run-badges">
        <span class="compare-run-badge" style="background:${flowColor}; color:#000"
          >${runDisplayLabel(run)}</span
        >
        <span
          class="compare-run-badge status"
          style="border-color:${statusColor}; color:${statusColor}"
          >${run.status}</span
        >
        <span class="compare-run-badge muted">${run.lane}</span>
        ${run.variant ? html`<span class="compare-run-badge muted">${run.variant}</span>` : nothing}
        <span class="compare-run-badge muted">${run.slotId ?? 'no slot'}</span>
        ${lane.activeCount > 0
          ? html`<span class="compare-run-badge status" style="border-color:#3b82f6; color:#3b82f6"
              >${lane.activeCount} active</span
            >`
          : nothing}
      </div>
      <div class="compare-run-title">${run.ticketOrPr}</div>
      ${run.summary && run.summary !== run.ticketOrPr
        ? html`<div class="compare-run-summary">${run.summary}</div>`
        : nothing}
      <div class="compare-run-meta">
        run ${run.id.slice(0, 8)} · ${run.project} · ${run.metrics?.runner ?? '?'} /
        ${run.metrics?.model ?? '?'} · ${formatCreatedAt(run.createdAt)}
      </div>
      <div class="compare-run-family">${lane.headline}. ${lane.forkHint}</div>
      ${familyRuns.length > 1
        ? html`
            <div class="compare-run-family-chips">
              ${visibleFamilyRuns.map(
                (member) => html`
                  <span
                    class="compare-run-family-chip ${member.id === run.id ? 'current' : ''}"
                    style="--chip-color:${runStatusColor(member.status)}"
                    title="${comparePickerFamilyChipLabel(
                      member,
                    )} · ${member.status} · slot ${member.slotId ?? 'unknown'}"
                  >
                    <span class="compare-run-family-dot"></span>
                    ${comparePickerFamilyChipLabel(member)}
                  </span>
                `,
              )}
              ${hiddenFamilyCount > 0
                ? html`<span class="compare-run-badge muted">+${hiddenFamilyCount} more</span>`
                : nothing}
            </div>
          `
        : nothing}
      <div class="compare-run-pipeline">
        <run-pipeline-mini
          .run=${run}
          .steps=${run.steps ?? []}
          .flowType=${run.flowType}
        ></run-pipeline-mini>
      </div>
      <div class="compare-run-cta">Use as baseline →</div>
    </div>
  `;
}

export interface ComparisonFlowPanelRenderContext {
  comparisonFlow: boolean;
  comparisonBaselineSelected: boolean;
  pickerOpen: boolean;
  pickerSearch: string;
  pickerRuns: readonly Run[];
  pickerLoading: boolean;
  enterComparisonFlow: () => void;
  enterNormalFlow: () => void;
  openComparisonPicker: () => void;
  onSelectBaselineRun: (run: Run) => void;
  setPickerOpen: (open: boolean) => void;
  setPickerSearch: (value: string) => void;
}

const NEW_RUN_TOOLTIP =
  'Start a fresh root run for a ticket or PR. No link to an existing comparison family.';
const COMPARISON_SIBLING_TOOLTIP =
  'Dispatch another runner or model on the same ticket alongside an existing run. Pick the baseline run first; siblings stay grouped for side-by-side review.';

function renderComparisonFlowHint(ctx: ComparisonFlowPanelRenderContext) {
  if (!ctx.comparisonFlow) {
    return html`
      <div class="comparison-flow-hint comparison-flow-hint-neutral">
        <div class="comparison-flow-hint-title">Fresh root run</div>
        <div class="comparison-flow-hint-copy">
          Enter a ticket or PR and dispatch as usual. Switch to
          <strong>Comparison sibling</strong> when you want a second runner or model on the same
          work alongside an existing run.
        </div>
      </div>
    `;
  }
  if (!ctx.comparisonBaselineSelected) {
    return html`
      <div class="comparison-flow-hint comparison-flow-hint-accent">
        <div class="comparison-flow-hint-title">Step 1 — pick baseline run</div>
        <div class="comparison-flow-hint-copy">
          Choose the existing run to compare against. Ticket, project, and flow prefill from that
          run; then set runner, model, template, and slot before dispatch.
        </div>
        <button
          class="prior-runs-open"
          data-testid="dispatch-compare-picker-open"
          ?disabled=${ctx.pickerLoading}
          @click=${() => ctx.openComparisonPicker()}
        >
          ${ctx.pickerLoading ? 'Loading runs…' : 'Pick baseline run…'}
        </button>
      </div>
    `;
  }
  return html`
    <div class="comparison-flow-hint comparison-flow-hint-accent">
      <div class="comparison-flow-hint-title">Comparison sibling</div>
      <div class="comparison-flow-hint-copy">
        Baseline selected — configure runner, model, template, and slot below. This fork joins the
        same comparison family for side-by-side review.
      </div>
    </div>
  `;
}

export function renderComparisonFlowPanel(ctx: ComparisonFlowPanelRenderContext) {
  return html`
    <div class="comparison-flow-panel">
      <div class="section-label">Dispatch as</div>
      <div class="pill-row comparison-flow-pills">
        <button
          class="pill ${ctx.comparisonFlow ? '' : 'selected'}"
          data-testid="dispatch-intent-new-run"
          title=${NEW_RUN_TOOLTIP}
          @click=${() => ctx.enterNormalFlow()}
        >
          New run
        </button>
        <button
          class="pill ${ctx.comparisonFlow ? 'selected' : ''}"
          data-testid="dispatch-intent-comparison"
          title=${COMPARISON_SIBLING_TOOLTIP}
          @click=${() => ctx.enterComparisonFlow()}
        >
          Comparison sibling
        </button>
      </div>
      ${renderComparisonFlowHint(ctx)}
      ${ctx.comparisonFlow && !ctx.comparisonBaselineSelected
        ? renderCompareRunPickerModal({
            open: ctx.pickerOpen,
            runs: ctx.pickerRuns,
            pickerSearch: ctx.pickerSearch,
            title: 'Pick comparison baseline',
            subtitle: `${ctx.pickerRuns.length} recent run${ctx.pickerRuns.length === 1 ? '' : 's'}`,
            emptyMessage: 'No runs match this search.',
            onSelectRun: ctx.onSelectBaselineRun,
            setPickerOpen: ctx.setPickerOpen,
            setPickerSearch: ctx.setPickerSearch,
          })
        : nothing}
    </div>
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
