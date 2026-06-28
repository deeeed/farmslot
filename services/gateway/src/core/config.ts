// core/config.ts — Slot/pool/project config loading
// TypeScript port of lib/slot-common.sh: resolve_slot, load_slot_vars, load_project_config, get_project_field

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_TASK_DIR,
  FAILURE_CATEGORIES,
  type PoolSlotMode,
  PREPARE_PHASES,
  PREPARE_REQUIREMENTS,
  type PreparePhase,
  type PrepareRequirement,
  type ProjectConfig,
  type SlotActionDefinition,
} from '@farmslot/protocol';

import { farmslotRoot } from '../projects/repo-root.js';

const poolDir = path.join(farmslotRoot, 'pool');
const projectsDir = path.join(farmslotRoot, 'projects');

// Browser/CDP resources are consumed by Node's standards-compliant fetch in the
// recipe harness and MetaMask recipe runner. The Fetch standard blocks these
// ports before any network request is attempted; using one makes a live browser
// look like "zero CDP targets" to downstream readiness checks.
const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

export function isHttpFetchForbiddenPort(port: number): boolean {
  return FETCH_FORBIDDEN_PORTS.has(port);
}

function assertFetchCompatibleCdpPort(slotId: string, rawPort: string): void {
  const cdpPort = Number(rawPort);
  if (!Number.isInteger(cdpPort) || cdpPort <= 0 || cdpPort > 65_535) {
    throw new Error(`Invalid cdp_port '${rawPort}' in slot ${slotId}`);
  }
  if (isHttpFetchForbiddenPort(cdpPort)) {
    throw new Error(
      `Invalid cdp_port ${cdpPort} in slot ${slotId}: this port is blocked by standards-compliant ` +
        'fetch clients used by CDP readiness checks. Use a non-forbidden port such as 7666.',
    );
  }
}

// ─── Raw pool JSON shape ───

export interface RawPoolJson {
  machine: string;
  project: string;
  platform: string;
  os: string;
  host: string;
  ssh_user: string;
  android_home?: string;
  claude_path?: string;
  codex_path?: string;
  opencode_path?: string;
  cursor_path?: string;
  grok_path?: string;
  dispatch_cmd?: string;
  recycle_cmd?: string;
  slots: RawPoolSlot[];
}

export interface RawPoolSlot {
  id: string;
  enabled?: boolean;
  mode?: 'dispatch' | 'custom';
  project?: string;
  platform?: string;
  repo: string;
  session: string;
  branch?: string;
  app?: string;
  lifecycle?: string;
  agent?: string;
  task?: string | null;
  resources?: Record<string, Record<string, string | number | boolean>>;
}

// ─── Resolved slot config (mirrors bash load_slot_vars globals) ───

export interface SlotVars {
  slotId: string;
  machine: string;
  platform: string;
  host: string;
  sshUser: string;
  osType: string;
  claudePath: string;
  codexPath: string;
  opencodePath: string;
  cursorPath: string;
  grokPath: string;
  dispatchCmd: string;
  recycleCmd: string;
  repo: string;
  session: string;
  slotMode: PoolSlotMode;
  slotEnabled: boolean;
  sshTarget: string;
  remoteRepo: string;
  projectName: string;
  // Resource-derived (flattened from slot.resources)
  resourceVars: Record<string, string>;
}

// ─── Raw project.json shape ───

