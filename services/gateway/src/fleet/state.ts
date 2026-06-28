// state.ts — Read/watch .farm-status.json, pool/*.json, projects/*/project.json
// Transforms raw JSON into protocol types

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { watch } from 'chokidar';

import type {
  ActiveResourcePointer,
  FleetStatus,
  FleetSummary,
  PoolConfig,
  ProjectConfig,
  ResourceRollup,
  SafetyTier,
  SlotActionDefinition,
  SlotHealth,
  SlotLifecycle,
  SlotPhase,
  SlotStatus,
  TmuxWorkerFilterConfig,
} from '@farmslot/protocol';

import {
  normalizeRawProjectAutoRecovery,
  normalizeRawProjectBacklog,
  normalizeRawProjectPrepare,
} from '../core/config.js';
import { farmslotRoot } from '../projects/repo-root.js';

import { enrichSlotHostLoad, getAllMachineHealth } from './node-health.js';
import { getActiveResources, getCachedSlotResources } from './resource-manager.js';

const VALID_SAFETY_TIERS: SafetyTier[] = ['sandboxed', 'full-auto', 'dangerous'];
export function isValidSafetyTier(value: unknown): value is SafetyTier {
  return typeof value === 'string' && (VALID_SAFETY_TIERS as string[]).includes(value);
}

export type StateChangeHandler = (fleet: FleetStatus) => void;

const statusFile = path.join(farmslotRoot, '.farm-status.json');
const poolDir = path.join(farmslotRoot, 'pool');
const projectsDir = path.join(farmslotRoot, 'projects');

function normalizeProjectCICheckGroups(rawCi: any): ProjectConfig['ci']['checkGroups'] {
  const explicit = Array.isArray(rawCi?.check_groups) ? rawCi.check_groups : [];
  if (explicit.length > 0) {
    return explicit
      .filter(
        (group: any) =>
          typeof group?.name === 'string' &&
          group.name.length > 0 &&
          typeof group?.match === 'string' &&
          group.match.length > 0,
      )
      .map((group: any) => ({
        name: group.name,
        match: group.match,
        matchMode: group.match_mode ?? 'exact',
        aggregate: group.aggregate ?? 'all',
      }));
  }
  const legacy = Array.isArray(rawCi?.watch_checks) ? rawCi.watch_checks : [];
  return legacy
    .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0)
    .map((name: string) => ({
      name,
      match: name,
      matchMode: 'includes' as const,
      aggregate: 'latest' as const,
    }));
}

function normalizeSlotActions(rawActions: any): Record<string, SlotActionDefinition> | undefined {
  if (!rawActions || typeof rawActions !== 'object' || Array.isArray(rawActions)) return undefined;
  const actions: Record<string, SlotActionDefinition> = {};
  for (const [id, raw] of Object.entries(rawActions)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const action = raw as Record<string, unknown>;
    if (typeof action.label !== 'string' || typeof action.command !== 'string') continue;
    actions[id] = {
      label: action.label,
      command: action.command,
      ...(typeof action.mode === 'string'
        ? { mode: action.mode as SlotActionDefinition['mode'] }
        : {}),
      ...(Array.isArray(action.placement)
        ? { placement: action.placement as SlotActionDefinition['placement'] }
        : {}),
      ...(typeof action.style === 'string'
        ? { style: action.style as SlotActionDefinition['style'] }
        : {}),
      ...(typeof action.confirm === 'string' ? { confirm: action.confirm } : {}),
      ...(typeof action.timeoutMs === 'number'
        ? { timeoutMs: action.timeoutMs }
        : typeof action.timeout_ms === 'number'
          ? { timeoutMs: action.timeout_ms }
          : {}),
      ...(Array.isArray(action.refresh)
        ? { refresh: action.refresh as SlotActionDefinition['refresh'] }
        : {}),
    };
  }
  return Object.keys(actions).length > 0 ? actions : undefined;
}

