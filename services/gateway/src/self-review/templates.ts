import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TASK_DIR, type ReviewValidationDepth } from '@farmslot/protocol';

import {
  getOrchestratorTaskRoot,
  loadProjectVars,
  loadSlotVars,
  resolveProjectRuntimeDir,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
} from '../core/config.js';
import { getRun } from '../runs/store.js';

interface SelfReviewConfig {
  enabled: boolean;
  runner?: string;
  model?: string;
  max_retries?: number;
  review_timeout_min?: number;
}

export async function expandSelfReviewTemplate(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  taskDir: string,
  runId: string,
  validationDepth: ReviewValidationDepth,
): Promise<string> {
  // Read template from project
  const run = getRun(runId);
  const project = run?.project;
  if (!project)
    throw new Error(`Cannot expand self-review template without a project for run ${runId}`);

  let template: string;
  try {
    const { farmslotRoot } = await import('../fleet/state.js');
    const templateDir = path.join(farmslotRoot, 'projects', project, 'templates', 'worker');
    const depthTemplatePath = path.join(templateDir, `self-review.${validationDepth}.md`);
    const fallbackTemplatePath = path.join(templateDir, 'self-review.md');
    try {
      template = await readFile(depthTemplatePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new Error(`Failed to read ${depthTemplatePath}: ${(err as Error).message}`);
      }
      if (validationDepth === 'static-code') {
        throw new Error(
          `Static-code self-review template not found for project ${project}: ${depthTemplatePath}`,
        );
      }
      template = await readFile(fallbackTemplatePath, 'utf-8');
    }
  } catch (err) {
    throw new Error(
      `Self-review template not found for project ${project} (${validationDepth}): ${(err as Error).message}`,
    );
  }

  // Resolve runtimeDir and mobile reference repo path from project vars
  const runtimeDir = await resolveProjectRuntimeDir(project);
  let mobileRepo = '';
  try {
    const pv = await loadProjectVars(project);
    const parentDir = path.dirname(vars.remoteRepo);
    const refName = pv.projectJson.reference_repos?.mobile?.local_name;
    const candidates = refName
      ? [path.join(parentDir, refName), path.join(parentDir, refName.replace(/-ref$/, '-1'))]
      : [];
    for (const c of candidates) {
      if (existsSync(c)) {
        mobileRepo = c;
        break;
      }
    }
  } catch (err) {
    // Recoverable: runtimeDir defaults to '.agent', mobileRepo stays empty.
    console.warn(`[self-review] project vars fallback for ${project}: ${(err as Error).message}`);
  }

  // Expand {{VAR}} placeholders
  const { farmslotRoot } = await import('../fleet/state.js');
  const replacements: Record<string, string> = {
    TASK_DIR: taskDir,
    REPO: vars.remoteRepo,
    PLATFORM: vars.platform || 'ios',
    WATCHER_PORT: vars.resourceVars.port ?? '',
    CDP_PORT: vars.resourceVars.cdpPort ?? '',
    RUNTIME_DIR: runtimeDir,
    TICKET: run?.ticketOrPr ?? '',
    SESSION: vars.session,
    MOBILE_REPO: mobileRepo,
    VALIDATION_DEPTH: validationDepth,
    FARMSLOT_DIR: farmslotRoot,
    farmslot_dir: farmslotRoot,
  };

  let expanded = template;
  for (const [key, val] of Object.entries(replacements)) {
    expanded = expanded.replaceAll(`{{${key}}}`, val);
  }
  return expanded;
}

export async function getSelfReviewConfig(project: string): Promise<SelfReviewConfig> {
  try {
    const pv = await loadProjectVars(project).catch(() => null);
    if (!pv?.projectJson) return { enabled: false };
    const raw = pv.projectJson.self_review;
    if (raw && typeof raw === 'object') {
      return {
        enabled: raw.enabled === true,
        runner: raw.runner,
        model: raw.model,
        max_retries: raw.max_retries,
        review_timeout_min: raw.review_timeout_min,
      };
    }
  } catch (err) {
    // Config structure errors disable self-review for this project — a malformed
    // config should not crash the run pipeline.
    console.warn(
      `[self-review] config parse error for ${project}, disabling: ${(err as Error).message}`,
    );
  }
  return { enabled: false };
}

export async function resolveWorkerTaskDir(
  _vars: Awaited<ReturnType<typeof loadSlotVars>>,
  project: string,
  taskFile: string | null,
): Promise<string | null> {
  if (!taskFile) return null;
  const pv = await loadProjectVars(project).catch(() => null);
  const taskDirName = pv ? resolveProjectTaskDirName(pv.projectJson) : DEFAULT_TASK_DIR;

  const orchRoot = pv ? getOrchestratorTaskRoot(project, pv.projectJson) : null;
  const taskRelDir = orchRoot ? resolveTaskRelDir(taskFile, orchRoot) : null;
  if (!taskRelDir) return null;
  return `${taskDirName}/${taskRelDir}`;
}