export interface RawProjectJson {
  name?: string;
  repo_url?: string;
  primary_repo?: string;
  default_branch?: string;
  worktree_base?: string;
  slot_tracking_branch?: string;
  merge_main_strategy?: 'merge' | 'rebase';
  recipe_run_supports_playback_slow?: boolean;
  recipe_run_supports_video_recording?: boolean;
  apps?: string[];
  external?: { mock_mode?: boolean; fixtures_dir?: string };
  reference_repos?: Record<string, { repo_url: string; local_name: string; branch?: string }>;
  paths?: { runtime_dir?: string; artifact_dir?: string; recipe_dir?: string };
  vars?: Record<string, string>;
  node_support?: {
    paths?: string[];
  };
  command_env?: {
    unset?: string[];
    set?: Record<string, string>;
  };
  eval_harnesses?: Record<
    string,
    {
      repo_url?: string;
      path?: string;
      local_path?: string;
      default_ref?: string;
      source?: string;
    }
  >;
  defaults?: Record<string, { runner: string; model: string; effort?: string }>;
  diff_analysis?: {
    source_filter?: {
      use_defaults?: boolean;
      allowlist?: { extensions?: string[]; basenames?: string[]; patterns?: string[] };
      blocklist?: { extensions?: string[]; basenames?: string[]; patterns?: string[] };
    };
    review_input_timeout_ms?: number;
  };
  hooks?: Record<string, string | Record<string, string>>;
  health?: Record<string, string>;
  monitoring?: {
    poll_interval_min?: number;
    stuck_timeout_min?: number;
    idle_timeout_min?: number;
    total_timeout_min?: number;
    max_nudges?: number;
  };
  ci?: {
    enabled?: boolean;
    repo?: string;
    pr_labels?: string[];
    pr_title_suffix?: string;
    default_scope?: string;
    watch_checks?: string[];
    check_groups?: Array<{
      name: string;
      match: string;
      match_mode?: 'exact' | 'includes' | 'regex';
      aggregate?: 'all' | 'any' | 'latest';
    }>;
    bot_patterns?: Array<{
      author: string;
      label: string;
      default_action: 'nudge_worker' | 'alert_only';
      actions?: Array<{
        body_match: string;
        action: 'nudge_worker' | 'alert_only';
        label?: string;
      }>;
    }>;
  };
  fixtures?: {
    templates?: Array<{ src?: string; dst: string; compose?: Record<string, unknown> }>;
    directories?: Array<{ src: string; dst: string; exclude?: string[]; sentinel?: string }>;
  };
  platforms?: Record<string, Record<string, string>>;
  slot_actions?: Record<string, RawSlotActionDefinition>;
  resources?: Record<
    string,
    {
      type: string;
      platform?: string;
      label: string;
      streamable?: boolean;
      controllable?: boolean;
      watch?: { type: string; path?: string; port?: string; cmd?: string; intervalMs?: number };
      hooks?: Record<string, string>;
      actions?: Record<string, RawSlotActionDefinition>;
    }
  >;
  evidence_prefilter?: { mode?: 'suggest' | 'autonomous'; min_runs_for_autonomous?: number };
  auto_recovery?: {
    enabled?: boolean;
    maxAttempts?: number;
    allowedSteps?: string[];
    allowedCategories?: string[];
    disabled_patterns?: string[];
    llm?: { enabled?: boolean; dailyUsdCap?: number; timeoutMs?: number };
  };
  backlog?: {
    auto_dispatch?: { enabled?: boolean };
  };
  prepare?: {
    default?: string;
    profiles?: Record<
      string,
      {
        label?: string;
        description?: string;
        phases?: string[];
        hooks?: Record<string, string>;
        requires?: string[];
        fallback?: string;
      }
    >;
  };
  recipe_timeout?: number;
  // Project-level safety-tier policy (ADR-023 §3). Applied at run create time
  // when neither the dispatch params nor a parent run supplies an explicit
  // tier. Projects running established agents on trusted machines opt into
  // 'full-auto' or 'dangerous'; fresh or audited projects leave this unset
  // to inherit the runner's intrinsic 'sandboxed' fallback.
  default_safety_tier?: 'sandboxed' | 'full-auto' | 'dangerous';
  self_review?: {
    enabled?: boolean;
    runner?: string;
    model?: string;
    max_retries?: number;
    review_timeout_min?: number;
  };
  publication_review?: Partial<
    Record<
      'fix-bug' | 'dev',
      {
        minimum_independent_reviews?: number;
        require_cross_runner?: boolean;
      }
    >
  >;
  jira?: {
    project?: string;
    base_url?: string;
    email_env?: string;
    api_token_env?: string;
  };
}

