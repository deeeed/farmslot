import { existsSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_WORKER_TEMPLATE_BY_FLOW,
  type TaskTemplateSelection,
  type TaskTemplateSelectionSource,
  type WorkerTemplateOption,
} from '@farmslot/protocol';

export const PROJECT_WORKER_TEMPLATE_BY_FLOW = DEFAULT_WORKER_TEMPLATE_BY_FLOW;

const INTERACTIVE_PROJECT_WORKER_TEMPLATE_BY_FLOW: Record<string, string> = {
  'fix-bug': 'fix-bug-interactive.md',
  dev: 'dev-interactive.md',
  'pr-complete': 'pr-complete-interactive.md',
};

export interface ResolvedProjectWorkerTemplate extends WorkerTemplateOption {
  templatePath: string;
  content: string;
  selectionSource: TaskTemplateSelectionSource;
  selectionReason: string;
}

export function defaultProjectWorkerTemplateFileName(flow: string): string {
  return PROJECT_WORKER_TEMPLATE_BY_FLOW[flow] ?? `${flow}.md`;
}

export function parseProjectWorkerTemplateFileName(
  flow: string,
  fileName: string,
): { variant: string | null; isDefault: boolean } | null {
  if (path.basename(fileName) !== fileName || !fileName.endsWith('.md')) return null;
  const defaultFileName = defaultProjectWorkerTemplateFileName(flow);
  if (fileName === defaultFileName) return { variant: null, isDefault: true };
  const prefix = `${defaultFileName.replace(/\.md$/, '')}-`;
  if (!fileName.startsWith(prefix)) return null;
  const variant = fileName.slice(prefix.length, -'.md'.length).trim();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(variant)) return null;
  return { variant, isDefault: false };
}

function projectWorkerTemplateLabel(
  flow: string,
  fileName: string,
  variant: string | null,
  isDefault: boolean,
): string {
  if (isDefault) return `${flow} (default)`;
  return variant ? `${flow} · ${variant}` : fileName;
}

function projectWorkerTemplateOption(flow: string, fileName: string): WorkerTemplateOption | null {
  const parsed = parseProjectWorkerTemplateFileName(flow, fileName);
  if (!parsed) return null;
  return {
    flowType: flow as WorkerTemplateOption['flowType'],
    fileName,
    variant: parsed.variant,
    label: projectWorkerTemplateLabel(flow, fileName, parsed.variant, parsed.isDefault),
    isDefault: parsed.isDefault,
  };
}

export async function listProjectWorkerTemplateOptions(
  projectTemplatesDir: string,
  flow: string,
): Promise<WorkerTemplateOption[]> {
  const workerDir = path.join(projectTemplatesDir, 'worker');
  if (!existsSync(workerDir)) return [];
  const files = (await readdir(workerDir)).filter((file) => file.endsWith('.md'));
  return files
    .map((file) => projectWorkerTemplateOption(flow, file))
    .filter((option): option is WorkerTemplateOption => Boolean(option))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.fileName.localeCompare(b.fileName);
    });
}

export function normalizeProjectWorkerTemplateSelection(
  flow: string,
  selection: TaskTemplateSelection,
): TaskTemplateSelection {
  const fileName = path.basename(selection.fileName ?? '');
  if (!fileName || fileName !== selection.fileName || !fileName.endsWith('.md')) {
    throw new Error(
      `Invalid worker template selection for ${flow}: fileName must be a project-owned markdown basename`,
    );
  }
  const parsed = parseProjectWorkerTemplateFileName(flow, fileName);
  if (!parsed) {
    const defaultFileName = defaultProjectWorkerTemplateFileName(flow);
    throw new Error(
      `Invalid worker template selection for ${flow}: ${fileName} does not match ${defaultFileName} or ${defaultFileName.replace(/\.md$/, '')}-<variant>.md (lowercase variant, no trailing punctuation)`,
    );
  }
  if (selection.variant != null && selection.variant !== parsed.variant) {
    throw new Error(
      `Invalid worker template selection for ${flow}: variant ${selection.variant} does not match ${fileName}`,
    );
  }
  return { fileName, variant: parsed.variant };
}

