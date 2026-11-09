import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveFarmPaths, type FarmPaths } from '../../src/node/farm-paths.js';
import { farmslotHome } from '../../src/node/farmslot-home.js';
import { resolveProjectsDir } from '../../src/node/farm-layout.js';
import { resolveSlotPoolDir } from '../../src/node/slot-by-repo.js';

function fixture(t: TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), 'farm-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function instance(home: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(path.join(home, 'config'), { recursive: true });
  writeFileSync(
    path.join(home, 'config', 'instance.json'),
    JSON.stringify({ layout: 2, ...extra }),
  );
}

function entries(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    entries(child, prefix ? `${prefix}.${key}` : key),
  );
}

function pathEntries(paths: FarmPaths): [string, string][] {
  const { home, config, pool, projects, code, state, backups, data } = paths;
  return entries({ home, config, pool, projects, code, state, backups, data });
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

// Import the real selectors in an ordinary process so gateway test-only isolation does
// not replace their production defaults. Every selected root and HOME is temporary.
function realSelectors(
  checkout: string,
  machineHome: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (
      key.startsWith('FARMSLOT_') ||
      key === 'NODE_TEST_CONTEXT' ||
      key === 'GATEWAY_PORT' ||
      key === 'CANARY_HOME'
    )
      delete childEnv[key];
  }
  Object.assign(childEnv, env, {
    HOME: machineHome,
    FARMSLOT_ROOT: checkout,
    TSX_TSCONFIG_PATH: path.join(repo, 'services/gateway/tsconfig.json'),
  });
  const source = `
    import { farmslotHome } from ${JSON.stringify(path.join(repo, 'packages/protocol/src/node/farmslot-home.ts'))};
    import { resolveProjectsDir } from ${JSON.stringify(path.join(repo, 'packages/protocol/src/node/farm-layout.ts'))};
    import { resolveSlotPoolDir } from ${JSON.stringify(path.join(repo, 'packages/protocol/src/node/slot-by-repo.ts'))};
    import { resolveRunsDir } from ${JSON.stringify(path.join(repo, 'packages/run-bundle/src/paths.ts'))};
    import { runArchiveRoot } from ${JSON.stringify(path.join(repo, 'services/gateway/src/runs/storage-archive.ts'))};
    import { NODE_SUPPORT_ROOT } from ${JSON.stringify(path.join(repo, 'services/gateway/src/runners/runner-observability.ts'))};
    import { runBundleHome } from ${JSON.stringify(path.join(repo, 'services/gateway/src/run-completion/retained-artifacts.ts'))};
    import { runsDirectory } from ${JSON.stringify(path.join(repo, 'services/gateway/src/runs/store.ts'))};
    import { getCopilotDir } from ${JSON.stringify(path.join(repo, 'services/gateway/src/chat/chat-memory.ts'))};
    import { homedir } from 'node:os';
    import path from 'node:path';
    const root = process.env.FARMSLOT_ROOT;
    console.log(JSON.stringify({
      home: farmslotHome(), projects: resolveProjectsDir(root), pool: resolveSlotPoolDir().dir,
      libraryRuns: resolveRunsDir(root), gatewayRuns: runsDirectory(), archive: runArchiveRoot(),
      support: path.join(homedir(), NODE_SUPPORT_ROOT.slice(2)),
      bundles: path.join(runBundleHome(), 'run-bundles'), copilot: getCopilotDir(),
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    {
      cwd: repo,
      env: childEnv,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`,
  );
  const value: unknown = JSON.parse(result.stdout);
  assert.ok(value && typeof value === 'object');
  const parsed: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    assert.equal(typeof item, 'string');
    if (typeof item === 'string') parsed[key] = item;
  }
  return parsed;
}

