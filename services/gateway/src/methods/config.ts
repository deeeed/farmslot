// methods/config.ts — config.pools, config.pool, config.projects, config.project,
// config.templates, config.templatePreview, config.templateOptions, config.slot.update, config.pool.update

import { existsSync } from 'node:fs';
import { copyFile, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ConfigPoolParams,
  ConfigPoolRawResult,
  ConfigPoolResult,
  ConfigPoolsResult,
  ConfigPoolUpdateParams,
  ConfigPoolUpdateResult,
  ConfigProjectAutoRecoveryUpdateParams,
  ConfigProjectAutoRecoveryUpdateResult,
  ConfigProjectBacklogUpdateParams,
  ConfigProjectBacklogUpdateResult,
  ConfigProjectParams,
  ConfigProjectResult,
  ConfigProjectsResult,
  ConfigSlotUpdateParams,
  ConfigSlotUpdateResult,
  ConfigTemplateOptionsParams,
  ConfigTemplateOptionsResult,
  ConfigTemplatePreviewParams,
  ConfigTemplatePreviewResult,
  ConfigTemplatesParams,
  ConfigTemplatesResult,
  TemplatePreview,
} from '@farmslot/protocol';

import {
  invalidateProjectVarsCache,
  loadProjectVars,
  poolDir,
  projectsDir,
  resolveSlot,
  validateAutoRecoveryConfig,
  validateBacklogConfig,
} from '../core/config.js';
import { type RawPoolSlot, updateSlotStatus } from '../core/index.js';
import {
  loadFleetStatus,
  loadPoolConfig,
  loadPoolConfigs,
  loadProjectConfig,
  loadProjectConfigs,
} from '../fleet/state.js';
import { listWorkerTemplateOptions } from '../tasks/worker-template-options.js';
import { FLOW_TO_TEMPLATE, generateTaskSchema } from '../tasks/writer.js';

