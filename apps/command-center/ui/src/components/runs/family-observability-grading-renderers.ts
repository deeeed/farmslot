import { html, nothing } from 'lit';

import type { FamilyObservabilityRunSummary } from '@farmslot/protocol';

import { semanticColor } from './family-observability-display-model.js';
import {
  canGradeFamilyRun,
  type GradeDraft,
  type GradeVerdictDraft,
  type VerdictValue,
} from './family-observability-grading.js';
import type { SemanticPickerDetail } from './grade-semantic-picker.js';

interface FamilyGradingPanelRenderOptions {
  run: FamilyObservabilityRunSummary;
  draft: GradeDraft;
  isEditing: boolean;
  submitting: boolean;
  gradeError: string;
  onStartEditing: (run: FamilyObservabilityRunSummary) => void;
  onVerdictChange: (
    run: FamilyObservabilityRunSummary,
    targetId: string,
    verdict: VerdictValue,
  ) => void;
  onVerdictNoteInput: (run: FamilyObservabilityRunSummary, targetId: string, note: string) => void;
  onPickerChange: (runId: string, detail: SemanticPickerDetail) => void;
  onCancelEditing: () => void;
  onSubmitGrade: (run: FamilyObservabilityRunSummary) => void;
}

interface FamilyImprovementTriggerRenderOptions {
  run: FamilyObservabilityRunSummary;
  proposing: boolean;
  model: string;
  elapsedSeconds: number;
  error: string | null | undefined;
  onPropose: (run: FamilyObservabilityRunSummary) => void;
}

export function renderFamilyGradingPanel(options: FamilyGradingPanelRenderOptions) {
  const { run } = options;
  if (!canGradeFamilyRun(run)) return nothing;
  const existing = run.humanGrade;
  if (existing && !options.isEditing) {
    const color = semanticColor(existing.recipe_semantic);
    const when = new Date(existing.graded_at).toLocaleDateString();
    const verdicts = existing.proof_target_verdicts ?? [];
    return html`
      <div class="grade-panel">
        <div class="grade-row">
          <span class="grade-label">Grade</span>
          <span class="grade-chip" style=${`background:${color}22; color:${color}`}
            >${existing.recipe_semantic}</span
          >
          <span class="grade-reasoning">${existing.reasoning || '(no reasoning)'}</span>
          <span class="grade-meta">${existing.graded_by} · ${when}</span>
          <button class="grade-link" @click=${() => options.onStartEditing(run)}>Edit</button>
        </div>
        ${verdicts.length > 0
          ? html`
              <div class="verdict-summary">
                ${verdicts.map(
                  (verdict) => html`
                    <span class="verdict-chip verdict-${verdict.verdict}">
                      ${verdict.target} ·
                      ${verdict.verdict}${verdict.note ? html` — ${verdict.note}` : ''}
                    </span>
                  `,
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  const draft = options.draft;
  const targets = run.proofTargets ?? [];
  return html`
    <div class="grade-panel">
      <div class="grade-title">Human grade</div>
      ${targets.length > 0
        ? html`
            <div class="verdict-list">
              ${targets.map((target) => {
                const entry: GradeVerdictDraft = draft.verdicts.get(target.id) ?? {};
                return html`
                  <div class="verdict-row">
                    <div class="verdict-target">${target.target}</div>
                    <div class="verdict-pills">
                      ${(['pass', 'fail', 'not-applicable'] as const).map(
                        (verdict) => html`
                          <button
                            class="verdict-pill ${verdict} ${entry.verdict === verdict
                              ? 'selected'
                              : ''}"
                            ?disabled=${options.submitting}
                            @click=${() => options.onVerdictChange(run, target.id, verdict)}
                          >
                            ${verdict === 'not-applicable' ? 'n/a' : verdict}
                          </button>
                        `,
                      )}
                    </div>
                    <input
                      class="verdict-note"
                      type="text"
                      placeholder="note (optional)"
                      .value=${entry.note ?? ''}
                      ?disabled=${options.submitting}
                      @input=${(event: InputEvent) =>
                        options.onVerdictNoteInput(
                          run,
                          target.id,
                          (event.target as HTMLInputElement).value,
                        )}
                    />
                  </div>
                `;
              })}
            </div>
            <div class="grade-derived">
              Overall:
              <strong style=${`color:${semanticColor(draft.semantic)}`}
                >${draft.semantic || '—'}</strong
              >
              ${draft.overridden ? html`<span class="muted">(manual override)</span>` : nothing}
            </div>
          `
        : nothing}
      <grade-semantic-picker
        .value=${draft.semantic}
        .reasoning=${draft.reasoning}
        .showReasoning=${true}
        .reasoningPlaceholder=${'Reasoning (required when marking bad or any target failed)'}
        @picker-change=${(event: CustomEvent<SemanticPickerDetail>) =>
          options.onPickerChange(run.runId, event.detail)}
      ></grade-semantic-picker>
      ${options.gradeError ? html`<div class="grade-error">${options.gradeError}</div>` : nothing}
      <div class="grade-actions">
        ${existing
          ? html`
              <button
                class="action-btn"
                ?disabled=${options.submitting}
                @click=${options.onCancelEditing}
              >
                Cancel
              </button>
            `
          : nothing}
        <button
          class="action-btn primary"
          ?disabled=${options.submitting || !draft.semantic}
          @click=${() => options.onSubmitGrade(run)}
        >
          ${options.submitting ? 'Saving…' : existing ? 'Update grade' : 'Submit grade'}
        </button>
      </div>
    </div>
  `;
}

export function renderFamilyImprovementTrigger(options: FamilyImprovementTriggerRenderOptions) {
  const grade = options.run.humanGrade;
  if (!grade) return nothing;
  const verdicts = grade.proof_target_verdicts ?? [];
  const hasFailing = verdicts.some((verdict) => verdict.verdict === 'fail');
  const semanticTriggers = grade.recipe_semantic === 'ok' || grade.recipe_semantic === 'bad';
  if (!semanticTriggers && !hasFailing) return nothing;
  const hasError = Boolean(options.error);
  const buttonLabel = options.proposing
    ? `Analyzing with ${options.model}…`
    : hasError
      ? 'Retry recipe improvement'
      : 'Propose recipe improvement';
  const tooltip =
    'Runs the improvement-engine against learnings.md via LLM. Analysis is async (typically 30–120s). A new decision appears in the timeline when it completes — safe to leave this page.';
  return html`
    <div class="improvement-trigger">
      <div class="improvement-trigger-row">
        <button
          class="action-btn primary"
          ?disabled=${options.proposing}
          title=${tooltip}
          @click=${() => options.onPropose(options.run)}
        >
          ${options.proposing ? html`<span class="pulse-dot"></span>` : nothing}${buttonLabel}
        </button>
      </div>
      ${options.proposing
        ? html`
            <div class="improvement-hint active">
              <span class="improvement-badge">LLM call · ${options.model}</span>
              <span class="improvement-elapsed" aria-live="polite"
                >elapsed ${options.elapsedSeconds}s</span
              >
              <span class="improvement-async"
                >Async — safe to leave this page. Decision arrives in timeline.</span
              >
            </div>
          `
        : html`
            <div class="improvement-hint">
              <span class="improvement-badge">LLM call · ${options.model}</span>
              <span class="improvement-duration">~1–2 min</span>
              <span class="improvement-async">Async — decision arrives in timeline.</span>
            </div>
          `}
      ${options.error ? html`<div class="proposal-error">${options.error}</div>` : nothing}
    </div>
  `;
}