for (const shape of ['gateway', 'node'] as const) {
  test(`legacy ${shape} paths equal today's selectors`, (t) => {
    const root = fixture(t);
    const checkout = path.join(root, 'checkout');
    const machineHome = path.join(root, 'machine-home');
    for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
      const file = path.join(checkout, marker);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, marker.endsWith('.json') ? '{}' : '');
    }
    mkdirSync(machineHome);
    const workspace = path.join(root, 'farmslot-node-dev');
    // code-refs.md:38-39,52: deployed pool env explicitly supplies all three roots.
    const env: NodeJS.ProcessEnv =
      shape === 'gateway'
        ? { FARMSLOT_HOME: path.join(root, 'home'), FARMSLOT_ROOT: checkout }
        : {
            FARMSLOT_HOME: '~/.farmslot-dev',
            FARMSLOT_ROOT: checkout,
            FARMSLOT_WORKSPACE: workspace,
            FARMSLOT_POOL_DIR: path.join(workspace, 'pool'),
            FARMSLOT_PROJECTS_DIR: path.join(workspace, 'projects'),
          };
    // farmslotHome uses os.homedir, so the parent and real-selector child use the same temp HOME.
    const previousHome = process.env.HOME;
    process.env.HOME = machineHome;
    t.after(() => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    });
    const paths = resolveFarmPaths({ role: 'gateway', env, checkoutRoot: checkout });
    const real = realSelectors(checkout, machineHome, env);
    const home = farmslotHome(env);
    assert.equal(paths.home, real.home);
    assert.equal(paths.home, home);
    assert.equal(paths.projects, real.projects);
    assert.equal(paths.projects, resolveProjectsDir(checkout, env));
    assert.equal(paths.pool, real.pool);
    assert.equal(paths.pool, resolveSlotPoolDir(env)?.dir);
    assert.equal(paths.state.runs, real.gatewayRuns);
    assert.equal(paths.state.runs, real.libraryRuns);
    assert.equal(paths.data.runBundles, real.bundles);
    assert.equal(paths.data.runArchive, real.archive);
    assert.equal(paths.code.support, real.support);
    assert.equal(paths.state.copilot, real.copilot);

    // Non-exported selectors are mirrored below, with their source locations.
    const expected = {
      home,
      config: home,
      // packages/slot-config/src/config.ts:75, poolDir is private.
      pool: env.FARMSLOT_POOL_DIR
        ? path.resolve(env.FARMSLOT_POOL_DIR)
        : path.join(checkout, 'pool'),
      projects: resolveProjectsDir(checkout, env),
      code: {
        // Machine workspace: packages/slot-config/src/hooks.ts:128; local checkout otherwise.
        node: env.FARMSLOT_WORKSPACE ?? checkout,
        cli: path.join(machineHome, '.local/share/farmslot-cli'), // scripts/lib/node-cli-refresh.sh:26
        bin: path.join(machineHome, '.local/bin'), // scripts/lib/node-cli-refresh.sh:178
        support: real.support,
      },
      state: {
        runs: real.gatewayRuns,
        taskPins: path.resolve(home, 'task-pins'), // packages/agent-runtime/src/task-init/execution-provenance.ts:145
        nativeSessions: path.resolve(home, 'native-sessions'), // packages/agent-runtime/src/native/client.ts:59
        reviewWorkspaces: path.join(home, 'review-workspaces'), // services/gateway/src/review-workspaces/workspace.ts:230
        sources: path.join(home, 'sources'), // services/gateway/src/sources/runtime.ts:115
        nodeLink: path.join(home, 'node-link'), // services/node/src/index.ts:255
        logs: path.join(home, 'logs'), // services/gateway/src/observability/log-registry.ts:95
        tmp: '/tmp/farmslot-prepare', // services/gateway/src/methods/slot/prepare-command.ts:725
        cache: path.join(checkout, '.farm-cache'), // services/gateway/src/core/farm-cache.ts:14
        gatewayLock: path.join(checkout, '.runs/gateway-7777.pid'), // services/gateway/src/index.ts:199
        backlog: path.join(checkout, '.backlog.json'), // services/gateway/src/backlog/store.ts:203
        roadmap: path.join(checkout, '.roadmap'), // services/gateway/src/roadmap/store.ts:88
        workGraphs: path.join(checkout, '.work-graphs'), // services/gateway/src/work-graph/store.ts:92
        copilot: real.copilot,
        assessments: path.join(home, 'assessments'), // services/gateway/src/assessment/store.ts:56
        analytics: path.join(checkout, '.runs/analytics'), // services/gateway/src/runs/analytics.ts:40
      },
      backups: path.join(checkout, '.backups'), // scripts/backup-runs.sh:6; other backup producers differ.
      data: {
        root: home, // No existing aggregate legacy data root.
        runBundles: real.bundles,
        runArchive: real.archive,
        taskPinsArchive: path.join(home, 'task-pins-archive'), // Reserved; no current selector.
        canary: path.join(machineHome, 'farmslot-canary'), // scripts/runner-validation/canary/nightly.sh:31
        datasets: path.join(home, 'datasets'), // Reserved; no current selector.
      },
    };
    assert.deepEqual(pathEntries(paths), entries(expected));
    assert.deepEqual(
      paths.envOverrides,
      shape === 'gateway' ? [] : ['FARMSLOT_POOL_DIR', 'FARMSLOT_PROJECTS_DIR'],
    );
    assert.equal(paths.layout, 'legacy');
  });
}

