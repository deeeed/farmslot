import { html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { PRProjectCatalog, PRRuleField, PRRulePredicate } from '@farmslot/protocol';

import '../shared/choice-picker.js';

import type { ChoicePicker } from '../shared/choice-picker.js';

import { prAutomationStyles } from './pr-automation-styles.js';

type Comparison = Extract<PRRulePredicate, { kind: 'compare' }>;
const types: Record<string, Exclude<PRRuleField, string>['valueType']> = {
  TEXT: 'text',
  NUMBER: 'number',
  DATE: 'date',
  SINGLE_SELECT: 'single-select',
};

@customElement('pr-project-field-picker')
export class PRProjectFieldPicker extends LitElement {
  @property({ attribute: false }) node?: Comparison;
  @property({ attribute: false }) catalogs: PRProjectCatalog[] = [];
  @property({ type: Boolean }) disabled = false;
  static styles = prAutomationStyles;
  private change(node: Comparison) {
    this.dispatchEvent(
      new CustomEvent('comparison-change', { detail: node, bubbles: true, composed: true }),
    );
  }
  render() {
    const node = this.node;
    if (!node || typeof node.field === 'string') return nothing;
    const field = node.field;
    const entries = this.catalogs.flatMap((project) =>
      project.fields.flatMap((entry) =>
        types[entry.dataType]
          ? [{ project, entry, key: JSON.stringify([project.id, entry.id]) }]
          : [],
      ),
    );
    const selected = entries.find(
      (item) => item.project.id === field.projectId && item.entry.id === field.fieldId,
    );
    return html`<fieldset ?disabled=${this.disabled}>
      <label
        >Project field<choice-picker
          data-testid="pr-project-field-binding"
          .value=${selected?.key ?? ''}
          @change=${(event: Event) => {
            const choice = entries.find(
              (item) => item.key === (event.target as ChoicePicker).value,
            );
            if (choice)
              this.change({
                ...node,
                field: {
                  projectId: choice.project.id,
                  fieldId: choice.entry.id,
                  valueType: types[choice.entry.dataType],
                },
                operator: 'equals',
                value: choice.entry.dataType === 'NUMBER' ? 0 : '',
              });
          }}
        >
          <option value="" disabled .selected=${!selected}>Choose a field by name</option>
          ${entries.map(
            (item) =>
              html`<option .value=${item.key} .selected=${item === selected}>
                ${item.project.title} / ${item.entry.name}
              </option>`,
          )}
        </choice-picker></label
      >
      ${selected?.entry.options && field.valueType === 'single-select'
        ? node.operator === 'equals'
          ? html`<label
              >Option<choice-picker
                data-testid="pr-project-field-option"
                .value=${typeof node.value === 'string' ? node.value : ''}
                @change=${(event: Event) =>
                  this.change({ ...node, value: (event.target as ChoicePicker).value })}
              >
                <option value="" disabled .selected=${!node.value}>Choose an option</option>
                ${selected.entry.options.map(
                  (option) =>
                    html`<option .value=${option.id} .selected=${node.value === option.id}>
                      ${option.name}
                    </option>`,
                )}
              </choice-picker></label
            >`
          : node.operator === 'one-of'
            ? html`<div class="row">
                ${selected.entry.options.map(
                  (option) =>
                    html`<label class="check"
                      ><input
                        type="checkbox"
                        .checked=${Array.isArray(node.value) && node.value.includes(option.id)}
                        @change=${(event: Event) => {
                          const values = Array.isArray(node.value) ? node.value : [];
                          this.change({
                            ...node,
                            value: (event.target as HTMLInputElement).checked
                              ? [...new Set([...values, option.id])]
                              : values.filter((id) => id !== option.id),
                          });
                        }}
                      />${option.name}</label
                    >`,
                )}
              </div>`
            : nothing
        : nothing}
    </fieldset>`;
  }
}