export interface RawSlotActionDefinition extends Omit<SlotActionDefinition, 'timeoutMs'> {
  timeoutMs?: number;
  timeout_ms?: number;
}

export interface ProjectVars {
  projectName: string;
  projectConfig: string; // path to project.json
  projectFixturesDir: string;
  projectTemplatesDir: string;
  projectJson: RawProjectJson;
  runtimeDir: string;
  artifactDir: string;
  recipeDir?: string;
}

// ─── resolveSlot ───

export interface ResolvedSlot {
  pool: RawPoolJson;
  slot: RawPoolSlot;
  poolFile: string;
}

export async function resolveSlot(slotId: string): Promise<ResolvedSlot> {
  let files: string[];
  try {
    files = await readdir(poolDir);
  } catch {
    throw new Error(`Pool directory not found: ${poolDir}`);
  }

  for (const file of files) {
    if (!file.endsWith('.json') || file === 'example.json') continue;
    try {
      const content = await readFile(path.join(poolDir, file), 'utf-8');
      const pool: RawPoolJson = JSON.parse(content);
      const slot = pool.slots.find((s) => s.id === slotId);
      if (slot) {
        return { pool, slot, poolFile: path.join(poolDir, file) };
      }
    } catch {
      /* skip invalid files */
    }
  }

  throw new Error(`Slot '${slotId}' not found in any pool JSON under ${poolDir}/`);
}

// ─── resolveRemoteRepo ───

export function resolveRemoteRepo(repo: string, osType: string, sshUser: string): string {
  if (repo.startsWith('/')) return repo;
  if (repo.startsWith('~')) {
    const homeDir = osType === 'darwin' ? `/Users/${sshUser}` : `/home/${sshUser}`;
    return repo.replace(/^~/, homeDir);
  }
  return repo;
}

// ─── loadSlotVars ───

export async function loadSlotVars(slotId: string): Promise<SlotVars> {
  const { pool, slot } = await resolveSlot(slotId);

  const machine = pool.machine;
  const platform = slot.platform || pool.platform;
  const host = pool.host;
  const sshUser = pool.ssh_user;
  const osType = pool.os || 'linux';
  const claudePath = pool.claude_path || '';
  const codexPath = pool.codex_path || '';
  const opencodePath = pool.opencode_path || '';
  const cursorPath = pool.cursor_path || '';
  const grokPath = pool.grok_path || '';
  const dispatchCmd = pool.dispatch_cmd || '';
  const recycleCmd = pool.recycle_cmd || '';

  const repo = slot.repo;
  const session = slot.session;

  // Slot mode: explicit mode > enabled flag > dispatch
  let slotMode: PoolSlotMode;
  if (slot.mode) {
    slotMode = slot.mode as PoolSlotMode;
  } else if (slot.enabled === false) {
    slotMode = 'disabled';
  } else {
    slotMode = 'dispatch';
  }

  const slotEnabled = slotMode !== 'disabled';
  const sshTarget = `${sshUser}@${host}`;
  let remoteRepo = resolveRemoteRepo(repo, osType, sshUser);
  if (repo === '.' || repo.startsWith('./') || repo.startsWith('../')) {
    if (host === 'localhost' || host === '127.0.0.1') {
      remoteRepo = path.resolve(farmslotRoot, repo);
    } else {
      throw new Error(
        `Relative repo path '${repo}' is only valid for localhost slots (slot ${slotId})`,
      );
    }
  }
  const projectName = slot.project || pool.project || '';

  // Flatten resources into resourceVars
  const resourceVars: Record<string, string> = {};
  for (const [_key, instance] of Object.entries(slot.resources ?? {})) {
    for (const [field, value] of Object.entries(instance)) {
      if (field in resourceVars)
        throw new Error(`Duplicate resource field '${field}' in slot ${slotId}`);
      resourceVars[field] = String(value);
    }
  }
  if (resourceVars.cdp_port) {
    assertFetchCompatibleCdpPort(slotId, resourceVars.cdp_port);
  }
  // Auto-inject
  resourceVars.platform = platform;
  resourceVars.slot_id = slotId;
  if (slot.app && !resourceVars.app) {
    resourceVars.app = slot.app;
  }

  return {
    slotId,
    machine,
    platform,
    host,
    sshUser,
    osType,
    claudePath,
    codexPath,
    opencodePath,
    cursorPath,
    grokPath,
    dispatchCmd,
    recycleCmd,
    repo,
    session,
    slotMode,
    slotEnabled,
    sshTarget,
    remoteRepo,
    projectName,
    resourceVars,
  };
}

