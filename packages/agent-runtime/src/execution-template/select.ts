import {
  EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX,
  type ExecutionTemplateDefaultMatch,
} from '@farmslot/protocol';

import { listExecutionTemplates } from './resolve.js';
import { executionTemplateReference } from './snapshot.js';
import {
  type ExecutionTemplateEntry,
  ExecutionTemplateSelectionError,
  type ListCompatibleExecutionTemplatesOptions,
  type SelectedExecutionTemplate,
  type SelectExecutionTemplateOptions,
} from './types.js';

function domainLabels(entry: ExecutionTemplateEntry): string[] {
  return entry.labels.filter((label) => label.startsWith(EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX));
}

/**
 * A source declaring `domains` participates only when the caller requests one
 * of them. Single authority for the domain gate — the gateway catalog reuses
 * this instead of keeping its own copy.
 */
export function executionTemplateSourceParticipates(
  source: SelectExecutionTemplateOptions['sources'][number],
  domain: string | undefined,
): boolean {
  return !source.domains || (domain !== undefined && source.domains.includes(domain));
}

/** Entry-level twin of {@link executionTemplateSourceParticipates}: an entry
 * carrying `domain:` labels participates only for a matching requested domain. */
export function executionTemplateEntryParticipates(
  entry: ExecutionTemplateEntry,
  domain: string | undefined,
): boolean {
  const labels = domainLabels(entry);
  if (labels.length === 0) return true;
  return (
    domain !== undefined && labels.includes(`${EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX}${domain}`)
  );
}

function isCompatible(
  entry: ExecutionTemplateEntry,
  options: SelectExecutionTemplateOptions,
): boolean {
  if (entry.shadowedBy) return false;
  if (entry.flow !== options.flow) return false;
  if (!entry.platforms.includes('*') && !entry.platforms.includes(options.platform)) return false;
  if (entry.runMode !== null && entry.runMode !== options.runMode) return false;
  return executionTemplateEntryParticipates(entry, options.domain);
}

function defaultMatches(
  when: ExecutionTemplateDefaultMatch,
  options: SelectExecutionTemplateOptions,
): boolean {
  return (
    (when.flow === undefined || when.flow === options.flow) &&
    (when.platform === undefined || when.platform === options.platform) &&
    (when.runMode === undefined || when.runMode === options.runMode) &&
    (when.domain === undefined || when.domain === options.domain)
  );
}

function compatibleIds(entries: ExecutionTemplateEntry[]): string {
  const ids = entries.map((entry) => entry.id).sort();
  return ids.length === 0 ? '(none)' : ids.join(', ');
}

function selected(
  entry: ExecutionTemplateEntry,
  reason: SelectedExecutionTemplate['reason'],
): SelectedExecutionTemplate {
  return { entry, reason, reference: executionTemplateReference(entry) };
}

export function listCompatibleExecutionTemplates(
  options: ListCompatibleExecutionTemplatesOptions,
): ExecutionTemplateEntry[] {
  const participatingSources = options.sources.filter((source) =>
    executionTemplateSourceParticipates(source, options.domain),
  );
  return listExecutionTemplates({
    sources: participatingSources,
    includeShadowed: true,
  }).filter((entry) => isCompatible(entry, options));
}

/**
 * Diagnose an explicit-id miss: templates whose id/flow/platform/runMode all
 * match but that were excluded solely by the domain gate (source `domains` or
 * entry `domain:` labels). Returns the domains that would make each selectable
 * so the selection error can name them instead of failing silently.
 */
function domainExcludedExplicitMatches(
  options: SelectExecutionTemplateOptions,
): { sourceId: string; domains: string[] }[] {
  if (!options.explicitId) return [];
  const matches: { sourceId: string; domains: string[] }[] = [];
  for (const entry of listExecutionTemplates({ sources: options.sources, includeShadowed: true })) {
    if (entry.id !== options.explicitId) continue;
    if (entry.flow !== options.flow) continue;
    if (!entry.platforms.includes('*') && !entry.platforms.includes(options.platform)) continue;
    if (entry.runMode !== null && entry.runMode !== options.runMode) continue;
    const source = options.sources.find((candidate) => candidate.id === entry.sourceId);
    const enabling = new Set<string>([
      ...(source?.domains ?? []),
      ...domainLabels(entry).map((label) =>
        label.slice(EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX.length),
      ),
    ]);
    if (enabling.size === 0) continue;
    if (options.domain !== undefined && enabling.has(options.domain)) continue;
    matches.push({ sourceId: entry.sourceId, domains: [...enabling].sort() });
  }
  return matches;
}

/**
 * Select one configured-catalog template. Source precedence has already
 * resolved duplicate ids; it never chooses between distinct compatible ids.
 */
export function selectExecutionTemplate(
  options: SelectExecutionTemplateOptions,
): SelectedExecutionTemplate {
  const compatible = listCompatibleExecutionTemplates(options);

  if (options.explicitId) {
    const explicit = compatible.find((entry) => entry.id === options.explicitId);
    if (!explicit) {
      const domainExcluded = domainExcludedExplicitMatches(options);
      if (domainExcluded.length > 0) {
        const detail = domainExcluded
          .map((match) => `${match.sourceId} (domain: ${match.domains.join(', ')})`)
          .join('; ');
        throw new ExecutionTemplateSelectionError(
          'missing-or-incompatible',
          `Execution template "${options.explicitId}" exists only in domain-restricted catalog entries: ${detail}. ` +
            `Pass one of those domains to select it. Compatible ids: ${compatibleIds(compatible)}.`,
        );
      }
      throw new ExecutionTemplateSelectionError(
        'missing-or-incompatible',
        `Execution template "${options.explicitId}" is missing or incompatible. Compatible ids: ${compatibleIds(compatible)}.`,
      );
    }
    return selected(explicit, 'explicit');
  }

  const matchingDefault = options.defaults?.find((rule) => defaultMatches(rule.when, options));
  if (matchingDefault) {
    const target = compatible.find((entry) => entry.id === matchingDefault.templateId);
    if (!target) {
      throw new ExecutionTemplateSelectionError(
        'missing-or-incompatible',
        `Configured execution-template default "${matchingDefault.templateId}" is missing or incompatible. Compatible ids: ${compatibleIds(compatible)}.`,
      );
    }
    return selected(target, 'configured-default');
  }

  const exactDomain = options.domain
    ? compatible.filter((entry) =>
        domainLabels(entry).includes(`${EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX}${options.domain}`),
      )
    : [];
  if (exactDomain.length === 1) return selected(exactDomain[0]!, 'single-domain-candidate');
  if (exactDomain.length > 1) {
    throw new ExecutionTemplateSelectionError(
      'ambiguous',
      `Execution-template selection is ambiguous for domain "${options.domain}". Choose one exact id: ${compatibleIds(exactDomain)}.`,
    );
  }

  const general = compatible.filter((entry) => domainLabels(entry).length === 0);
  if (general.length === 1) return selected(general[0]!, 'single-general-candidate');
  if (general.length === 0) {
    throw new ExecutionTemplateSelectionError(
      'no-compatible-template',
      'No compatible execution template exists for the requested inputs.',
    );
  }
  throw new ExecutionTemplateSelectionError(
    'ambiguous',
    `Execution-template selection is ambiguous. Choose one exact id: ${compatibleIds(general)}.`,
  );
}
