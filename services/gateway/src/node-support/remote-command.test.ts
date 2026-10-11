import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotVars } from '../core/index.js';

import type { NodeSupportIo } from './ensure.js';
import {
  hasRemoteFarmRef,
  NodeSupportPendingError,
  remapRemoteFarmRefs,
  resetRemoteFarmCommandCache,
  resolveRemoteFarmCommand,
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
function fakeNode(opts: { failUpload?: boolean } = {}) {
  const calls: string[] = [];
  let manifest: string | null = null;
  const io: NodeSupportIo = {
    exec: async (_vars, cmd) => {
      calls.push(`exec:${cmd.slice(0, 20)}`);
      const homeResult = fakeSupportHomeResult(cmd);
      if (homeResult) return homeResult;
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
  assert.ok(node.calls.includes('writeFiles'), 'second slot gets its selection recorded');
  assert.ok(!node.calls.includes('write'), 'and the bundle is not republished');
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
  const dir = path.join(farmslotRoot, 'projects', name);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, 'project.json'),
    JSON.stringify({
      hooks: { health_check: `bash {{farmslot_dir}}/projects/${name}/scripts/h.sh` },
    }),
  );
  const script = path.join(dir, 'scripts', 'h.sh');
  writeFileSync(script, 'echo v1\n');
  return { name, editScript: (body) => writeFileSync(script, body) };
}

/** A node whose bundle uploads wait until released. */
function gatedNode(opts: { failUpload?: boolean } = {}) {
  const uploads: string[] = [];
  const manifests = new Map<string, string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const io: NodeSupportIo = {
    exec: async (_vars, cmd) =>
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
      // The incoming manifest; the publish moves it to support/<hash>/.
      const hash = (JSON.parse(data) as { hash: string }).hash;
      manifests.set(`/tmp/node-home/farmslot-node/support/${hash}/manifest.json`, data);
    },
    writeFiles: async (_vars, base) => {
      if (!base.includes('.incoming')) return; // the slot's selection record
      uploads.push(base);
      await gate;
      if (opts.failUpload) throw new Error('upload failed');
    },
  };
  return { io, uploads, release };
}

const farmVars = (name: string, slotId: string, machine = 'mini'): SlotVars =>
  ({ ...remoteVars(slotId), machine, projectName: name }) as SlotVars;

test('a hook expanded after a fast-forward never joins the older publish', async (t) => {
  resetRemoteFarmCommandCache();
  const farm = await withTempFarm(t);
  const node = gatedNode();
  const cmd = `bash ~/farmslot-node/projects/${farm.name}/scripts/h.sh`;

  const before = resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-1'), cmd, { io: node.io });
  t.after(() => node.release());
  const started = performance.now();
  while (node.uploads.length < 1) {
    assert.ok(
      performance.now() - started < 2_000,
      'first bundle must finish reading before the edit',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  farm.editScript('echo v2\n');
  const now = Date.now() + 2_100;
  t.mock.method(Date, 'now', () => now); // expire the cache without a fixed wait
  const after = resolveRemoteFarmCommand(farmVars(farm.name, 'mini-x-1'), cmd, { io: node.io });
  // Hold the first upload until the second has started its own (or clearly
  // never will), so the second call meets the first still in flight.
  for (let waited = 0; node.uploads.length < 2 && waited < 2_000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  node.release();

  const [oldCmd, newCmd] = await Promise.all([before, after]);
  assert.notEqual(oldCmd, newCmd, 'the new config runs from its own bundle');
  assert.equal(node.uploads.length, 2, 'both bundles were delivered');
});

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
  const selected = await resolveRemoteFarmCommand(remoteVars(), HOOK, { io: node.io });
  assert.equal(selected, command);
  assert.equal(node.calls.filter((call) => call === 'select').length, 1);
});
