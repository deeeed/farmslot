import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  farmslotRoot,
  type ProjectVars,
  type RawProjectJson,
  type SlotVars,
} from '../core/index.js';
import {
  nodeSupportHashPath,
  RUNNER_OBSERVABILITY_SUPPORT_PATHS,
} from '../runners/runner-observability.js';

import { persistedNodeSupportRuns } from './activation.js';
import {
  collectNodeSupportBundle,
  ensureNodeSupportBundle,
  fixtureCheckVars,
  nodeSupportBundlePaths,
  type NodeSupportIo,
  selectedNodeSupportDir,
} from './ensure.js';
import { remapRemoteFarmRefs } from './remote-command.js';
import { fakeSupportHomeResult, isSupportHomeCommand } from './support-test-fixtures.js';

const projectRoot = path.join(farmslotRoot, 'projects', 'ensure-test');
test.before(() => {
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'project.json'),
    JSON.stringify({
      qa: {
        default_profile: 'smoke',
        profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa/default' }],
      },
    }),
  );
});
test.after(() => rmSync(projectRoot, { recursive: true, force: true }));

const projectVars = {
  projectName: 'ensure-test',
  projectJson: {},
  runtimeDir: '.agent',
} as unknown as ProjectVars;

function remoteVars(slotId = 'macpro-x-1'): SlotVars {
  return {
    slotId,
    host: 'macpro.local',
    machine: 'macpro',
    sshTarget: 'deeeed@macpro.local',
    projectName: 'ensure-test',
    remoteRepo: '/Users/deeeed/dev/x',
  } as unknown as SlotVars;
}

interface Recorded {
  execs: string[];
  written: Array<{ base: string; paths: string[] }>;
  manifests: string[];
}

