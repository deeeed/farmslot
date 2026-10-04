import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotVars } from '../core/index.js';

import type { NodeSupportIo } from './ensure.js';
import {
  hasRemoteFarmRef,
  remapRemoteFarmRefs,
  resetRemoteFarmCommandCache,
  resolveRemoteFarmCommand,
} from './remote-command.js';

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
    writeFiles: async () => {
      calls.push('writeFiles');
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
  const match = /~\/farmslot-node\/support\/([0-9a-f]{64})\/projects\/farmslot-farm\/setup\//.exec(
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
