import assert from 'node:assert/strict';
import test from 'node:test';

import { expandTemplate } from '@farmslot/slot-config';

import type { SlotVars } from '../core/index.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';
import { commandIncludesFarmPath } from '../fleet/farm-paths.js';
import {
  buildPiAuthCheckCommand,
  buildPiModelCatalogCommand,
} from '../runners/runner-observability.js';
import { makeVars } from '../runners/test-fixtures.js';

import { ensureNodeSupportBundle, type NodeSupportIo } from './ensure.js';
import {
  commandWaitsForNodeSupport,
  hasRemoteFarmRef,
  NodeSupportPendingError,
  remapRemoteFarmRefs,
  resetRemoteFarmCommandCache,
  resolveRemoteFarmCommand,
  settleNodeSupportDeliveries,
} from './remote-command.js';
import { fakeSupportHomeResult } from './support-test-fixtures.js';

// A real tracked project, so the bundle paths come from a real config.
const PROJECT = 'farmslot-farm';

function remoteVars(slotId = 'mini-ff-1'): SlotVars {
  return {
    slotId,
    host: 'mini.local',
    machine: 'mini',
    sshTarget: 'deeeed@mini.local',
    projectName: PROJECT,
    remoteRepo: '/Users/deeeed/dev/x',
  } as unknown as SlotVars;
}

/** A node that holds no bundle until this fake publishes one. */
function fakeCommandFiles() {
  const files = new Map<string, string>();
  return {
    read: (command: string) => files.get(command) ?? command,
    write: (file: string, data: string) =>
      files.set(`/bin/sh ${shellExpressionForRemotePath(file)}`, data),
    stage: (command: string) => {
      const match = /^mktemp '([^']+\/\.command\.)XXXXXX'$/.exec(command);
      return match ? { exitCode: 0, stdout: `${match[1]}fixture\n`, stderr: '' } : undefined;
    },
  };
}

function fakeNode(opts: { failUpload?: boolean } = {}) {
  const calls: string[] = [];
  const commands = fakeCommandFiles();
  let manifest: string | null = null;
  const io: NodeSupportIo = {
    retentionReferences: async () => ({ selectionPaths: [], runHashes: [] }),
    exec: async (_vars, cmd) => {
      cmd = commands.read(cmd);
      calls.push(`exec:${cmd.slice(0, 20)}`);
      if (cmd.startsWith(': farmslot-node-support-activate') && cmd.includes('"selectionPath":'))
        calls.push('select');
      const homeResult = fakeSupportHomeResult(cmd);
      if (homeResult) return homeResult;
      const staging = commands.stage(cmd);
      if (staging) return staging;
      if (cmd.includes('mktemp -d')) {
        return { exitCode: 0, stdout: '/home/u/farmslot-node/support/.incoming/x\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    fileExists: async () => {
      calls.push('exists');
      return manifest !== null;
    },
    readFile: async (_vars, filePath) => {
      calls.push('read');
      if (filePath.endsWith('manifest.json') && manifest) return manifest;
      throw new Error(`unexpected read ${filePath}`);
    },
    writeFile: async (_vars, filePath, data) => {
      commands.write(filePath, data);
      calls.push('write');
      if (filePath.endsWith('manifest.json')) manifest = data;
    },
    writeFiles: async (_vars, _base, files) => {
      calls.push('writeFiles');
      if (files.some((file) => file.path === 'node-support-hash')) calls.push('select');
      if (opts.failUpload) throw new Error('node went away mid-upload');
    },
  };
  return { io, calls };
}

const HOOK =
  "bash ~/farmslot-node/projects/farmslot-farm/setup/health-check.sh '/r' && " +
  'bash ~/farmslot-node/projects/other-farm/scripts/x.sh && ' +
  'bash ~/farmslot-node/scripts/write-runtime-context.sh';

test('only references the bundle carries are moved onto it', () => {
  const paths = ['projects/farmslot-farm/project.json', 'projects/farmslot-farm/setup', 'scripts'];
  const out = remapRemoteFarmRefs(HOOK, '~/farmslot-node/support/abc', paths);
  assert.equal(
    out,
    "bash ~/farmslot-node/support/abc/projects/farmslot-farm/setup/health-check.sh '/r' && " +
      'bash ~/farmslot-node/projects/other-farm/scripts/x.sh && ' +
      'bash ~/farmslot-node/support/abc/scripts/write-runtime-context.sh',
  );
  assert.equal(
    remapRemoteFarmRefs(
      "bash ~/farmslot-node/projects/farmslot-farm/setup/preflight.sh '/r' '~/farmslot-node' x ~/farmslot-node",
      '~/farmslot-node/support/abc',
      paths,
    ),
    "bash ~/farmslot-node/support/abc/projects/farmslot-farm/setup/preflight.sh '/r' '~/farmslot-node/support/abc' x ~/farmslot-node/support/abc",
    'a bare farm root handed to a script becomes the bundle root',
  );
  assert.equal(
    remapRemoteFarmRefs("x '~/farmslot-node'", '~/farmslot-node/support/abc', [
      'scripts/install-runner-observability.mjs',
    ]),
    "x '~/farmslot-node'",
    'a bundle without project support does not stand in for the root',
  );
  assert.equal(
    remapRemoteFarmRefs(
      'ls ~/farmslot-node-dev ~/farmslot-node/packages/x',
      '~/farmslot-node/support/abc',
      paths,
    ),
    'ls ~/farmslot-node-dev ~/farmslot-node/packages/x',
    'other installs and unbundled roots are untouched',
  );
  assert.equal(
    remapRemoteFarmRefs(
      'bash ~/farmslot-node/projects/farmslot-farm-extra/setup/x.sh',
      '~/farmslot-node/support/abc',
      paths,
    ),
    'bash ~/farmslot-node/projects/farmslot-farm-extra/setup/x.sh',
    'a sibling project with a shared name prefix is not covered',
  );
});

test('commands without a farm reference are not touched', async () => {
  resetRemoteFarmCommandCache();
  const node = fakeNode();
  for (const cmd of [
    'git status',
    'mkdir -p "${HOME}/farmslot-node/support/.locks"',
    'ls ~/farmslot-node/support/abc/projects/farmslot-farm/setup',
    'ls ~/farmslot-node-dev/projects/x',
  ]) {
    assert.equal(hasRemoteFarmRef(cmd), false, cmd);
    assert.equal(await resolveRemoteFarmCommand(remoteVars(), cmd, { io: node.io }), cmd);
  }
  assert.deepEqual(node.calls, [], 'no node round trip for unrelated commands');
});

test('a hook on a node without the current bundle runs from the bundle it just received', async () => {
  // The F15 shape: the gateway's config moved ahead of what the node was
  // deployed with. The hook must not reach the node's stale copy.
  resetRemoteFarmCommandCache();
  const node = fakeNode();

  const resolved = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });

  assert.ok(node.calls.includes('writeFiles'), 'bundle published before the hook runs');
  const match =
    /\/tmp\/node-home\/farmslot-node\/support\/([0-9a-f]{64})\/projects\/farmslot-farm\/setup\//.exec(
      resolved,
    );
  assert.ok(match, `hook points at a content-hashed bundle: ${resolved}`);
  assert.match(resolved, /support\/[0-9a-f]{64}\/scripts\/write-runtime-context\.sh/);
  assert.match(resolved, / ~\/farmslot-node\/projects\/other-farm\//, 'uncovered ref untouched');

  // The next hook on that slot reuses the verified bundle without a round trip.
  node.calls.length = 0;
  const again = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.equal(again, resolved);
  assert.equal(node.calls.length, 0, 'no round trip within the verified window');

  // Another slot on the same machine still has its own selection written.
  await resolveRemoteFarmCommand(remoteVars('mini-ff-2'), HOOK, { io: node.io });
  assert.ok(node.calls.includes('select'), 'second slot gets its selection recorded');
  assert.ok(!node.calls.includes('write'), 'and the bundle is not republished');
});