test("legacy per-store overrides retain each selector's path handling and are reported", (t) => {
  const home = fixture(t);
  const env = {
    FARMSLOT_HOME: home,
    FARMSLOT_POOL_DIR: 'relative/pool',
    FARMSLOT_PROJECTS_DIR: '~/projects',
    FARMSLOT_RUNS_DIR: 'relative/runs',
    FARMSLOT_NATIVE_STATE_DIR: 'relative/native',
    FARMSLOT_RUN_ARCHIVE_ROOT: '~/archive',
    FARMSLOT_LOG_DIR: '~/logs',
    FARMSLOT_DIR: 'relative/cache',
    FARMSLOT_BACKLOG_FILE: 'relative/backlog.json',
    FARMSLOT_ROADMAP_DIR: '~/roadmap',
    FARMSLOT_WORK_GRAPH_DIR: 'relative/graphs',
    FARMSLOT_COPILOT_DIR: '~/copilot',
    FARMSLOT_ANALYTICS_DIR: 'relative/analytics',
    CANARY_HOME: 'relative/canary',
    GATEWAY_PORT: '8812',
  };
  const paths = resolveFarmPaths({ role: 'gateway', env, checkoutRoot: home });
  assert.equal(paths.pool, path.resolve(env.FARMSLOT_POOL_DIR));
  assert.equal(paths.projects, resolveProjectsDir(home, env));
  assert.equal(paths.state.runs, env.FARMSLOT_RUNS_DIR); // G/runs/store.ts:143 returns raw, B/paths.ts:31 resolves.
  assert.equal(paths.state.nativeSessions, path.resolve(env.FARMSLOT_NATIVE_STATE_DIR));
  assert.equal(
    paths.state.reviewWorkspaces,
    path.join(path.dirname(path.resolve(env.FARMSLOT_NATIVE_STATE_DIR)), 'review-workspaces'),
  );
  assert.equal(paths.state.logs, path.resolve(env.FARMSLOT_LOG_DIR));
  assert.equal(paths.state.cache, path.join(env.FARMSLOT_DIR, '.farm-cache'));
  assert.equal(paths.state.gatewayLock, path.join(home, '.runs/gateway-8812.pid'));
  assert.equal(paths.data.runArchive, env.FARMSLOT_RUN_ARCHIVE_ROOT);
  assert.equal(paths.data.canary, env.CANARY_HOME);
  assert.deepEqual(
    [
      paths.state.backlog,
      paths.state.roadmap,
      paths.state.workGraphs,
      paths.state.copilot,
      paths.state.analytics,
    ],
    [
      env.FARMSLOT_BACKLOG_FILE,
      env.FARMSLOT_ROADMAP_DIR,
      env.FARMSLOT_WORK_GRAPH_DIR,
      env.FARMSLOT_COPILOT_DIR,
      env.FARMSLOT_ANALYTICS_DIR,
    ],
  );
  assert.deepEqual(
    [...paths.envOverrides].sort(),
    Object.keys(env)
      .filter((key) => !['FARMSLOT_HOME', 'GATEWAY_PORT'].includes(key))
      .sort(),
  );
});

