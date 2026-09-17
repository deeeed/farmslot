import assert from 'node:assert/strict';
import test from 'node:test';

import { farmslotRoot, type ProjectVars, type SlotVars } from '../core/index.js';
import { RUNNER_OBSERVABILITY_SUPPORT_PATHS } from '../runners/runner-observability.js';

import { ensureNodeSupportBundle, type NodeSupportIo } from './ensure.js';

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
    exec: async (_vars, cmd) => {
      rec.execs.push(cmd);
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
  cmd.includes('mktemp -d')
    ? 'incoming'
    : cmd.includes('hash_file()')
      ? 'verify'
      : cmd.includes('.locks')
        ? 'publish'
        : cmd.startsWith('rm -rf')
          ? 'discard'
          : cmd.startsWith('[ -f ') && cmd.includes('install-runner-observability.mjs')
            ? 'presence'
            : 'other';

test('a local slot uses the checkout directly and touches no node', async () => {
  const { io, rec } = fakeIo({ remoteManifestHash: null });
  const state = await ensureNodeSupportBundle(
    { ...remoteVars(), host: 'localhost', machine: 'local' } as SlotVars,
    '.agent',
    { projectVars, io },
  );
  assert.deepEqual(state, { supportDir: farmslotRoot, hash: null, published: false });
  assert.equal(rec.execs.length, 0);
  assert.equal(rec.written.length, 0);
});

test('a slot on a stale bundle gets the current bundle published and selected; later launches only re-check and repoint', async () => {
  const { io, rec } = fakeIo({ remoteManifestHash: null });
  const state = await ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io });
  assert.ok(state?.hash, 'a remote slot gets a content hash');
  assert.equal(state.published, true);
  assert.equal(state.supportDir, `~/farmslot-node/support/${state.hash}`);
  assert.deepEqual(rec.execs.map(kind), ['incoming', 'verify', 'publish', 'verify']);
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
  assert.equal(selection.base, '/Users/deeeed/dev/x/.agent/.observability');
  assert.deepEqual(selection.paths, ['node-support-hash']);

  // Next launch on the same slot: one presence check, pointer rewritten, no publish.
  const again = await ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io });
  assert.equal(again?.published, false);
  assert.deepEqual(rec.execs.slice(4).map(kind), ['presence']);
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
  assert.deepEqual(rec.execs.map(kind), ['presence']);
  assert.equal(rec.written.length, 1);
  assert.deepEqual(rec.written[0].paths, ['node-support-hash']);
  // Prepare asks for the full checksum verification.
  await ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io, verify: 'full' });
  assert.deepEqual(rec.execs.slice(1).map(kind), ['verify']);
});

test('a bundle whose files are gone is reported and never selected', async () => {
  const probe = fakeIo({ remoteManifestHash: null });
  const current = await ensureNodeSupportBundle(remoteVars(), '.agent', {
    projectVars,
    io: probe.io,
  });
  const { io, rec } = fakeIo({ remoteManifestHash: current!.hash });
  io.exec = async () => ({ exitCode: 1, stdout: '', stderr: 'missing' });
  await assert.rejects(
    ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io }),
    /Node support bundle corrupt/,
  );
  assert.equal(rec.written.length, 0);
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
  assert.deepEqual(rec.execs.map(kind), ['incoming', 'discard']);
  assert.equal(rec.written.length, 0, 'no pointer is written for an unpublished bundle');
});