test('a hook expanded from a configured workspace uses the selected immutable support', async () => {
  resetRemoteFarmCommandCache();
  const node = fakeNode();
  const vars = makeVars({
    host: 'remote.invalid',
    machine: 'configured-support-node',
    slotId: 'configured-support-slot',
    projectName: PROJECT,
    machineEnv: { FARMSLOT_WORKSPACE: '/configured/farm-node' },
  });
  const hook = expandTemplate(
    'bash {{farmslot_dir}}/projects/farmslot-farm/setup/sandbox-dev.sh start --gateway-port 8804',
    vars,
  );
  assert.ok(hook.includes('/configured/farm-node/projects/'));
  assert.equal(commandIncludesFarmPath(hook, vars), true, 'staged execution admits the hook');
  const command = `${hook} && bash ~/farmslot-node/scripts/write-runtime-context.sh`;
  const resolved = await resolveRemoteFarmCommand(vars, command, { io: node.io });
  assert.match(
    resolved,
    /\/support\/[0-9a-f]{64}\/projects\/farmslot-farm\/setup\/sandbox-dev\.sh/,
  );
  assert.doesNotMatch(resolved, /\/configured\/farm-node\/projects\//);
  assert.match(resolved, /\/support\/[0-9a-f]{64}\/scripts\/write-runtime-context\.sh/);
  assert.ok(node.calls.includes('writeFiles'), 'the matching bundle is published before launch');
});

test('remote auth resolves its current bundled helper before executing a stale loose node', async () => {
  resetRemoteFarmCommandCache();
  const node = fakeNode();
  const vars = makeVars({
    host: 'remote-fixture.local',
    machine: 'remote-fixture',
    projectName: PROJECT,
  });
  const command = buildPiAuthCheckCommand(vars, 'pi', 'ollama/fixture');
  assert.equal(hasRemoteFarmRef(command), true);
  const resolved = await resolveRemoteFarmCommand(vars, command, { io: node.io });
  assert.match(
    resolved,
    /farmslot-node\/support\/[0-9a-f]{64}\/scripts\/runners\/pi-farmslot-providers\.mjs/,
  );
  assert.doesNotMatch(resolved, /node ~\/farmslot-node\/scripts/);
  assert.ok(node.calls.includes('writeFiles'), 'current bundle is installed before auth');
});

test('remote pi catalog resolves helper and extension to the same verified bundle', async () => {
  resetRemoteFarmCommandCache();
  const node = fakeNode();
  const vars = makeVars({
    host: 'remote-fixture.local',
    machine: 'remote-fixture',
    projectName: PROJECT,
  });
  const resolved = await resolveRemoteFarmCommand(vars, buildPiModelCatalogCommand(vars, 'pi'), {
    io: node.io,
  });
  const helper = resolved.match(
    /([^\s\x27\x22]*\/farmslot-node\/support\/[0-9a-f]{64})\/scripts\/runners\/pi-farmslot-providers\.mjs/,
  );
  assert.ok(helper);
  assert.ok(resolved.includes(`-e ${helper[1]}/scripts/runners/pi-farmslot-observability.ts`));
  assert.doesNotMatch(resolved, /~\/farmslot-node\/scripts/);
  assert.doesNotMatch(resolved, /\.observability\/bin/);
  assert.ok(node.calls.includes('writeFiles'));
});

test('concurrent hooks on one slot share a single publish', async () => {
  resetRemoteFarmCommandCache();
  const node = fakeNode();
  const [first, second] = await Promise.all([
    resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io }),
    resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io }),
  ]);
  assert.equal(first, second);
  assert.equal(
    node.calls.filter((call) => call === 'exists').length,
    1,
    'one ensure ran; the second hook waited on it',
  );
});

