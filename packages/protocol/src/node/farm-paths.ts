import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLegacyStorageFacts } from './farm-paths-storage.js';
import { expandHome } from './farmslot-home.js';

export const FARM_INSTANCE_CLAIM = '.farmslot-instance';

export type FarmRole = 'gateway' | 'node';

export type FarmPathEnv = Readonly<Record<string, string | undefined>>;

export interface LegacyFarmStorageFacts {
  runBundles: string;
}

export interface ResolveFarmPathsOptions {
  home?: string;
  role: FarmRole;
  env?: FarmPathEnv;
  checkoutRoot?: string;
  agentRuntimeScripts?: string;
  userHome?: string;
  legacyFacts?: LegacyFarmStorageFacts;
  /** A marker read on the target by deployment tooling; null means absent. */
  instanceConfig?: InstanceConfig | null;
}

export interface FarmStatePaths {
  runs: string;
  taskPins: string;
  nativeSessions: string;
  reviewWorkspaces: string;
  sources: string;
  nodeLink: string;
  logs: string;
  tmp: string;
  cache: string;
  gatewayLock: string;
  sessionArchives: string;
  episodes: string;
  reviewWorkspaceSupport: string;
  browserCache: string;
  copilotRuntime: string;
  assessmentArtifacts: string;
  pressureHistory: string;
  intelligenceAudit: string;
  feedbackLedger: string;
  extraLogDirs: string[];
}

export interface GatewayFarmStatePaths extends FarmStatePaths {
  /** Legacy uses the backlog JSON file; layout 2 uses the backlog directory. */
  backlog: string;
  backlogFile: string;
  roadmap: string;
  workGraphs: string;
  copilot: string;
  assessments: string;
  analytics: string;
  backlogSpecs: string;
  refinementPrompts: string;
  dispatchQueue: string;
  statusFile: string;
  evalCaps: string;
  observabilityAgreement: string;
  backlogRefinementPrompts: string;
  resourceWatchState: string;
  capabilityStore: string;
}

export interface FarmCodePaths {
  checkout: string;
  agentRuntimeScripts: string;
  templateNode: string;
  node: string;
  cli: string;
  bin: string;
  support: string;
}

export interface FarmDataPaths {
  /** Legacy stores have no common data root; this is the selected farm home. */
  root: string;
  /** Legacy default candidate unless legacyFacts is supplied. Reports use resolveReportedFarmPaths. */
  runBundles: string;
  runArchive: string;
  taskPinsArchive: string;
  canary: string;
  datasets: string;
}

interface SharedFarmPaths {
  layout: 'legacy' | 2;
  instance: string;
  home: string;
  /** Per-store environment variable names actually honoured, for path reports. */
  envOverrides: string[];
  config: string;
  configFiles: {
    sources: string;
  };
  pool: string;
  projects: string;
  templateProjects: string;
  code: FarmCodePaths;
  backups: string;
  data: FarmDataPaths;
}

export interface NodeFarmPaths extends SharedFarmPaths {
  role: 'node';
  state: FarmStatePaths;
}

export interface GatewayFarmPaths extends SharedFarmPaths {
  role: 'gateway';
  state: GatewayFarmStatePaths;
}

export type FarmPaths = NodeFarmPaths | GatewayFarmPaths;