function normalizeProjectResources(rawResources: any): ProjectConfig['resources'] {
  if (!rawResources || typeof rawResources !== 'object' || Array.isArray(rawResources))
    return undefined;
  const resources: NonNullable<ProjectConfig['resources']> = {};
  for (const [id, raw] of Object.entries(rawResources)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const resource = raw as Record<string, unknown>;
    const actions = normalizeSlotActions(resource.actions);
    resources[id] = {
      type: (typeof resource.type === 'string' ? resource.type : 'device') as NonNullable<
        ProjectConfig['resources']
      >[string]['type'],
      ...(typeof resource.platform === 'string' ? { platform: resource.platform } : {}),
      label: typeof resource.label === 'string' ? resource.label : id,
      streamable: typeof resource.streamable === 'boolean' ? resource.streamable : true,
      controllable: typeof resource.controllable === 'boolean' ? resource.controllable : false,
      ...(resource.watch && typeof resource.watch === 'object' && !Array.isArray(resource.watch)
        ? { watch: resource.watch as NonNullable<ProjectConfig['resources']>[string]['watch'] }
        : {}),
      ...(resource.hooks && typeof resource.hooks === 'object' && !Array.isArray(resource.hooks)
        ? { hooks: resource.hooks as NonNullable<ProjectConfig['resources']>[string]['hooks'] }
        : {}),
      ...(actions ? { actions } : {}),
    };
  }
  return Object.keys(resources).length > 0 ? resources : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const TMUX_WORKER_FILTER_FIELDS = [
  'nodeId',
  'session',
  'target',
  'windowName',
  'pane',
  'paneId',
  'title',
  'cwd',
  'command',
  'linkedSlotId',
  'linkedRunId',
  'linkedFamilyId',
] as const;

const TMUX_WORKER_FILTER_FIELD_ALIASES: Record<string, (typeof TMUX_WORKER_FILTER_FIELDS)[number]> =
  {
    node_id: 'nodeId',
    window_name: 'windowName',
    pane_id: 'paneId',
    linked_slot_id: 'linkedSlotId',
    linked_run_id: 'linkedRunId',
    linked_family_id: 'linkedFamilyId',
  };

function normalizeTmuxWorkerFilterRule(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const rule: Record<string, string> = {};
  for (const field of TMUX_WORKER_FILTER_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string' && value.length > 0) rule[field] = value;
  }
  for (const [alias, field] of Object.entries(TMUX_WORKER_FILTER_FIELD_ALIASES)) {
    if (rule[field]) continue;
    const value = raw[alias];
    if (typeof value === 'string' && value.length > 0) rule[field] = value;
  }
  return Object.keys(rule).length > 0 ? rule : undefined;
}

function normalizeTmuxWorkerFilterRuleList(raw: unknown): Record<string, string>[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rules = raw
    .map((rule) => normalizeTmuxWorkerFilterRule(rule))
    .filter((rule): rule is Record<string, string> => Boolean(rule));
  return rules.length > 0 ? rules : undefined;
}

function normalizeTmuxWorkerFilters(raw: unknown): TmuxWorkerFilterConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const include = normalizeTmuxWorkerFilterRuleList(raw.include ?? raw.allow ?? raw.allowlist);
  const exclude = normalizeTmuxWorkerFilterRuleList(raw.exclude ?? raw.block ?? raw.blocklist);
  if (!include && !exclude) return undefined;
  return {
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  };
}