test('a bundle that cannot be delivered fails the command instead of running the stale copy', async () => {
  resetRemoteFarmCommandCache();
  const node = fakeNode({ failUpload: true });
  await assert.rejects(
    resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io }),
    /node went away mid-upload/,
  );
});

test('a slot without project config keeps the node copy', async () => {
  resetRemoteFarmCommandCache();
  const node = fakeNode();
  const vars = { ...remoteVars(), projectName: 'no-such-project-farm' } as SlotVars;
  assert.equal(await resolveRemoteFarmCommand(vars, HOOK, { io: node.io }), HOOK);
  assert.deepEqual(node.calls, []);
});

// ─── Delivery races, against a farm this test owns ───

async function withTempFarm(t: test.TestContext): Promise<{
  name: string;
  editScript: (body: string) => void;
}> {
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { farmslotRoot } = await import('../core/index.js');
  const name = `remote-command-test-${process.pid}-${Date.now()}-farm`;
  const dir = path.join(farmslotRoot(), 'projects', name);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, 'project.json'),
    JSON.stringify({
      qa: {
        default_profile: 'smoke',
        profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa/default' }],
      },
      hooks: { health_check: `bash {{farmslot_dir}}/projects/${name}/scripts/h.sh` },
    }),
  );
  const script = path.join(dir, 'scripts', 'h.sh');
  writeFileSync(script, 'echo v1\n');
  return { name, editScript: (body) => writeFileSync(script, body) };
}

/** A node whose bundle uploads wait until released; `uploads` lists one entry per delivery. */
function gatedNode(opts: { failUpload?: boolean } = {}) {
  const uploads: string[] = [];
  const uploadWaiters: Array<{ count: number; resolve: () => void }> = [];
  const commands = fakeCommandFiles();
  const manifests = new Map<string, string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const io: NodeSupportIo = {
    retentionReferences: async () => ({ selectionPaths: [], runHashes: [] }),
    exec: async (_vars, cmd) =>
      commands.stage(cmd) ??
      fakeSupportHomeResult(cmd) ??
      (cmd.includes('mktemp -d')
        ? {
            exitCode: 0,
            stdout: `/h/farmslot-node/support/.incoming/x${uploads.length}\n`,
            stderr: '',
          }
        : { exitCode: 0, stdout: '', stderr: '' }),
    fileExists: async (_vars, file) => manifests.has(file),
    readFile: async (_vars, file) => {
      const body = manifests.get(file) ?? [...manifests.values()].at(-1);
      if (!body) throw new Error(`unexpected read ${file}`);
      return body;
    },
    writeFile: async (_vars, file, data) => {
      commands.write(file, data);
      if (file.includes('/.command.')) return;
      // The incoming manifest; the publish moves it to support/<hash>/.
      const hash = (JSON.parse(data) as { hash: string }).hash;
      manifests.set(`/tmp/node-home/farmslot-node/support/${hash}/manifest.json`, data);
    },
    writeFiles: async (_vars, base) => {
      if (!base.includes('.incoming')) return; // the slot's selection record
      // One delivery per incoming directory, however many requests it takes.
      if (uploads.includes(base)) return;
      uploads.push(base);
      for (const waiter of uploadWaiters) {
        if (uploads.length >= waiter.count) waiter.resolve();
      }
      await gate;
      if (opts.failUpload) throw new Error('upload failed');
    },
  };
  const waitForUploads = (count: number): Promise<void> => {
    if (uploads.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      uploadWaiters.push({ count, resolve });
    });
  };
  return { io, uploads, release, waitForUploads };
}

const farmVars = (name: string, slotId: string, machine = 'mini'): SlotVars =>
  ({ ...remoteVars(slotId), machine, projectName: name }) as SlotVars;

test(
  'a hook expanded after a fast-forward never joins the older publish',
  { timeout: 30_000 },
  async (t) => {
    resetRemoteFarmCommandCache();
    const farm = await withTempFarm(t);
    const node = gatedNode();
    const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

    const before = resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-1'), cmd, { io: node.io });
    t.after(() => node.release());
    await node.waitForUploads(1);
    farm.editScript('echo v2\n');
    const now = Date.now() + 2_100;
    t.mock.method(Date, 'now', () => now); // expire the cache without a fixed wait
    const after = resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-1'), cmd, { io: node.io });
    // Keep the first publish in flight until the changed bundle starts its own.
    await node.waitForUploads(2);
    node.release();

    const [oldCmd, newCmd] = await Promise.all([before, after]);
    assert.notEqual(oldCmd, newCmd, 'the new config runs from its own bundle');
    assert.equal(node.uploads.length, 2, 'both bundles were delivered');
  },
);

