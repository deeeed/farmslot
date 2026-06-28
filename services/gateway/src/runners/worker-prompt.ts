import path from 'node:path';

import { loadPromptTemplate } from '../core/prompt-templates.js';

const DEFAULT_PROMPT_PROJECT = 'farmslot-farm';
const WORKER_DISPATCH_TEMPLATE = 'worker-dispatch.md';
const WORKER_NUDGE_TEMPLATE = 'worker-nudge.md';

export type WorkerPromptVars = {
  taskFile: string;
  taskDir?: string;
};

function expandWorkerPromptVars({ taskFile, taskDir }: WorkerPromptVars): Record<string, string> {
  const resolvedTaskDir = taskDir ?? path.posix.dirname(taskFile.replace(/\\/g, '/'));
  return {
    TASK_FILE: taskFile,
    TASK_DIR: resolvedTaskDir,
    task_file: taskFile,
    task_dir: resolvedTaskDir,
  };
}

async function loadWorkerPromptTemplate(
  project: string,
  templateName: string,
  vars: Record<string, string>,
): Promise<string | null> {
  const projectTemplate = await loadPromptTemplate(project, templateName, vars);
  if (projectTemplate?.trim()) return projectTemplate.trim();
  if (project === DEFAULT_PROMPT_PROJECT) return null;
  const fallback = await loadPromptTemplate(DEFAULT_PROMPT_PROJECT, templateName, vars);
  return fallback?.trim() ?? null;
}

export async function resolveWorkerDispatchPrompt(
  project: string,
  vars: WorkerPromptVars,
): Promise<string> {
  const expandedVars = expandWorkerPromptVars(vars);
  const template = await loadWorkerPromptTemplate(
    project,
    WORKER_DISPATCH_TEMPLATE,
    expandedVars,
  );
  if (!template) {
    throw new Error(
      `Missing worker dispatch prompt template for project '${project}' ` +
        `(expected projects/${project}/templates/prompts/${WORKER_DISPATCH_TEMPLATE}, ` +
        `or canonical projects/${DEFAULT_PROMPT_PROJECT}/templates/prompts/${WORKER_DISPATCH_TEMPLATE})`,
    );
  }
  return template;
}

export async function resolveWorkerNudgePrompt(
  project: string,
  vars: WorkerPromptVars,
): Promise<string> {
  const expandedVars = expandWorkerPromptVars(vars);
  const template = await loadWorkerPromptTemplate(project, WORKER_NUDGE_TEMPLATE, expandedVars);
  if (!template) {
    throw new Error(
      `Missing worker nudge prompt template for project '${project}' ` +
        `(expected projects/${project}/templates/prompts/${WORKER_NUDGE_TEMPLATE}, ` +
        `or canonical projects/${DEFAULT_PROMPT_PROJECT}/templates/prompts/${WORKER_NUDGE_TEMPLATE})`,
    );
  }
  return template;
}