// ─── loadProjectVars ───

// Short-TTL cache so the live-recipe-context read path doesn't re-parse
// project.json from disk on every cached file read. Cold panel-open burst
// would otherwise hit project.json 20-36× per slot before the artifact-text
// cache absorbs the load (each readPortableTextIfExists for a remote slot
// transitively calls resolveWorkerTaskDir → loadProjectVars). 5s TTL matches
// the artifact-text cache TTL — long enough to absorb a burst, short enough
// for project.json edits to land in the next refresh cycle.
const PROJECT_VARS_CACHE_TTL_MS = 5_000;
const projectVarsCache = new Map<string, { value: ProjectVars; at: number }>();

export function invalidateProjectVarsCache(projectName?: string): void {
  if (!projectName) projectVarsCache.clear();
  else projectVarsCache.delete(projectName);
}

export async function loadProjectVars(projectName: string): Promise<ProjectVars> {
  const cached = projectVarsCache.get(projectName);
  if (cached && Date.now() - cached.at < PROJECT_VARS_CACHE_TTL_MS) return cached.value;

  const projectConfig = path.join(projectsDir, projectName, 'project.json');
  const projectFixturesDir = path.join(projectsDir, projectName, 'fixtures');
  const projectTemplatesDir = path.join(projectsDir, projectName, 'templates');

  let projectJson: RawProjectJson;
  try {
    const content = await readFile(projectConfig, 'utf-8');
    projectJson = JSON.parse(content);
  } catch {
    throw new Error(`Project config not found: ${projectConfig}`);
  }

  validateAutoRecoveryConfig(projectJson, projectConfig);
  validateBacklogConfig(projectJson, projectConfig);
  validateEvalHarnessesConfig(projectJson, projectConfig);
  validatePublicationReviewConfig(projectJson, projectConfig);
  validatePrepareConfig(projectJson, projectConfig);

  const runtimeDir = projectJson.paths?.runtime_dir || '.agent';
  const artifactDir = projectJson.paths?.artifact_dir || '.task';
  const recipeDir = projectJson.paths?.recipe_dir || `${runtimeDir}/recipes`;

  const value: ProjectVars = {
    projectName,
    projectConfig,
    projectFixturesDir,
    projectTemplatesDir,
    projectJson,
    runtimeDir,
    artifactDir,
    recipeDir,
  };
  projectVarsCache.set(projectName, { value, at: Date.now() });
  return value;
}

/** Project runtime dir for runner observability and hook installs (defaults to `.agent`). */
export async function resolveProjectRuntimeDir(project?: string | null): Promise<string> {
  if (!project?.trim()) return '.agent';
  try {
    const pv = await loadProjectVars(project);
    return pv.runtimeDir || '.agent';
  } catch {
    return '.agent';
  }
}