function normalizePublicationReview(
  raw: Record<string, unknown>,
): ProjectConfig['publicationReview'] | undefined {
  const cfg = raw.publication_review;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return undefined;
  const normalized: ProjectConfig['publicationReview'] = {};
  for (const flow of ['fix-bug', 'dev'] as const) {
    const flowConfig = (cfg as Record<string, unknown>)[flow];
    if (!isRecord(flowConfig)) continue;
    const flowReview: NonNullable<ProjectConfig['publicationReview']>[typeof flow] = {};
    const minimumIndependentReviews = flowConfig.minimum_independent_reviews;
    if (
      minimumIndependentReviews !== undefined &&
      (typeof minimumIndependentReviews !== 'number' ||
        !Number.isInteger(minimumIndependentReviews) ||
        minimumIndependentReviews < 0)
    ) {
      throw new Error(
        `publication_review.${flow}.minimum_independent_reviews must be a non-negative integer`,
      );
    }
    if (typeof minimumIndependentReviews === 'number') {
      flowReview.minimumIndependentReviews = minimumIndependentReviews;
    }
    const requireCrossRunner = flowConfig.require_cross_runner;
    if (requireCrossRunner !== undefined && typeof requireCrossRunner !== 'boolean') {
      throw new Error(`publication_review.${flow}.require_cross_runner must be a boolean`);
    }
    if (typeof requireCrossRunner === 'boolean') {
      flowReview.requireCrossRunner = requireCrossRunner;
    }
    normalized[flow] = flowReview;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

let cachedFleet: FleetStatus | null = null;
const changeHandlers: StateChangeHandler[] = [];

// ─── Task progress overlay (enriched by task-watcher, not persisted to disk) ───

interface TaskProgressOverlay {
  taskPhase: string; // e.g. "Validate 5/7"
  taskStepProgress: number; // 0.0-1.0
}

const taskProgressCache = new Map<string, TaskProgressOverlay>();

export function setTaskProgressOverlay(
  slotId: string,
  phase: string | null,
  completed: number,
  total: number,
): void {
  if (!phase || total === 0) {
    taskProgressCache.delete(slotId);
    return;
  }
  taskProgressCache.set(slotId, {
    taskPhase: `${phase} ${completed}/${total}`,
    taskStepProgress: completed / total,
  });
}

export function clearTaskProgressOverlay(slotId: string): void {
  taskProgressCache.delete(slotId);
}

// ─── PR Health overlay (populated by CI monitor ticks) ───

const prHealthCache = new Map<string, SlotStatus['prHealth']>();

export function setPrHealthOverlay(slotId: string, prHealth: SlotStatus['prHealth']): void {
  if (!prHealth) {
    prHealthCache.delete(slotId);
    return;
  }
  prHealthCache.set(slotId, prHealth);
}

export function clearPrHealthOverlay(slotId: string): void {
  prHealthCache.delete(slotId);
}

// ─── Branch overlay (enriched by branch-watcher, not persisted to disk) ───

const branchOverlayCache = new Map<string, string>();

export function setBranchOverlay(slotId: string, branch: string): void {
  branchOverlayCache.set(slotId, branch);
}

export function clearBranchOverlay(slotId: string): void {
  branchOverlayCache.delete(slotId);
}

// ─── Raw JSON shape from .farm-status.json ───

interface RawSlot {
  slot: string;
  machine: string;
  platform: string;
  project: string;
  ssh: string;
  dev: string;
  devserver: string;
  device: string;
  cdp: string;
  fixtures: string;
  branch: string;
  session?: string;
  repo?: string;
  linked_worktree?: boolean;
  agent: string;
  enabled: boolean;
  mode: string;
  dispatchable: boolean;
  lifecycle: string;
  task_id: string | null;
  task_file: string | null;
  current_run_id?: string | null;
  current_flow_type?: string | null;
  current_ticket_or_pr?: string | null;
  current_mode?: string | null;
  current_family_id?: string | null;
  current_lane?: string | null;
  current_variant?: string | null;
  agent_contexts?: SlotStatus['agentContexts'];
  dispatched_at: string | null;
  completed_at: string | null;
  runner: string | null;
  model: string | null;
  resources?: Record<string, Record<string, string | number | boolean>>;
}

interface RawStatus {
  checked_at: string;
  slots: RawSlot[];
}

// ─── Transform ───

// Map old lifecycle values from .farm-status.json to new 5-state model + phase
function mapLifecycleAndPhase(
  rawLifecycle: string,
  rawMode: string,
): { lifecycle: SlotLifecycle; phase: SlotPhase; warm: boolean } {
  switch (rawLifecycle) {
    case 'ready':
      return { lifecycle: 'ready', phase: null, warm: true };
    case 'released':
      return { lifecycle: 'ready', phase: null, warm: false };
    case 'preparing':
      return { lifecycle: 'busy', phase: 'preparing', warm: false };
    case 'dispatching':
      return { lifecycle: 'busy', phase: 'dispatching', warm: false };
    case 'working':
      return { lifecycle: 'busy', phase: 'working', warm: false };
    case 'releasing':
      return { lifecycle: 'busy', phase: 'releasing', warm: false };
    case 'review-gate':
      return { lifecycle: 'busy', phase: 'review-gate', warm: false };
    case 'ci-watch':
      return { lifecycle: 'held', phase: 'ci-watch', warm: false };
    case 'custom':
      return { lifecycle: 'manual', phase: null, warm: false };
    case 'disabled':
      return { lifecycle: 'disabled', phase: null, warm: false };
    default:
      // Fallback: derive from pool mode
      if (rawMode === 'custom') return { lifecycle: 'manual', phase: null, warm: false };
      if (rawMode === 'disabled') return { lifecycle: 'disabled', phase: null, warm: false };
      return { lifecycle: 'ready', phase: null, warm: false };
  }
}

function transformSlot(raw: RawSlot): SlotStatus {
  const health: SlotHealth = {
    ssh: raw.ssh,
    device: raw.dev,
    devserver: raw.devserver ?? (raw as any).metro ?? '-',
    cdp: raw.cdp,
    fixtures: raw.fixtures,
  };
  // Read new fields if present, otherwise map from old values
  const rawPhase = (raw as any).phase as string | null | undefined;
  const rawWarm = (raw as any).warm as boolean | undefined;
  let lifecycle: SlotLifecycle;
  let phase: SlotPhase;
  let warm: boolean;
  if (rawPhase !== undefined) {
    // New format — read directly
    lifecycle = raw.lifecycle as SlotLifecycle;
    phase = (rawPhase ?? null) as SlotPhase;
    warm = rawWarm ?? false;
  } else {
    // Old format — map
    const mapped = mapLifecycleAndPhase(raw.lifecycle, raw.mode);
    lifecycle = mapped.lifecycle;
    phase = mapped.phase;
    warm = mapped.warm;
  }
  return {
    slot: raw.slot,
    machine: raw.machine,
    platform: raw.platform as string,
    project: raw.project,
    health,
    branch: raw.branch,
    session: raw.session,
    repo: raw.repo,
    linkedWorktree: raw.linked_worktree ?? false,
    agent: raw.agent as SlotStatus['agent'],
    enabled: raw.enabled,
    dispatchable: raw.dispatchable,
    lifecycle,
    phase,
    warm,
    taskId: raw.task_id,
    taskFile: raw.task_file,
    currentRunId: raw.current_run_id ?? null,
    currentFlowType: raw.current_flow_type ?? null,
    currentTicketOrPr: raw.current_ticket_or_pr ?? null,
    currentMode: raw.current_mode ?? null,
    currentFamilyId: raw.current_family_id ?? null,
    currentLane: (raw.current_lane as SlotStatus['currentLane']) ?? null,
    currentVariant: raw.current_variant ?? null,
    dispatchedAt: raw.dispatched_at,
    completedAt: raw.completed_at,
    agentContexts: raw.agent_contexts ?? undefined,
    runner: raw.runner,
    model: raw.model,
    resources: raw.resources,
    deviceName: raw.device ?? null,
    taskPhase: null,
    taskStepProgress: null,
  };
}

function computeSummary(slots: SlotStatus[]): FleetSummary {
  const summary: FleetSummary = {
    total: slots.length,
    ready: 0,
    busy: 0,
    held: 0,
    manual: 0,
    disabled: 0,
    blocked: 0,
    warmCount: 0,
  };
  for (const s of slots) {
    switch (s.lifecycle) {
      case 'ready': {
        const healthy = s.health.ssh !== 'FAIL' && s.health.devserver !== 'FAIL';
        if (healthy) summary.ready++;
        else summary.blocked++;
        if (s.warm) summary.warmCount++;
        break;
      }
      case 'busy':
        summary.busy++;
        break;
      case 'held':
        summary.held++;
        break;
      case 'manual':
        summary.manual++;
        break;
      case 'disabled':
        summary.disabled++;
        break;
    }
  }
  return summary;
}

function computeResourceRollup(slot: SlotStatus): ResourceRollup {
  const statuses = getCachedSlotResources(slot.slot);
  if (!statuses || statuses.size === 0) return 'none';
  const pointers = getActiveResources(slot.slot);
  let running = 0;
  let stopped = 0;
  let staleHits = 0;
  let ownedMismatch = false;
  for (const [resourceId, status] of statuses) {
    if (status === 'running') {
      running++;
      const ptr: ActiveResourcePointer | undefined = pointers?.get(resourceId);
      const ptrRunId = ptr?.runId ?? null;
      if (ptrRunId && slot.currentRunId && ptrRunId !== slot.currentRunId) {
        ownedMismatch = true;
      }
    } else if (status === 'stale') {
      // stale means the process is alive but owned by a prior run — count
      // toward `running` so the rollup lands on 'stale' (see line 259), not
      // 'none'. The staleHits counter drives the final verdict.
      staleHits++;
      running++;
    } else if (status === 'stopped' || status === 'error') {
      stopped++;
    }
  }
  if (running === 0) return 'none';
  if (staleHits > 0 || ownedMismatch) return 'stale';
  if (stopped > 0) return 'partial';
  return 'coherent';
}

function transformFleet(raw: RawStatus): FleetStatus {
  const slots = raw.slots.map((s) => {
    const slot = transformSlot(s);
    const overlay = taskProgressCache.get(slot.slot);
    if (overlay) {
      slot.taskPhase = overlay.taskPhase;
      slot.taskStepProgress = overlay.taskStepProgress;
    }
    const prHealth = prHealthCache.get(slot.slot);
    if (prHealth) {
      slot.prHealth = prHealth;
    }
    const branchOverride = branchOverlayCache.get(slot.slot);
    if (branchOverride) {
      slot.branch = branchOverride;
    }
    slot.resourceRollup = computeResourceRollup(slot);
    return slot;
  });
  // Enrich slots with host load from node health
  enrichSlotHostLoad(slots);
  const machines = getAllMachineHealth();
  return {
    checkedAt: raw.checked_at,
    slots,
    summary: computeSummary(slots),
    ...(machines.length > 0 ? { machines } : {}),
  };
}

// ─── Public API ───

export async function loadFleetStatus(forceRefresh = false): Promise<FleetStatus> {
  if (cachedFleet && !forceRefresh) return cachedFleet;
  try {
    const content = await readFile(statusFile, 'utf-8');
    const raw: RawStatus = JSON.parse(content);
    cachedFleet = transformFleet(raw);
  } catch (err) {
    console.error(
      `[state] loadFleetStatus failed: ${(err as Error).message} — falling back to empty fleet`,
    );
    cachedFleet = {
      checkedAt: new Date().toISOString(),
      slots: [],
      summary: {
        total: 0,
        ready: 0,
        busy: 0,
        held: 0,
        manual: 0,
        disabled: 0,
        blocked: 0,
        warmCount: 0,
      },
    };
  }
  return cachedFleet;
}

export function getCachedFleet(): FleetStatus | null {
  return cachedFleet;
}

export function onStateChange(handler: StateChangeHandler): void {
  changeHandlers.push(handler);
}

export function startFileWatcher(): void {
  const watcher = watch(statusFile, { persistent: true, ignoreInitial: true });
  watcher.on('change', async () => {
    await loadFleetStatus(true);
    if (cachedFleet) {
      for (const handler of changeHandlers) {
        handler(cachedFleet);
      }
    }
  });

  // Watch pool config changes — hot-reload without gateway restart
  let poolDebounce: ReturnType<typeof setTimeout> | undefined;
  const poolWatcher = watch(path.join(poolDir, '*.json'), {
    persistent: true,
    ignoreInitial: true,
  });
  poolWatcher.on('all', () => {
    clearTimeout(poolDebounce);
    poolDebounce = setTimeout(async () => {
      try {
        console.log('[state] pool config changed — triggering fleet refresh');
        const { fleetRefresh } = await import('../methods/fleet.js');
        await fleetRefresh();
      } catch (err) {
        console.error('[state] pool refresh failed:', (err as Error).message);
      }
    }, 2000);
  });
}

// ─── Pool configs ───

export async function loadPoolConfigs(): Promise<PoolConfig[]> {
  const pools: PoolConfig[] = [];
  try {
    const files = await readdir(poolDir);
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'example.json') continue;
      try {
        const content = await readFile(path.join(poolDir, file), 'utf-8');
        const raw = JSON.parse(content);
        const tmuxWorkers = normalizeTmuxWorkerFilters(raw.tmux_workers ?? raw.tmuxWorkers);
        pools.push({
          machine: raw.machine,
          project: raw.project,
          platform: raw.platform,
          os: raw.os,
          host: raw.host,
          sshUser: raw.ssh_user,
          ...(tmuxWorkers ? { tmuxWorkers } : {}),
          slots: (raw.slots || []).map((s: any) => ({
            id: s.id,
            enabled: s.enabled,
            mode: s.mode || 'dispatch',
            project: s.project || raw.project,
            repo: s.repo,
            session: s.session,
            resources: s.resources,
          })),
        });
      } catch {
        /* skip invalid files */
      }
    }
  } catch {
    /* pool dir might not exist */
  }

  // Warn on duplicate session names within the same machine
  const sessionsByMachine = new Map<string, Map<string, string>>();
  for (const pool of pools) {
    const machine =
      pool.host === 'localhost' || pool.host === '127.0.0.1' ? '_local_' : pool.machine;
    if (!sessionsByMachine.has(machine)) sessionsByMachine.set(machine, new Map());
    const seen = sessionsByMachine.get(machine)!;
    for (const slot of pool.slots) {
      if (slot.session && seen.has(slot.session)) {
        console.warn(
          `[pool] session name collision: "${slot.session}" used by both ${seen.get(slot.session)} and ${slot.id} on machine ${pool.machine}`,
        );
      }
      if (slot.session) seen.set(slot.session, slot.id);
    }
  }

  return pools;
}

