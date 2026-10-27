// @farmslot:serial — writes slot fixtures into the shared `pool/` directory and status file.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { WebSocket } from 'ws';

import { type FsConflictDetails, FsErrorCodes } from '@farmslot/protocol';

import * as nodeFs from '../../../node/src/commands/fs.js';
import { poolDir } from '../core/config.js';
import { statusFile } from '../core/state.js';
import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse } from '../fleet/node-rpc.js';

import { fsDelete, fsMkdir, fsRead, fsRename, fsWrite } from './filesystem.js';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
// "café\n" in Latin-1: not valid UTF-8, so decoding the text loses bytes.
const nonUtf8 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);

const nodeCommands: Record<string, (params: any) => Promise<unknown>> = {
  'fs.read': nodeFs.fsRead,
  'fs.write': nodeFs.fsWrite,
  'fs.rename': nodeFs.fsRename,
  'fs.delete': nodeFs.fsDelete,
  'fs.mkdir': nodeFs.fsMkdir,
};

/** Answers gateway file requests with the node's own commands, as services/node replies. */
class NodeFileHost {
  readyState = WebSocket.OPEN;
  readonly methods: string[] = [];

  send(raw: string) {
    const frame = JSON.parse(raw) as { id: string; method: string; params: unknown };
    this.methods.push(frame.method);
    void (async () => {
      try {
        handleNodeResponse(frame.id, true, await nodeCommands[frame.method](frame.params));
      } catch (error) {
        const failed = error as NodeJS.ErrnoException & { details?: unknown };
        handleNodeResponse(
          frame.id,
          false,
          null,
          failed.message,
          failed.code,
          undefined,
          failed.details,
        );
      }
    })();
  }
}

interface Slot {
  slotId: string;
  repoDir: string;
  host?: NodeFileHost;
}

async function localSlot(t: TestContext): Promise<Slot> {
  return slotFixture(t, 'localhost', 'local-conditional-machine');
}

/** A remote slot whose node runs the real node file commands on a local directory. */
async function remoteSlot(t: TestContext, conditionalWrites: boolean): Promise<Slot> {
  const machine = `conditional-node-${randomUUID()}`;
  const slot = await slotFixture(t, '203.0.113.10', machine);
  const host = new NodeFileHost();
  registerNode(
    machine,
    1,
    host as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    conditionalWrites,
  );
  t.after(() => unregisterByWs(host as any));
  return { ...slot, host };
}

async function slotFixture(t: TestContext, host: string, machine: string): Promise<Slot> {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'farmslot-conditional-'));
  const slotId = `conditional-${path.basename(repoDir)}`;
  const poolFile = path.join(poolDir, `${slotId}.json`);
  await mkdir(poolDir, { recursive: true });
  await writeFile(
    poolFile,
    JSON.stringify({
      machine,
      project: 'demo-project',
      platform: 'ios',
      os: process.platform === 'darwin' ? 'darwin' : 'linux',
      host,
      ssh_user: 'tester',
      slots: [{ id: slotId, repo: repoDir, session: 'slot' }],
    }),
  );
  t.after(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });
  return { slotId, repoDir };
}

/** The slot's claim row in the status file, restored after the test. */
async function claimSlot(t: TestContext, slotId: string, runId: string | null) {
  const prior = await readFile(statusFile, 'utf8').catch(() => null);
  const data = prior ? JSON.parse(prior) : { slots: [] };
  const others = (data.slots ?? []).filter((row: { slot: string }) => row.slot !== slotId);
  await mkdir(path.dirname(statusFile), { recursive: true });
  await writeFile(
    statusFile,
    `${JSON.stringify({
      ...data,
      slots: [
        ...others,
        { slot: slotId, lifecycle: runId ? 'busy' : 'ready', current_run_id: runId },
      ],
    })}\n`,
  );
  t.after(async () => {
    if (prior == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, prior);
  });
}

async function refused(promise: Promise<unknown>, details: FsConflictDetails) {
  await assert.rejects(promise, (error: NodeJS.ErrnoException & { details?: unknown }) => {
    assert.equal(error.code, FsErrorCodes.conflict, error.message);
    assert.deepEqual(error.details, details);
    return true;
  });
}

test('fs.read returns the hash of the raw bytes, equal to fs.hash, on local and remote slots', async (t) => {
  for (const slot of [await localSlot(t), await remoteSlot(t, true)]) {
    await writeFile(path.join(slot.repoDir, 'latin1.txt'), nonUtf8);
    const read = await fsRead({ slotId: slot.slotId, path: 'latin1.txt' });
    const { sha256: nodeHash } = await nodeFs.fsHash({
      root: slot.repoDir,
      relPath: 'latin1.txt',
    });
    assert.equal(read.hash, nodeHash);
    assert.equal(read.hash, sha256(nonUtf8));
    assert.notEqual(read.hash, sha256(read.content), 'the hash is not taken from decoded text');
  }
});

