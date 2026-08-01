import { html, nothing, type TemplateResult } from 'lit';

import {
  inventoryGridTemplateColumns,
  isInventoryActivationKey,
} from './work-inventory-table-model.js';
import type {
  WorkInventoryColumnDef,
  WorkInventoryRowRenderOptions,
  WorkInventorySortDirection,
  WorkInventorySortState,
} from './work-inventory-types.js';

export * from './work-inventory-table-model.js';
export { workInventoryTableStyles } from './work-inventory-table-styles.js';
export * from './work-inventory-types.js';
export * from './work-inventory-url-state.js';

function sortArrow(direction: WorkInventorySortDirection): string {
  return direction === 'asc' ? ' ↑' : ' ↓';
}

export function renderWorkInventorySortHeader<TSortKey extends string>(options: {
  label: string;
  columnKey: TSortKey;
  sort: WorkInventorySortState<TSortKey>;
  testId?: string;
  onSort: (key: TSortKey) => void;
}): TemplateResult {
  const active = options.sort.key === options.columnKey;
  const arrow = active ? sortArrow(options.sort.direction) : '';
  const ariaSort = active
    ? options.sort.direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  return html`<button
    class=${active ? 'active' : ''}
    type="button"
    data-testid=${options.testId ?? `work-inventory-sort-${options.columnKey}`}
    aria-sort=${ariaSort}
    @click=${() => options.onSort(options.columnKey)}
  >
    ${options.label}${arrow}
  </button>`;
}

export function renderWorkInventoryTableHead<TSortKey extends string>(options: {
  columns: readonly WorkInventoryColumnDef<TSortKey>[];
  sort: WorkInventorySortState<TSortKey>;
  onSort: (key: TSortKey) => void;
  leadingCells?: TemplateResult | typeof nothing;
  testIdPrefix?: string;
}): TemplateResult {
  const prefix = options.testIdPrefix ?? 'work-inventory';
  return html`<div
    class="work-inventory-head table-head"
    role="row"
    data-testid=${`${prefix}-head`}
  >
    ${options.leadingCells ?? nothing}
    ${options.columns.map((column) => {
      if (column.sortable === false) {
        return html`<span class="col-label" data-testid=${column.testId ?? nothing}
          >${column.label}</span
        >`;
      }
      return renderWorkInventorySortHeader({
        label: column.label,
        columnKey: column.key,
        sort: options.sort,
        testId: column.testId ?? `${prefix}-sort-${column.key}`,
        onSort: options.onSort,
      });
    })}
  </div>`;
}

export function renderWorkInventoryRow(options: {
  row: WorkInventoryRowRenderOptions;
  cells: TemplateResult | Array<TemplateResult | typeof nothing | string>;
}): TemplateResult {
  const { row, cells } = options;
  const className = [
    'work-inventory-row',
    'compact-row',
    row.selected ? 'selected' : '',
    row.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return html`<div
    class=${className}
    role="button"
    tabindex=${row.disabled ? -1 : 0}
    data-testid=${row.testId ?? `work-inventory-row-${row.id}`}
    data-row-id=${row.id}
    aria-pressed=${row.selected ? 'true' : 'false'}
    @click=${() => {
      if (!row.disabled) row.onActivate();
    }}
    @keydown=${(event: KeyboardEvent) => {
      if (row.disabled) return;
      if (isInventoryActivationKey(event.key)) {
        event.preventDefault();
        row.onActivate();
      }
    }}
  >
    ${cells}
  </div>`;
}

export function renderWorkInventoryTable(options: {
  columns: readonly WorkInventoryColumnDef[];
  head: TemplateResult;
  rows: TemplateResult | TemplateResult[];
  empty?: TemplateResult | typeof nothing;
  isEmpty?: boolean;
  testId?: string;
  leadingTracks?: readonly string[];
  minWidth?: string;
}): TemplateResult {
  const columnsStyle = inventoryGridTemplateColumns(options.columns, options.leadingTracks);
  const minWidth = options.minWidth ?? '720px';
  return html`<div
    class="work-inventory-scroll"
    data-testid=${options.testId ?? 'work-inventory-table'}
  >
    <div
      class="work-inventory-table"
      style=${`--work-inventory-columns:${columnsStyle}; min-width:${minWidth}`}
    >
      ${options.head}
      ${options.isEmpty
        ? html`<div class="work-inventory-empty">
            ${options.empty ?? html`No items match this view.`}
          </div>`
        : options.rows}
    </div>
  </div>`;
}

export function renderWorkInventoryBackButton(options: {
  label?: string;
  testId?: string;
  onBack: () => void;
}): TemplateResult {
  return html`<button
    type="button"
    class="work-inventory-back"
    data-testid=${options.testId ?? 'work-inventory-back'}
    @click=${options.onBack}
  >
    ${options.label ?? '← Back to list'}
  </button>`;
}

export function renderWorkInventoryLayout(options: {
  list: TemplateResult | typeof nothing;
  detail: TemplateResult | typeof nothing;
  showList: boolean;
  showDetail: boolean;
  testId?: string;
}): TemplateResult {
  const mode =
    options.showList && options.showDetail
      ? 'split'
      : options.showDetail
        ? 'detail-only'
        : 'list-only';
  // Always mount list + detail slots. Hiding with CSS (not unmounting) keeps
  // list scrollTop and DOM selection state across narrow detail ↔ Back.
  return html`<div
    class="work-inventory-layout ${mode}"
    data-testid=${options.testId ?? 'work-inventory-layout'}
    data-layout=${mode}
  >
    <div
      class="work-inventory-list-slot ${options.showList ? '' : 'is-visually-hidden'}"
      data-testid="work-inventory-list-slot"
      aria-hidden=${options.showList ? 'false' : 'true'}
      ?inert=${!options.showList}
    >
      ${options.list}
    </div>
    <div
      class="work-inventory-detail-slot ${options.showDetail ? '' : 'is-visually-hidden'}"
      data-testid="work-inventory-detail-slot"
      aria-hidden=${options.showDetail ? 'false' : 'true'}
      ?inert=${!options.showDetail}
    >
      ${options.detail}
    </div>
  </div>`;
}
