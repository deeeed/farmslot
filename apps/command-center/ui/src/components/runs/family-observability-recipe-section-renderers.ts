import { html, nothing } from 'lit';

import type { FamilyObservabilityRunSummary } from '@farmslot/protocol';

import type { RecipeCockpitView } from '../recipe/recipe-quality-cockpit.js';

import type { GradeDraft, VerdictValue } from './family-observability-grading.js';
import { familyHasConvergedGood } from './family-observability-grading.js';
import {
  renderFamilyGradingPanel,
  renderFamilyImprovementTrigger,
} from './family-observability-grading-renderers.js';
import { renderFamilyRecipePanel } from './family-observability-recipe-renderers.js';
import type { SemanticPickerDetail } from './grade-semantic-picker.js';

interface FamilyRecipeRerunCheck {
  ok: boolean;
  reason?: string;
  slotId?: string;
}

interface FamilyRecipeSectionOptions {
  selectedRun: FamilyObservabilityRunSummary | null;
  rerunCheck: FamilyRecipeRerunCheck;
  recipeView: RecipeCockpitView;
  showRerunOutput: boolean;
  editingRunId: string;
  submittingGradeFor: string;
  gradeError: string;
  improvementModel: string;
  proposingFor: ReadonlySet<string>;
  proposalError: ReadonlyMap<string, string>;
  gradeDraft: (run: FamilyObservabilityRunSummary) => GradeDraft;
  elapsedSeconds: (runId: string) => number;
  onRecipeViewChange: (view: RecipeCockpitView) => void;
  onRerunOnWarmSlot: (run: FamilyObservabilityRunSummary) => void;
  onOpenSlotHistoryAt: (run: FamilyObservabilityRunSummary) => void;
  onRerunRunningChange: (event: CustomEvent<boolean>) => void;
  onStartEditingGrade: (run: FamilyObservabilityRunSummary) => void;
  onVerdictChange: (
    run: FamilyObservabilityRunSummary,
    targetId: string,
    verdict: VerdictValue,
  ) => void;
  onVerdictNoteInput: (run: FamilyObservabilityRunSummary, targetId: string, note: string) => void;
  onPickerChange: (runId: string, detail: SemanticPickerDetail) => void;
  onCancelEditingGrade: () => void;
  onSubmitGrade: (run: FamilyObservabilityRunSummary) => void;
  onProposeImprovement: (run: FamilyObservabilityRunSummary) => void;
}

export function renderFamilyConvergedPill(runs: readonly FamilyObservabilityRunSummary[]) {
  if (!familyHasConvergedGood(runs)) return nothing;
  return html`<span
    class="converged-pill converged"
    title="All graded runs marked good with no failing proof targets"
    >graded good</span
  >`;
}

export function renderFamilyRecipeSection(options: FamilyRecipeSectionOptions) {
  return renderFamilyRecipePanel({
    selectedRun: options.selectedRun,
    rerunCheck: options.rerunCheck,
    recipeView: options.recipeView,
    showRerunOutput: options.showRerunOutput,
    onRecipeViewChange: options.onRecipeViewChange,
    onRerunOnWarmSlot: options.onRerunOnWarmSlot,
    onOpenSlotHistoryAt: options.onOpenSlotHistoryAt,
    onRerunRunningChange: options.onRerunRunningChange,
    renderGradingPanel: (run) => renderRecipeSectionGradingPanel(options, run),
    renderImprovementTrigger: (run) => renderRecipeSectionImprovementTrigger(options, run),
  });
}

function renderRecipeSectionGradingPanel(
  options: FamilyRecipeSectionOptions,
  run: FamilyObservabilityRunSummary,
) {
  return renderFamilyGradingPanel({
    run,
    draft: options.gradeDraft(run),
    isEditing: options.editingRunId === run.runId,
    submitting: options.submittingGradeFor === run.runId,
    gradeError: options.gradeError,
    onStartEditing: options.onStartEditingGrade,
    onVerdictChange: options.onVerdictChange,
    onVerdictNoteInput: options.onVerdictNoteInput,
    onPickerChange: options.onPickerChange,
    onCancelEditing: options.onCancelEditingGrade,
    onSubmitGrade: options.onSubmitGrade,
  });
}

function renderRecipeSectionImprovementTrigger(
  options: FamilyRecipeSectionOptions,
  run: FamilyObservabilityRunSummary,
) {
  const proposing = options.proposingFor.has(run.runId);
  return renderFamilyImprovementTrigger({
    run,
    proposing,
    model: options.improvementModel || '…',
    elapsedSeconds: proposing ? options.elapsedSeconds(run.runId) : 0,
    error: options.proposalError.get(run.runId),
    onPropose: options.onProposeImprovement,
  });
}