test('stale and absent preconditions are refused with the current hash, locally and through a node', async (t) => {
  for (const slot of [await localSlot(t), await remoteSlot(t, true)]) {
    const { slotId, repoDir } = slot;
    const file = (name: string) => path.join(repoDir, name);
    await writeFile(file('a.txt'), 'one');
    const { hash: one } = await fsRead({ slotId, path: 'a.txt' });

    await refused(fsWrite({ slotId, path: 'a.txt', content: 'lost', expectedHash: 'stale' }), {
      reason: 'hash',
      currentHash: one,
    });
    assert.equal(await readFile(file('a.txt'), 'utf8'), 'one');
    const written = await fsWrite({ slotId, path: 'a.txt', content: 'two', expectedHash: one });
    assert.deepEqual(written, { ok: true, hash: sha256('two') });
    await refused(fsWrite({ slotId, path: 'missing.txt', content: 'x', expectedHash: one }), {
      reason: 'hash',
    });

    // `null` means the file must not exist.
    await refused(fsWrite({ slotId, path: 'a.txt', content: 'lost', expectedHash: null }), {
      reason: 'hash',
      currentHash: sha256('two'),
    });
    assert.deepEqual(await fsWrite({ slotId, path: 'b.txt', content: 'b', expectedHash: null }), {
      ok: true,
      hash: sha256('b'),
    });

    // A guarded rename needs the source hash and an absent destination.
    await refused(
      fsRename({ slotId, oldPath: 'a.txt', newPath: 'b.txt', expectedHash: sha256('two') }),
      { reason: 'destination-exists', currentHash: sha256('b') },
    );
    await refused(fsRename({ slotId, oldPath: 'a.txt', newPath: 'c.txt', expectedHash: 'stale' }), {
      reason: 'hash',
      currentHash: sha256('two'),
    });
    // A directory destination has no hash; a symlink destination keeps its refusal.
    await mkdir(file('dir'));
    await refused(
      fsRename({ slotId, oldPath: 'a.txt', newPath: 'dir', expectedHash: sha256('two') }),
      { reason: 'destination-exists' },
    );
    await symlink('b.txt', file('link'));
    await assert.rejects(
      fsRename({ slotId, oldPath: 'a.txt', newPath: 'link', expectedHash: sha256('two') }),
      /Refusing final-component symlink: link/,
    );
    assert.equal(await readFile(file('a.txt'), 'utf8'), 'two');
    assert.ok((await stat(file('dir'))).isDirectory());
    assert.equal(await readFile(file('b.txt'), 'utf8'), 'b');
    assert.deepEqual(
      await fsRename({ slotId, oldPath: 'a.txt', newPath: 'c.txt', expectedHash: sha256('two') }),
      { ok: true, hash: sha256('two') },
    );

    await refused(fsDelete({ slotId, path: 'c.txt', expectedHash: 'stale' }), {
      reason: 'hash',
      currentHash: sha256('two'),
    });
    assert.equal(await readFile(file('c.txt'), 'utf8'), 'two');
    await fsDelete({ slotId, path: 'c.txt', expectedHash: sha256('two') });
    await assert.rejects(stat(file('c.txt')), { code: 'ENOENT' });

    await assert.rejects(
      fsDelete({ slotId, path: 'dir', expectedHash: sha256('') }),
      /File versions apply to files only/,
    );
    assert.ok((await stat(file('dir'))).isDirectory());
  }
});

test('a change naming a run is refused unless the slot serves that run, and null requires none', async (t) => {
  // Run binding is the gateway's check, so a node without conditional writes is bound too.
  for (const slot of [await localSlot(t), await remoteSlot(t, false)]) {
    const { slotId, repoDir } = slot;
    await claimSlot(t, slotId, 'run-a');
    await refused(fsWrite({ slotId, path: 'a.txt', content: 'x', runId: 'run-b' }), {
      reason: 'run',
      currentRunId: 'run-a',
    });
    await refused(fsWrite({ slotId, path: 'a.txt', content: 'x', runId: null }), {
      reason: 'run',
      currentRunId: 'run-a',
    });
    await refused(fsMkdir({ slotId, path: 'dir', runId: 'run-b' }), {
      reason: 'run',
      currentRunId: 'run-a',
    });
    await assert.rejects(stat(path.join(repoDir, 'a.txt')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(repoDir, 'dir')), { code: 'ENOENT' });
    await fsWrite({ slotId, path: 'a.txt', content: 'x', runId: 'run-a' });

    await claimSlot(t, slotId, null);
    await refused(fsDelete({ slotId, path: 'a.txt', runId: 'run-a' }), {
      reason: 'run',
      currentRunId: null,
    });
    await fsRename({ slotId, oldPath: 'a.txt', newPath: 'b.txt', runId: null });
    assert.equal(await readFile(path.join(repoDir, 'b.txt'), 'utf8'), 'x');
  }
});

test('a conditional write to a node without conditionalWrites is refused before it is sent', async (t) => {
  const { slotId, repoDir, host } = await remoteSlot(t, false);
  await writeFile(path.join(repoDir, 'a.txt'), 'one');
  for (const change of [
    () => fsWrite({ slotId, path: 'a.txt', content: 'two', expectedHash: sha256('one') }),
    () => fsWrite({ slotId, path: 'new.txt', content: 'two', expectedHash: null }),
    () => fsRename({ slotId, oldPath: 'a.txt', newPath: 'b.txt', expectedHash: sha256('one') }),
    () => fsDelete({ slotId, path: 'a.txt', expectedHash: sha256('one') }),
  ])
    await assert.rejects(change(), { code: FsErrorCodes.preconditionUnsupported });
  assert.deepEqual(host!.methods, []);
  assert.equal(await readFile(path.join(repoDir, 'a.txt'), 'utf8'), 'one');
  // Unconditional writes behave as today.
  await fsWrite({ slotId, path: 'a.txt', content: 'two' });
  assert.equal(await readFile(path.join(repoDir, 'a.txt'), 'utf8'), 'two');
});
