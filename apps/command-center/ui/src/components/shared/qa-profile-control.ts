import { html, nothing } from 'lit';

import { type ProjectQaConfig, type QaInput, resolveQaProfileId } from '@farmslot/protocol';

import './choice-picker.js';

import { renderQaInputFields } from './qa-input-fields.js';

/** Shared profile selection for Dispatch, PR requests and automation policies. */
export function renderQaProfileControl(options: {
  config?: ProjectQaConfig;
  value?: string;
  projectSelected?: boolean;
  disabled?: boolean;
  testId: string;
  change: (id: string) => void;
  inputs?: Record<string, QaInput>;
  changeInputs?: (inputs: Record<string, QaInput>) => void;
}) {
  const { config, testId } = options;
  if (options.projectSelected === false)
    return html`<p class="section-help muted" data-testid=${`${testId}-empty`}>
      Choose a project to see its QA options.
    </p>`;
  if (!config?.profiles.length)
    return html`<p class="section-help muted" data-testid=${`${testId}-empty`}>
      QA profiles are not configured for this project.
    </p>`;
  const selectedId = resolveQaProfileId(config, options.value || undefined);
  const selected = config.profiles.find((profile) => profile.id === selectedId);
  return html`<label class="section-label"
      >Validation
      <choice-picker
        data-testid=${testId}
        .value=${selectedId ?? ''}
        required
        ?disabled=${options.disabled}
        @change=${(event: Event) => options.change((event.target as HTMLSelectElement).value)}
      >
        <option value="">Choose a QA profile</option>
        ${config.profiles.map(
          (profile) =>
            html`<option value=${profile.id}>
              ${profile.title}
              (${profile.id})${profile.id === config.default_profile ? ' (default)' : ''}
            </option>`,
        )}
      </choice-picker>
    </label>
    ${selected?.description
      ? html`<p class="section-help muted">${selected.description}</p>`
      : nothing}
    ${options.changeInputs
      ? renderQaInputFields({
          profile: selected,
          inputs: options.inputs,
          disabled: options.disabled,
          change: options.changeInputs,
        })
      : nothing}`;
}
