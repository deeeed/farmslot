import type {
  WorkInventoryColumnDef,
  WorkInventoryLayoutState,
  WorkInventorySortDirection,
  WorkInventorySortState,
} from './work-inventory-types.js';

export function compareInventoryValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * Sort rows by a surface-provided value extractor. Stable secondary order uses
 * `tieBreak` (typically a stable row id or source ref).
 */
export function sortInventoryRows<T>(
  rows: readonly T[],
  getValue: (row: T) => string | number | null | undefined,
  direction: WorkInventorySortDirection,
  tieBreak: (row: T) => string,
): T[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary = compareInventoryValues(getValue(a), getValue(b));
    if (primary !== 0) return primary * multiplier;
    return tieBreak(a).localeCompare(tieBreak(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

/**
 * Toggle sort when the operator clicks a header. Re-clicking the active key
 * flips direction; a new key uses `defaultDirectionForKey`.
 */
export function nextSortState<TSortKey extends string>(
  current: WorkInventorySortState<TSortKey>,
  key: TSortKey,
  defaultDirectionForKey: (key: TSortKey) => WorkInventorySortDirection = () => 'asc',
): WorkInventorySortState<TSortKey> {
  if (current.key === key) {
    return {
      key,
      direction: current.direction === 'asc' ? 'desc' : 'asc',
    };
  }
  return { key, direction: defaultDirectionForKey(key) };
}

/** Build the CSS `grid-template-columns` value from column widths. */
export function inventoryGridTemplateColumns(
  columns: readonly WorkInventoryColumnDef[],
  leadingTracks: readonly string[] = [],
): string {
  return [...leadingTracks, ...columns.map((column) => column.width)].join(' ');
}

/**
 * Resolve which row should appear selected. Optionally auto-select a single
 * remaining row (work-graph inventory) without dropping the list affordance.
 */
export function resolveSelectedRowId(
  rowIds: readonly string[],
  selectedId: string,
  options: { autoSelectSingle?: boolean } = {},
): string {
  if (selectedId && rowIds.includes(selectedId)) return selectedId;
  if (options.autoSelectSingle && rowIds.length === 1) return rowIds[0] ?? '';
  return '';
}

/** Enter/Space activate a focused inventory row (not pointer-only). */
export function isInventoryActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

/**
 * Wide layouts: inventory + optional detail side-by-side.
 * Narrow + selection: detail replaces inventory unless the operator chose Back
 * (`forceList`) or there is no selection.
 */
export function inventoryShowsList(layout: WorkInventoryLayoutState): boolean {
  if (!layout.hasSelection) return true;
  if (!layout.narrowViewport) return true;
  return Boolean(layout.forceList);
}

export function inventoryShowsDetail(layout: WorkInventoryLayoutState): boolean {
  if (!layout.hasSelection) return false;
  if (!layout.narrowViewport) return true;
  return !layout.forceList;
}

/** Whether the narrow-screen Back control should be visible. */
export function inventoryShowsBackAffordance(layout: WorkInventoryLayoutState): boolean {
  return layout.hasSelection && layout.narrowViewport && !layout.forceList;
}

/**
 * Whether a single-graph (or single-row) auto-selection still needs a visible
 * table/back affordance so the inventory remains the canonical browsing state.
 */
