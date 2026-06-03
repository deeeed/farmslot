import { html, nothing } from 'lit';

import type { EvalTaskProfile } from '@farmslot/protocol';

import { EVAL_CANDIDATE_RUNNERS, runnerLabel } from '../../utils/runner-options.js';

import { type CandidateTemplateChoice, EVAL_REVIEW_MODE_OPTIONS } from './eval-cockpit-model.js';
import type { CandidateRow } from './eval-cockpit-url-state.js';

export interface EvalCockpitCandidateMatrixRenderOptions {
  candidateRows: readonly CandidateRow[];
  selectedCaseCount: number;
  enabledCandidateCount: number;
  selectedTaskProfile: EvalTaskProfile;
  advancedStrategyOpen: boolean;
  candidateTemplateOptionsLoading: boolean;
  candidateTemplateOptionsError: string;
  addRow: () => void;
  removeRow: (id: string) => void;
  updateRow: (id: string, patch: Partial<CandidateRow>) => void;
  setCandidateRunner: (id: string, runner: string) => void;
  setCandidateTemplate: (id: string, templatePath: string) => void;
  setAdvancedStrategyOpen: (open: boolean) => void;
  candidateLabel: (row: CandidateRow) => string;
  generatedCandidateLabel: (row: CandidateRow) => string;
  candidateModelOptions: (runner: string) => string[];
  candidateTemplateChoices: (taskProfile: EvalTaskProfile) => CandidateTemplateChoice[];
  candidateTemplateSummary: (row: CandidateRow) => string;
  candidateVariant: (row: CandidateRow) => string;
}

