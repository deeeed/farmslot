// methods/slot-actions.ts — project-configured slot/resource shortcut actions

import { execFile } from 'node:child_process';

import type {
  SlotActionListParams,
  SlotActionListResult,
  SlotActionMode,
  SlotActionPlacement,
  SlotActionRefreshTarget,
  SlotActionRunParams,
  SlotActionRunResult,
  SlotActionStyle,
  SlotActionSummary,
} from '@farmslot/protocol';

import {
  loadProjectVars,
  loadSlotVars,
  type RawProjectJson,
  type RawSlotActionDefinition,
  resolveSlot,
} from '../core/config.js';
import { expandTemplate } from '../core/hooks.js';
import { getNode } from '../fleet/machine-registry.js';
import { getSlotLocality, sendNodeRequest } from '../fleet/node-rpc.js';
import {
  findUnresolvedPlaceholders,
  hasUnresolvedPlaceholders,
  pollSlotResources,
} from '../fleet/resource-manager.js';

const ACTION_ID_RE = /^[A-Za-z0-9._-]+$/;
const PLACEMENTS: SlotActionPlacement[] = ['slot-header', 'resource-panel'];
const STYLES: SlotActionStyle[] = ['primary', 'secondary', 'danger'];
const REFRESH_TARGETS: SlotActionRefreshTarget[] = ['resources', 'fleet', 'slot', 'none'];
const MODES: SlotActionMode[] = ['run', 'copy'];

