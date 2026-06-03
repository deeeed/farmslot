import { existsSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  FlowType,
  TaskTemplateSelection,
  TaskTemplateSelectionSource,
  WorkerTemplateOption,
} from '@farmslot/protocol';

import type { ProjectVars } from '../core/config.js';

export const FLOW_TO_TEMPLATE: Record<string, string> = {
  'fix-bug': 'fix-bug.md',
  'review-pr': 'review-pr.md',
  dev: 'dev.md',
  'pr-complete': 'pr-complete.md',
  'merge-main': 'merge-main.md',
};

export interface ResolvedWorkerTemplateSelection extends WorkerTemplateOption {
  templatePath: string;
  content: string;
  selectionSource: TaskTemplateSelectionSource;
  selectionReason: string;
}

export function defaultTemplateFileNameForFlow(flowType: string): string {
  return FLOW_TO_TEMPLATE[flowType] ?? `${flowType}.md`;
}

async function workerTemplateExists(projectVars: ProjectVars, fileName: string): Promise<boolean> {
  const templatePath = path.join(projectVars.projectTemplatesDir, 'worker', fileName);
  try {
    await access(templatePath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

export function parseWorkerTemplateFileName(
  flowType: FlowType | string,
  fileName: string,
): { variant: string | null; isDefault: boolean } | null {
  if (path.basename(fileName) !== fileName || !fileName.endsWith('.md')) return null;
  const defaultFileName = defaultTemplateFileNameForFlow(flowType);
  if (fileName === defaultFileName) return { variant: null, isDefault: true };
  const defaultBase = defaultFileName.replace(/\.md$/, '');
  const prefix = `${defaultBase}-`;
  if (!fileName.startsWith(prefix)) return null;
  const variant = fileName.slice(prefix.length, -'.md'.length).trim();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(variant)) return null;
  return { variant, isDefault: false };
}

function labelForOption(
  flowType: FlowType,
  fileName: string,
  variant: string | null,
  isDefault: boolean,
): string {
  if (isDefault) return `${flowType} (default)`;
  return variant ? `${flowType} · ${variant}` : fileName;
}

function toOption(flowType: FlowType, fileName: string): WorkerTemplateOption | null {
  const parsed = parseWorkerTemplateFileName(flowType, fileName);
  if (!parsed) return null;
  return {
    flowType,
    fileName,
    variant: parsed.variant,
    label: labelForOption(flowType, fileName, parsed.variant, parsed.isDefault),
    isDefault: parsed.isDefault,
  };
}

export async function listWorkerTemplateOptions(
  projectVars: ProjectVars,
  flowType: FlowType,
): Promise<WorkerTemplateOption[]> {
  const workerDir = path.join(projectVars.projectTemplatesDir, 'worker');
  if (!existsSync(workerDir)) return [];
  const files = (await readdir(workerDir)).filter((file) => file.endsWith('.md'));
  const options = files
    .map((file) => toOption(flowType, file))
    .filter((option): option is WorkerTemplateOption => Boolean(option));
  return options.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.fileName.localeCompare(b.fileName);
  });
}

export function normalizeTaskTemplateSelection(
  flowType: FlowType,
  selection: TaskTemplateSelection,
): TaskTemplateSelection {
  const fileName = path.basename(selection.fileName ?? '');
  if (!fileName || fileName !== selection.fileName || !fileName.endsWith('.md')) {
    throw new Error(
      `Invalid worker template selection for ${flowType}: fileName must be a project-owned markdown basename`,
    );
  }
  const parsed = parseWorkerTemplateFileName(flowType, fileName);
  if (!parsed) {
    throw new Error(
      `Invalid worker template selection for ${flowType}: ${fileName} does not match ${defaultTemplateFileNameForFlow(flowType)} or ${defaultTemplateFileNameForFlow(flowType).replace(/\.md$/, '')}-<variant>.md (lowercase variant, no trailing punctuation)`,
    );
  }
  if (selection.variant != null && selection.variant !== parsed.variant) {
    throw new Error(
      `Invalid worker template selection for ${flowType}: variant ${selection.variant} does not match ${fileName}`,
    );
  }
  return { fileName, variant: parsed.variant };
}

export async function resolveWorkerTemplateSelection(
  projectVars: ProjectVars,
  flowType: FlowType,
  selection?: TaskTemplateSelection | null,
  source?: TaskTemplateSelectionSource,
  reason?: string,
): Promise<ResolvedWorkerTemplateSelection> {
  const selectionSource = source ?? (selection ? 'explicit' : 'default');
  const normalized = selection
    ? normalizeTaskTemplateSelection(flowType, selection)
    : { fileName: defaultTemplateFileNameForFlow(flowType), variant: null };
  const parsed = parseWorkerTemplateFileName(flowType, normalized.fileName);
  if (!parsed) {
    throw new Error(`Invalid worker template selection for ${flowType}: ${normalized.fileName}`);
  }
  const templatePath = path.join(projectVars.projectTemplatesDir, 'worker', normalized.fileName);
  if (!existsSync(templatePath)) {
    const suffix = selection ? 'selected ' : '';
    throw new Error(`${suffix}Worker template not found: ${templatePath}`);
  }
  const content = await readFile(templatePath, 'utf-8');
  return {
    flowType,
    fileName: normalized.fileName,
    variant: parsed.variant,
    label: labelForOption(flowType, normalized.fileName, parsed.variant, parsed.isDefault),
    isDefault: parsed.isDefault,
    templatePath,
    content,
    selectionSource,
    selectionReason:
      reason ??
      (selectionSource === 'explicit'
        ? 'explicit taskTemplate selection'
        : 'default flow template selection'),
  };
}

export async function resolveWorkerTemplateSelectionForRun(
  projectVars: ProjectVars,
  flowType: FlowType,
  mode?: 'interactive' | 'autonomous' | 'validation',
  selection?: TaskTemplateSelection | null,
): Promise<ResolvedWorkerTemplateSelection> {
  if (selection) return resolveWorkerTemplateSelection(projectVars, flowType, selection);
  if (flowType === 'dev' && mode === 'interactive') {
    const interactiveFileName = 'dev-interactive.md';
    if (await workerTemplateExists(projectVars, interactiveFileName)) {
      return resolveWorkerTemplateSelection(
        projectVars,
        flowType,
        { fileName: interactiveFileName },
        'implicit-interactive-dev',
        'dev interactive mode selected dev-interactive.md because it exists',
      );
    }
  }
  const fallbackReason =
    flowType === 'dev' && mode === 'interactive'
      ? 'dev-interactive.md absent, using default dev template'
      : undefined;
  return resolveWorkerTemplateSelection(projectVars, flowType, null, 'default', fallbackReason);
}