test('legacy bundle-home fallback follows runs only when no home was supplied', (t) => {
  const root = fixture(t);
  const env = { FARMSLOT_RUNS_DIR: path.join(root, 'runs') };
  // services/gateway/src/run-completion/retained-artifacts.ts:152
  assert.equal(
    resolveFarmPaths({ home: root, role: 'node', env }).data.runBundles,
    path.join(root, 'run-bundles'),
  );
  // Avoid the real default home by setting HOME to a temporary directory.
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  assert.equal(
    resolveFarmPaths({ role: 'node', env }).data.runBundles,
    path.join(env.FARMSLOT_RUNS_DIR, 'bundle-home/run-bundles'),
  );
});

test('layout 2 has every Amendment 6 path under home or data, with root precedence', (t) => {
  const root = fixture(t);
  const home = path.join(root, '.instance');
  instance(home, { name: 'label/never-a-path' });
  const paths = resolveFarmPaths({ home, role: 'gateway', env: {} });
  assert.equal(paths.layout, 2);
  assert.equal(paths.instance, 'label/never-a-path');
  assert.equal(paths.data.root, path.join(home, 'data'));
  assert.deepEqual(paths.code, {
    node: path.join(home, 'code/node'),
    cli: path.join(home, 'code/cli'),
    bin: path.join(home, 'code/bin'),
    support: path.join(home, 'code/support'),
  });
  assert.deepEqual(paths.state, {
    runs: path.join(home, 'state/runs'),
    taskPins: path.join(home, 'state/task-pins'),
    nativeSessions: path.join(home, 'state/native-sessions'),
    reviewWorkspaces: path.join(home, 'state/review-workspaces'),
    sources: path.join(home, 'state/sources'),
    nodeLink: path.join(home, 'state/node-link'),
    logs: path.join(home, 'state/logs'),
    tmp: path.join(home, 'state/tmp'),
    cache: path.join(home, 'state/cache'),
    gatewayLock: path.join(home, 'state/gateway.lock'),
    backlog: path.join(home, 'state/backlog'),
    roadmap: path.join(home, 'state/roadmap'),
    workGraphs: path.join(home, 'state/work-graphs'),
    copilot: path.join(home, 'state/copilot'),
    assessments: path.join(home, 'state/assessments'),
    analytics: path.join(home, 'state/analytics'),
  });
  assert.deepEqual(paths.data, {
    root: path.join(home, 'data'),
    runBundles: path.join(home, 'data/run-bundles'),
    runArchive: path.join(home, 'data/run-archive'),
    taskPinsArchive: path.join(home, 'data/task-pins-archive'),
    canary: path.join(home, 'data/canary'),
    datasets: path.join(home, 'data/datasets'),
  });
  assert.equal(paths.config, path.join(home, 'config'));
  assert.equal(paths.pool, path.join(home, 'pool'));
  assert.equal(paths.projects, path.join(home, 'projects'));
  assert.equal(paths.backups, path.join(home, 'backups'));
  for (const [key, value] of pathEntries(paths)) assert.ok(inside(value, home), `${key}: ${value}`);
  const external = path.join(root, 'volume/instance');
  const fromEnv = resolveFarmPaths({
    home,
    role: 'gateway',
    env: { FARMSLOT_DATA: external, FARMSLOT_POOL_DIR: '/ignored' },
  });
  assert.equal(fromEnv.data.root, external);
  assert.deepEqual(fromEnv.envOverrides, []);
  for (const [key, value] of entries(fromEnv.data)) assert.ok(inside(value, external), key);
  instance(home, { dataRoot: path.join(root, 'configured') });
  assert.equal(
    resolveFarmPaths({ home, role: 'node', env: { FARMSLOT_DATA: external } }).data.root,
    path.join(root, 'configured'),
  );
});

