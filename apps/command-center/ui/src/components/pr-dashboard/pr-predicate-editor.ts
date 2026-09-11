import { html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type {
  PRProjectCatalog,
  PRRuleField,
  PRRulePredicate,
  PRRuleValue,
} from '@farmslot/protocol';

import '../shared/choice-picker.js';
import './pr-project-field-picker.js';

import type { ChoicePicker } from '../shared/choice-picker.js';

import { prAutomationStyles } from './pr-automation-styles.js';

type Comparison = Extract<PRRulePredicate, { kind: 'compare' }>;
const fields: Array<Extract<PRRuleField, string>> = [
  'repository',
  'author',
  'state',
  'draft',
  'base-branch',
  'head-branch',
  'labels',
  'changed-paths',
  'author-teams',
  'project-memberships',
];
export function defaultPRPredicate(): Comparison {
  return { kind: 'compare', field: 'state', operator: 'equals', value: 'open' };
}
function fieldType(field: PRRuleField): 'text' | 'number' | 'boolean' | 'set' {
  if (typeof field !== 'string') return field.valueType === 'number' ? 'number' : 'text';
  if (field === 'draft') return 'boolean';
  return ['labels', 'changed-paths', 'author-teams', 'project-memberships'].includes(field)
    ? 'set'
    : 'text';
}
function operators(field: PRRuleField): Comparison['operator'][] {
  const type = fieldType(field);
  return type === 'set'
    ? ['contains-any', 'contains-all', 'glob', 'is-set']
    : type === 'number'
      ? ['equals', 'greater-than', 'less-than', 'is-set']
      : type === 'boolean'
        ? ['equals', 'is-set']
        : ['equals', 'one-of', 'glob', 'is-set'];
}
function initialValue(field: PRRuleField, operator: Comparison['operator']): PRRuleValue {
  if (operator === 'is-set') return true;
  if (['one-of', 'contains-any', 'contains-all', 'glob'].includes(operator)) return [];
  return fieldType(field) === 'boolean' ? false : fieldType(field) === 'number' ? 0 : '';
}

@customElement('pr-predicate-editor')
export class PRPredicateEditor extends LitElement {
  @property({ attribute: false }) value: PRRulePredicate = defaultPRPredicate();
  @property({ type: Boolean }) disabled = false;
  @property({ type: Number }) depth = 0;
  @property({ attribute: false }) catalogs: PRProjectCatalog[] = [];
  static styles = prAutomationStyles;
  private change(value: PRRulePredicate) {
    this.dispatchEvent(
      new CustomEvent('predicate-change', { detail: value, bubbles: true, composed: true }),
    );
  }
  private child(value: PRRulePredicate, change: (value: PRRulePredicate) => void) {
    return html`<pr-predicate-editor
      .value=${value}
      .disabled=${this.disabled}
      .depth=${this.depth + 1}
      .catalogs=${this.catalogs}
      @predicate-change=${(event: CustomEvent<PRRulePredicate>) => {
        event.stopPropagation();
        change(event.detail);
      }}
    ></pr-predicate-editor>`;
  }
  private comparison(node: Comparison) {
    const field = node.field;
    const list = Array.isArray(node.value);
    const boolean = node.operator === 'is-set' || fieldType(field) === 'boolean';
    const optionPicker =
      typeof field !== 'string' &&
      field.valueType === 'single-select' &&
      ['equals', 'one-of'].includes(node.operator) &&
      this.catalogs.some(
        (project) =>
          project.id === field.projectId &&
          project.fields.some((entry) => entry.id === field.fieldId && entry.options),
      );
    return html`<div class="grid">
        <label
          >PR fact<choice-picker
            data-testid="pr-predicate-field"
            .value=${typeof field === 'string' ? field : 'project-field'}
            @change=${(event: Event) => {
              const value = (event.target as ChoicePicker).value;
              const next: PRRuleField =
                value === 'project-field'
                  ? { projectId: '', fieldId: '', valueType: 'single-select' }
                  : (fields.find((field) => field === value) ?? 'state');
              const operator = operators(next)[0];
              this.change({
                kind: 'compare',
                field: next,
                operator,
                value: initialValue(next, operator),
              });
            }}
          >
            ${fields.map(
              (entry) =>
                html`<option .value=${entry} .selected=${entry === field}>${entry}</option>`,
            )}
            <option value="project-field" .selected=${typeof field !== 'string'}>
              GitHub Project field
            </option>
          </choice-picker></label
        >
        <label
          >Comparison<choice-picker
            data-testid="pr-predicate-operator"
            .value=${node.operator}
            @change=${(event: Event) => {
              const operator = operators(field).find(
                (operator) => operator === (event.target as ChoicePicker).value,
              )!;
              this.change({ ...node, operator, value: initialValue(field, operator) });
            }}
          >
            ${operators(field).map(
              (operator) =>
                html`<option .value=${operator} .selected=${operator === node.operator}>
                  ${operator}
                </option>`,
            )}
          </choice-picker></label
        >
        ${optionPicker
          ? nothing
          : boolean
            ? html`<label class="check"
                ><input
                  type="checkbox"
                  .checked=${node.value === true}
                  @change=${(event: Event) =>
                    this.change({ ...node, value: (event.target as HTMLInputElement).checked })}
                />${node.operator === 'is-set' ? 'Value is set' : 'True'}</label
              >`
            : html`<label
                >${list ? 'Values, one per line' : 'Value'}
                ${list
                  ? html`<textarea
                      data-testid="pr-predicate-values"
                      rows="2"
                      .value=${(node.value as string[]).join('\n')}
                      @change=${(event: Event) =>
                        this.change({
                          ...node,
                          value: (event.target as HTMLTextAreaElement).value
                            .split('\n')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        })}
                    ></textarea>`
                  : html`<input
                      data-testid="pr-predicate-value"
                      type=${fieldType(field) === 'number' ? 'number' : 'text'}
                      .value=${node.value === null ? '' : String(node.value)}
                      ?disabled=${node.value === null}
                      @change=${(event: Event) =>
                        this.change({
                          ...node,
                          value:
                            fieldType(field) === 'number'
                              ? Number((event.target as HTMLInputElement).value)
                              : (event.target as HTMLInputElement).value,
                        })}
                    />`}
              </label>`}
        ${node.operator === 'equals'
          ? html`<label class="check"
              ><input
                type="checkbox"
                .checked=${node.value === null}
                @change=${(event: Event) =>
                  this.change({
                    ...node,
                    value: (event.target as HTMLInputElement).checked
                      ? null
                      : initialValue(field, 'equals'),
                  })}
              />Match an unset value</label
            >`
          : nothing}
      </div>
      ${typeof field !== 'string'
        ? html`${this.catalogs.length
              ? html`<pr-project-field-picker
                  .node=${node}
                  .catalogs=${this.catalogs}
                  .disabled=${this.disabled}
                  @comparison-change=${(event: CustomEvent<Comparison>) => {
                    event.stopPropagation();
                    this.change(event.detail);
                  }}
                ></pr-project-field-picker>`
              : nothing}
            <div class="grid">
              <label
                >Project ID<input
                  .value=${field.projectId}
                  placeholder="PVT_…"
                  @change=${(event: Event) =>
                    this.change({
                      ...node,
                      field: {
                        ...field,
                        projectId: (event.target as HTMLInputElement).value.trim(),
                      },
                    })}
              /></label>
              <label
                >Field ID<input
                  .value=${field.fieldId}
                  @change=${(event: Event) =>
                    this.change({
                      ...node,
                      field: { ...field, fieldId: (event.target as HTMLInputElement).value.trim() },
                    })}
              /></label>
              <label
                >Field type<choice-picker
                  .value=${field.valueType}
                  @change=${(event: Event) => {
                    const type = (['text', 'number', 'date', 'single-select'] as const).find(
                      (type) => type === (event.target as ChoicePicker).value,
                    )!;
                    const next = { ...field, valueType: type };
                    this.change({
                      ...node,
                      field: next,
                      operator: 'equals',
                      value: initialValue(next, 'equals'),
                    });
                  }}
                >
                  ${['text', 'number', 'date', 'single-select'].map(
                    (type) =>
                      html`<option .value=${type} .selected=${type === field.valueType}>
                        ${type}
                      </option>`,
                  )}
                </choice-picker></label
              >
            </div>
            <p class="muted">
              Single-select comparisons use option IDs, so renaming a board column does not change
              the rule.
            </p>`
        : nothing}`;
  }
  render() {
    const node = this.value;
    return html`<fieldset class="card" ?disabled=${this.disabled}>
      <div class="row" role="group" aria-label="Match conditions">
        ${(['compare', 'all', 'any', 'not'] as const).map(
          (kind) =>
            html`<button
              type="button"
              data-testid=${`pr-predicate-${kind}`}
              aria-pressed=${String(node.kind === kind)}
              ?disabled=${kind !== 'compare' && this.depth >= 8}
              @click=${() => {
                if (node.kind === kind) return;
                this.change(
                  kind === 'all' || kind === 'any'
                    ? { kind, items: [defaultPRPredicate()] }
                    : kind === 'not'
                      ? { kind, item: defaultPRPredicate() }
                      : defaultPRPredicate(),
                );
              }}
            >
              ${{
                compare: 'A condition',
                all: 'All conditions',
                any: 'Any condition',
                not: 'Not matching',
              }[kind]}
            </button>`,
        )}
      </div>
      ${node.kind === 'compare'
        ? this.comparison(node)
        : node.kind === 'not'
          ? this.child(node.item, (item) => this.change({ ...node, item }))
          : html` ${node.items.map(
                (item, index) =>
                  html`<div>
                    ${this.child(item, (value) =>
                      this.change({
                        ...node,
                        items: node.items.map((item, i) => (i === index ? value : item)),
                      }),
                    )}<button
                      type="button"
                      ?disabled=${node.items.length === 1}
                      @click=${() =>
                        this.change({ ...node, items: node.items.filter((_, i) => i !== index) })}
                    >
                      Remove condition
                    </button>
                  </div>`,
              )}
              <button
                type="button"
                ?disabled=${this.depth >= 8 || node.items.length >= 100}
                @click=${() =>
                  this.change({ ...node, items: [...node.items, defaultPRPredicate()] })}
              >
                Add condition
              </button>`}
    </fieldset>`;
  }
}