export function validatePublicationReviewConfig(
  projectJson: RawProjectJson,
  projectConfig: string,
): void {
  const cfg = projectJson.publication_review;
  if (!cfg) return;
  for (const flow of ['fix-bug', 'dev'] as const) {
    const flowConfig = cfg[flow];
    if (!flowConfig) continue;
    const minReviews = flowConfig.minimum_independent_reviews;
    if (minReviews !== undefined && (!Number.isInteger(minReviews) || minReviews < 0)) {
      throw new Error(
        `${projectConfig}: publication_review.${flow}.minimum_independent_reviews must be a non-negative integer`,
      );
    }
    if (
      flowConfig.require_cross_runner !== undefined &&
      typeof flowConfig.require_cross_runner !== 'boolean'
    ) {
      throw new Error(
        `${projectConfig}: publication_review.${flow}.require_cross_runner must be a boolean`,
      );
    }
  }
}

export function validateEvalHarnessesConfig(
  projectJson: RawProjectJson,
  projectConfig: string,
): void {
  const cfg = projectJson.eval_harnesses;
  if (!cfg) return;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`${projectConfig}: eval_harnesses must be an object`);
  }
  for (const [name, entry] of Object.entries(cfg)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(`${projectConfig}: eval_harnesses key "${name}" is invalid`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${projectConfig}: eval_harnesses.${name} must be an object`);
    }
    for (const field of ['repo_url', 'path', 'local_path', 'default_ref', 'source'] as const) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') {
        throw new Error(`${projectConfig}: eval_harnesses.${name}.${field} must be a string`);
      }
    }
    if (!entry.repo_url && !entry.local_path) {
      throw new Error(
        `${projectConfig}: eval_harnesses.${name} must define repo_url or local_path`,
      );
    }
    if (entry.repo_url && !entry.path) {
      throw new Error(`${projectConfig}: eval_harnesses.${name}.path is required with repo_url`);
    }
  }
}

function validateStringArray(value: unknown, field: string, projectConfig: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${projectConfig}: auto_recovery.${field} must be a string[]`);
  }
}

export function validateAutoRecoveryConfig(
  projectJson: RawProjectJson,
  projectConfig: string,
): void {
  const cfg = projectJson.auto_recovery;
  if (!cfg) return;
  if (cfg.enabled !== undefined && typeof cfg.enabled !== 'boolean')
    throw new Error(`${projectConfig}: auto_recovery.enabled must be a boolean`);
  if (cfg.maxAttempts !== undefined && (!Number.isInteger(cfg.maxAttempts) || cfg.maxAttempts < 0))
    throw new Error(`${projectConfig}: auto_recovery.maxAttempts must be a non-negative integer`);
  validateStringArray(cfg.allowedSteps, 'allowedSteps', projectConfig);
  validateStringArray(cfg.allowedCategories, 'allowedCategories', projectConfig);
  if (
    cfg.allowedCategories?.some(
      (category) => !(FAILURE_CATEGORIES as readonly string[]).includes(category),
    )
  ) {
    throw new Error(
      `${projectConfig}: auto_recovery.allowedCategories contains an unknown failure category`,
    );
  }
  validateStringArray(cfg.disabled_patterns, 'disabled_patterns', projectConfig);
  if (cfg.llm?.enabled !== undefined && typeof cfg.llm.enabled !== 'boolean')
    throw new Error(`${projectConfig}: auto_recovery.llm.enabled must be a boolean`);
  if (
    cfg.llm?.dailyUsdCap !== undefined &&
    (typeof cfg.llm.dailyUsdCap !== 'number' ||
      !Number.isFinite(cfg.llm.dailyUsdCap) ||
      cfg.llm.dailyUsdCap < 0)
  )
    throw new Error(
      `${projectConfig}: auto_recovery.llm.dailyUsdCap must be a finite non-negative number`,
    );
  if (
    cfg.llm?.timeoutMs !== undefined &&
    (!Number.isInteger(cfg.llm.timeoutMs) || cfg.llm.timeoutMs < 0)
  )
    throw new Error(`${projectConfig}: auto_recovery.llm.timeoutMs must be a non-negative integer`);
}

