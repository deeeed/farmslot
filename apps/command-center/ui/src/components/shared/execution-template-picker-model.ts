// Pure view-model for the execution-template catalog picker. The gateway
// supplies the catalog (a full snapshot when the client asked for unfiltered).
// This model filters that snapshot locally so farm/flow/domain/mode switches
// do not refetch. Dispatch still validates the chosen source and digest.
import type {
  DomainRestrictedExecutionTemplateSource,
  ExecutionTemplateCatalogOption,
  ExecutionTemplateDefault,
  ExecutionTemplateOptions,
} from '@farmslot/protocol';
import { EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX } from '@farmslot/protocol';

export interface ExecutionTemplatePickerFilters {
  /** Active domain filter; empty string means general (no domain). */
  domain: string;
  runMode: 'autonomous' | 'interactive';
  /** When set, hide templates for other flows. */
  flow?: string;
  /** When set, hide templates that do not list this platform or `*`. */
  platform?: string;
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

export function optionMatchesPickerFilters(
  option: ExecutionTemplateCatalogOption,
  filters: ExecutionTemplatePickerFilters,
): boolean {
  if (filters.flow && option.flow !== filters.flow) return false;
  if (option.runMode != null && option.runMode !== filters.runMode) return false;
  if (
    filters.platform &&
    !option.platforms.includes('*') &&
    !option.platforms.includes(filters.platform)
  ) {
    return false;
  }
  if (option.sourceDomains && option.sourceDomains.length > 0) {
    if (!filters.domain || !option.sourceDomains.includes(filters.domain)) return false;
  }
  const domains = optionDomains(option);
  if (domains.length > 0) {
    if (!filters.domain || !domains.includes(filters.domain)) return false;
  }
  return true;
}

function advertisedDomainsForOption(option: ExecutionTemplateCatalogOption): string[] {
  const entryDomains = optionDomains(option);
  if (option.sourceDomains && option.sourceDomains.length > 0) {
    return entryDomains.length > 0
      ? entryDomains.filter((domain) => option.sourceDomains!.includes(domain))
      : [...option.sourceDomains];
  }
  return entryDomains;
}

export function localDomainRestrictedSources(
  options: readonly ExecutionTemplateCatalogOption[],
  filters: ExecutionTemplatePickerFilters,
): DomainRestrictedExecutionTemplateSource[] {
  const bySource = new Map<string, Set<string>>();
  for (const option of options) {
    if (filters.flow && option.flow !== filters.flow) continue;
    if (option.runMode != null && option.runMode !== filters.runMode) continue;
    if (
      filters.platform &&
      !option.platforms.includes('*') &&
      !option.platforms.includes(filters.platform)
    ) {
      continue;
    }
    if (optionMatchesPickerFilters(option, filters)) continue;
    const advertised = advertisedDomainsForOption(option);
    if (advertised.length === 0) continue;
    const domains = bySource.get(option.sourceId) ?? new Set<string>();
    for (const domain of advertised) domains.add(domain);
    bySource.set(option.sourceId, domains);
  }
  return [...bySource.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, domains]) => ({
      id,
      reason: 'domain-restricted' as const,
      domains: [...domains].sort((a, b) => a.localeCompare(b)),
    }));
}

export function pickCompatibleExecutionTemplateId(input: {
  options: readonly ExecutionTemplateCatalogOption[];
  defaults?: readonly ExecutionTemplateDefault[];
  flow: string;
  runMode: 'autonomous' | 'interactive';
  domain: string;
  platform?: string;
  preferredId?: string;
}): string {
  if (input.preferredId && input.options.some((option) => option.id === input.preferredId)) {
    return input.preferredId;
  }
  const domain = input.domain || undefined;
  const matchingDefault = (input.defaults ?? []).find(
    (rule) =>
      (rule.when.flow === undefined || rule.when.flow === input.flow) &&
      (rule.when.runMode === undefined || rule.when.runMode === input.runMode) &&
      (rule.when.domain === undefined || rule.when.domain === domain) &&
      (rule.when.platform === undefined || rule.when.platform === input.platform),
  );
  if (matchingDefault && input.options.some((option) => option.id === matchingDefault.templateId)) {
    return matchingDefault.templateId;
  }
  const exactDomain = domain
    ? input.options.filter((option) => optionDomains(option).includes(domain))
    : [];
  if (exactDomain.length === 1) return exactDomain[0]?.id ?? '';
  const general = input.options.filter((option) => optionDomains(option).length === 0);
  if (general.length === 1) return general[0]?.id ?? '';
  return input.options.length === 1 ? (input.options[0]?.id ?? '') : '';
}

export function deriveExecutionTemplatePickerView(
  catalog: ExecutionTemplateOptions,
  selectedId: string,
  filters: ExecutionTemplatePickerFilters,
): ExecutionTemplatePickerView {
  const matched = catalog.options.filter((option) => optionMatchesPickerFilters(option, filters));
  const unshadowedIds = new Set(
    matched.filter((option) => !option.shadowedBy).map((option) => option.id),
  );
  const visible = matched.filter((option) => !option.shadowedBy || !unshadowedIds.has(option.id));
  const rows = visible.map((option) => ({
    option,
    domains: optionDomains(option),
    selected: selectedId !== '' && option.id === selectedId,
    gatewayDefault: catalog.selectedId !== undefined && option.id === catalog.selectedId,
  }));
  const selectedRow = rows.find((row) => row.selected) ?? null;
  const selectionValid = selectedId === '' || selectedRow !== null;
  const summary = activeFilterSummary(filters);
  const localRestricted = localDomainRestrictedSources(catalog.options, filters);
  const restrictedSources =
    localRestricted.length > 0 ? localRestricted : (catalog.filteredSources ?? []);

  const sourceNotices = [
    ...catalog.unavailableSources.map((source) => `${source.id}: ${source.reason}`),
    ...restrictedSources.map(
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
