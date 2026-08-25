import path from 'node:path';

import {
  type ExecutionTemplateEntry,
  executionTemplateEntryParticipates,
  executionTemplateReference,
  ExecutionTemplateSelectionError,
  type ExecutionTemplateSource,
  executionTemplateSourceDirty,
  executionTemplateSourceParticipates,
  executionTemplateSourceRevision,
  listCompatibleExecutionTemplates,
  listExecutionTemplates,
  projectWorkerTemplateSource,
  readExecutionTemplateSnapshot,
  resolveConfiguredExecutionTemplateSources,
  type SelectedExecutionTemplate,
  selectExecutionTemplate,
} from '@farmslot/agent-runtime';
import {
  EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX,
  type ExecutionTemplateCatalogOption,
  type ExecutionTemplateOptions,
  type ExecutionTemplateRunMode,
} from '@farmslot/protocol';
import { resolveEffectiveDomain } from '@farmslot/slot-config';

import type { ProjectVars } from '../core/config.js';

export interface ExecutionTemplateCatalogQuery {
  flow?: string;
  platform?: string;
  runMode?: ExecutionTemplateRunMode;
  domain?: string;
  explicitId?: string;
  /** Include domain-restricted sources and skip flow/mode/platform/domain filters. */
  unfiltered?: boolean;
}

export interface ResolvedConfiguredExecutionTemplate extends SelectedExecutionTemplate {
  markdown: string;
}

export interface ResolvedSlotExecutionTemplate extends ResolvedConfiguredExecutionTemplate {
  effectiveDomain?: string;
}

export interface ConfiguredExecutionTemplateSnapshot {
  entry: ExecutionTemplateEntry;
  markdown: string;
}

function projectPackRoot(projectVars: ProjectVars): string {
  return path.dirname(projectVars.projectConfig);
}

function configuredCatalog(projectVars: ProjectVars): {
  sources: ExecutionTemplateSource[];
  unavailable: ExecutionTemplateOptions['unavailableSources'];
} {
  const root = projectPackRoot(projectVars);
  const configured = resolveConfiguredExecutionTemplateSources(
    projectVars.projectJson.execution_templates,
    { projectPackRoot: root },
  );
  return {
    sources: [
      projectWorkerTemplateSource(
        projectVars.projectName,
        projectVars.projectTemplatesDir,
        executionTemplateSourceRevision(root),
        executionTemplateSourceDirty(root),
      ),
      ...configured.sources,
    ],
    unavailable: configured.unavailable,
  };
}

function domainFilteredSources(
  sources: ExecutionTemplateSource[],
  query: ExecutionTemplateCatalogQuery,
): ExecutionTemplateOptions['filteredSources'] {
  const enablingBySource = new Map<string, Set<string>>();
  const participating: ExecutionTemplateSource[] = [];
  for (const source of sources) {
    if (executionTemplateSourceParticipates(source, query.domain)) {
      participating.push(source);
    } else {
      enablingBySource.set(source.id, new Set(source.domains ?? []));
    }
  }
  // Entry-label gates inside participating sources hide templates just as
  // silently as a dropped source; report them under their source id too.
  const relevant = listExecutionTemplates({
    sources: participating,
    flow: query.flow,
    includeShadowed: false,
    ...(query.platform ? { platform: query.platform } : {}),
    ...(query.runMode ? { runMode: query.runMode } : {}),
  });
  for (const entry of relevant) {
    if (executionTemplateEntryParticipates(entry, query.domain)) continue;
    const entryDomains = entry.labels
      .filter((label) => label.startsWith(EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX))
      .map((label) => label.slice(EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX.length));
    // Same intersection rule as the explicit-id diagnostic in select.ts: when
    // the source also declares domains, only domains passing BOTH gates may be
    // advertised — an empty intersection is an unreachable authoring error.
    const source = sources.find((candidate) => candidate.id === entry.sourceId);
    const advertised =
      source?.domains && source.domains.length > 0
        ? entryDomains.filter((domain) => source.domains!.includes(domain))
        : entryDomains;
    if (advertised.length === 0) continue;
    const domains = enablingBySource.get(entry.sourceId) ?? new Set<string>();
    for (const domain of advertised) domains.add(domain);
    enablingBySource.set(entry.sourceId, domains);
  }
  return [...enablingBySource.entries()]
    .filter(([, domains]) => domains.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, domains]) => ({
      id,
      reason: 'domain-restricted' as const,
      domains: [...domains].sort((a, b) => a.localeCompare(b)),
    }));
}

