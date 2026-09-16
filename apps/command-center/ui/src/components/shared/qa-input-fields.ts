import { css, html, nothing, unsafeCSS } from 'lit';

import { type QaInput, qaInputFieldValue, type QaProfile } from '@farmslot/protocol';

import './choice-picker.js';

import { colors, fonts } from '../../styles/theme-tokens.js';

export const qaInputFieldStyles = css`
  .qa-input-field {
    display: grid;
    gap: 6px;
    margin: 10px 0;
  }
  .qa-input-field input:not([type='checkbox']) {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    padding: 8px 10px;
    color: ${unsafeCSS(colors.textPrimary)};
    background: ${unsafeCSS(colors.bgInput)};
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: 4px;
    font: 12px ${unsafeCSS(fonts.mono)};
  }
  .qa-input-field input:focus {
    outline: 1px solid ${unsafeCSS(colors.accent)};
  }
  .qa-input-field .section-help {
    text-transform: none;
    letter-spacing: normal;
  }
`;

/** Preserve sibling inputs when changing a nested field such as scope.hours. */
export function setQaInputField(
  inputs: Record<string, QaInput>,
  path: string,
  value: QaInput | undefined,
): Record<string, QaInput> {
  const parts = path.split('.');
  if (parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part)))
    throw new Error('Invalid QA input path');
  const copy = structuredClone(inputs);
  let object = copy;
  for (const part of parts.slice(0, -1)) {
    const existing = object[part];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) object[part] = {};
    object = object[part] as Record<string, QaInput>;
  }
  if (value === undefined) delete object[parts.at(-1)!];
  else object[parts.at(-1)!] = value;
  return copy;
}

/** Shared between Dispatch, PR requests and automation settings; all meanings come from the farm. */
export function renderQaInputFields(options: {
  profile?: QaProfile;
  inputs?: Record<string, QaInput>;
  disabled?: boolean;
  change: (inputs: Record<string, QaInput>) => void;
}) {
  const inputs = { ...options.profile?.inputs, ...options.inputs };
  return (options.profile?.input_fields ?? []).map((field) => {
    const value = qaInputFieldValue(inputs, field.path);
    const changed = (next: QaInput | undefined) =>
      options.change(setQaInputField(inputs, field.path, next));
    return html`<label class="section-label qa-input-field"
      >${field.title}${field.required ? ' *' : ''}
      ${field.type === 'select'
        ? html`<choice-picker
            data-qa-input=${field.path}
            .value=${typeof value === 'string' ? value : ''}
            ?disabled=${options.disabled}
            @change=${(event: Event) =>
              changed((event.target as HTMLSelectElement).value || undefined)}
          >
            <option value="">Choose ${field.title.toLowerCase()}</option>
            ${field.options?.map(
              (option) => html`<option value=${option.value}>${option.title}</option>`,
            )}
          </choice-picker>`
        : field.type === 'boolean'
          ? html`<input
              data-qa-input=${field.path}
              type="checkbox"
              .checked=${value === true}
              ?disabled=${options.disabled}
              @change=${(event: Event) => changed((event.target as HTMLInputElement).checked)}
            />`
          : html`<input
              data-qa-input=${field.path}
              type=${field.type === 'number' ? 'number' : 'text'}
              .value=${value === undefined || value === null ? '' : String(value)}
              ?disabled=${options.disabled}
              @input=${(event: Event) => {
                const input = (event.target as HTMLInputElement).value;
                const value = field.type === 'number' ? Number(input) : input;
                changed(
                  input === '' || (typeof value === 'number' && !Number.isFinite(value))
                    ? null
                    : value,
                );
              }}
            />`}
      ${field.description ? html`<span class="section-help">${field.description}</span>` : nothing}
    </label>`;
  });
}