export async function resolveProjectWorkerTemplate(
  projectTemplatesDir: string,
  flow: string,
  selection?: TaskTemplateSelection | null,
  source?: TaskTemplateSelectionSource,
  reason?: string,
): Promise<ResolvedProjectWorkerTemplate> {
  const selectionSource = source ?? (selection ? 'explicit' : 'default');
  const normalized = selection
    ? normalizeProjectWorkerTemplateSelection(flow, selection)
    : { fileName: defaultProjectWorkerTemplateFileName(flow), variant: null };
  const parsed = parseProjectWorkerTemplateFileName(flow, normalized.fileName);
  if (!parsed) {
    throw new Error(`Invalid worker template selection for ${flow}: ${normalized.fileName}`);
  }
  const templatePath = path.join(projectTemplatesDir, 'worker', normalized.fileName);
  if (!existsSync(templatePath)) {
    const prefix = selection ? 'selected ' : '';
    throw new Error(`${prefix}Worker template not found: ${templatePath}`);
  }
  return {
    flowType: flow as WorkerTemplateOption['flowType'],
    fileName: normalized.fileName,
    variant: parsed.variant,
    label: projectWorkerTemplateLabel(flow, normalized.fileName, parsed.variant, parsed.isDefault),
    isDefault: parsed.isDefault,
    templatePath,
    content: await readFile(templatePath, 'utf8'),
    selectionSource,
    selectionReason:
      reason ??
      (selectionSource === 'explicit'
        ? 'explicit taskTemplate selection'
        : 'default flow template selection'),
  };
}

export function domainProjectWorkerTemplateFileName(flow: string, domain: string): string | null {
  const defaultBase = defaultProjectWorkerTemplateFileName(flow).replace(/\.md$/, '');
  const fileName = `${defaultBase}-${domain}.md`;
  return parseProjectWorkerTemplateFileName(flow, fileName) ? fileName : null;
}

async function projectWorkerTemplateExists(
  projectTemplatesDir: string,
  fileName: string,
): Promise<boolean> {
  try {
    await access(path.join(projectTemplatesDir, 'worker', fileName));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

function interactiveSelectionSource(flow: string): TaskTemplateSelectionSource {
  if (flow === 'fix-bug') return 'implicit-interactive-fix-bug';
  if (flow === 'dev') return 'implicit-interactive-dev';
  return 'implicit-interactive-pr-complete';
}

export async function resolveProjectWorkerTemplateForRun(
  projectTemplatesDir: string,
  flow: string,
  mode?: 'interactive' | 'autonomous' | 'validation',
  selection?: TaskTemplateSelection | null,
  domain?: string,
): Promise<ResolvedProjectWorkerTemplate> {
  if (selection) return resolveProjectWorkerTemplate(projectTemplatesDir, flow, selection);

  const interactiveFileName =
    mode === 'interactive' ? INTERACTIVE_PROJECT_WORKER_TEMPLATE_BY_FLOW[flow] : undefined;
  if (
    interactiveFileName &&
    (await projectWorkerTemplateExists(projectTemplatesDir, interactiveFileName))
  ) {
    return resolveProjectWorkerTemplate(
      projectTemplatesDir,
      flow,
      { fileName: interactiveFileName },
      interactiveSelectionSource(flow),
      `${flow} interactive mode selected ${interactiveFileName} because it exists`,
    );
  }

  const domainFileName = domain ? domainProjectWorkerTemplateFileName(flow, domain) : null;
  if (domainFileName && (await projectWorkerTemplateExists(projectTemplatesDir, domainFileName))) {
    return resolveProjectWorkerTemplate(
      projectTemplatesDir,
      flow,
      { fileName: domainFileName },
      'implicit-domain',
      `domain '${domain}' selected ${domainFileName} because it exists`,
    );
  }

  return resolveProjectWorkerTemplate(
    projectTemplatesDir,
    flow,
    null,
    'default',
    interactiveFileName
      ? `${interactiveFileName} absent, using default ${flow} template`
      : undefined,
  );
}