test('slots on one machine share one upload of the same bundle', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;
  const all = Promise.all(
    ['mini-x-1', 'mini-x-2', 'mini-x-3'].map((slot) =>
      resolveRemoteFarmCommand(farmVars(farm.name, slot), cmd, { io: node.io }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  node.release();
  const results = await all;
  assert.equal(new Set(results).size, 1);
  assert.equal(node.uploads.length, 1, 'one upload per machine and bundle');
});

test('a budget that runs out leaves the delivery running for the next command', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  await assert.rejects(
    resolveRemoteFarmCommand(vars, cmd, { io: node.io, budgetMs: 100 }),
    NodeSupportPendingError,
  );
  const next = resolveRemoteFarmCommand(vars, cmd, { io: node.io });
  node.release();
  assert.match(await next, /support\/[0-9a-f]{64}\//);
  assert.equal(node.uploads.length, 1, 'the next command joined the same delivery');
});

/** A node whose every call is counted, so a cached answer shows as zero calls. */
function countedIo(io: NodeSupportIo): { io: NodeSupportIo; calls: () => number } {
  let calls = 0;
  const count =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      calls++;
      return fn(...args);
    };
  return {
    io: {
      ...io,
      exec: count(io.exec),
      fileExists: count(io.fileExists),
      readFile: count(io.readFile),
      writeFile: count(io.writeFile),
      writeFiles: count(io.writeFiles),
    },
    calls: () => calls,
  };
}

test('a delivery that finishes after every budget ran out serves the next command from the cache', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  const counted = countedIo(node.io);
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  await assert.rejects(
    resolveRemoteFarmCommand(vars, cmd, { io: counted.io, budgetMs: 50 }),
    NodeSupportPendingError,
  );
  node.release();
  // Nobody waits for it now; it finishes on its own.
  await settleNodeSupportDeliveries();
  const before = counted.calls();
  const mapped = await resolveRemoteFarmCommand(vars, cmd, { io: counted.io, budgetMs: 50 });
  assert.match(mapped, /support\/[0-9a-f]{64}\//);
  assert.equal(counted.calls(), before, 'the finished delivery answered without asking the node');
  assert.equal(node.uploads.length, 1);
});

test('a delivery overtaken by a config change while nobody waited caches nothing', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  const counted = countedIo(node.io);
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  await assert.rejects(
    resolveRemoteFarmCommand(vars, cmd, { io: counted.io, budgetMs: 50 }),
    NodeSupportPendingError,
  );
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  farm.editScript('echo v2\n');
  now += 2_100;
  node.release();
  await settleNodeSupportDeliveries();

  // Back to the delivered content: its bundle is checked on the node again, not served from a
  // cache entry recorded while the config said otherwise.
  farm.editScript('echo v1\n');
  now += 2_100;
  const before = counted.calls();
  await resolveRemoteFarmCommand(vars, cmd, { io: counted.io });
  assert.ok(counted.calls() > before, 'the overtaken delivery left no cache entry');
});

test('a probe waits for the support bundle only where execOnSlot would deliver one', () => {
  const machineEnv = { HOME: '/Users/u', FARMSLOT_WORKSPACE: '/Users/u/dev' };
  const remote = { host: 'remote-box.local', machine: 'remote-box', machineEnv };
  const local = { host: 'localhost', machine: 'remote-box', machineEnv };
  const repoProbe = "git -C '/Users/u/dev/metamask/x' rev-parse HEAD";
  const workspaceHook = "bash '/Users/u/dev/projects/x-farm/setup/health-check.sh' --repo '/r'";
  const nodeHook = 'bash /Users/u/farmslot-node/projects/x-farm/setup/health-check.sh';
  // A repo under the workspace is not a farm reference: only projects/ and scripts/ are.
  assert.equal(commandWaitsForNodeSupport(remote, repoProbe), false);
  assert.equal(commandWaitsForNodeSupport(remote, workspaceHook), true);
  assert.equal(commandWaitsForNodeSupport(remote, nodeHook), true);
  // A plain local shell runs the checkout's own scripts and never waits for a bundle.
  assert.equal(commandWaitsForNodeSupport(local, workspaceHook), false);
  assert.equal(commandWaitsForNodeSupport(local, repoProbe), false);
});

test('a background-finished delivery is not cached after a newer selection for its slot', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  const counted = countedIo(node.io);
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  await assert.rejects(
    resolveRemoteFarmCommand(vars, cmd, { io: counted.io, budgetMs: 50 }),
    NodeSupportPendingError,
  );
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  // Bundle 2 is selected while bundle 1's delivery is still uploading.
  farm.editScript('echo v2\n');
  now += 2_100;
  const second = resolveRemoteFarmCommand(vars, cmd, { io: counted.io });
  node.release();
  await second;
  await settleNodeSupportDeliveries();

  farm.editScript('echo v1\n');
  now += 2_100;
  const before = counted.calls();
  await resolveRemoteFarmCommand(vars, cmd, { io: counted.io });
  assert.ok(counted.calls() > before, 'bundle 1 is checked on the node again');
});

test('a background-finished read-only delivery serves read-only commands, not selecting ones', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  const counted = countedIo(node.io);
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  await assert.rejects(
    resolveRemoteFarmCommand(vars, cmd, { io: counted.io, budgetMs: 50, selectSlot: false }),
    NodeSupportPendingError,
  );
  node.release();
  await settleNodeSupportDeliveries();
  let before = counted.calls();
  await resolveRemoteFarmCommand(vars, cmd, { io: counted.io, selectSlot: false });
  assert.equal(counted.calls(), before, 'the read-only entry answered the read-only command');
  before = counted.calls();
  await resolveRemoteFarmCommand(vars, cmd, { io: counted.io });
  assert.ok(counted.calls() > before, 'a selecting command still selects on the node');
});