function catalogOption(
  entry: ExecutionTemplateEntry,
  source?: ExecutionTemplateSource,
): ExecutionTemplateCatalogOption {
  return {
    ...executionTemplateReference(entry),
    title: entry.title,
    ...(entry.description ? { description: entry.description } : {}),
    sourceKind: entry.sourceKind,
    ...(source?.domains && source.domains.length > 0 ? { sourceDomains: [...source.domains] } : {}),
    ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
  };
}

export function projectUsesExecutionTemplateCatalog(projectVars: ProjectVars): boolean {
  return projectVars.projectJson.execution_templates !== undefined;
}

export function availableExecutionTemplateDomains(projectVars: ProjectVars): string[] {
  const domains = new Set<string>();
  for (const domain of Object.keys(projectVars.projectJson.command_env?.domains ?? {})) {
    domains.add(domain);
  }
  for (const source of projectVars.projectJson.execution_templates?.sources ?? []) {
    for (const domain of source.domains ?? []) domains.add(domain);
  }
  for (const rule of projectVars.projectJson.execution_templates?.defaults ?? []) {
    if (rule.when.domain) domains.add(rule.when.domain);
  }
  return [...domains].sort((a, b) => a.localeCompare(b));
}

export function configuredExecutionTemplateOptions(
  projectVars: ProjectVars,
  query: ExecutionTemplateCatalogQuery,
): ExecutionTemplateOptions {
  if (!projectUsesExecutionTemplateCatalog(projectVars)) {
    throw new Error(`Project "${projectVars.projectName}" has no execution-template catalog.`);
  }

  const { sources, unavailable } = configuredCatalog(projectVars);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const defaults = projectVars.projectJson.execution_templates?.defaults;
  const toOptions = (entries: ExecutionTemplateEntry[]): ExecutionTemplateCatalogOption[] =>
    entries.map((entry) => catalogOption(entry, sourceById.get(entry.sourceId)));

  if (query.unfiltered) {
    const listed = listExecutionTemplates({
      sources,
      includeShadowed: true,
      ...(query.flow ? { flow: query.flow } : {}),
    });
    return {
      configured: true,
      options: toOptions(listed),
      availableDomains: availableExecutionTemplateDomains(projectVars),
      unavailableSources: unavailable,
      filteredSources: [],
      ...(defaults && defaults.length > 0 ? { defaults } : {}),
    };
  }

  if (!query.flow) {
    throw new Error('Execution-template catalog queries require flow unless unfiltered.');
  }

  const flow = query.flow;
  const options =
    query.platform && query.runMode
      ? listCompatibleExecutionTemplates({
          sources,
          flow,
          platform: query.platform,
          runMode: query.runMode,
          ...(query.domain ? { domain: query.domain } : {}),
        })
      : listExecutionTemplates({
          sources: sources.filter((source) =>
            executionTemplateSourceParticipates(source, query.domain),
          ),
          flow,
          includeShadowed: false,
          ...(query.platform ? { platform: query.platform } : {}),
          ...(query.runMode ? { runMode: query.runMode } : {}),
        }).filter((entry) => executionTemplateEntryParticipates(entry, query.domain));

  let selected: SelectedExecutionTemplate | undefined;
  if (query.platform && query.runMode) {
    try {
      selected = selectExecutionTemplate({
        sources,
        flow,
        platform: query.platform,
        runMode: query.runMode,
        ...(query.domain ? { domain: query.domain } : {}),
        ...(query.explicitId ? { explicitId: query.explicitId } : {}),
        defaults,
      });
    } catch (error) {
      if (
        !(error instanceof ExecutionTemplateSelectionError) ||
        (error.code !== 'ambiguous' && error.code !== 'no-compatible-template')
      ) {
        throw error;
      }
      // Options remain useful when no implicit choice is possible; the caller
      // must select one of the returned exact ids.
    }
  }

  return {
    configured: true,
    options: toOptions(options),
    availableDomains: availableExecutionTemplateDomains(projectVars),
    ...(selected
      ? {
          selectedId: selected.entry.id,
          selectionReason: selected.reason,
        }
      : {}),
    unavailableSources: unavailable,
    filteredSources: domainFilteredSources(sources, { ...query, flow }),
    ...(defaults && defaults.length > 0 ? { defaults } : {}),
  };
}

