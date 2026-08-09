// Pure view-model for the execution-template catalog picker. The gateway is
// the filtering/selection authority — this model only shapes what it returned
// (options, unavailable and domain-filtered sources) into rows, counts, and
// notices, so the picker can never invent compatibility the gateway didn't grant.
import type { ExecutionTemplateCatalogOption, ExecutionTemplateOptions } from '@farmslot/protocol';
import { EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX } from '@farmslot/protocol';

export interface ExecutionTemplatePickerFilters {
  /** Active domain filter; empty string means general (no domain). */
  domain: string;
  runMode: 'autonomous' | 'interactive';
}

export interface ExecutionTemplatePickerRow {
  option: ExecutionTemplateCatalogOption;
  /** Domain labels with the `domain:` prefix stripped. */
  domains: string[];
  selected: boolean;
  /** True when the gateway's implicit selection picked this row. */
  gatewayDefault: boolean;
}

export interface ExecutionTemplatePickerView {
  rows: ExecutionTemplatePickerRow[];
  resultCount: number;
  /** Human-readable active-filter description, always present (AC7/AC8). */
  activeFilterSummary: string;
  /** False when a non-empty selection no longer exists in the option set. */
  selectionValid: boolean;
  selectedRow: ExecutionTemplatePickerRow | null;
  /** Names the active filters when the catalog is empty (AC8). */
  emptyStateMessage: string | null;
  /** Unavailable roots + domain-filtered sources, never silently hidden (AC8). */
  sourceNotices: string[];
  /** Selection/default provenance line for the selected row (AC9). */
  selectionSummary: string | null;
}

export function optionDomains(option: ExecutionTemplateCatalogOption): string[] {
  return option.labels
    .filter((label) => label.startsWith(EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX))
    .map((label) => label.slice(EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX.length));
}

export function activeFilterSummary(filters: ExecutionTemplatePickerFilters): string {
  return `domain: ${filters.domain || 'general'} · mode: ${filters.runMode}`;
}

export function deriveExecutionTemplatePickerView(
  catalog: ExecutionTemplateOptions,
  selectedId: string,
  filters: ExecutionTemplatePickerFilters,
): ExecutionTemplatePickerView {
  const rows = catalog.options.map((option) => ({
    option,
    domains: optionDomains(option),
    selected: selectedId !== '' && option.id === selectedId,
    gatewayDefault: catalog.selectedId !== undefined && option.id === catalog.selectedId,
  }));
  const selectedRow = rows.find((row) => row.selected) ?? null;
  const selectionValid = selectedId === '' || selectedRow !== null;
  const summary = activeFilterSummary(filters);

  const sourceNotices = [
    ...catalog.unavailableSources.map((source) => `${source.id}: ${source.reason}`),
    // Older gateways omit filteredSources; absence means "nothing reported",
    // not an error.
    ...(catalog.filteredSources ?? []).map(
      (source) =>
        `${source.id}: ${source.reason} — select domain ${source.domains.join(' or ')} to include it`,
    ),
  ];

  const selectedForSummary = selectedRow ?? rows.find((row) => row.gatewayDefault) ?? null;
  const selectionSummary = selectedForSummary
    ? `${selectedForSummary.option.id} · ${selectedForSummary.option.sourceId}` +
      (selectedForSummary.selected
        ? selectedForSummary.gatewayDefault && catalog.selectionReason
          ? ` · ${catalog.selectionReason}`
          : ' · explicit'
        : ` · ${catalog.selectionReason ?? 'gateway default'}`)
    : null;

  return {
    rows,
    resultCount: rows.length,
    activeFilterSummary: summary,
    selectionValid,
    selectedRow,
    emptyStateMessage:
      rows.length === 0 ? `No compatible execution template for ${summary}.` : null,
    sourceNotices,
    selectionSummary,
  };
}