test('a delivery that fails after its budget ran out is reported to the next command', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode({ failUpload: true });
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  await assert.rejects(
    resolveRemoteFarmCommand(vars, cmd, { io: node.io, budgetMs: 50 }),
    NodeSupportPendingError,
  );
  node.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // No unhandled rejection above; the retry surfaces the failure.
  await assert.rejects(resolveRemoteFarmCommand(vars, cmd, { io: node.io }), /upload failed/);
});

test('a wait without a budget lasts until the delivery finishes, past any short timeout', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  const waiting = resolveRemoteFarmCommand(vars, cmd, { io: node.io });
  await node.waitForUploads(1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  node.release();
  assert.match(await waiting, /support\/[0-9a-f]{64}\//);
});

test(
  "a wait without a budget is held to the delivery's own deadline and names what is left",
  { timeout: 10_000 },
  async (t) => {
    resetRemoteFarmCommandCache();
    const farm = await withTempFarm(t);
    const node = gatedNode();
    t.after(() => node.release());
    const vars = farmVars(farm.name, 'mini-x-1');
    const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

    const error = await resolveRemoteFarmCommand(vars, cmd, {
      io: { ...node.io, deliveryDeadlineMs: 100 },
    }).then(
      () => assert.fail('a delivery that never finishes cannot resolve'),
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof NodeSupportPendingError);
    assert.match(
      error.message,
      /^node support bundle [0-9a-f]{8} for mini-x-1 was not delivered within its 100ms deadline \(uploading; \d+ of \d+ bytes left to send, \d+ files\)$/,
    );
  },
);

test('after a delivery misses its deadline, the next command starts a fresh one', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  t.after(() => node.release());
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;
  const io = { ...node.io, deliveryDeadlineMs: 100 };

  await assert.rejects(resolveRemoteFarmCommand(vars, cmd, { io }), NodeSupportPendingError);
  const next = resolveRemoteFarmCommand(vars, cmd, { io: node.io });
  await node.waitForUploads(2);
  node.release();
  assert.match(await next, /support\/[0-9a-f]{64}\//);
  assert.equal(node.uploads.length, 2, 'the stalled delivery was not joined');
});

test('a command after a deadline nobody watched starts a fresh delivery', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  t.after(() => node.release());
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  // A budgeted hook gives up before the deadline, so no waiter sees it pass.
  await assert.rejects(
    resolveRemoteFarmCommand(vars, cmd, {
      io: { ...node.io, deliveryDeadlineMs: 100 },
      budgetMs: 20,
    }),
    NodeSupportPendingError,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const next = resolveRemoteFarmCommand(vars, cmd, { io: node.io });
  await node.waitForUploads(2);
  node.release();
  assert.match(await next, /support\/[0-9a-f]{64}\//);
});

test(
  "another slot never waits on a stalled machine upload past that upload's deadline",
  { timeout: 10_000 },
  async (t) => {
    resetRemoteFarmCommandCache();
    const farm = await withTempFarm(t);
    const node = gatedNode();
    t.after(() => node.release());
    const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

    // Slot 1's hook starts the machine upload with a short deadline and gives up.
    await assert.rejects(
      resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-1'), cmd, {
        io: { ...node.io, deliveryDeadlineMs: 100 },
        budgetMs: 20,
      }),
      NodeSupportPendingError,
    );
    // Slot 2 arrives while that upload is still within its deadline, and outlives it.
    const other = resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-2'), cmd, { io: node.io });
    await node.waitForUploads(2);
    node.release();
    assert.match(await other, /support\/[0-9a-f]{64}\//);
    assert.equal(node.uploads.length, 2, 'slot 2 uploaded on its own');
  },
);

test(
  'a cancelled wait returns at once and leaves the delivery for the next command',
  { timeout: 10_000 },
  async (t) => {
    resetRemoteFarmCommandCache();
    const farm = await withTempFarm(t);
    const node = gatedNode();
    t.after(() => node.release());
    const vars = farmVars(farm.name, 'mini-x-1');
    const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

    // A fresh delivery probes the node for its copy; a joined one does not.
    let probes = 0;
    const io: NodeSupportIo = {
      ...node.io,
      fileExists: async (...args) => {
        probes++;
        return node.io.fileExists(...args);
      },
    };
    const controller = new AbortController();
    const waiting = resolveRemoteFarmCommand(vars, cmd, { io, signal: controller.signal });
    await node.waitForUploads(1);
    const cancelledAt = Date.now();
    controller.abort();
    await assert.rejects(waiting);
    assert.ok(Date.now() - cancelledAt < 1_000, 'the wait ends when it is cancelled');

    const next = resolveRemoteFarmCommand(vars, cmd, { io });
    // Let the next command reach its delivery before the first one can finish.
    await new Promise((resolve) => setTimeout(resolve, 50));
    node.release();
    assert.match(await next, /support\/[0-9a-f]{64}\//);
    assert.equal(node.uploads.length, 1, 'no second upload');
    assert.equal(probes, 1, 'the next command joined the same delivery');
  },
);

test(
  "a slot that waited on another slot's upload gets its own full deadline for its delivery",
  { timeout: 10_000 },
  async (t) => {
    resetRemoteFarmCommandCache();
    const farm = await withTempFarm(t);
    const node = gatedNode();
    t.after(() => node.release());
    const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;
    // Slot 1's upload stalls; it gives up at once and its delivery expires
    // ~400 ms after it started.
    await assert.rejects(
      resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-1'), cmd, {
        io: { ...node.io, deliveryDeadlineMs: 400 },
        budgetMs: 20,
      }),
      NodeSupportPendingError,
    );
    // Times below count from slot 1 giving up, just after its delivery started.
    const started = Date.now();
    const at = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, Math.max(0, started + ms - Date.now())));
    // Slot 2 joins at ~50 ms with an 800 ms deadline and waits on slot 1's
    // upload until it expires (under ~400 ms), then starts its own: that
    // delivery has 800 ms from there.
    await at(50);
    const other = resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-2'), cmd, {
      io: { ...node.io, deliveryDeadlineMs: 800 },
    });
    await node.waitForUploads(2);
    // Past a deadline counted from the join (~850 ms), within its own (~1150+ ms).
    await at(1000);
    node.release();
    assert.match(await other, /support\/[0-9a-f]{64}\//);
  },
);