export function validateBacklogConfig(projectJson: RawProjectJson, projectConfig: string): void {
  const cfg = projectJson.backlog;
  if (!cfg) return;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`${projectConfig}: backlog must be an object`);
  }
  if (cfg.auto_dispatch !== undefined) {
    if (typeof cfg.auto_dispatch !== 'object' || Array.isArray(cfg.auto_dispatch)) {
      throw new Error(`${projectConfig}: backlog.auto_dispatch must be an object`);
    }
    if (typeof cfg.auto_dispatch.enabled !== 'boolean') {
      throw new Error(`${projectConfig}: backlog.auto_dispatch.enabled must be a boolean`);
    }
  }
}

export function validatePrepareConfig(projectJson: RawProjectJson, projectConfig: string): void {
  const cfg = projectJson.prepare;
  if (!cfg) return;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`${projectConfig}: prepare must be an object`);
  }
  const profiles = cfg.profiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error(`${projectConfig}: prepare.profiles must be an object`);
  }
  const profileNames = Object.keys(profiles);
  if (profileNames.length === 0) {
    throw new Error(`${projectConfig}: prepare.profiles must define at least one profile`);
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(`${projectConfig}: prepare.profiles key "${name}" is invalid`);
    }
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error(`${projectConfig}: prepare.profiles.${name} must be an object`);
    }
    if (profile.label !== undefined && typeof profile.label !== 'string') {
      throw new Error(`${projectConfig}: prepare.profiles.${name}.label must be a string`);
    }
    if (profile.description !== undefined && typeof profile.description !== 'string') {
      throw new Error(`${projectConfig}: prepare.profiles.${name}.description must be a string`);
    }
    const phases = profile.phases;
    if (!Array.isArray(phases) || phases.length === 0) {
      throw new Error(`${projectConfig}: prepare.profiles.${name}.phases must be a non-empty array`);
    }
    for (const phase of phases) {
      if (!(PREPARE_PHASES as readonly string[]).includes(phase)) {
        throw new Error(
          `${projectConfig}: prepare.profiles.${name}.phases contains unknown phase "${phase}" (allowed: ${PREPARE_PHASES.join(', ')})`,
        );
      }
    }
    if (new Set(phases).size !== phases.length) {
      throw new Error(`${projectConfig}: prepare.profiles.${name}.phases contains duplicates`);
    }
    if (profile.hooks !== undefined) {
      if (typeof profile.hooks !== 'object' || Array.isArray(profile.hooks)) {
        throw new Error(`${projectConfig}: prepare.profiles.${name}.hooks must be an object`);
      }
      for (const [hookName, hookCmd] of Object.entries(profile.hooks)) {
        if (typeof hookCmd !== 'string' || !hookCmd.trim()) {
          throw new Error(
            `${projectConfig}: prepare.profiles.${name}.hooks.${hookName} must be a non-empty string`,
          );
        }
      }
    }
    const requires = profile.requires;
    if (requires !== undefined) {
      if (!Array.isArray(requires)) {
        throw new Error(`${projectConfig}: prepare.profiles.${name}.requires must be an array`);
      }
      for (const requirement of requires) {
        if (!(PREPARE_REQUIREMENTS as readonly string[]).includes(requirement)) {
          throw new Error(
            `${projectConfig}: prepare.profiles.${name}.requires contains unknown check "${requirement}" (allowed: ${PREPARE_REQUIREMENTS.join(', ')})`,
          );
        }
      }
      if (new Set(requires).size !== requires.length) {
        throw new Error(`${projectConfig}: prepare.profiles.${name}.requires contains duplicates`);
      }
    }
    if (profile.fallback !== undefined) {
      if (typeof profile.fallback !== 'string' || !(profile.fallback in profiles)) {
        throw new Error(
          `${projectConfig}: prepare.profiles.${name}.fallback must name an existing profile`,
        );
      }
      if (profile.fallback === name) {
        throw new Error(`${projectConfig}: prepare.profiles.${name}.fallback must not be itself`);
      }
    }
    if (Array.isArray(requires) && requires.length > 0 && !profile.fallback) {
      throw new Error(
        `${projectConfig}: prepare.profiles.${name} declares requires but no fallback profile`,
      );
    }
  }
  // Fallback chains must terminate. requires⇒fallback guarantees every chain
  // keeps extending until a profile with no requires; only a cycle violates that.
  for (const name of profileNames) {
    const seen = new Set<string>([name]);
    let current = profiles[name].fallback;
    while (current) {
      if (seen.has(current)) {
        throw new Error(
          `${projectConfig}: prepare.profiles fallback chain from "${name}" contains a cycle at "${current}"`,
        );
      }
      seen.add(current);
      current = profiles[current].fallback;
    }
  }
  if (cfg.default !== undefined) {
    if (typeof cfg.default !== 'string' || !(cfg.default in profiles)) {
      throw new Error(`${projectConfig}: prepare.default must name an existing profile`);
    }
  }
}