function extractPlaceholders(content: string): string[] {
  const matches = content.match(/\{\{(\w+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(2, -2)))];
}

function fileNameToFlowType(fileName: string): string {
  // Inverse of FLOW_TO_TEMPLATE
  for (const [flow, tmpl] of Object.entries(FLOW_TO_TEMPLATE)) {
    if (tmpl === fileName) return flow;
  }
  return fileName.replace(/\.md$/, '');
}

async function buildTemplatePreview(
  templatesDir: string,
  fileName: string,
): Promise<TemplatePreview> {
  const filePath = path.join(templatesDir, 'worker', fileName);
  const content = await readFile(filePath, 'utf-8');
  const flowType = fileNameToFlowType(fileName);
  const schema = generateTaskSchema(content, flowType);
  const placeholders = extractPlaceholders(content);
  return { flowType, fileName, schema, placeholders, rawMarkdown: content };
}

function isNodeFsError(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

async function readProjectLearnings(project: string): Promise<ConfigProjectResult['learnings']> {
  const relativePath = `projects/${project}/learnings/LEARNINGS.md`;
  const learningsPath = path.join(projectsDir, project, 'learnings', 'LEARNINGS.md');
  try {
    const [content, info] = await Promise.all([
      readFile(learningsPath, 'utf-8'),
      stat(learningsPath),
    ]);
    return {
      exists: true,
      relativePath,
      content,
      updatedAt: info.mtime.toISOString(),
      sizeBytes: info.size,
    };
  } catch (err) {
    if (isNodeFsError(err, 'ENOENT')) {
      return { exists: false, relativePath, content: '', updatedAt: null, sizeBytes: null };
    }
    throw err;
  }
}

// ─── Existing handlers ───

function normalizeBacklogUpdate(
  update: ConfigProjectBacklogUpdateParams['backlog'],
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (typeof update.autoDispatch?.enabled === 'boolean') {
    raw.auto_dispatch = {
      enabled: update.autoDispatch.enabled,
    };
  }
  return raw;
}

export async function configProjectBacklogUpdate(
  params: ConfigProjectBacklogUpdateParams,
): Promise<ConfigProjectBacklogUpdateResult> {
  const projectFilePath = path.join(projectsDir, params.project, 'project.json');
  if (!existsSync(projectFilePath)) throw new Error(`Project file not found: ${params.project}`);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(projectFilePath, 'utf-8'));
  } catch {
    throw new Error(`Invalid project JSON: ${params.project}`);
  }

  const projectName =
    typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : params.project;
  if (projectName !== params.project) {
    throw new Error(`Project name mismatch: expected "${params.project}", got "${projectName}"`);
  }

  const existingBacklog =
    raw.backlog && typeof raw.backlog === 'object' && !Array.isArray(raw.backlog)
      ? (raw.backlog as Record<string, unknown>)
      : {};
  const normalizedUpdate = normalizeBacklogUpdate(params.backlog);
  raw.backlog = {
    ...existingBacklog,
    ...normalizedUpdate,
    ...(existingBacklog.auto_dispatch || normalizedUpdate.auto_dispatch
      ? {
          auto_dispatch: {
            ...(existingBacklog.auto_dispatch &&
            typeof existingBacklog.auto_dispatch === 'object' &&
            !Array.isArray(existingBacklog.auto_dispatch)
              ? existingBacklog.auto_dispatch
              : {}),
            ...((normalizedUpdate.auto_dispatch as Record<string, unknown> | undefined) ?? {}),
          },
        }
      : {}),
  };

  validateBacklogConfig(raw, projectFilePath);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const backupPath = `${projectFilePath}.bak.${timestamp}`;
  await copyFile(projectFilePath, backupPath);
  await writeFile(projectFilePath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');

  invalidateProjectVarsCache(params.project);
  const project = await loadProjectConfig(params.project);
  if (!project) throw new Error(`Project not found after update: ${params.project}`);
  console.log(`[config] project ${params.project} backlog updated, backup: ${backupPath}`);
  return { ok: true, backup: backupPath, project };
}

export async function configPools(): Promise<ConfigPoolsResult> {
  const pools = await loadPoolConfigs();
  return { pools };
}

export async function configPool(params: ConfigPoolParams): Promise<ConfigPoolResult> {
  const pool = await loadPoolConfig(params.machine);
  if (!pool) throw new Error(`Pool not found: ${params.machine}`);
  return { pool };
}

export async function configProjects(): Promise<ConfigProjectsResult> {
  const projects = await loadProjectConfigs();
  return { projects };
}

export async function configProject(params: ConfigProjectParams): Promise<ConfigProjectResult> {
  const project = await loadProjectConfig(params.project);
  if (!project) throw new Error(`Project not found: ${params.project}`);
  return { project, learnings: await readProjectLearnings(params.project) };
}

// ─── Raw pool JSON for editor ───

export async function configPoolRaw(params: ConfigPoolParams): Promise<ConfigPoolRawResult> {
  const files = await readdir(poolDir);
  for (const file of files) {
    if (!file.endsWith('.json') || file === 'example.json') continue;
    const filePath = path.join(poolDir, file);
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed.machine === params.machine) {
        return { raw: content };
      }
    } catch {
      /* skip */
    }
  }
  throw new Error(`Pool file not found for machine: ${params.machine}`);
}

// ─── Template viewer (Phase 1) ───

export async function configTemplates(
  params: ConfigTemplatesParams,
): Promise<ConfigTemplatesResult> {
  const projectVars = await loadProjectVars(params.project);
  const workerDir = path.join(projectVars.projectTemplatesDir, 'worker');
  if (!existsSync(workerDir)) {
    return { templates: [] };
  }
  const files = await readdir(workerDir);
  const mdFiles = files.filter((f) => f.endsWith('.md')).sort();
  const templates = await Promise.all(
    mdFiles.map((f) => buildTemplatePreview(projectVars.projectTemplatesDir, f)),
  );
  return { templates };
}

export async function configTemplateOptions(
  params: ConfigTemplateOptionsParams,
): Promise<ConfigTemplateOptionsResult> {
  const projectVars = await loadProjectVars(params.project);
  return { options: await listWorkerTemplateOptions(projectVars, params.flowType) };
}

export async function configTemplatePreview(
  params: ConfigTemplatePreviewParams,
): Promise<ConfigTemplatePreviewResult> {
  const projectVars = await loadProjectVars(params.project);
  const fileName = FLOW_TO_TEMPLATE[params.flowType] ?? `${params.flowType}.md`;
  const filePath = path.join(projectVars.projectTemplatesDir, 'worker', fileName);
  if (!existsSync(filePath)) {
    throw new Error(`Template not found: ${fileName} for project ${params.project}`);
  }
  const template = await buildTemplatePreview(projectVars.projectTemplatesDir, fileName);
  return { template };
}