function fakeIo(opts: { remoteManifestHash: string | null }): {
  io: NodeSupportIo;
  rec: Recorded;
} {
  const rec: Recorded = { execs: [], written: [], manifests: [] };
  const io: NodeSupportIo = {
    retentionReferences: async () => ({ selectionPaths: [], runHashes: [] }),
    exec: async (_vars, cmd) => {
      rec.execs.push(cmd);
      if (cmd.startsWith(': farmslot-node-support-activate')) {
        const selection = /"selectionPath":"([^"]+)"/.exec(cmd)?.[1];
        if (selection)
          rec.written.push({ base: path.dirname(selection), paths: [path.basename(selection)] });
      }
      const homeResult = fakeSupportHomeResult(cmd);
      if (homeResult) return homeResult;
      if (cmd.includes('mktemp -d')) {
        return {
          exitCode: 0,
          stdout: '/Users/deeeed/farmslot-node/support/.incoming/x.abc\n',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    // The manifest exists once the node held one or this fake published one.
    fileExists: async () => opts.remoteManifestHash !== null || rec.manifests.length > 0,
    readFile: async (_vars, filePath) => {
      if (filePath.endsWith('manifest.json')) {
        const published = rec.manifests.at(-1);
        return published ?? JSON.stringify({ hash: opts.remoteManifestHash });
      }
      throw new Error(`unexpected read ${filePath}`);
    },
    writeFile: async (_vars, filePath, data) => {
      if (filePath.endsWith('manifest.json')) rec.manifests.push(data);
    },
    writeFiles: async (_vars, baseDir, files) => {
      rec.written.push({ base: baseDir, paths: files.map((file) => file.path) });
    },
  };
  return { io, rec };
}

const kind = (cmd: string) =>
  cmd.startsWith(': farmslot-node-support-activate')
    ? 'activate'
    : isSupportHomeCommand(cmd)
      ? 'resolve-home'
      : cmd.includes('mktemp -d')
        ? 'incoming'
        : cmd.includes('shasum -a 256')
          ? 'verify'
          : cmd.includes('.locks')
            ? 'publish'
            : cmd.startsWith('rm -rf')
              ? 'discard'
              : cmd.startsWith('[ -f ') && cmd.includes('install-runner-observability.mjs')
                ? 'presence'
                : 'other';

test("a bundle carries the pack's templates and pack-rooted template sources for hosted task init", async (t) => {
  const name = 'ensure-templates-test';
  const pack = path.join(farmslotRoot, 'projects', name);
  t.after(() => rmSync(pack, { recursive: true, force: true }));
  mkdirSync(path.join(pack, 'templates/worker'), { recursive: true });
  mkdirSync(path.join(pack, 'checklists'), { recursive: true });
  writeFileSync(path.join(pack, 'templates/worker/dev.md'), '# Dev\n');
  writeFileSync(path.join(pack, 'checklists/review.md'), '# Review\n');
  const projectJson: RawProjectJson = {
    qa: {
      default_profile: 'smoke',
      profiles: [{ id: 'smoke', title: 'Smoke', template_id: 'qa/default' }],
    },
    execution_templates: {
      sources: [
        { id: 'project:checklists', kind: 'workspace', root: { projectPath: 'checklists' } },
        { id: 'project:absent', kind: 'workspace', root: { projectPath: 'absent' } },
        { id: 'package:outside', kind: 'package', root: { env: 'OUTSIDE_TEMPLATES' } },
      ],
    },
  };
  writeFileSync(path.join(pack, 'project.json'), JSON.stringify(projectJson));
  const paths = nodeSupportBundlePaths(name, projectJson);
  assert.ok(paths.includes(`projects/${name}/templates`));
  assert.ok(paths.includes(`projects/${name}/checklists`));
  assert.ok(!paths.some((entry) => entry.endsWith('/absent')));
  const { manifest } = await collectNodeSupportBundle(name, paths);
  const shipped = manifest.files.map((file) => file.path);
  assert.ok(shipped.includes(`projects/${name}/templates/worker/dev.md`));
  assert.ok(shipped.includes(`projects/${name}/checklists/review.md`));
});

test('a local slot uses the checkout directly and touches no node', async () => {
  const { io, rec } = fakeIo({ remoteManifestHash: null });
  const state = await ensureNodeSupportBundle(
    { ...remoteVars(), host: 'localhost', machine: 'local' } as SlotVars,
    '.agent',
    { projectVars, io },
  );
  assert.equal(state?.supportDir, farmslotRoot);
  assert.equal(state?.hash, null);
  assert.equal(state?.published, false);
  assert.deepEqual(
    state?.paths,
    [...RUNNER_OBSERVABILITY_SUPPORT_PATHS].sort(),
    'a project without farm refs still carries the runner installer',
  );
  assert.equal(rec.execs.length, 0);
  assert.equal(rec.written.length, 0);
});

test('a slot on a stale bundle gets the current bundle published and selected; later launches only re-check and repoint', async () => {
  const { io, rec } = fakeIo({ remoteManifestHash: null });
  const state = await ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io });
  assert.ok(state?.hash, 'a remote slot gets a content hash');
  assert.equal(state.published, true);
  assert.equal(state.supportDir, `/tmp/node-home/farmslot-node/support/${state.hash}`);
  assert.deepEqual(rec.execs.map(kind), [
    'resolve-home',
    'incoming',
    'verify',
    'activate',
    'verify',
  ]);
  const manifest = JSON.parse(rec.manifests[0]) as {
    hash: string;
    paths: string[];
    fileCount: number;
  };
  assert.equal(manifest.hash, state.hash);
  assert.ok(manifest.paths.includes('scripts/install-runner-observability.mjs'));
  assert.ok(manifest.paths.includes('scripts/runners/pi-farmslot-providers.mjs'));
  assert.equal(
    manifest.fileCount,
    RUNNER_OBSERVABILITY_SUPPORT_PATHS.length,
    'a project without hooks bundles only the installer files',
  );
  // The slot's pointer is the last write and names the published bundle.
  const selection = rec.written.at(-1)!;
  assert.equal(selection.base, '/Users/deeeed/dev/.farmslot-runtime/x/.agent/.observability');
  assert.deepEqual(selection.paths, ['node-support-hash']);

  // Next launch on the same slot: one presence check, pointer rewritten, no publish.
  const again = await ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io });
  assert.equal(again?.published, false);
  assert.deepEqual(rec.execs.slice(5).map(kind), ['resolve-home', 'presence', 'activate']);
  assert.equal(rec.written.length, 3, 'the pointer is written on every launch');
  assert.deepEqual(rec.written.at(-1)!.paths, ['node-support-hash']);
});