export function normalizeRawProjectBacklog(
  raw: RawProjectJson['backlog'],
): ProjectConfig['backlog'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const autoDispatch = raw.auto_dispatch;
  return {
    ...(autoDispatch && typeof autoDispatch === 'object' && !Array.isArray(autoDispatch)
      ? {
          autoDispatch: {
            ...(typeof autoDispatch.enabled === 'boolean' ? { enabled: autoDispatch.enabled } : {}),
          },
        }
      : {}),
  };
}

export function normalizeRawProjectPrepare(
  raw: RawProjectJson['prepare'],
  projectName?: string,
): ProjectConfig['prepare'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const profilesRaw = raw.profiles;
  if (!profilesRaw || typeof profilesRaw !== 'object' || Array.isArray(profilesRaw)) {
    return undefined;
  }
  const profiles: NonNullable<ProjectConfig['prepare']>['profiles'] = {};
  for (const [name, profile] of Object.entries(profilesRaw)) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
    const phases = Array.isArray(profile.phases)
      ? profile.phases.filter((p): p is PreparePhase =>
          (PREPARE_PHASES as readonly string[]).includes(String(p)),
        )
      : [];
    if (phases.length === 0) {
      // The fleet-status read path is lenient (unlike validatePrepareConfig in
      // loadProjectVars) — surface the drop so a phase typo doesn't just make
      // profile pills vanish from the wizard with no feedback.
      console.warn(
        `[config] project ${projectName ?? '<unknown>'}: prepare.profiles.${name} has no valid phases, skipping`,
      );
      continue;
    }
    profiles[name] = {
      phases,
      ...(typeof profile.label === 'string' ? { label: profile.label } : {}),
      ...(typeof profile.description === 'string' ? { description: profile.description } : {}),
      ...(profile.hooks && typeof profile.hooks === 'object' && !Array.isArray(profile.hooks)
        ? { hooks: profile.hooks }
        : {}),
      ...(Array.isArray(profile.requires)
        ? {
            requires: profile.requires.filter((r): r is PrepareRequirement =>
              (PREPARE_REQUIREMENTS as readonly string[]).includes(String(r)),
            ),
          }
        : {}),
      ...(typeof profile.fallback === 'string' ? { fallback: profile.fallback } : {}),
    };
  }
  if (Object.keys(profiles).length === 0) return undefined;
  return { ...(typeof raw.default === 'string' ? { default: raw.default } : {}), profiles };
}

