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

function isCompatible(
  entry: ExecutionTemplateEntry,
  options: SelectExecutionTemplateOptions,
): boolean {
  if (entry.shadowedBy) return false;
  if (entry.flow !== options.flow) return false;
  if (!entry.platforms.includes('*') && !entry.platforms.includes(options.platform)) return false;
  if (entry.runMode !== null && entry.runMode !== options.runMode) return false;

  const labels = domainLabels(entry);
  if (labels.length === 0) return true;
  return (
    options.domain !== undefined &&
    labels.includes(`${EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX}${options.domain}`)
  );
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
  const participatingSources = options.sources.filter(
    (source) =>
      !source.domains || (options.domain !== undefined && source.domains.includes(options.domain)),
  );
  return listExecutionTemplates({
    sources: participatingSources,
    includeShadowed: true,
  }).filter((entry) => isCompatible(entry, options));
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