/** Addressable path leaves, including indexed path arrays. Metadata is never a path. */
export function farmPathEntries(paths: FarmPaths): [string, string][] {
  const roots = Object.fromEntries(
    Object.entries(paths).filter(
      ([key]) => !['layout', 'instance', 'role', 'envOverrides'].includes(key),
    ),
  );
  function entries(value: unknown, prefix: string): [string, string][] {
    if (typeof value === 'string') return [[prefix, value]];
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) =>
      entries(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return entries(roots, '');
}

export function resolveReportedFarmPaths(
  options: ResolveFarmPathsOptions & { role: 'node' },
): NodeFarmPaths;
export function resolveReportedFarmPaths(
  options: ResolveFarmPathsOptions & { role: 'gateway' },
): GatewayFarmPaths;
export function resolveReportedFarmPaths(options: ResolveFarmPathsOptions): FarmPaths;
/** Read storage authority outside the resolver before exposing an instance report. */
export function resolveReportedFarmPaths(options: ResolveFarmPathsOptions): FarmPaths {
  const paths = resolveFarmPaths(options);
  return paths.layout === 2
    ? paths
    : resolveFarmPaths({ ...options, legacyFacts: readLegacyStorageFacts(paths) });
}

export interface InstanceConfig {
  layout: 2;
  name?: string;
  dataRoot?: string;
  ports?: FarmInstancePorts;
}

export interface FarmInstancePorts {
  gateway?: number;
}

function isFarmInstancePorts(value: unknown): value is FarmInstancePorts {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (!('gateway' in value) ||
      (typeof value.gateway === 'number' &&
        Number.isInteger(value.gateway) &&
        value.gateway > 0 &&
        value.gateway <= 65535))
  );
}