test('an already-cancelled wait starts no delivery', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode({ failUpload: true });
  t.after(() => node.release());
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  t.after(() => process.off('unhandledRejection', record));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    resolveRemoteFarmCommand(vars, cmd, { io: node.io, signal: controller.signal }),
  );
  node.release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(node.uploads.length, 0, 'a cancelled caller starts nothing');
  assert.deepEqual(unhandled, [], 'no delivery fails with nobody listening');
});

test('a slot that takes over an expired machine upload is the one later slots join', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  t.after(() => node.release());
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  // Slot 1's upload stalls and expires.
  await assert.rejects(
    resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-1'), cmd, {
      io: { ...node.io, deliveryDeadlineMs: 200 },
      budgetMs: 20,
    }),
    NodeSupportPendingError,
  );
  // Slot 2 waits on it, then uploads itself.
  const second = resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-2'), cmd, { io: node.io });
  await node.waitForUploads(2);
  // Slot 3 arrives during slot 2's upload and must join it, not upload again.
  const third = resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-3'), cmd, { io: node.io });
  await new Promise((resolve) => setTimeout(resolve, 100));
  node.release();
  assert.equal((await Promise.all([second, third])).length, 2);
  assert.equal(node.uploads.length, 2, 'one upload after the takeover');
});

test('slots waiting on an expired machine upload take it over once, not each', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  t.after(() => node.release());
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  // Slot 1's upload stalls; slots 2 and 3 are both waiting on it when it expires.
  await assert.rejects(
    resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-1'), cmd, {
      io: { ...node.io, deliveryDeadlineMs: 200 },
      budgetMs: 20,
    }),
    NodeSupportPendingError,
  );
  const waiting = ['mini-x-2', 'mini-x-3'].map((slot) =>
    resolveRemoteFarmCommand(farmVars(farm.name, slot), cmd, { io: node.io }),
  );
  await node.waitForUploads(2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  node.release();
  assert.equal((await Promise.all(waiting)).length, 2);
  assert.equal(node.uploads.length, 2, 'one takeover upload, joined by the other slot');
});

test('slots that joined a successful upload finish in parallel, not one after another', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  t.after(() => node.release());
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;
  // Slot 2's own activation hangs until released.
  let releaseSlot2!: () => void;
  const slot2Gate = new Promise<void>((resolve) => (releaseSlot2 = resolve));
  t.after(() => releaseSlot2());
  const io: NodeSupportIo = {
    ...node.io,
    exec: async (vars, command, ...rest) => {
      if (vars.slotId === 'mini-x-2' && command.includes('farmslot-node-support-activate'))
        await slot2Gate;
      return node.io.exec(vars, command, ...rest);
    },
  };

  const first = resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-1'), cmd, { io });
  await node.waitForUploads(1);
  const second = resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-2'), cmd, { io });
  const third = resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-3'), cmd, { io });
  await new Promise((resolve) => setTimeout(resolve, 50));
  node.release();
  await first;
  const thirdDone = await Promise.race([
    third.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  assert.equal(thirdDone, true, 'slot 3 does not wait for slot 2');
  releaseSlot2();
  await second;
});

test(
  'a slot waiting through two uploads gets a fresh deadline after each',
  { timeout: 10_000 },
  async (t) => {
    resetRemoteFarmCommandCache();
    const farm = await withTempFarm(t);
    const node = gatedNode();
    t.after(() => node.release());
    const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

    // Slot 1's upload stalls; it gives up at once and its delivery expires
    // ~400 ms after it started.
    await assert.rejects(
      resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-1'), cmd, {
        io: { ...node.io, deliveryDeadlineMs: 400 },
        budgetMs: 20,
      }),
      NodeSupportPendingError,
    );
    const started = Date.now();
    const at = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, Math.max(0, started + ms - Date.now())));
    // Slots 2 and 3 join at ~50 ms with 800 ms deadlines. One takes over at
    // under ~400 ms; the other waits on it, past ~850 ms from its join.
    await at(50);
    const waiting = ['mini-x-2', 'mini-x-3'].map((slot) =>
      resolveRemoteFarmCommand(farmVars(farm.name, slot), cmd, {
        io: { ...node.io, deliveryDeadlineMs: 800 },
      }),
    );
    await node.waitForUploads(2);
    await at(1000);
    node.release();
    assert.equal((await Promise.all(waiting)).length, 2);
  },
);