// Build the .farm-status.json fields to write when a slot's mode/enabled
// changes. Resets stale custom/disabled lifecycle when leaving those modes —
// otherwise dispatch validation stays blocked even after the pool is fixed.
function statusFieldsForModeChange(
  mode: string | undefined,
  enabled: boolean | undefined,
  prevLifecycle: string | undefined,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (enabled !== undefined) fields.enabled = enabled;
  if (mode !== undefined) {
    fields.mode = mode;
    if (mode === 'custom') {
      fields.lifecycle = 'manual';
      fields.phase = null;
    } else if (mode === 'disabled') {
      fields.lifecycle = 'disabled';
      fields.phase = null;
    } else if (
      prevLifecycle === 'custom' ||
      prevLifecycle === 'disabled' ||
      prevLifecycle === 'manual'
    ) {
      fields.lifecycle = 'ready';
      fields.phase = null;
    }
  }
  return fields;
}

// ─── Slot enable/disable (Phase 3) ───

export async function configSlotUpdate(
  params: ConfigSlotUpdateParams,
): Promise<ConfigSlotUpdateResult> {
  const { slotId, update } = params;

  // Check lifecycle — refuse for in-flight slots
  const fleet = await loadFleetStatus();
  const slotStatus = fleet.slots.find((s) => s.slot === slotId);
  if (slotStatus && slotStatus.lifecycle === 'busy') {
    throw new Error(
      `Cannot update slot ${slotId}: slot is busy (${slotStatus.phase ?? 'unknown'})`,
    );
  }

  // Find slot in pool JSON
  const resolved = await resolveSlot(slotId);
  const poolFilePath = resolved.poolFile;
  const raw = JSON.parse(await readFile(poolFilePath, 'utf-8'));
  const slotIdx = raw.slots.findIndex((s: { id: string }) => s.id === slotId);
  if (slotIdx === -1) throw new Error(`Slot ${slotId} not found in pool file`);

  // Apply updates
  if (update.enabled !== undefined) {
    raw.slots[slotIdx].enabled = update.enabled;
  }
  if (update.mode !== undefined) {
    raw.slots[slotIdx].mode = update.mode;
  }

  // Backup + write
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const backupPath = `${poolFilePath}.bak.${timestamp}`;
  await copyFile(poolFilePath, backupPath);
  await writeFile(poolFilePath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');

  // Sync into .farm-status.json + cache now — server.ts also calls fleetRefresh()
  // after this returns, but that runs SSH/device health checks and can take 30s+,
  // long enough for a follow-up dispatch to read stale state and fail validation.
  const fields = statusFieldsForModeChange(update.mode, update.enabled, slotStatus?.lifecycle);
  if (Object.keys(fields).length > 0) {
    await updateSlotStatus(slotId, fields);
    await loadFleetStatus(true);
  }

  console.log(`[config] slot ${slotId} updated: ${JSON.stringify(update)}, backup: ${backupPath}`);
  return { ok: true };
}

// ─── Pool JSON editor (Phase 4) ───

export async function configPoolUpdate(
  params: ConfigPoolUpdateParams,
): Promise<ConfigPoolUpdateResult> {
  const { machine, content } = params;

  // Validate JSON
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid JSON');
  }

  // Structural validation
  if (parsed.machine !== machine) {
    throw new Error(`Machine name mismatch: expected "${machine}", got "${parsed.machine}"`);
  }
  if (!Array.isArray(parsed.slots) || parsed.slots.length === 0) {
    throw new Error('Pool must have a non-empty slots array');
  }
  for (const slot of parsed.slots) {
    if (!slot.id || !slot.repo || !slot.session) {
      throw new Error(`Slot missing required fields (id, repo, session): ${JSON.stringify(slot)}`);
    }
  }

  // Find pool file
  const files = await readdir(poolDir);
  let poolFilePath: string | null = null;
  for (const file of files) {
    if (!file.endsWith('.json') || file === 'example.json') continue;
    try {
      const existing = JSON.parse(await readFile(path.join(poolDir, file), 'utf-8'));
      if (existing.machine === machine) {
        poolFilePath = path.join(poolDir, file);
        break;
      }
    } catch {
      /* skip */
    }
  }
  if (!poolFilePath) throw new Error(`Pool file not found for machine: ${machine}`);

  // Backup + write
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const backupPath = `${poolFilePath}.bak.${timestamp}`;
  await copyFile(poolFilePath, backupPath);
  await writeFile(poolFilePath, content.endsWith('\n') ? content : content + '\n', 'utf-8');

  // Sync mode/enabled changes into .farm-status.json + cache now — see
  // configSlotUpdate above for why this is needed before fleetRefresh.
  const fleet = await loadFleetStatus();
  const prevSlots = new Map(fleet.slots.map((s) => [s.slot, s]));
  for (const slot of parsed.slots as RawPoolSlot[]) {
    const prev = prevSlots.get(slot.id);
    if (!prev) continue;
    const newMode = slot.mode ?? (slot.enabled === false ? 'disabled' : 'dispatch');
    const newEnabled = slot.enabled !== false;
    // Infer previous mode from fleet status lifecycle/enabled
    const prevMode = !prev.enabled
      ? 'disabled'
      : prev.lifecycle === 'manual'
        ? 'custom'
        : 'dispatch';
    if (prevMode === newMode && prev.enabled === newEnabled) continue;
    const fields = statusFieldsForModeChange(
      prevMode === newMode ? undefined : newMode,
      prev.enabled === newEnabled ? undefined : newEnabled,
      prev.lifecycle,
    );
    await updateSlotStatus(slot.id, fields);
  }
  await loadFleetStatus(true);

  console.log(`[config] pool ${machine} updated, backup: ${backupPath}`);
  return { ok: true, backup: backupPath };
}