function readInstanceConfig(home: string): InstanceConfig | undefined {
  let content: string;
  try {
    content = readFileSync(path.join(home, 'config', 'instance.json'), 'utf8');
  } catch (error) {
    // An absent marker is an unmigrated instance. Other read failures must be visible.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  return parseFarmInstanceConfig(JSON.parse(content), path.join(home, 'config', 'instance.json'));
}

/** Validate a target's marker before resolving its paths on the deploying host. */
export function parseFarmInstanceConfig(value: unknown, file: string): InstanceConfig {
  if (
    !value ||
    typeof value !== 'object' ||
    !('layout' in value) ||
    value.layout !== 2 ||
    ('name' in value && (typeof value.name !== 'string' || !value.name.trim())) ||
    ('dataRoot' in value && (typeof value.dataRoot !== 'string' || !value.dataRoot.trim())) ||
    ('ports' in value && !isFarmInstancePorts(value.ports))
  ) {
    throw new Error(`Invalid farm instance config: ${file}`);
  }
  return {
    layout: 2,
    ...('name' in value && typeof value.name === 'string' ? { name: value.name } : {}),
    ...('ports' in value && isFarmInstancePorts(value.ports) ? { ports: value.ports } : {}),
    ...('dataRoot' in value && typeof value.dataRoot === 'string'
      ? { dataRoot: value.dataRoot }
      : {}),
  };
}

export function resolveFarmPaths(
  options: ResolveFarmPathsOptions & { role: 'gateway' },
): GatewayFarmPaths;
export function resolveFarmPaths(
  options: ResolveFarmPathsOptions & { role: 'node' },
): NodeFarmPaths;
export function resolveFarmPaths(options: ResolveFarmPathsOptions): FarmPaths;
/**
 * Report one instance's paths without creating directories or discovering stores.
 * Only config/instance.json is read. Legacy selectors remain in place until migration.
 */
export function resolveFarmPaths(options: ResolveFarmPathsOptions): FarmPaths {
  const env = options.env ?? process.env;
  const selectedHome = expandHome(
    (options.home ?? env.FARMSLOT_HOME)?.trim() || path.join(homedir(), '.farmslot'),
  );
  const config =
    options.instanceConfig === undefined
      ? readInstanceConfig(selectedHome)
      : options.instanceConfig;
  const home = config ? path.resolve(selectedHome) : selectedHome;
  const instance = config?.name ?? path.basename(home).replace(/^\./u, '');
  const envOverrides: string[] = [];
  // Match each selector's own truthiness/nullish and path handling in legacy mode.
  function override(name: string, fallback: string, nullish = false): string {
    const value = env[name];
    if (nullish ? value !== undefined : !!value) {
      envOverrides.push(name);
      return value ?? fallback;
    }
    return fallback;
  }
  const atHome = (...parts: string[]) => path.join(home, ...parts);
  if (config) {
    const data = config.dataRoot ?? (env.FARMSLOT_DATA?.trim() || atHome('data'));
    const dataRoot = path.resolve(home, expandHome(data));
    const shared: SharedFarmPaths = {
      layout: 2,
      instance,
      home,
      envOverrides,
      config: atHome('config'),
      configFiles: { sources: atHome('config', 'sources.json') },
      pool: atHome('pool'),
      projects: atHome('projects'),
      templateProjects: atHome('projects'),
      code: {
        checkout: atHome('code', 'node'),
        agentRuntimeScripts:
          options.agentRuntimeScripts ??
          atHome('code', 'node', 'packages', 'agent-runtime', 'scripts'),
        templateNode: atHome('code', 'node'),
        node: atHome('code', 'node'),
        cli: atHome('code', 'cli'),
        bin: atHome('code', 'bin'),
        support: atHome('code', 'support'),
      },
      backups: atHome('backups'),
      data: {
        root: dataRoot,
        runBundles: path.join(dataRoot, 'run-bundles'),
        runArchive: path.join(dataRoot, 'run-archive'),
        taskPinsArchive: path.join(dataRoot, 'task-pins-archive'),
        canary: path.join(dataRoot, 'canary'),
        datasets: path.join(dataRoot, 'datasets'),
      },
    };
    const state: FarmStatePaths = {
      runs: atHome('state', 'runs'),
      taskPins: atHome('state', 'task-pins'),
      nativeSessions: atHome('state', 'native-sessions'),
      reviewWorkspaces: atHome('state', 'review-workspaces'),
      sources: atHome('state', 'sources'),
      nodeLink: atHome('state', 'node-link'),
      logs: atHome('state', 'logs'),
      tmp: atHome('state', 'tmp'),
      cache: atHome('state', 'cache'),
      gatewayLock: atHome('state', 'gateway.lock'),
      sessionArchives: atHome('state', 'runs', 'session-archives'),
      episodes: atHome('state', 'episodes'),
      reviewWorkspaceSupport: atHome('state', 'review-workspace-support'),
      browserCache: atHome('state', 'browser-cache'),
      copilotRuntime: atHome('state', 'copilot-runtime'),
      assessmentArtifacts: atHome('state', 'assessment-artifacts'),
      pressureHistory: atHome('state', 'pressure-history.json'),
      intelligenceAudit: atHome('state', 'logs', 'intelligence-actions'),
      feedbackLedger: atHome('state', 'feedback-ledger.json'),
      extraLogDirs: [],
    };
    return options.role === 'gateway'
      ? {
          ...shared,
          role: 'gateway',
          state: {
            ...state,
            backlog: atHome('state', 'backlog'),
            backlogFile: atHome('state', 'backlog', 'backlog.json'),
            roadmap: atHome('state', 'roadmap'),
            workGraphs: atHome('state', 'work-graphs'),
            copilot: atHome('state', 'copilot'),
            assessments: atHome('state', 'assessments'),
            analytics: atHome('state', 'analytics'),
            backlogSpecs: atHome('state', 'backlog', 'specs'),
            refinementPrompts: atHome('state', 'roadmap', 'refinement-prompts'),
            dispatchQueue: atHome('state', 'dispatch-queue.json'),
            statusFile: atHome('state', 'status.json'),
            evalCaps: atHome('state', 'eval-suite-caps.json'),
            observabilityAgreement: atHome('state', 'observability-agreement'),
            backlogRefinementPrompts: atHome('state', 'backlog', 'refinement-prompts'),
            resourceWatchState: atHome('state', 'cache', 'resource-watch-state.json'),
            capabilityStore: atHome('state', 'runtime-capabilities.json'),
          },
        }
      : { ...shared, role: 'node', state };
  }

  // Source and dist have the same depth. No marker scans or workspace-state reads.
  const checkout =
    options.checkoutRoot ?? (env.FARMSLOT_ROOT || undefined) ?? defaultCheckoutRoot();
  const root = path.resolve(checkout);
  const userHome = options.userHome ?? homedir();
  const pool = override('FARMSLOT_POOL_DIR', path.join(root, 'pool'));
  if (env.FARMSLOT_PROJECTS_DIR) envOverrides.push('FARMSLOT_PROJECTS_DIR');
  const runs = override('FARMSLOT_RUNS_DIR', path.join(root, '.runs'));
  const native = path.resolve(
    override('FARMSLOT_NATIVE_STATE_DIR', atHome('native-sessions'), true),
  );
  const shared: SharedFarmPaths = {
    layout: 'legacy',
    instance,
    home,
    envOverrides,
    config: home,
    configFiles: { sources: override('FARMSLOT_SOURCES_CONFIG', atHome('sources.json'), true) },
    pool: env.FARMSLOT_POOL_DIR ? path.resolve(pool) : pool,
    projects: env.FARMSLOT_PROJECTS_DIR
      ? path.resolve(env.FARMSLOT_PROJECTS_DIR)
      : path.join(root, 'projects'),
    templateProjects: path.join(root, 'projects'),
    code: {
      checkout: root,
      agentRuntimeScripts:
        options.agentRuntimeScripts ??
        path.join(
          root,
          installedProtocol()
            ? 'node_modules/@farmslot/agent-runtime/scripts'
            : 'packages/agent-runtime/scripts',
        ),
      templateNode: env.FARMSLOT_WORKSPACE
        ? path.resolve(expandHome(env.FARMSLOT_WORKSPACE))
        : root,
      node: env.FARMSLOT_WORKSPACE ? path.resolve(expandHome(env.FARMSLOT_WORKSPACE)) : root,
      cli: path.join(userHome, '.local', 'share', 'farmslot-cli'),
      bin: path.join(userHome, '.local', 'bin'),
      support: path.join(homedir(), 'farmslot-node', 'support'),
    },
    backups: path.join(root, '.backups'),
    data: {
      root: home,
      runBundles:
        options.legacyFacts?.runBundles ??
        path.join(
          options.home !== undefined || env.FARMSLOT_HOME || !env.FARMSLOT_RUNS_DIR
            ? home
            : path.join(runs, 'bundle-home'),
          'run-bundles',
        ),
      runArchive: override('FARMSLOT_RUN_ARCHIVE_ROOT', atHome('run-archive'), true),
      taskPinsArchive: atHome('task-pins-archive'),
      canary: override('CANARY_HOME', path.join(homedir(), 'farmslot-canary')),
      datasets: atHome('datasets'),
    },
  };
  const state: FarmStatePaths = {
    runs,
    taskPins: path.resolve(home, 'task-pins'),
    nativeSessions: native,
    reviewWorkspaces: path.join(path.dirname(native), 'review-workspaces'),
    sources: atHome('sources'),
    nodeLink: atHome('node-link'),
    logs: env.FARMSLOT_LOG_DIR
      ? path.resolve(override('FARMSLOT_LOG_DIR', atHome('logs')))
      : atHome('logs'),
    tmp: '/tmp/farmslot-prepare',
    cache: path.join(override('FARMSLOT_DIR', root), '.farm-cache'),
    gatewayLock: path.resolve(root, '.runs', `gateway-${Number(env.GATEWAY_PORT) || 7777}.pid`),
    sessionArchives: path.join(runs, 'session-archives'),
    episodes: path.join(runs, 'episodes'),
    reviewWorkspaceSupport: path.join(runs, 'review-workspace-support'),
    browserCache: env.RECIPE_HARNESS_BROWSER_CACHE
      ? path.resolve(override('RECIPE_HARNESS_BROWSER_CACHE', ''))
      : path.join(
          env.XDG_CACHE_HOME || path.join(homedir(), '.cache'),
          'farmslot',
          'browser-probe.json',
        ),
    copilotRuntime: atHome('copilot-runtime'),
    assessmentArtifacts: home,
    pressureHistory: atHome('state', 'pressure-history.json'),
    intelligenceAudit: override(
      'FARMSLOT_INTELLIGENCE_AUDIT_DIR',
      atHome('logs', 'intelligence-actions'),
      true,
    ),
    feedbackLedger: env.FARMSLOT_FEEDBACK_LEDGER?.trim()
      ? override('FARMSLOT_FEEDBACK_LEDGER', '').trim()
      : atHome('state', 'feedback-ledger.json'),
    extraLogDirs: override('FARMSLOT_EXTRA_LOG_DIRS', '')
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.resolve(entry)),
  };
  return options.role === 'gateway'
    ? {
        ...shared,
        role: 'gateway',
        state: {
          ...state,
          backlog: override('FARMSLOT_BACKLOG_FILE', path.join(root, '.backlog.json')),
          backlogFile: env.FARMSLOT_BACKLOG_FILE || path.join(root, '.backlog.json'),
          roadmap: override('FARMSLOT_ROADMAP_DIR', path.join(root, '.roadmap'), true),
          workGraphs: override('FARMSLOT_WORK_GRAPH_DIR', path.join(root, '.work-graphs')),
          copilot: override('FARMSLOT_COPILOT_DIR', path.join(root, 'copilot'), true),
          assessments: atHome('assessments'),
          analytics: override('FARMSLOT_ANALYTICS_DIR', path.join(root, '.runs', 'analytics')),
          backlogSpecs: override(
            'FARMSLOT_BACKLOG_SPEC_DIR',
            path.join(root, '.backlog', 'specs'),
            true,
          ),
          refinementPrompts: override(
            'FARMSLOT_ROADMAP_REFINEMENT_PROMPT_DIR',
            path.join(
              env.FARMSLOT_ROADMAP_DIR ?? path.join(root, '.roadmap'),
              'refinement-prompts',
            ),
            true,
          ),
          dispatchQueue: override(
            'FARMSLOT_DISPATCH_QUEUE_FILE',
            path.join(root, '.dispatch-queue.json'),
          ),
          statusFile: path.join(root, '.farm-status.json'),
          evalCaps: override(
            'FARMSLOT_EVAL_SUITE_CAP_FILE',
            path.join(root, '.eval-suite-caps.json'),
          ),
          observabilityAgreement: override(
            'FARMSLOT_OBSERVABILITY_AGREEMENT_DIR',
            path.join(root, '.runs', 'observability-agreement'),
          ),
          backlogRefinementPrompts: override(
            'FARMSLOT_BACKLOG_REFINEMENT_PROMPT_DIR',
            path.join(root, '.backlog', 'refinement-prompts'),
            true,
          ),
          resourceWatchState: override(
            'FARMSLOT_RESOURCE_WATCH_STATE_FILE',
            path.join(root, '.farm-cache', 'resource-watch-state.json'),
            true,
          ),
          capabilityStore: override(
            'FARMSLOT_CAPABILITY_STORE_FILE',
            path.join(
              env.FARMSLOT_ROOT?.trim() || process.cwd(),
              '.runs',
              `runtime-capabilities-${env.GATEWAY_PORT?.trim() || '7777'}.json`,
            ),
          ),
        },
      }
    : { ...shared, role: 'node', state };
}