test('a slot whose node already holds the current bundle is checked and repointed, never republished', async () => {
  const probe = fakeIo({ remoteManifestHash: null });
  const current = await ensureNodeSupportBundle(remoteVars(), '.agent', {
    projectVars,
    io: probe.io,
  });
  const { io, rec } = fakeIo({ remoteManifestHash: current!.hash });
  const state = await ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io });
  assert.equal(state?.published, false);
  assert.deepEqual(rec.execs.map(kind), ['resolve-home', 'presence', 'activate']);
  assert.equal(rec.written.length, 1);
  assert.deepEqual(rec.written[0].paths, ['node-support-hash']);
  // Prepare asks for the full checksum verification.
  await ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io, verify: 'full' });
  assert.deepEqual(rec.execs.slice(3).map(kind), ['resolve-home', 'verify', 'activate']);
});

test('a bundle whose files are gone is reported and never selected', async () => {
  const probe = fakeIo({ remoteManifestHash: null });
  const current = await ensureNodeSupportBundle(remoteVars(), '.agent', {
    projectVars,
    io: probe.io,
  });
  const { io, rec } = fakeIo({ remoteManifestHash: current!.hash });
  const originalExec = io.exec;
  io.exec = async (vars, cmd) =>
    isSupportHomeCommand(cmd)
      ? originalExec(vars, cmd)
      : { exitCode: 1, stdout: '', stderr: 'missing' };
  await assert.rejects(
    ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io }),
    /Node support bundle corrupt/,
  );
  assert.equal(rec.written.length, 0);
});

test('unreadable run inventory preserves all bundles without blocking delivery or reuse', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'support-unreadable-run-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { io, rec } = fakeIo({ remoteManifestHash: null });
  io.retentionReferences = async () => {
    await persistedNodeSupportRuns(directory);
    return { selectionPaths: [], runHashes: [] };
  };
  const details: string[] = [];
  const options = {
    projectVars,
    io,
    step: (_name: string, detail: string) => details.push(detail),
  };
  for (const content of ['{', JSON.stringify({ id: 'broken' })]) {
    await writeFile(path.join(directory, 'broken.json'), content);
    const state = await ensureNodeSupportBundle(remoteVars(), '.agent', options);
    assert.ok(state?.hash);
  }
  assert.equal(rec.execs.filter((cmd) => kind(cmd) === 'activate').length, 2);
  for (const cmd of rec.execs.filter((cmd) => kind(cmd) === 'activate'))
    assert.ok(cmd.includes('"references":null'));
  assert.equal(details.filter((detail) => detail.includes('pruning skipped')).length, 2);
  assert.deepEqual(rec.written.at(-1)?.paths, ['node-support-hash']);
});

test('a failed upload discards the incoming dir and aborts the launch', async () => {
  const { io, rec } = fakeIo({ remoteManifestHash: null });
  io.writeFiles = async (_vars, baseDir) => {
    if (baseDir.includes('.incoming')) throw new Error('scp died');
    rec.written.push({ base: baseDir, paths: [] });
  };
  await assert.rejects(
    ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io }),
    /scp died/,
  );
  assert.deepEqual(rec.execs.map(kind), ['resolve-home', 'incoming', 'discard']);
  assert.equal(rec.written.length, 0, 'no pointer is written for an unpublished bundle');
});