test('a budget that runs out names the bundle, its phase and the bytes left', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  t.after(() => node.release());
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  await assert.rejects(
    resolveRemoteFarmCommand(vars, cmd, { io: node.io, budgetMs: 100 }),
    (error: unknown) =>
      error instanceof NodeSupportPendingError &&
      /^node support bundle [0-9a-f]{8} for mini-x-1 still being delivered after 100ms \(\w[^;]*; \d+ of \d+ bytes left to send, \d+ files\)$/.test(
        error.message,
      ),
  );
});

/** The gated node with its manifest probes counted: a probe means a round trip, not the cache. */
function countingNode() {
  const node = gatedNode();
  node.release();
  let probes = 0;
  const io: NodeSupportIo = {
    ...node.io,
    fileExists: async (...args) => {
      probes++;
      return node.io.fileExists(...args);
    },
  };
  return { io, probes: () => probes };
}

for (const via of ['a command', 'a direct ensure (prepare)'] as const) {
  test(`a slot moved to another bundle by ${via} never reuses its earlier bundle from the cache`, async (t) => {
    // Moving the slot's selection lets the node prune the earlier bundle, so a
    // cached verification of it would point commands at a deleted directory
    // (the dev-server shutdown on mini-ff-1 that left a gateway on its port).
    resetRemoteFarmCommandCache();
    const farm = await withTempFarm(t);
    const node = countingNode();
    const vars = farmVars(farm.name, 'mini-x-1');
    const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;
    const first = await resolveRemoteFarmCommand(vars, cmd, { io: node.io });
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);

    farm.editScript('echo v2\n');
    now += 2_100; // past the local bundle's recheck interval
    if (via === 'a command') {
      assert.notEqual(await resolveRemoteFarmCommand(vars, cmd, { io: node.io }), first);
    } else {
      const moved = await ensureNodeSupportBundle(vars, '.agent', { io: node.io });
      assert.ok(moved?.hash && !first.includes(moved.hash), 'the slot now selects bundle 2');
    }

    farm.editScript('echo v1\n');
    now += 2_100;
    const probes = node.probes();
    assert.equal(await resolveRemoteFarmCommand(vars, cmd, { io: node.io }), first);
    assert.ok(
      node.probes() > probes,
      'bundle 1 is checked on the node again, not taken from the cache',
    );
  });
}

test('a delivery that finishes after a newer selection never caches its older bundle', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  node.release();
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;
  // The first delivery publishes and selects bundle 1, then waits on its
  // post-publish manifest read until the second has selected bundle 2.
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
  t.after(() => releaseFirst());
  let held = false;
  let probes = 0;
  const io: NodeSupportIo = {
    ...node.io,
    fileExists: async (...args) => {
      probes++;
      return node.io.fileExists(...args);
    },
    readFile: async (vars, file) => {
      if (!held && file.endsWith('/manifest.json') && file.includes('/support/')) {
        held = true;
        await firstHeld;
      }
      return node.io.readFile(vars, file);
    },
  };
  const first = resolveRemoteFarmCommand(vars, cmd, { io });
  for (let waited = 0; !held; waited += 10) {
    assert.ok(waited < 5_000, 'the first delivery reached its manifest read');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  farm.editScript('echo v2\n');
  now += 2_100;
  const second = await resolveRemoteFarmCommand(vars, cmd, { io });
  releaseFirst();
  const older = await first;
  assert.notEqual(older, second);

  farm.editScript('echo v1\n');
  now += 2_100;
  const before = probes;
  assert.equal(await resolveRemoteFarmCommand(vars, cmd, { io }), older);
  assert.ok(probes > before, 'bundle 1 is checked on the node again, not taken from the cache');
});

for (const outcome of ['still running', 'failed'] as const) {
  test(`a cached bundle is not served while a selection for its slot is ${outcome}`, async (t) => {
    // The node selects the new bundle and prunes the old one inside the
    // activation, before the gateway hears back, and a failed activation may
    // still have moved the slot.
    resetRemoteFarmCommandCache();
    const farm = await withTempFarm(t);
    const node = gatedNode();
    node.release();
    const vars = farmVars(farm.name, 'mini-x-1');
    const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;
    let probes = 0;
    let holdActivation = false;
    let activationReached!: () => void;
    const reached = new Promise<void>((resolve) => (activationReached = resolve));
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => (releaseActivation = resolve));
    t.after(() => releaseActivation());
    // Large node-support commands are staged as a file and run with /bin/sh.
    const staged = new Map<string, string>();
    const isActivation = (command: string) =>
      (staged.get(command) ?? command).includes('farmslot-node-support-activate');
    const io: NodeSupportIo = {
      ...node.io,
      fileExists: async (...args) => {
        probes++;
        return node.io.fileExists(...args);
      },
      writeFile: async (vars, file, data) => {
        staged.set(`/bin/sh ${shellExpressionForRemotePath(file)}`, data);
        return node.io.writeFile(vars, file, data);
      },
      exec: async (vars, command, ...rest) => {
        if (holdActivation && isActivation(command)) {
          holdActivation = false;
          activationReached();
          if (outcome === 'failed') throw new Error('activation failed after selecting');
          await activationGate;
        }
        return node.io.exec(vars, command, ...rest);
      },
    };
    const first = await resolveRemoteFarmCommand(vars, cmd, { io });
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);

    // A command for bundle 2 reaches its selecting activation.
    farm.editScript('echo v2\n');
    now += 2_100;
    holdActivation = true;
    const moving = resolveRemoteFarmCommand(vars, cmd, { io });
    await reached;
    if (outcome === 'failed') await assert.rejects(moving);

    // Bundle 1 again: the cached entry must not be used.
    farm.editScript('echo v1\n');
    now += 2_100;
    const before = probes;
    // Resolved while the bundle 2 activation is still held on the node.
    assert.equal(await resolveRemoteFarmCommand(vars, cmd, { io }), first);
    assert.ok(probes > before, 'bundle 1 is checked on the node again, not taken from the cache');
    releaseActivation();
    if (outcome === 'still running') await moving;
  });
}