export function resolveConfiguredExecutionTemplate(
  projectVars: ProjectVars,
  query: Required<Pick<ExecutionTemplateCatalogQuery, 'flow' | 'platform' | 'runMode'>> &
    Pick<ExecutionTemplateCatalogQuery, 'domain' | 'explicitId'>,
): ResolvedConfiguredExecutionTemplate {
  if (!projectUsesExecutionTemplateCatalog(projectVars)) {
    throw new Error(`Project "${projectVars.projectName}" has no execution-template catalog.`);
  }
  const { sources } = configuredCatalog(projectVars);
  const selected = selectExecutionTemplate({
    sources,
    flow: query.flow,
    platform: query.platform,
    runMode: query.runMode,
    ...(query.domain ? { domain: query.domain } : {}),
    ...(query.explicitId ? { explicitId: query.explicitId } : {}),
    defaults: projectVars.projectJson.execution_templates?.defaults,
  });
  const snapshot = readExecutionTemplateSnapshot(selected.entry);
  return { ...selected, markdown: snapshot.markdown };
}

export function readConfiguredExecutionTemplateSnapshot(
  projectVars: ProjectVars,
  query: Pick<ExecutionTemplateCatalogQuery, 'flow'> & {
    id: string;
    sourceId: string;
    sha256: string;
  },
): ConfiguredExecutionTemplateSnapshot {
  if (!projectUsesExecutionTemplateCatalog(projectVars)) {
    throw new Error(`Project "${projectVars.projectName}" has no execution-template catalog.`);
  }
  const { sources } = configuredCatalog(projectVars);
  const entry = listExecutionTemplates({
    sources,
    flow: query.flow,
    includeShadowed: true,
  }).find((candidate) => candidate.id === query.id && candidate.sourceId === query.sourceId);
  if (!entry) {
    throw new Error(
      `Execution template "${query.id}" from source "${query.sourceId}" is no longer available.`,
    );
  }
  if (entry.sha256 !== query.sha256) {
    throw new Error(
      `Execution template "${query.id}" changed after catalog resolution. Refresh the catalog and preview it again.`,
    );
  }
  return { entry, markdown: readExecutionTemplateSnapshot(entry).markdown };
}

export function resolveConfiguredExecutionTemplateForSlot(
  projectVars: ProjectVars,
  query: {
    flow: string;
    platform: string;
    runMode: ExecutionTemplateRunMode;
    explicitDomain?: string;
    slotDomain?: string;
    explicitId?: string;
  },
): ResolvedSlotExecutionTemplate {
  const effectiveDomain = resolveEffectiveDomain(query.explicitDomain, query.slotDomain);
  return {
    ...resolveConfiguredExecutionTemplate(projectVars, {
      flow: query.flow,
      platform: query.platform,
      runMode: query.runMode,
      ...(effectiveDomain ? { domain: effectiveDomain } : {}),
      ...(query.explicitId ? { explicitId: query.explicitId } : {}),
    }),
    ...(effectiveDomain ? { effectiveDomain } : {}),
  };
}