export function normalizeRawProjectAutoRecovery(
  raw: RawProjectJson['auto_recovery'],
): ProjectConfig['autoRecovery'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return {
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    ...(Number.isInteger(raw.maxAttempts) ? { maxAttempts: raw.maxAttempts } : {}),
    ...(Array.isArray(raw.allowedSteps)
      ? {
          allowedSteps: raw.allowedSteps.filter((v: unknown): v is string => typeof v === 'string'),
        }
      : {}),
    ...(Array.isArray(raw.allowedCategories)
      ? {
          allowedCategories: raw.allowedCategories.filter(
            (v: unknown): v is any => typeof v === 'string',
          ),
        }
      : {}),
    ...(Array.isArray(raw.disabled_patterns)
      ? {
          disabledPatterns: raw.disabled_patterns.filter(
            (v: unknown): v is string => typeof v === 'string',
          ),
        }
      : {}),
    ...(raw.llm && typeof raw.llm === 'object' && !Array.isArray(raw.llm)
      ? {
          llm: {
            ...(typeof raw.llm.enabled === 'boolean' ? { enabled: raw.llm.enabled } : {}),
            ...(typeof raw.llm.dailyUsdCap === 'number' && Number.isFinite(raw.llm.dailyUsdCap)
              ? { dailyUsdCap: raw.llm.dailyUsdCap }
              : {}),
            ...(Number.isInteger(raw.llm.timeoutMs) ? { timeoutMs: raw.llm.timeoutMs } : {}),
          },
        }
      : {}),
  };
}

// ─── getProjectField ───

export function getProjectField(projectJson: RawProjectJson, dotpath: string): string {
  const raw = getProjectFieldRaw(projectJson, dotpath);
  return typeof raw === 'string' ? raw : '';
}

export function getProjectFieldRaw(projectJson: RawProjectJson, dotpath: string): unknown {
  let current: unknown = projectJson;
  for (const key of dotpath.split('.')) {
    if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Worker-repo task root: `task_dir` overrides `paths.artifact_dir`, then protocol default. */
export function resolveProjectTaskDirName(projectJson: RawProjectJson): string {
  const explicit = getProjectField(projectJson, 'task_dir');
  if (explicit) return explicit;
  const artifactDir = getProjectField(projectJson, 'paths.artifact_dir');
  if (artifactDir) return artifactDir;
  return DEFAULT_TASK_DIR;
}

export function isMockModeProject(projectJson?: RawProjectJson | null): boolean {
  return Boolean(projectJson?.external?.mock_mode);
}

export function getOrchestratorTaskRoot(
  projectName: string,
  projectJson?: RawProjectJson | null,
): string {
  if (isMockModeProject(projectJson)) {
    return path.join(farmslotRoot, '.sandbox', projectName, 'tasks');
  }
  return path.join(farmslotRoot, 'projects', projectName, 'tasks');
}

export function resolveTaskRelDir(
  taskFile: string,
  taskRoot: string,
  taskFilename = 'TASK.md',
): string | null {
  const normalizedTaskRoot = path.resolve(taskRoot);
  const normalizedTaskFile = path.resolve(taskFile);
  if (path.basename(normalizedTaskFile) !== taskFilename) return null;
  const relativeTaskPath = path.relative(normalizedTaskRoot, normalizedTaskFile);
  if (
    relativeTaskPath === '..' ||
    relativeTaskPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTaskPath)
  ) {
    return null;
  }
  const relativeTaskDir = path.dirname(relativeTaskPath);
  return relativeTaskDir === '.' ? '' : relativeTaskDir;
}

// ─── Resolve task directory paths for a slot ───

export interface TaskPaths {
  vars: SlotVars;
  taskDir: string;
  taskMdPath: string;
  signalPath: string;
}

export async function resolveTaskPaths(slotId: string, taskFile: string): Promise<TaskPaths> {
  const vars = await loadSlotVars(slotId);
  let taskDirName = DEFAULT_TASK_DIR;
  try {
    const pv = await loadProjectVars(vars.projectName);
    taskDirName = resolveProjectTaskDirName(pv.projectJson);
  } catch {
    /* use default */
  }
  const taskDir = path.join(vars.remoteRepo, taskDirName, taskFile);
  return {
    vars,
    taskDir,
    taskMdPath: path.join(taskDir, 'TASK.md'),
    signalPath: path.join(taskDir, 'SIGNAL.json'),
  };
}

// ─── Re-export paths for external use ───

export { farmslotRoot, poolDir, projectsDir };