test('two layout 2 instances and their subdirectories on a shared data volume are disjoint', (t) => {
  const root = fixture(t);
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  instance(a, { dataRoot: path.join(root, 'volume/a') });
  instance(b, { dataRoot: path.join(root, 'volume/b') });
  const pathsA = resolveFarmPaths({ home: a, role: 'gateway', env: {} });
  const pathsB = resolveFarmPaths({ home: b, role: 'gateway', env: {} });
  for (const [keyA, valueA] of pathEntries(pathsA)) {
    for (const [keyB, valueB] of pathEntries(pathsB)) {
      assert.ok(!inside(valueA, valueB) && !inside(valueB, valueA), `${keyA} overlaps ${keyB}`);
    }
  }
});

for (const layout of ['legacy', 2] as const) {
  test(`${layout}: roles share all common paths and resolving A/B/A has no cache`, (t) => {
    const root = fixture(t);
    const a = path.join(root, '.a');
    const b = path.join(root, '.b');
    if (layout === 2) {
      instance(a);
      instance(b);
    }
    const opts = { home: a, env: {}, checkoutRoot: root };
    const gateway = resolveFarmPaths({ ...opts, role: 'gateway' });
    const node = resolveFarmPaths({ ...opts, role: 'node' });
    assert.equal(node.instance, 'a');
    const gatewayEntries = new Map(pathEntries(gateway));
    for (const [key, value] of pathEntries(node)) assert.equal(value, gatewayEntries.get(key), key);
    assert.ok(!('backlog' in node.state));
    resolveFarmPaths({ ...opts, home: b, role: 'gateway' });
    assert.deepEqual(resolveFarmPaths({ ...opts, role: 'gateway' }), gateway);
    if (layout === 2) {
      instance(a, { name: 'updated', dataRoot: path.join(root, 'new-data') });
      assert.equal(resolveFarmPaths({ ...opts, role: 'gateway' }).instance, 'updated');
    }
  });
}

test('home precedence expands tilde, and resolution only reads the instance marker', (t) => {
  const root = fixture(t);
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const env = { FARMSLOT_HOME: '~/env-home' };
  assert.equal(resolveFarmPaths({ role: 'node', env }).home, farmslotHome(env));
  assert.equal(
    resolveFarmPaths({ home: '~/arg-home', role: 'node', env }).home,
    path.join(root, 'arg-home'),
  );
  assert.equal(resolveFarmPaths({ role: 'node', env: {} }).home, path.join(homedir(), '.farmslot'));
  assert.deepEqual(readdirSync(root), []);
  const home = path.join(root, 'instance');
  instance(home);
  // A directory at either legacy config path would fail a read. The resolver must ignore them.
  mkdirSync(path.join(home, 'run-bundle-retention.json'));
  mkdirSync(path.join(home, 'bundle-store.json'));
  const before = readdirSync(home, { recursive: true });
  resolveFarmPaths({ home, role: 'gateway', env: {} });
  assert.deepEqual(readdirSync(home, { recursive: true }), before);
  writeFileSync(path.join(home, 'config/instance.json'), '{');
  assert.throws(() => resolveFarmPaths({ home, role: 'node', env: {} }), SyntaxError);
  for (const value of [{ layout: 3 }, { layout: 2, name: 3 }, { layout: 2, dataRoot: [] }, null]) {
    writeFileSync(path.join(home, 'config/instance.json'), JSON.stringify(value));
    assert.throws(
      () => resolveFarmPaths({ home, role: 'node', env: {} }),
      /Invalid farm instance config/,
    );
  }
  rmSync(path.join(home, 'config/instance.json'));
  mkdirSync(path.join(home, 'config/instance.json'));
  assert.throws(() => resolveFarmPaths({ home, role: 'node', env: {} }), { code: 'EISDIR' });
});