interface ResolvedSlotAction {
  summary: SlotActionSummary;
  command: string;
  timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePlacement(
  value: unknown,
  fallback: SlotActionPlacement[],
): SlotActionPlacement[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value.filter((entry): entry is SlotActionPlacement =>
    PLACEMENTS.includes(entry as SlotActionPlacement),
  );
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeRefresh(
  value: unknown,
  fallback: SlotActionRefreshTarget[],
): SlotActionRefreshTarget[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value.filter((entry): entry is SlotActionRefreshTarget =>
    REFRESH_TARGETS.includes(entry as SlotActionRefreshTarget),
  );
  if (normalized.includes('none')) return ['none'];
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeStyle(value: unknown): SlotActionStyle {
  return STYLES.includes(value as SlotActionStyle) ? (value as SlotActionStyle) : 'secondary';
}

function normalizeMode(value: unknown): SlotActionMode {
  return MODES.includes(value as SlotActionMode) ? (value as SlotActionMode) : 'run';
}

function normalizeTimeoutMs(action: RawSlotActionDefinition): number {
  const raw = action.timeoutMs ?? action.timeout_ms;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

export function normalizeExecExitCode(code: unknown, signal?: unknown, errored = false): number {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (code === null || code === undefined) return signal || errored ? 1 : 0;
  return 1;
}

function normalizeAction(
  id: string,
  action: unknown,
  source: { resourceId?: string; defaultPlacement: SlotActionPlacement[] },
): ResolvedSlotAction | null {
  if (!ACTION_ID_RE.test(id) || !isRecord(action)) return null;
  const raw = action as unknown as RawSlotActionDefinition;
  if (typeof raw.label !== 'string' || raw.label.trim().length === 0) return null;
  if (typeof raw.command !== 'string' || raw.command.trim().length === 0) return null;

  const mode = normalizeMode(raw.mode);
  const summary: SlotActionSummary = {
    id: source.resourceId ? `resource:${source.resourceId}:${id}` : `slot:${id}`,
    label: raw.label.trim(),
    mode,
    style: normalizeStyle(raw.style),
    placement: normalizePlacement(raw.placement, source.defaultPlacement),
    refresh: normalizeRefresh(raw.refresh, mode === 'copy' ? ['none'] : ['resources']),
    ...(typeof raw.confirm === 'string' && raw.confirm.trim().length > 0
      ? { confirm: raw.confirm.trim() }
      : {}),
    ...(typeof raw.description === 'string' && raw.description.trim().length > 0
      ? { description: raw.description.trim() }
      : {}),
    ...(source.resourceId ? { resourceId: source.resourceId } : {}),
  };

  return {
    summary,
    command: raw.command,
    timeoutMs: normalizeTimeoutMs(raw),
  };
}

export function collectSlotActions(projectJson: RawProjectJson): ResolvedSlotAction[] {
  const actions: ResolvedSlotAction[] = [];

  for (const [id, action] of Object.entries(projectJson.slot_actions ?? {})) {
    const normalized = normalizeAction(id, action, { defaultPlacement: ['slot-header'] });
    if (normalized) actions.push(normalized);
  }

  for (const [resourceId, resource] of Object.entries(projectJson.resources ?? {})) {
    if (!ACTION_ID_RE.test(resourceId)) continue;
    for (const [id, action] of Object.entries(resource.actions ?? {})) {
      const normalized = normalizeAction(id, action, {
        resourceId,
        defaultPlacement: ['resource-panel'],
      });
      if (normalized) actions.push(normalized);
    }
  }

  return actions;
}

async function resolveProjectActions(slotId: string): Promise<ResolvedSlotAction[]> {
  const { pool, slot } = await resolveSlot(slotId);
  const projectName = slot.project ?? pool.project;
  const projectVars = await loadProjectVars(projectName);
  return collectSlotActions(projectVars.projectJson);
}

function actionMatchesPlacement(
  action: SlotActionSummary,
  placement?: SlotActionPlacement,
): boolean {
  return !placement || action.placement.includes(placement);
}

function findAction(actions: ResolvedSlotAction[], actionId: string): ResolvedSlotAction | null {
  return actions.find((action) => action.summary.id === actionId) ?? null;
}

async function executeExpandedCommand(
  slotId: string,
  command: string,
  timeoutMs: number,
): Promise<Omit<SlotActionRunResult, 'refresh'>> {
  const slotVars = await loadSlotVars(slotId);
  const { isLocal, machine } = await getSlotLocality(slotId);

  if (!isLocal) {
    const node = getNode(machine);
    if (!node) {
      return { ok: false, detail: `No node connected for ${machine}` };
    }
    const execResult = (await sendNodeRequest(
      node,
      'exec',
      {
        cmd: command,
        cwd: slotVars.remoteRepo,
        timeout: timeoutMs,
      },
      { timeout: timeoutMs },
    )) as { stdout: string; stderr: string; exitCode?: unknown; code?: unknown; signal?: unknown };
    const exitCode = normalizeExecExitCode(
      execResult.exitCode ?? execResult.code,
      execResult.signal,
    );
    return {
      ok: exitCode === 0,
      detail:
        exitCode === 0
          ? execResult.stdout?.trim() || undefined
          : execResult.stderr?.trim() || `exit ${exitCode}`,
      stdout: execResult.stdout ?? '',
      stderr: execResult.stderr ?? '',
      exitCode,
    };
  }

  return new Promise<Omit<SlotActionRunResult, 'refresh'>>((resolve) => {
    execFile(
      'bash',
      ['-c', command],
      { cwd: slotVars.remoteRepo, timeout: timeoutMs },
      (err, stdout, stderr) => {
        const exitCode = normalizeExecExitCode(
          typeof err === 'object' && err && 'code' in err ? err.code : undefined,
          typeof err === 'object' && err && 'signal' in err ? err.signal : undefined,
          !!err,
        );
        resolve({
          ok: !err,
          detail: err ? stderr.trim() || err.message : stdout.trim() || undefined,
          stdout,
          stderr,
          exitCode,
        });
      },
    );
  });
}

export async function slotActionList(params: SlotActionListParams): Promise<SlotActionListResult> {
  const actions = await resolveProjectActions(params.slotId);
  return {
    actions: actions
      .map((action) => action.summary)
      .filter((summary) => actionMatchesPlacement(summary, params.placement)),
  };
}

export async function slotActionRun(params: SlotActionRunParams): Promise<SlotActionRunResult> {
  const actions = await resolveProjectActions(params.slotId);
  const action = findAction(actions, params.actionId);
  if (!action) {
    return { ok: false, detail: `Slot action '${params.actionId}' not found` };
  }

  const slotVars = await loadSlotVars(params.slotId);
  const { pool, slot } = await resolveSlot(params.slotId);
  const projectName = slot.project ?? pool.project;
  const projectVars = await loadProjectVars(projectName);
  const expanded = expandTemplate(action.command, slotVars, projectVars);
  if (hasUnresolvedPlaceholders(expanded)) {
    const unresolved = findUnresolvedPlaceholders(expanded);
    return {
      ok: false,
      detail: `unresolved placeholders: ${unresolved.join(', ')}`,
      refresh: action.summary.refresh,
    };
  }

  if (action.summary.mode === 'copy') {
    return {
      ok: true,
      detail: 'command resolved',
      command: expanded,
      refresh: action.summary.refresh,
    };
  }

  const result = await executeExpandedCommand(params.slotId, expanded, action.timeoutMs);
  if (result.ok && action.summary.refresh.includes('resources')) {
    await pollSlotResources(params.slotId);
  }
  return { ...result, refresh: action.summary.refresh };
}