test('after two selections for a slot overlap, neither bundle is served from the cache', async (t) => {
  // The node runs overlapping activations in its own order; the gateway only
  // sees the order their responses arrive in, so it cannot tell which one the
  // slot ended on, and the other may have been pruned.
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  node.release();
  const vars = farmVars(farm.name, 'mini-x-1');
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;
  const staged = new Map<string, string>();
  const gates: Array<{ reached: () => void; release: () => void; wait: Promise<void> }> = [];
  let holds = 0;
  let probes = 0;
  const hold = () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const gate = { reached, release, wait };
    gates.push(gate);
    return arrived;
  };
  t.after(() => gates.forEach((gate) => gate.release()));
  const io: NodeSupportIo = {
    ...node.io,
    fileExists: async (...args) => {
      probes++;
      return node.io.fileExists(...args);
    },
    writeFile: async (vars, file, data) => {
      staged.set(`/bin/sh ${shellExpressionForRemotePath(file)}`, data);
      return node.io.writeFile(vars, file, data);
    },
    exec: async (vars, command, ...rest) => {
      if (
        holds > 0 &&
        (staged.get(command) ?? command).includes('farmslot-node-support-activate')
      ) {
        const gate = gates[gates.length - holds];
        holds--;
        gate.reached();
        await gate.wait;
      }
      return node.io.exec(vars, command, ...rest);
    },
  };
  await resolveRemoteFarmCommand(vars, cmd, { io });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);

  // Bundle 2's selection starts and is held on the node...
  farm.editScript('echo v2\n');
  now += 2_100;
  const firstHeld = hold();
  const secondHeld = hold();
  holds = 2;
  const toBundle2 = resolveRemoteFarmCommand(vars, cmd, { io });
  await firstHeld;
  // ...and bundle 1's selection starts while it runs.
  farm.editScript('echo v1\n');
  now += 2_100;
  const toBundle1 = resolveRemoteFarmCommand(vars, cmd, { io });
  await secondHeld;
  // Bundle 2's response arrives first, bundle 1's last.
  gates[0].release();
  await toBundle2;
  gates[1].release();
  const bundle1 = await toBundle1;

  const before = probes;
  assert.equal(await resolveRemoteFarmCommand(vars, cmd, { io }), bundle1);
  assert.ok(probes > before, 'bundle 1 is checked on the node again, not taken from the cache');
});

test('every direct node exec sender is reviewed for farm script references', async () => {
  // execOnSlot resolves farm refs for everything routed through it. A new call
  // site that sends `exec` to a node directly would bypass that and reopen F15
  // for whatever commands it carries. Adding one means deciding: resolve its
  // command, or list it here because it only sends gateway-built commands.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const path = await import('node:path');
  const src = path.resolve(import.meta.dirname, '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) ? [full] : [];
    });
  const senders = walk(src)
    .filter((file) =>
      /(?:sendNodeRequest(?:Streaming)?|requestNativeNode)\(\s*[\w.]+,\s*(?:[\w.]+,\s*)?'exec'/.test(
        readFileSync(file, 'utf8'),
      ),
    )
    .map((file) => path.relative(src, file))
    .sort();
  // How many commands each file resolves: one per exec path it owns.
  const resolvesFarmRefs: Record<string, number> = {
    'fleet/node-rpc.ts': 0, // nodeExec, reached through execOnSlot (core/exec.ts)
    'fleet/resource-exec.ts': 1, // resource health
    'fleet/resource-manager.ts': 2, // resource control and watch commands
    'methods/slot-actions.ts': 1,
  };
  const gatewayBuiltOnly = [
    'methods/tmux-worker-create.ts', // UUID shell creation and exact-pane cleanup; no farm script references
    'methods/tmux-workers.ts',
    'run-engine/remote-probes.ts',
    'runners/native/node.ts', // argv only
    'runtime/screen-session.ts',
  ];
  assert.deepEqual(senders, [...Object.keys(resolvesFarmRefs), ...gatewayBuiltOnly].sort());
  for (const [file, expected] of Object.entries(resolvesFarmRefs)) {
    const calls =
      readFileSync(path.join(src, file), 'utf8').match(/resolve(?:Remote|Slot)FarmCommand\(/g) ??
      [];
    assert.equal(calls.length, expected, `${file} resolves farm refs on each exec path`);
  }
});

test('read-only prerequisite cache cannot suppress later slot bundle selection', async () => {
  resetRemoteFarmCommandCache();
  const node = fakeNode();
  const command = await resolveRemoteFarmCommand(remoteVars(), HOOK, {
    io: node.io,
    selectSlot: false,
  });
  assert.equal(node.calls.includes('select'), false);
  assert.match(command, /fcntl\.LOCK_SH/);
  const calls = node.calls.length;
  assert.equal(
    await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io, selectSlot: false }),
    command,
  );
  assert.equal(node.calls.length, calls, 'the protected read-only command can use its cache');
  const selected = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.match(selected, /^bash .*\/support\/[a-f0-9]{64}\//);
  assert.equal(node.calls.filter((call) => call === 'select').length, 1);
});
