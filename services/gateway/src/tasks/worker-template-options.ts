import {
  defaultProjectWorkerTemplateFileName,
  domainProjectWorkerTemplateFileName,
  listProjectWorkerTemplateOptions,
  normalizeProjectWorkerTemplateSelection,
  parseProjectWorkerTemplateFileName,
  PROJECT_WORKER_TEMPLATE_BY_FLOW,
  type ResolvedProjectWorkerTemplate,
  resolveProjectWorkerTemplate,
  resolveProjectWorkerTemplateForRun,
} from '@farmslot/agent-runtime';
import type {
  FlowType,
  TaskTemplateSelection,
  TaskTemplateSelectionSource,
  WorkerTemplateOption,
} from '@farmslot/protocol';

import type { ProjectVars } from '../core/config.js';

/**
 * ProjectVars-bound compatibility surface for existing gateway consumers.
 * Selection itself lives in @farmslot/agent-runtime.
 */
export const FLOW_TO_TEMPLATE = PROJECT_WORKER_TEMPLATE_BY_FLOW;
export const defaultTemplateFileNameForFlow = defaultProjectWorkerTemplateFileName;
export const domainTemplateFileNameForFlow = domainProjectWorkerTemplateFileName;
export const normalizeTaskTemplateSelection = normalizeProjectWorkerTemplateSelection;
export const parseWorkerTemplateFileName = parseProjectWorkerTemplateFileName;
export type ResolvedWorkerTemplateSelection = ResolvedProjectWorkerTemplate;

export function listWorkerTemplateOptions(
  projectVars: ProjectVars,
  flowType: FlowType,
): Promise<WorkerTemplateOption[]> {
  return listProjectWorkerTemplateOptions(projectVars.projectTemplatesDir, flowType);
}

export function resolveWorkerTemplateSelection(
  projectVars: ProjectVars,
  flowType: FlowType,
  selection?: TaskTemplateSelection | null,
  source?: TaskTemplateSelectionSource,
  reason?: string,
): Promise<ResolvedWorkerTemplateSelection> {
  return resolveProjectWorkerTemplate(
    projectVars.projectTemplatesDir,
    flowType,
    selection,
    source,
    reason,
  );
}

export function resolveWorkerTemplateSelectionForRun(
  projectVars: ProjectVars,
  flowType: FlowType,
  mode?: 'interactive' | 'autonomous' | 'validation',
  selection?: TaskTemplateSelection | null,
  domain?: string,
): Promise<ResolvedWorkerTemplateSelection> {
  return resolveProjectWorkerTemplateForRun(
    projectVars.projectTemplatesDir,
    flowType,
    mode,
    selection,
    domain,
  );
}