export function renderEvalCockpitCandidateMatrix(options: EvalCockpitCandidateMatrixRenderOptions) {
  const trialCount = options.selectedCaseCount * options.enabledCandidateCount;
  return html`
    <section class="eval-panel candidate-replay-panel">
      <div class="eval-panel-head">
        <div>
          <div class="eval-panel-title">Candidate replay</div>
          <div class="eval-muted">
            Dispatch-style isolated replay candidates. Bugfix replay is the default; choosing a dev
            Reference switches the template to dev. The replay base is selected from each Reference
            automatically.
          </div>
        </div>
        <button class="eval-button" @click=${() => options.addRow()}>Add another candidate</button>
      </div>
      <div class="candidate-trial-summary">
        ${options.selectedCaseCount} Reference case${options.selectedCaseCount === 1 ? '' : 's'} ×
        ${options.enabledCandidateCount} enabled
        Candidate${options.enabledCandidateCount === 1 ? '' : 's'} = ${trialCount} isolated
        trial${trialCount === 1 ? '' : 's'}.
      </div>
      <div class="candidate-card-list">
        ${options.candidateRows.map((row, index) => {
          const models = options.candidateModelOptions(row.runner);
          return html`
            <article class=${`candidate-card ${row.enabled ? '' : 'disabled'}`}>
              <div class="candidate-card-head">
                <div>
                  <div class="candidate-card-title">${options.candidateLabel(row)}</div>
                  <div class="eval-muted">
                    Candidate ${index + 1} · ${row.runner || 'runner'} / ${row.model || 'model'} ·
                    isolated from the selected Reference base
                  </div>
                </div>
                <div class="candidate-card-actions">
                  <button
                    class=${`choice-chip ${row.enabled ? 'active' : ''}`}
                    @click=${() => options.updateRow(row.id, { enabled: !row.enabled })}
                  >
                    ${row.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  <button
                    class="link-button"
                    @click=${() => options.removeRow(row.id)}
                    ?disabled=${options.candidateRows.length === 1}
                  >
                    Remove
                  </button>
                </div>
              </div>

              <div class="dispatch-like-block">
                <label class="field-label"
                  >Candidate name
                  <input
                    placeholder=${options.generatedCandidateLabel(row)}
                    .value=${row.label}
                    @input=${(e: InputEvent) =>
                      options.updateRow(row.id, { label: (e.target as HTMLInputElement).value })}
                  />
                  <small class="base-choice-note"
                    >Editable display name for remembering this candidate. Leave blank to use the
                    generated name.</small
                  >
                </label>
              </div>

              <div class="dispatch-like-block">
                <div class="field-label">Runner</div>
                <div class="choice-row" role="group" aria-label="Candidate runner">
                  ${EVAL_CANDIDATE_RUNNERS.map(
                    (runner) => html`
                      <button
                        class=${`choice-chip ${row.runner === runner ? 'active' : ''}`}
                        aria-pressed=${row.runner === runner ? 'true' : 'false'}
                        @click=${() => options.setCandidateRunner(row.id, runner)}
                      >
                        ${runnerLabel(runner)}
                      </button>
                    `,
                  )}
                </div>
              </div>

              <div class="dispatch-like-block">
                <div class="field-label">Model</div>
                <div class="choice-row" role="group" aria-label="Candidate model">
                  ${models.map(
                    (model) => html`
                      <button
                        class=${`choice-chip ${row.model === model ? 'active' : ''}`}
                        aria-pressed=${row.model === model ? 'true' : 'false'}
                        @click=${() => options.updateRow(row.id, { model })}
                      >
                        ${model}
                      </button>
                    `,
                  )}
                </div>
              </div>

              <div class="start-ref-field">
                <div class="field-label">Template</div>
                <div class="template-choice-grid" role="group" aria-label="Candidate template">
                  ${options.candidateTemplateChoices(options.selectedTaskProfile).map(
                    (option) => html`
                      <button
                        class=${`template-choice-button ${row.templatePath === option.path ? 'active' : ''}`}
                        aria-pressed=${row.templatePath === option.path ? 'true' : 'false'}
                        @click=${() => options.setCandidateTemplate(row.id, option.path)}
                      >
                        <span>${option.label}</span>
                        <small>${option.description}</small>
                      </button>
                    `,
                  )}
                </div>
                ${options.candidateTemplateOptionsLoading
                  ? html`<div class="base-choice-note">Loading project template versions...</div>`
                  : nothing}
                ${options.candidateTemplateOptionsError
                  ? html`<div class="base-choice-note">
                      ${options.candidateTemplateOptionsError}
                    </div>`
                  : nothing}
                <div class="base-choice-note">
                  The gateway captures the exact template content hash and project commit at launch.
                </div>
              </div>

              <div class="start-ref-field">
                <div class="field-label">Replay base</div>
                <div class="base-choice-row">
                  <span class="choice-chip active">Reference before-commit</span>
                  <span class="base-choice-note"
                    >Set automatically from the selected Reference package or merged PR. Each
                    Candidate runs in a fresh artifact-only family.</span
                  >
                </div>
              </div>

              <details
                class="candidate-template-details"
                ?open=${options.advancedStrategyOpen}
                @toggle=${(e: Event) => {
                  options.setAdvancedStrategyOpen((e.target as HTMLDetailsElement).open);
                }}
              >
                <summary>
                  Advanced optional axes <span>${options.candidateTemplateSummary(row)}</span>
                </summary>
                <p class="advanced-help">
                  Usually leave these alone. They are for exact template/prompt/harness
                  reproducibility when comparing template revisions, not for normal bugfix replay.
                </p>
                <div class="candidate-advanced-grid">
                  <div class="field-label">
                    Generated variant
                    <code class="readonly-axis">${options.candidateVariant(row)}</code>
                  </div>
                  <label class="field-label"
                    >Exact template path
                    <input
                      .value=${row.templatePath}
                      @input=${(e: InputEvent) =>
                        options.updateRow(row.id, {
                          templatePath: (e.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field-label"
                    >Template version/hash
                    <input
                      placeholder="optional version/hash"
                      .value=${row.templateHash}
                      @input=${(e: InputEvent) =>
                        options.updateRow(row.id, {
                          templateHash: (e.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field-label"
                    >Prompt name
                    <input
                      .value=${row.promptName}
                      @input=${(e: InputEvent) =>
                        options.updateRow(row.id, {
                          promptName: (e.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field-label"
                    >Prompt hash
                    <input
                      placeholder="optional hash"
                      .value=${row.promptHash}
                      @input=${(e: InputEvent) =>
                        options.updateRow(row.id, {
                          promptHash: (e.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field-label"
                    >Harness ref
                    <input
                      placeholder="current"
                      .value=${row.harnessRef}
                      @input=${(e: InputEvent) =>
                        options.updateRow(row.id, {
                          harnessRef: (e.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field-label"
                    >Base recipe path
                    <input
                      placeholder="optional base recipe"
                      .value=${row.baseRecipePath}
                      @input=${(e: InputEvent) =>
                        options.updateRow(row.id, {
                          baseRecipePath: (e.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field-label"
                    >Review loop
                    <select
                      .value=${row.reviewMode}
                      @change=${(e: Event) =>
                        options.updateRow(row.id, {
                          reviewMode: (e.target as HTMLSelectElement)
                            .value as CandidateRow['reviewMode'],
                        })}
                    >
                      ${EVAL_REVIEW_MODE_OPTIONS.map(
                        (option) => html`<option value=${option.mode}>${option.label}</option>`,
                      )}
                    </select>
                    <span class="base-choice-note"
                      >${EVAL_REVIEW_MODE_OPTIONS.find((option) => option.mode === row.reviewMode)
                        ?.description}</span
                    >
                  </label>
                  ${row.reviewMode === 'custom'
                    ? html`
                        <label class="field-label"
                          >Review axis name
                          <input
                            placeholder="external-review"
                            .value=${row.reviewName}
                            @input=${(e: InputEvent) =>
                              options.updateRow(row.id, {
                                reviewName: (e.target as HTMLInputElement).value,
                              })}
                          />
                        </label>
                        <label class="field-label"
                          >Review axis version
                          <input
                            placeholder="optional version"
                            .value=${row.reviewVersion}
                            @input=${(e: InputEvent) =>
                              options.updateRow(row.id, {
                                reviewVersion: (e.target as HTMLInputElement).value,
                              })}
                          />
                        </label>
                      `
                    : nothing}
                </div>
                <label class="repeat-row"
                  ><input
                    type="checkbox"
                    .checked=${row.repeat}
                    @change=${(e: Event) =>
                      options.updateRow(row.id, {
                        repeat: (e.target as HTMLInputElement).checked,
                      })}
                  />
                  Force a new independent trial even when this exact candidate already exists</label
                >
              </details>
            </article>
          `;
        })}
      </div>
    </section>
  `;
}
