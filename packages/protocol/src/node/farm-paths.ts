import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProjectsDir } from './farm-layout.js';
import { farmslotHome } from './farmslot-home.js';

export type FarmRole = 'gateway' | 'node';

export interface ResolveFarmPathsOptions {
  home?: string;
  role: FarmRole;
  env?: NodeJS.ProcessEnv;
  checkoutRoot?: string;
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
}

export interface GatewayFarmStatePaths extends FarmStatePaths {
  /** Legacy uses the backlog JSON file; layout 2 uses the backlog directory. */
  backlog: string;
  roadmap: string;
  workGraphs: string;
  copilot: string;
  assessments: string;
  analytics: string;
}

export interface FarmCodePaths {
  node: string;
  cli: string;
  bin: string;
  support: string;
}

export interface FarmDataPaths {
  /** Legacy stores have no common data root; this is the selected farm home. */
  root: string;
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
  /** Per-store environment variable names actually honoured, for migration warnings. */
  envOverrides: string[];
  config: string;
  pool: string;
  projects: string;
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

interface InstanceConfig {
  layout: 2;
  name?: string;
  dataRoot?: string;
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
  const value: unknown = JSON.parse(content);
  if (
    !value ||
    typeof value !== 'object' ||
    !('layout' in value) ||
    value.layout !== 2 ||
    ('name' in value && (typeof value.name !== 'string' || !value.name.trim())) ||
    ('dataRoot' in value && (typeof value.dataRoot !== 'string' || !value.dataRoot.trim()))
  ) {
    throw new Error(`Invalid farm instance config: ${path.join(home, 'config', 'instance.json')}`);
  }
  return {
    layout: 2,
    ...('name' in value && typeof value.name === 'string' ? { name: value.name } : {}),
    ...('dataRoot' in value && typeof value.dataRoot === 'string'
      ? { dataRoot: value.dataRoot }
      : {}),
  };
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/') ? path.join(homedir(), value.slice(1)) : value;
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
  const selectedHome =
    options.home === undefined ? farmslotHome(env) : farmslotHome({ FARMSLOT_HOME: options.home });
  const config = readInstanceConfig(selectedHome);
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
      pool: atHome('pool'),
      projects: atHome('projects'),
      code: {
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
    };
    return options.role === 'gateway'
      ? {
          ...shared,
          role: 'gateway',
          state: {
            ...state,
            backlog: atHome('state', 'backlog'),
            roadmap: atHome('state', 'roadmap'),
            workGraphs: atHome('state', 'work-graphs'),
            copilot: atHome('state', 'copilot'),
            assessments: atHome('state', 'assessments'),
            analytics: atHome('state', 'analytics'),
          },
        }
      : { ...shared, role: 'node', state };
  }

  // Source and dist have the same depth. No marker scans or workspace-state reads.
  const checkout =
    options.checkoutRoot ??
    env.FARMSLOT_ROOT ??
    fileURLToPath(new URL('../../../../', import.meta.url));
  const root = path.resolve(checkout);
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
    pool: env.FARMSLOT_POOL_DIR ? path.resolve(pool) : pool,
    projects: resolveProjectsDir(root, env),
    code: {
      node: env.FARMSLOT_WORKSPACE ? path.resolve(expandHome(env.FARMSLOT_WORKSPACE)) : root,
      cli: path.join(homedir(), '.local', 'share', 'farmslot-cli'),
      bin: path.join(homedir(), '.local', 'bin'),
      support: path.join(homedir(), 'farmslot-node', 'support'),
    },
    backups: path.join(root, '.backups'),
    data: {
      root: home,
      // This reports the candidate only. Existing bundle-store.json bindings and retention
      // config can select another store; reading them would violate the resolver's I/O contract.
      runBundles: path.join(
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
  };
  return options.role === 'gateway'
    ? {
        ...shared,
        role: 'gateway',
        state: {
          ...state,
          backlog: override('FARMSLOT_BACKLOG_FILE', path.join(root, '.backlog.json')),
          roadmap: override('FARMSLOT_ROADMAP_DIR', path.join(root, '.roadmap'), true),
          workGraphs: override('FARMSLOT_WORK_GRAPH_DIR', path.join(root, '.work-graphs')),
          copilot: override('FARMSLOT_COPILOT_DIR', path.join(root, 'copilot'), true),
          assessments: atHome('assessments'),
          analytics: override('FARMSLOT_ANALYTICS_DIR', path.join(root, '.runs', 'analytics')),
        },
      }
    : { ...shared, role: 'node', state };
}
