import type { TemplateResult } from 'lit';

/** Shared sort direction for work inventory tables. */
export type WorkInventorySortDirection = 'asc' | 'desc';

export interface WorkInventorySortState<TSortKey extends string = string> {
  key: TSortKey;
  direction: WorkInventorySortDirection;
}

/**
 * Column descriptor for the domain-neutral inventory shell.
 * Surfaces map their protocol objects into columns; the shell never imports
 * Backlog, Roadmap, WorkGraph, or Run domain types.
 */
export interface WorkInventoryColumnDef<TSortKey extends string = string> {
  /** Stable column id; when sortable, also the sort key. */
  key: TSortKey;
  label: string;
  /** CSS grid track for this column (e.g. `minmax(120px, 1fr)`). */
  width: string;
  /** Default true. Non-sortable columns render a plain header label. */
  sortable?: boolean;
  /** Optional data-testid on the sort header button / label. */
  testId?: string;
}

export interface WorkInventoryRowRenderOptions {
  id: string;
  selected: boolean;
  disabled?: boolean;
  className?: string;
  testId?: string;
  onActivate: () => void;
}

export interface WorkInventoryUrlSortOptions<TSortKey extends string> {
  /** Hash query param for sort key. Default `sort`. Prefix per surface when routes collide. */
  sortParam?: string;
  /** Hash query param for direction. Default `direction`. */
  directionParam?: string;
  validKeys: readonly TSortKey[];
  defaultKey: TSortKey;
  defaultDirection?: WorkInventorySortDirection;
}

export interface WorkInventoryLayoutState {
  /** Whether a row is currently selected. */
  hasSelection: boolean;
  /**
   * When true, the viewport is narrow enough that inventory and detail cannot
   * sit side-by-side. Surfaces own the media-query; the shell only interprets.
   */
  narrowViewport: boolean;
  /**
   * When true on a narrow viewport with selection, show the inventory list
   * (back affordance) instead of the detail replacement.
   */
  forceList?: boolean;
}