export async function loadPoolConfig(machine: string): Promise<PoolConfig | null> {
  const pools = await loadPoolConfigs();
  return pools.find((p) => p.machine === machine) ?? null;
}

// ─── Project configs ───

export async function loadProjectConfigs(): Promise<ProjectConfig[]> {
  const projects: ProjectConfig[] = [];
  try {
    const dirs = await readdir(projectsDir);
    for (const dir of dirs) {
      try {
        const configPath = path.join(projectsDir, dir, 'project.json');
        const content = await readFile(configPath, 'utf-8');
        const raw = JSON.parse(content);
        const ciCheckGroups = normalizeProjectCICheckGroups(raw.ci);
        const resources = normalizeProjectResources(raw.resources);
        const slotActions = normalizeSlotActions(raw.slot_actions);
        if (typeof raw.ci?.pr_title_prefix === 'string') {
          // Legacy key from before the suffix rename — silently ignored by the schema (which
          // only knows pr_title_suffix), so PRs would ship without the human-gate marker.
          console.warn(
            `[state] project ${dir}: ci.pr_title_prefix is no longer supported — rename to ci.pr_title_suffix`,
          );
        }
        const autoRecovery = normalizeRawProjectAutoRecovery(raw.auto_recovery);
        const backlog = normalizeRawProjectBacklog(raw.backlog);
        const prepare = normalizeRawProjectPrepare(raw.prepare, raw.name || dir);
        const publicationReview = normalizePublicationReview(raw);
        const recipeRunSupportsPlaybackSlow = raw.recipe_run_supports_playback_slow === true;
        const recipeRunSupportsVideoRecording =
          raw.recipe_run_supports_video_recording === true;
        projects.push({
          name: raw.name || dir,
          repoUrl: raw.repo_url || '',
          defaultBranch: raw.default_branch || 'main',
          slotTrackingBranch:
            typeof raw.slot_tracking_branch === 'string' ? raw.slot_tracking_branch : undefined,
          worktreeBase: typeof raw.worktree_base === 'string' ? raw.worktree_base : undefined,
          apps: Array.isArray(raw.apps)
            ? raw.apps.filter(
                (app: unknown): app is string => typeof app === 'string' && app.length > 0,
              )
            : undefined,
          paths: {
            runtimeDir: raw.paths?.runtime_dir || '',
            artifactDir: raw.paths?.artifact_dir || '',
          },
          defaults: raw.defaults || {},
          hooks: raw.hooks || {},
          health: raw.health || {},
          ci: {
            repo: raw.ci?.repo || '',
            prLabels: Array.isArray(raw.ci?.pr_labels)
              ? raw.ci.pr_labels.filter(
                  (label: unknown): label is string =>
                    typeof label === 'string' && label.length > 0,
                )
              : undefined,
            prTitleSuffix:
              typeof raw.ci?.pr_title_suffix === 'string' ? raw.ci.pr_title_suffix : undefined,
            watchChecks: ciCheckGroups.map((group) => group.name),
            checkGroups: ciCheckGroups,
            botPatterns: (raw.ci?.bot_patterns || []).map(
              (bp: {
                author: string;
                label: string;
                default_action: 'nudge_worker' | 'alert_only';
                actions?: Array<{
                  body_match: string;
                  action: 'nudge_worker' | 'alert_only';
                  label?: string;
                }>;
              }) => ({
                author: bp.author,
                label: bp.label,
                defaultAction: bp.default_action,
                ...(bp.actions
                  ? {
                      actions: bp.actions.map((a) => ({
                        bodyMatch: a.body_match,
                        action: a.action,
                        ...(a.label ? { label: a.label } : {}),
                      })),
                    }
                  : {}),
              }),
            ),
          },
          jira: {
            project: raw.jira?.project || '',
            base_url: raw.jira?.base_url,
            email_env: raw.jira?.email_env,
            api_token_env: raw.jira?.api_token_env,
          },
          ...(isValidSafetyTier(raw.default_safety_tier)
            ? { defaultSafetyTier: raw.default_safety_tier }
            : {}),
          ...(resources ? { resources } : {}),
          ...(slotActions ? { slotActions } : {}),
          ...(raw.webhooks
            ? {
                webhooks: {
                  github_secret: raw.webhooks.github_secret,
                  jira_secret: raw.webhooks.jira_secret,
                  auto_dispatch: raw.webhooks.auto_dispatch,
                },
              }
            : {}),
          ...(raw.ci_watch
            ? {
                ci_watch: {
                  poll_interval_s: raw.ci_watch.poll_interval_s,
                  max_hold_min: raw.ci_watch.max_hold_min,
                  auto_dispatch: raw.ci_watch.auto_dispatch
                    ? {
                        test_failures: raw.ci_watch.auto_dispatch.test_failures,
                        merge_conflicts: raw.ci_watch.auto_dispatch.merge_conflicts,
                        bot_comments: raw.ci_watch.auto_dispatch.bot_comments,
                      }
                    : undefined,
                },
              }
            : {}),
          ...(raw.auto_recycle
            ? {
                auto_recycle: {
                  enabled: raw.auto_recycle.enabled,
                  interval_min: raw.auto_recycle.interval_min,
                  max_failures: raw.auto_recycle.max_failures,
                },
              }
            : {}),
          ...(autoRecovery ? { autoRecovery } : {}),
          ...(backlog ? { backlog } : {}),
          ...(prepare ? { prepare } : {}),
          ...(publicationReview ? { publicationReview } : {}),
          ...(recipeRunSupportsPlaybackSlow ? { recipeRunSupportsPlaybackSlow: true } : {}),
          ...(recipeRunSupportsVideoRecording ? { recipeRunSupportsVideoRecording: true } : {}),
        });
      } catch {
        /* skip invalid projects */
      }
    }
  } catch {
    /* projects dir might not exist */
  }
  return projects;
}

export async function loadProjectConfig(project: string): Promise<ProjectConfig | null> {
  const projects = await loadProjectConfigs();
  return projects.find((p) => p.name === project) ?? null;
}

export { farmslotRoot, statusFile };