test('read-only prerequisite delivery and reuse preserve the slot support pointer', async () => {
  const { io, rec } = fakeIo({ remoteManifestHash: null });
  const state = await ensureNodeSupportBundle(remoteVars(), '.agent', {
    projectVars,
    io,
    selectSlot: false,
  });
  assert.ok(state?.hash);
  assert.equal(state.published, true);
  assert.equal(
    rec.written.some((write) => write.paths.includes('node-support-hash')),
    false,
  );
  rec.written.length = 0;
  const reused = await ensureNodeSupportBundle(remoteVars(), '.agent', {
    projectVars,
    io,
    selectSlot: false,
  });
  assert.equal(reused?.published, false);
  assert.equal(rec.written.length, 0);
  await ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io });
  assert.deepEqual(rec.written.at(-1)?.paths, ['node-support-hash']);
});

test('a quoted project Node hook resolves from the remote home instead of the slot cwd', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { io } = fakeIo({ remoteManifestHash: null });
  const fakeExec = io.exec;
  io.exec = async (vars, cmd) => {
    if (!isSupportHomeCommand(cmd)) return fakeExec(vars, cmd);
    return {
      exitCode: 0,
      stdout: execFileSync('sh', ['-c', cmd.replaceAll('${HOME}', '${TEST_NODE_HOME}')], {
        env: { ...process.env, TEST_NODE_HOME: root },
        encoding: 'utf8',
      }),
      stderr: '',
    };
  };
  const state = await ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io });
  assert.ok(state);
  const hook = path.join(state.supportDir, 'projects/example-farm/scripts/project.mjs');
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const command = remapRemoteFarmRefs(
    `${JSON.stringify(process.execPath)} '~/farmslot-node/projects/example-farm/scripts/project.mjs' setup slot-6`,
    state.supportDir,
    ['projects/example-farm/scripts'],
  );
  assert.ok(!command.includes('~/'), command);
  assert.equal(
    execFileSync('sh', ['-c', command], { cwd: root, encoding: 'utf8' }).trim(),
    '["setup","slot-6"]',
  );
});

test('fixture checks read the bundle the slot selected, from the pointer ensure writes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-support-selected-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vars = { ...remoteVars(), remoteRepo: path.join(root, 'checkout') };
  const { io, rec } = fakeIo({ remoteManifestHash: null });
  const state = await ensureNodeSupportBundle(vars, '.agent', { projectVars, io });
  assert.ok(state?.hash);
  const pointer = nodeSupportHashPath(vars.remoteRepo, '.agent');
  assert.ok(!pointer.startsWith(`${vars.remoteRepo}/`), pointer);
  assert.equal(rec.written.at(-1)?.base, path.dirname(pointer));

  const shellIo: Pick<NodeSupportIo, 'exec'> = {
    exec: async (_vars, cmd) => {
      try {
        const stdout = execFileSync('sh', ['-c', cmd.replaceAll('${HOME}', '${TEST_NODE_HOME}')], {
          env: { ...process.env, TEST_NODE_HOME: root },
          encoding: 'utf8',
        });
        return { exitCode: 0, stdout, stderr: '' };
      } catch {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
    },
  };
  assert.equal(await selectedNodeSupportDir(vars, '.agent', projectVars, shellIo), undefined);
  await mkdir(path.dirname(pointer), { recursive: true });
  await writeFile(pointer, `${state.hash}\n`);
  assert.equal(
    await selectedNodeSupportDir(vars, '.agent', projectVars, shellIo),
    path.join(root, 'farmslot-node/support', state.hash),
  );
  await writeFile(pointer, '../../escape\n');
  assert.equal(await selectedNodeSupportDir(vars, '.agent', projectVars, shellIo), undefined);
  const local = { ...vars, host: 'localhost', machine: 'local' };
  assert.equal(await selectedNodeSupportDir(local, '.agent', projectVars, shellIo), farmslotRoot);
});

test('a fixture check whose node drops renders without a selection instead of failing the check', async () => {
  const dropped: Pick<NodeSupportIo, 'exec'> = {
    exec: async () => {
      throw new Error('node disconnected');
    },
  };
  assert.equal(await fixtureCheckVars(remoteVars(), projectVars, 5_000, dropped), undefined);
});