// A process may switch homes during a test or CLI invocation. Include the marker timestamp
// and environment in the key so neither a migration nor a changed override leaves stale roots.
const processPaths = new Map<string, FarmPaths>();

export function currentFarmPaths(
  role: 'gateway',
  env?: FarmPathEnv,
  checkoutRoot?: string,
): GatewayFarmPaths;
export function currentFarmPaths(
  role: 'node',
  env?: FarmPathEnv,
  checkoutRoot?: string,
): NodeFarmPaths;
export function currentFarmPaths(
  role: FarmRole,
  env: FarmPathEnv = process.env,
  checkoutRoot?: string,
): FarmPaths {
  const home = expandHome(env.FARMSLOT_HOME?.trim() || path.join(homedir(), '.farmslot'));
  let marker = 'absent';
  try {
    const info = statSync(path.join(home, 'config', 'instance.json'));
    marker = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
  } catch (error) {
    // A missing marker selects legacy; permission and other filesystem errors must surface.
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const selectedEnv = Object.entries(env).filter(
    ([name]) =>
      name.startsWith('FARMSLOT_') ||
      name === 'GATEWAY_PORT' ||
      name === 'CANARY_HOME' ||
      name === 'RECIPE_HARNESS_BROWSER_CACHE' ||
      name === 'XDG_CACHE_HOME',
  );
  const key = JSON.stringify([
    role,
    home,
    homedir(),
    marker,
    checkoutRoot,
    process.cwd(),
    selectedEnv,
  ]);
  let paths = processPaths.get(key);
  if (!paths) {
    paths = resolveFarmPaths({ role, env, checkoutRoot });
    processPaths.set(key, paths);
  }
  return paths;
}

/** Older nodes have no report. Keep their shell-expanded legacy paths in one place.
 * Template expansion historically honors WORKSPACE; helper execution does not.
 */
export function legacyRemoteFarmPaths(
  env: FarmPathEnv = {},
  discoveredCheckout?: string,
  agentRuntimeScripts?: string,
): {
  home: string;
  pool: string;
  projects: string;
  code: FarmCodePaths;
  state: { runs: string; tmp: string };
} {
  const node = discoveredCheckout ?? path.posix.join(env.HOME?.trim() || '~', 'farmslot-node');
  return {
    home: env.FARMSLOT_HOME?.trim() || '~/.farmslot',
    pool: env.FARMSLOT_POOL_DIR || path.posix.join(node, 'pool'),
    projects: env.FARMSLOT_PROJECTS_DIR || path.posix.join(node, 'projects'),
    code: {
      checkout: node,
      agentRuntimeScripts:
        agentRuntimeScripts ??
        path.posix.join(node, 'node_modules/@farmslot/agent-runtime/scripts'),
      node,
      templateNode: env.FARMSLOT_WORKSPACE?.trim() || node,
      cli: '~/.local/share/farmslot-cli',
      bin: '~/.local/bin',
      // Remote bundles are deployed beside the selected node checkout; the local
      // legacy selector uses the user-home node install even from an operator checkout.
      support: path.posix.join(node, 'support'),
    },
    state: {
      runs: env.FARMSLOT_RUNS_DIR || path.posix.join(node, '.runs'),
      tmp: '/tmp/farmslot-prepare',
    },
  };
}

/** Validate the optional wire report without trusting a cast at the RPC boundary. */
export function isNodeFarmPaths(value: unknown): value is NodeFarmPaths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const stringFields = (item: unknown, names: string[]): boolean => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    return names.every((name) => {
      const field: unknown = Reflect.get(item, name);
      return typeof field === 'string' && !field.includes('\0');
    });
  };
  const strings = (item: unknown): boolean =>
    Array.isArray(item) && item.every((entry) => typeof entry === 'string');
  return (
    fields.role === 'node' &&
    (fields.layout === 'legacy' || fields.layout === 2) &&
    stringFields(value, [
      'instance',
      'home',
      'config',
      'pool',
      'projects',
      'templateProjects',
      'backups',
    ]) &&
    stringFields(fields.configFiles, ['sources']) &&
    stringFields(fields.code, [
      'checkout',
      'agentRuntimeScripts',
      'templateNode',
      'node',
      'cli',
      'bin',
      'support',
    ]) &&
    stringFields(fields.data, [
      'root',
      'runBundles',
      'runArchive',
      'taskPinsArchive',
      'canary',
      'datasets',
    ]) &&
    stringFields(fields.state, [
      'runs',
      'taskPins',
      'nativeSessions',
      'reviewWorkspaces',
      'sources',
      'nodeLink',
      'logs',
      'tmp',
      'cache',
      'gatewayLock',
      'sessionArchives',
      'episodes',
      'reviewWorkspaceSupport',
      'browserCache',
      'copilotRuntime',
      'assessmentArtifacts',
      'pressureHistory',
      'intelligenceAudit',
      'feedbackLedger',
    ]) &&
    strings(fields.envOverrides) &&
    fields.state !== null &&
    typeof fields.state === 'object' &&
    strings(Reflect.get(fields.state, 'extraLogDirs'))
  );
}

// A standalone service installs the protocol as a scoped dependency. Its package
// location tells us the installation root without reading a second marker or package.
function installedProtocol(): boolean {
  const packageRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  return (
    path.basename(path.dirname(packageRoot)) === '@farmslot' &&
    path.basename(path.dirname(path.dirname(packageRoot))) === 'node_modules'
  );
}
function defaultCheckoutRoot(): string {
  return fileURLToPath(
    new URL(installedProtocol() ? '../../../../../' : '../../../../', import.meta.url),
  );
}
