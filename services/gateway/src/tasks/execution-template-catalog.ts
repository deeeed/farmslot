import path from 'node:path';

import {
  type ExecutionTemplateEntry,
  executionTemplateReference,
  ExecutionTemplateSelectionError,
  type ExecutionTemplateSource,
  executionTemplateSourceDirty,
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
  flow: string;
  platform?: string;
  runMode?: ExecutionTemplateRunMode;
  domain?: string;
  explicitId?: string;
}

export interface ResolvedConfiguredExecutionTemplate extends SelectedExecutionTemplate {
  markdown: string;
}

export interface ResolvedSlotExecutionTemplate extends ResolvedConfiguredExecutionTemplate {
  effectiveDomain?: string;
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

function sourceParticipates(source: ExecutionTemplateSource, domain: string | undefined): boolean {
  return !source.domains || (domain !== undefined && source.domains.includes(domain));
}

function entryParticipates(entry: ExecutionTemplateEntry, domain: string | undefined): boolean {
  const domainLabels = entry.labels.filter((label) =>
    label.startsWith(EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX),
  );
  return (
    domainLabels.length === 0 ||
    (domain !== undefined &&
      domainLabels.includes(`${EXECUTION_TEMPLATE_DOMAIN_LABEL_PREFIX}${domain}`))
  );
}

function catalogOption(entry: ExecutionTemplateEntry): ExecutionTemplateCatalogOption {
  return {
    ...executionTemplateReference(entry),
    title: entry.title,
    sourceKind: entry.sourceKind,
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
  const options =
    query.platform && query.runMode
      ? listCompatibleExecutionTemplates({
          sources,
          flow: query.flow,
          platform: query.platform,
          runMode: query.runMode,
          ...(query.domain ? { domain: query.domain } : {}),
        })
      : listExecutionTemplates({
          sources: sources.filter((source) => sourceParticipates(source, query.domain)),
          flow: query.flow,
          includeShadowed: false,
          ...(query.platform ? { platform: query.platform } : {}),
          ...(query.runMode ? { runMode: query.runMode } : {}),
        }).filter((entry) => entryParticipates(entry, query.domain));

  let selected: SelectedExecutionTemplate | undefined;
  if (query.platform && query.runMode) {
    try {
      selected = selectExecutionTemplate({
        sources,
        flow: query.flow,
        platform: query.platform,
        runMode: query.runMode,
        ...(query.domain ? { domain: query.domain } : {}),
        ...(query.explicitId ? { explicitId: query.explicitId } : {}),
        defaults: projectVars.projectJson.execution_templates?.defaults,
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
    options: options.map(catalogOption),
    availableDomains: availableExecutionTemplateDomains(projectVars),
    ...(selected
      ? {
          selectedId: selected.entry.id,
          selectionReason: selected.reason,
        }
      : {}),
    unavailableSources: unavailable,
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
