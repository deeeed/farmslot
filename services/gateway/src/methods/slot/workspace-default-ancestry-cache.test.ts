import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { WorkspaceProbe } from './workspace-probe.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-ancestry-cache-'));
for (const dir of [
  'pool',
  'projects/proof',
  'services/gateway',
  'scripts',
  'home',
  'runs',
  'repo/.git/refs/heads',
  'repo/.git/refs/remotes/origin',
])
  await mkdir(path.join(root, dir), { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  repo = path.join(root, 'repo');
await writeFile(path.join(root, 'CLAUDE.md'), '# Ancestry fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  '{"name":"proof","default_branch":"main"}',
);
await writeFile(path.join(repo, '.git/HEAD'), 'ref: refs/heads/work\n');
await writeFile(path.join(repo, '.git/refs/heads/work'), head + '\n');
await writeFile(path.join(repo, '.git/refs/remotes/origin/main'), base + '\n');
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'ancestry-fixture',
    host: 'localhost',
    platform: 'cli',
    project: 'proof',
    slots: [{ id: 'ancestry-slot', repo, session: 'ancestry-slot' }],
  }),
);
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: 'ancestry-slot',
        machine: 'ancestry-fixture',
        project: 'proof',
        platform: 'cli',
        ssh: 'LOCAL',
        branch: 'work',
        head_sha: head,
        lifecycle: 'ready',
        agent: 'idle',
        enabled: true,
        slot_epoch: 1,
      },
    ],
  }),
);
await import('../../runtime/mock-pty.test-support.js');
const actualReads = await import('../../host-services/read-command.js');
const commands: string[] = [];
mock.module('../../host-services/read-command.js', {
  namedExports: {
    ...actualReads,
    readSlotCommand: async (_vars: unknown, command: string) => {
      commands.push(command);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  },
});
const actualProbes = await import('../../core/read-probes.js');
mock.module('../../core/read-probes.js', {
  namedExports: {
    ...actualProbes,
    readSlotProbe: async () => ({ exitCode: 0, stdout: `${base}\trefs/heads/main\n`, stderr: '' }),
  },
});
const probe: WorkspaceProbe = {
  branch: 'work',
  headSha: head,
  localDefaultSha: base,
  dirtyFingerprint: 'clean',
  dirtyCount: 0,
  behind: 1,
  defaultFetchedAt: null,
  originKey: 'fixture',
  publicationRemote: 'origin',
  publicationRef: 'refs/heads/work',
  publicationRemoteKey: 'fixture',
};
const actualWorkspaceProbe = await import('./workspace-probe.js');
mock.module('./workspace-probe.js', {
  namedExports: { ...actualWorkspaceProbe, probeWorkspace: async () => ({ ...probe }) },
});
const { loadFleetStatus } = await import('../../fleet/state.js');
const modulePath: string = './workspace.js?ancestry-cache-regression';
const { enrichFleetWorkspaces }: typeof import('./workspace.js') = await import(modulePath);

test('unchanged passive positive ancestry is not queried again at each 90-second workspace expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const fleet = await loadFleetStatus(false, true);
  const first = await enrichFleetWorkspaces(fleet);
  assert.equal(first.slots[0]?.workspace?.publication, 'merged');
  t.mock.timers.tick(95000);
  const second = await enrichFleetWorkspaces(fleet);
  assert.equal(second.slots[0]?.workspace?.publication, 'merged');
  assert.notEqual(
    second.slots[0]?.workspace?.observedAt,
    first.slots[0]?.workspace?.observedAt,
    'the full workspace inspection and timestamp still refresh',
  );
  assert.equal(
    commands.filter((command) => command.includes(' merge-base --is-ancestor ')).length,
    1,
    'same exact HEAD/base and metadata must reuse the successful ancestry result',
  );
});
