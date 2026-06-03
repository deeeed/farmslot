import { html, nothing } from 'lit';

import type { EvalTaskProfile } from '@farmslot/protocol';

import type { EvalCaseCatalogItem, EvalCaseSourceKind } from './eval-suite-helpers.js';

export interface EvalCockpitManualEntryRenderOptions {
  manualProject: string;
  manualProjects: readonly string[];
  manualKind: EvalCaseSourceKind;
  manualTaskProfile: EvalTaskProfile;
  manualPrRef: string;
  manualRunId: string;
  manualPackagePath: string;
  manualGitRef: string;
  manualGitRepository: string;
  manualLabel: string;
  manualObjective: string;
  matchingPrReference: EvalCaseCatalogItem | null;
  setManualProject: (value: string) => void;
  setManualKind: (value: EvalCaseSourceKind) => void;
  setManualTaskProfile: (value: EvalTaskProfile) => void;
  setManualPrRef: (value: string) => void;
  setManualRunId: (value: string) => void;
  setManualPackagePath: (value: string) => void;
  setManualGitRef: (value: string) => void;
  setManualGitRepository: (value: string) => void;
  setManualLabel: (value: string) => void;
  setManualObjective: (value: string) => void;
  addManualCase: () => void;
}

function matchedReferenceLabel(matchingPrReference: EvalCaseCatalogItem | null): string {
  if (!matchingPrReference) {
    return 'If a matching Farmslot run is listed, Add will use that run instead of GitHub-only extraction.';
  }
  const sourceLabel =
    matchingPrReference.source.kind === 'prior-run'
      ? 'Run-backed Reference found'
      : 'Merged PR found';
  const runLabel = matchingPrReference.runId
    ? ` · run ${matchingPrReference.runId.slice(0, 8)}`
    : '';
  return `${sourceLabel}: ${matchingPrReference.label}${runLabel}`;
}

export function renderEvalCockpitManualEntry(options: EvalCockpitManualEntryRenderOptions) {
  return html`
    <div class="manual-entry">
      <div>
        <div class="eval-panel-title">Exact reference entry</div>
        <div class="eval-muted">
          Paste a PR URL/ref when it is faster than browsing. Before launch, Farmslot checks the
          current run catalog first and uses the matching run-backed Reference when one exists.
        </div>
      </div>
      <div class="eval-form-grid">
        <label
          >Project config
          <select
            .value=${options.manualProject}
            @change=${(event: Event) => {
              options.setManualProject((event.target as HTMLSelectElement).value);
            }}
          >
            ${options.manualProjects.map(
              (project) => html`<option value=${project}>${project}</option>`,
            )}
          </select>
          <small>Used only to pick the gateway project config for manual refs.</small>
        </label>
        <label
          >Source kind
          <select
            .value=${options.manualKind}
            @change=${(event: Event) => {
              options.setManualKind(
                (event.target as HTMLSelectElement).value as EvalCaseSourceKind,
              );
            }}
          >
            <option value="merged-pr">merged PR</option>
            <option value="prior-run">prior run</option>
            <option value="package">package</option>
            <option value="git-ref">git ref</option>
          </select>
        </label>
        <label
          >Task profile
          <select
            .value=${options.manualTaskProfile}
            @change=${(event: Event) => {
              options.setManualTaskProfile(
                (event.target as HTMLSelectElement).value as EvalTaskProfile,
              );
            }}
          >
            <option value="fix-bug">fix-bug</option>
            <option value="dev">dev</option>
          </select>
        </label>
        ${options.manualKind === 'merged-pr'
          ? html`
              <label
                >PR URL or ref
                <input
                  placeholder="https://github.com/owner/repo/pull/123"
                  .value=${options.manualPrRef}
                  @input=${(event: InputEvent) => {
                    options.setManualPrRef((event.target as HTMLInputElement).value);
                  }}
                />
                <small>${matchedReferenceLabel(options.matchingPrReference)}</small>
              </label>
            `
          : nothing}
        ${options.manualKind === 'prior-run'
          ? html`<label
              >Run id
              <input
                placeholder="run id"
                .value=${options.manualRunId}
                @input=${(event: InputEvent) => {
                  options.setManualRunId((event.target as HTMLInputElement).value);
                }}
            /></label>`
          : nothing}
        ${options.manualKind === 'package'
          ? html`<label
              >Package path
              <input
                placeholder="/path/reference.result-package.json"
                .value=${options.manualPackagePath}
                @input=${(event: InputEvent) => {
                  options.setManualPackagePath((event.target as HTMLInputElement).value);
                }}
            /></label>`
          : nothing}
        ${options.manualKind === 'git-ref'
          ? html`
              <label
                >Git ref
                <input
                  .value=${options.manualGitRef}
                  @input=${(event: InputEvent) => {
                    options.setManualGitRef((event.target as HTMLInputElement).value);
                  }}
              /></label>
              <label
                >Repository
                <input
                  placeholder="owner/repo"
                  .value=${options.manualGitRepository}
                  @input=${(event: InputEvent) => {
                    options.setManualGitRepository((event.target as HTMLInputElement).value);
                  }}
              /></label>
            `
          : nothing}
        <label
          >Label
          <input
            placeholder="optional case label"
            .value=${options.manualLabel}
            @input=${(event: InputEvent) => {
              options.setManualLabel((event.target as HTMLInputElement).value);
            }}
        /></label>
        <label class="wide"
          >Objective
          <input
            placeholder="optional case objective"
            .value=${options.manualObjective}
            @input=${(event: InputEvent) => {
              options.setManualObjective((event.target as HTMLInputElement).value);
            }}
        /></label>
      </div>
      <button class="eval-button" @click=${() => options.addManualCase()}>
        ${options.matchingPrReference ? 'Add matched Reference' : 'Add exact Reference'}
      </button>
    </div>
  `;
}