function normalizeAutoRecoveryUpdate(
  update: ConfigProjectAutoRecoveryUpdateParams['autoRecovery'],
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (typeof update.enabled === 'boolean') raw.enabled = update.enabled;
  if (update.maxAttempts !== undefined) raw.maxAttempts = update.maxAttempts;
  if (update.allowedSteps !== undefined) raw.allowedSteps = update.allowedSteps;
  if (update.allowedCategories !== undefined) raw.allowedCategories = update.allowedCategories;
  if (update.disabledPatterns !== undefined) raw.disabled_patterns = update.disabledPatterns;
  if (update.llm !== undefined) {
    raw.llm = {
      ...(typeof update.llm.enabled === 'boolean' ? { enabled: update.llm.enabled } : {}),
      ...(update.llm.dailyUsdCap !== undefined ? { dailyUsdCap: update.llm.dailyUsdCap } : {}),
      ...(update.llm.timeoutMs !== undefined ? { timeoutMs: update.llm.timeoutMs } : {}),
    };
  }
  return raw;
}

export async function configProjectAutoRecoveryUpdate(
  params: ConfigProjectAutoRecoveryUpdateParams,
): Promise<ConfigProjectAutoRecoveryUpdateResult> {
  const projectFilePath = path.join(projectsDir, params.project, 'project.json');
  if (!existsSync(projectFilePath)) throw new Error(`Project file not found: ${params.project}`);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(projectFilePath, 'utf-8'));
  } catch {
    throw new Error(`Invalid project JSON: ${params.project}`);
  }

  const projectName =
    typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : params.project;
  if (projectName !== params.project) {
    throw new Error(`Project name mismatch: expected "${params.project}", got "${projectName}"`);
  }

  const existingAutoRecovery =
    raw.auto_recovery && typeof raw.auto_recovery === 'object' && !Array.isArray(raw.auto_recovery)
      ? (raw.auto_recovery as Record<string, unknown>)
      : {};
  const normalizedUpdate = normalizeAutoRecoveryUpdate(params.autoRecovery);
  raw.auto_recovery = {
    ...existingAutoRecovery,
    ...normalizedUpdate,
    ...(existingAutoRecovery.llm || normalizedUpdate.llm
      ? {
          llm: {
            ...(existingAutoRecovery.llm &&
            typeof existingAutoRecovery.llm === 'object' &&
            !Array.isArray(existingAutoRecovery.llm)
              ? existingAutoRecovery.llm
              : {}),
            ...(normalizedUpdate.llm ?? {}),
          },
        }
      : {}),
  };

  validateAutoRecoveryConfig(raw, projectFilePath);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const backupPath = `${projectFilePath}.bak.${timestamp}`;
  await copyFile(projectFilePath, backupPath);
  await writeFile(projectFilePath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');

  invalidateProjectVarsCache(params.project);
  const project = await loadProjectConfig(params.project);
  if (!project) throw new Error(`Project not found after update: ${params.project}`);
  console.log(`[config] project ${params.project} auto_recovery updated, backup: ${backupPath}`);
  return { ok: true, backup: backupPath, project };
}
