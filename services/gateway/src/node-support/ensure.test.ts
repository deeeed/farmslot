import assert from 'node:assert/strict';
import test from 'node:test';

import { farmslotRoot, type ProjectVars, type SlotVars } from '../core/index.js';

import {
  ensureNodeSupportBundle,
  type NodeSupportIo,
  resetNodeSupportBundleCache,
} from './ensure.js';

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

function fakeIo(opts: { remoteManifestHash: string | null }): { io: NodeSupportIo; rec: Recorded } {
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
    fileExists: async () => opts.remoteManifestHash !== null,
    readFile: async (_vars, filePath) => {
      if (filePath.endsWith('manifest.json')) {
        // After a publish the manifest on the node is the one this call wrote.
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
          : 'other';

test('a local slot uses the checkout directly and touches no node', async () => {
  resetNodeSupportBundleCache();
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

test('a slot on a stale bundle gets the current bundle published and selected, then cached', async () => {
  resetNodeSupportBundleCache();
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
  assert.equal(
    manifest.fileCount,
    3,
    'a project without hooks bundles only the runner installer files',
  );
  // The slot's pointer is the last write and names the published bundle.
  const selection = rec.written.at(-1)!;
  assert.equal(selection.base, '/Users/deeeed/dev/x/.agent/.observability');
  assert.deepEqual(selection.paths, ['node-support-hash']);

  // Same process, same slot: nothing to do.
  const again = await ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io });
  assert.equal(again?.published, false);
  assert.equal(rec.execs.length, 4, 'no further node commands');
  assert.equal(rec.written.length, 2, 'no further writes');

  // Same machine, another slot: bundle known, only the pointer is written.
  await ensureNodeSupportBundle(remoteVars('macpro-x-2'), '.agent', { projectVars, io });
  assert.equal(rec.execs.length, 4);
  assert.equal(rec.written.at(-1)!.base, '/Users/deeeed/dev/x/.agent/.observability');
});

test('a slot whose node already holds the current bundle is verified once and only repointed', async () => {
  resetNodeSupportBundleCache();
  const probe = fakeIo({ remoteManifestHash: null });
  const current = await ensureNodeSupportBundle(remoteVars(), '.agent', {
    projectVars,
    io: probe.io,
  });
  resetNodeSupportBundleCache();
  const { io, rec } = fakeIo({ remoteManifestHash: current!.hash });
  const state = await ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io });
  assert.equal(state?.published, false);
  assert.deepEqual(rec.execs.map(kind), ['verify']);
  assert.equal(rec.written.length, 1);
  assert.deepEqual(rec.written[0].paths, ['node-support-hash']);
});

test('a corrupt current bundle is reported, not selected', async () => {
  resetNodeSupportBundleCache();
  const probe = fakeIo({ remoteManifestHash: null });
  const current = await ensureNodeSupportBundle(remoteVars(), '.agent', {
    projectVars,
    io: probe.io,
  });
  resetNodeSupportBundleCache();
  const { io, rec } = fakeIo({ remoteManifestHash: current!.hash });
  io.exec = async () => ({ exitCode: 1, stdout: '', stderr: 'mismatch' });
  await assert.rejects(
    ensureNodeSupportBundle(remoteVars(), '.agent', { projectVars, io }),
    /Node support bundle corrupt/,
  );
  assert.equal(rec.written.length, 0);
});
