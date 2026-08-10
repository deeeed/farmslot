import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse } from '../fleet/node-rpc.js';

import {
  WORKER_ARTIFACT_COPY_EXCLUDES,
  WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES,
} from './artifact-copy-policy.js';
import { setFileTransferBroadcast } from './file-transfer.js';
import {
  slotCopyDir,
  SlotCopyDirEntryError,
  slotCopyFile,
  slotFileExists,
  slotReadFileBuffer,
} from './slot-io.js';

class FakeNodeWebSocket {
  readyState = WebSocket.OPEN;
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(
    private readonly handlers: {
      onExists?: (params: { path: string; root?: string; relPath?: string }) => {
        exists: boolean;
      };
      onRealpath?: (params: { path: string; root?: string; relPath?: string }) => {
        path: string;
      };
      onList?: (params: { path: string; root?: string; relPath?: string }) => {
        entries: Array<{ name: string; type: string; size?: number }>;
      };
      onReadBase64?: (params: { path: string; root?: string; relPath?: string }) => {
        content: string;
      };
      onStat?: (params: { path: string; root?: string; relPath?: string }) => {
        size: number;
        isFile: boolean;
        isDirectory: boolean;
        mtimeMs: number;
      };
      onReadChunk?: (params: {
        path: string;
        root?: string;
        relPath?: string;
        offset?: number;
        length?: number;
      }) => {
        content: string;
        size: number;
        offset: number;
        bytesRead: number;
        eof: boolean;
      };
    },
  ) {}

  send(raw: string) {
    const frame = JSON.parse(raw) as {
      id: string;
      method: string;
      params: {
        path?: string;
        root?: string;
        relPath?: string;
        offset?: number;
        length?: number;
      };
    };
    this.calls.push({ method: frame.method, params: frame.params as Record<string, unknown> });
    const handlerParams = {
      ...frame.params,
      path:
        frame.params.path ?? path.resolve(frame.params.root ?? '/', frame.params.relPath ?? '.'),
    };
    queueMicrotask(() => {
      if (frame.method === 'fs.exists') {
        handleNodeResponse(
          frame.id,
          true,
          this.handlers.onExists?.(handlerParams) ?? { exists: false },
        );
        return;
      }
      if (frame.method === 'fs.realpath') {
        handleNodeResponse(
          frame.id,
          true,
          this.handlers.onRealpath?.(handlerParams) ?? { path: handlerParams.path },
        );
        return;
      }
      if (frame.method === 'fs.list') {
        handleNodeResponse(
          frame.id,
          true,
          this.handlers.onList?.(handlerParams) ?? { entries: [] },
        );
        return;
      }
      if (frame.method === 'fs.stat') {
        handleNodeResponse(
          frame.id,
          true,
          this.handlers.onStat?.(handlerParams) ?? {
            size: 0,
            isFile: true,
            isDirectory: false,
            mtimeMs: 0,
          },
        );
        return;
      }
      if (frame.method === 'fs.readBase64') {
        try {
          handleNodeResponse(
            frame.id,
            true,
            this.handlers.onReadBase64?.(handlerParams) ?? { content: '' },
          );
        } catch (err) {
          handleNodeResponse(
            frame.id,
            false,
            null,
            err instanceof Error ? err.message : String(err),
          );
        }
        return;
      }
      if (frame.method === 'fs.readChunk') {
        try {
          handleNodeResponse(
            frame.id,
            true,
            this.handlers.onReadChunk?.(handlerParams) ?? {
              content: '',
              size: 0,
              offset: handlerParams.offset ?? 0,
              bytesRead: 0,
              eof: true,
            },
          );
        } catch (err) {
          handleNodeResponse(
            frame.id,
            false,
            null,
            err instanceof Error ? err.message : String(err),
          );
        }
        return;
      }
      if (frame.method === 'fs.hash') {
        handleNodeResponse(frame.id, true, { sha256: 'deadbeef', size: 0 });
        return;
      }
      handleNodeResponse(frame.id, false, null, `unexpected method ${frame.method}`);
    });
  }
}

test('remote slot paths preserve .git segments relative to the filesystem root', async (t) => {
  let observed: { root?: string; relPath?: string } | undefined;
  const fakeWs = new FakeNodeWebSocket({
    onExists: (params) => {
      observed = params;
      return { exists: false };
    },
  });
  registerNode('slot-path-machine', 123, fakeWs as any);
  t.after(() => unregisterByWs(fakeWs as any));

  await slotFileExists(
    {
      host: '203.0.113.12',
      machine: 'slot-path-machine',
      sshTarget: 'tester@203.0.113.12',
    },
    '/repo/.git/config',
  );

  assert.equal(observed?.root, path.parse('/repo/.git/config').root);
  assert.equal(observed?.relPath, path.join('repo', '.git', 'config'));
});

test('slotCopyDir skips local symlinks instead of copying them into artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-slot-io-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceDir = path.join(root, 'source');
  const destDir = path.join(root, 'dest');
  const externalDir = path.join(root, 'external');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(externalDir, { recursive: true });
  await writeFile(path.join(sourceDir, 'kept.txt'), 'kept', 'utf-8');
  await writeFile(path.join(externalDir, 'outside.txt'), 'outside', 'utf-8');
  await symlink(externalDir, path.join(sourceDir, 'escape-link'));

  const copied = await slotCopyDir(
    { host: 'localhost', machine: 'test-machine', sshTarget: 'localhost' },
    sourceDir,
    destDir,
  );

  assert.equal(copied, 1);
  assert.equal(await readFile(path.join(destDir, 'kept.txt'), 'utf-8'), 'kept');
  assert.equal(existsSync(path.join(destDir, 'escape-link')), false);
  assert.equal(await readFile(path.join(externalDir, 'outside.txt'), 'utf-8'), 'outside');
});

test('slotCopyDir can skip excluded top-level files and directories', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-slot-io-exclude-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceDir = path.join(root, 'source');
  const destDir = path.join(root, 'dest');
  await mkdir(path.join(sourceDir, 'recipe-runs'), { recursive: true });
  await writeFile(path.join(sourceDir, 'keep.json'), '{}', 'utf-8');
  await writeFile(path.join(sourceDir, 'diff-stat.json'), '{\"stale\":true}', 'utf-8');
  await writeFile(path.join(sourceDir, 'recipe-runs', 'old.json'), '{}', 'utf-8');

  await slotCopyDir(
    { host: 'localhost', machine: 'test-machine', sshTarget: 'localhost' },
    sourceDir,
    destDir,
    { excludeTopLevel: ['recipe-runs', 'diff-stat.json'] },
  );

  assert.equal(existsSync(path.join(destDir, 'keep.json')), true);
  assert.equal(existsSync(path.join(destDir, 'diff-stat.json')), false);
  assert.equal(existsSync(path.join(destDir, 'recipe-runs')), false);
});

test('slotCopyDir worker artifact policy preserves gateway-owned diff artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-slot-io-diff-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceDir = path.join(root, 'slot-artifacts');
  const destDir = path.join(root, 'gateway-artifacts');
  await mkdir(path.join(sourceDir, 'recipe-runs'), { recursive: true });
  await mkdir(path.join(sourceDir, 'harness-launch'), { recursive: true });
  await mkdir(path.join(sourceDir, 'harness-relaunch'), { recursive: true });
  await mkdir(path.join(sourceDir, 'runtime-launch', 'chrome-profile'), { recursive: true });
  await mkdir(path.join(sourceDir, 'runtime-relaunch', 'chrome-profile'), { recursive: true });
  await mkdir(path.join(sourceDir, 'runner-blockers'), { recursive: true });
  await mkdir(path.join(sourceDir, 'screenshots'), { recursive: true });
  await mkdir(path.join(sourceDir, 'packages'), { recursive: true });
  await mkdir(path.join(destDir, 'packages'), { recursive: true });
  await mkdir(destDir, { recursive: true });
  await writeFile(path.join(sourceDir, 'diff.txt'), 'worker diff', 'utf-8');
  await writeFile(path.join(sourceDir, 'diff-stat.json'), '{"source":"worker"}', 'utf-8');
  await writeFile(path.join(sourceDir, 'experiment-manifest.json'), '{"source":"worker"}', 'utf-8');
  await writeFile(
    path.join(sourceDir, 'packages', 'candidate.result-package.json'),
    '{"source":"worker"}',
    'utf-8',
  );
  await writeFile(
    path.join(sourceDir, 'packages', 'worker-note.json'),
    '{"source":"worker-note"}',
    'utf-8',
  );
  await writeFile(path.join(sourceDir, 'report.md'), 'worker report', 'utf-8');
  await writeFile(path.join(sourceDir, 'recipe-runs', 'stale.json'), '{}', 'utf-8');
  await writeFile(path.join(sourceDir, 'harness-launch', 'summary.json'), '{}', 'utf-8');
  await writeFile(path.join(sourceDir, 'harness-relaunch', 'summary.json'), '{}', 'utf-8');
  await writeFile(
    path.join(sourceDir, 'runtime-launch', 'chrome-profile', 'Preferences'),
    '{}',
    'utf-8',
  );
  await writeFile(
    path.join(sourceDir, 'runtime-relaunch', 'chrome-profile', 'Preferences'),
    '{}',
    'utf-8',
  );
  await writeFile(
    path.join(sourceDir, 'runner-blockers', 'self-review-launch.txt'),
    'pane failed',
    'utf-8',
  );
  await writeFile(path.join(sourceDir, 'screenshots', 'debug.png'), 'debug', 'utf-8');
  await mkdir(path.join(sourceDir, 'recipe-harness', 'source', 'checkout'), { recursive: true });
  await mkdir(path.join(sourceDir, 'recipe-harness', 'verify'), { recursive: true });
  await writeFile(
    path.join(sourceDir, 'recipe-harness', 'source', 'checkout', 'SKILL.md'),
    'harness source',
    'utf-8',
  );
  await writeFile(
    path.join(sourceDir, 'recipe-harness', 'verify', 'summary.json'),
    '{"ok":true}',
    'utf-8',
  );
  await writeFile(path.join(destDir, 'diff.txt'), 'gateway diff', 'utf-8');
  await writeFile(path.join(destDir, 'diff-stat.json'), '{"source":"gateway"}', 'utf-8');
  await writeFile(path.join(destDir, 'experiment-manifest.json'), '{"source":"gateway"}', 'utf-8');
  await writeFile(
    path.join(destDir, 'packages', 'candidate.result-package.json'),
    '{"source":"gateway"}',
    'utf-8',
  );

  await slotCopyDir(
    { host: 'localhost', machine: 'test-machine', sshTarget: 'localhost' },
    sourceDir,
    destDir,
    {
      excludeTopLevel: [...WORKER_ARTIFACT_COPY_EXCLUDES],
      excludeRelativePaths: [...WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES],
    },
  );

  assert.equal(await readFile(path.join(destDir, 'diff.txt'), 'utf-8'), 'gateway diff');
  assert.equal(
    await readFile(path.join(destDir, 'diff-stat.json'), 'utf-8'),
    '{"source":"gateway"}',
  );
  assert.equal(
    await readFile(path.join(destDir, 'experiment-manifest.json'), 'utf-8'),
    '{"source":"gateway"}',
  );
  assert.equal(
    await readFile(path.join(destDir, 'packages', 'candidate.result-package.json'), 'utf-8'),
    '{"source":"gateway"}',
  );
  assert.equal(
    await readFile(path.join(destDir, 'packages', 'worker-note.json'), 'utf-8'),
    '{"source":"worker-note"}',
  );
  assert.equal(await readFile(path.join(destDir, 'report.md'), 'utf-8'), 'worker report');
  assert.equal(existsSync(path.join(destDir, 'recipe-harness', 'source')), false);
  assert.equal(
    await readFile(path.join(destDir, 'recipe-harness', 'verify', 'summary.json'), 'utf-8'),
    '{"ok":true}',
  );
  assert.equal(existsSync(path.join(destDir, 'recipe-runs')), false);
  assert.equal(existsSync(path.join(destDir, 'harness-launch')), false);
  assert.equal(existsSync(path.join(destDir, 'harness-relaunch')), false);
  assert.equal(existsSync(path.join(destDir, 'runtime-launch')), false);
  assert.equal(existsSync(path.join(destDir, 'runtime-relaunch')), false);
  assert.equal(existsSync(path.join(destDir, 'runner-blockers')), false);
  assert.equal(existsSync(path.join(destDir, 'screenshots')), false);
});

test('slotCopyDir rejects remote symlinked roots before recursive copy', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-slot-io-remote-'));
  const destDir = path.join(root, 'dest');
  const remoteDir = '/repo/artifacts/recipe-runs/linked-run';
  const fakeWs = new FakeNodeWebSocket({
    onExists: () => ({ exists: true }),
    onRealpath: ({ path: requestedPath }) => {
      if (requestedPath === remoteDir) return { path: '/outside/linked-run' };
      if (requestedPath === path.dirname(remoteDir)) return { path: '/repo/artifacts/recipe-runs' };
      return { path: requestedPath };
    },
  });
  registerNode('remote-machine', 123, fakeWs as any);

  t.after(async () => {
    unregisterByWs(fakeWs as any);
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () =>
      slotCopyDir(
        { host: '203.0.113.10', machine: 'remote-machine', sshTarget: 'tester@203.0.113.10' },
        remoteDir,
        destDir,
      ),
    /refuses symlinked root/,
  );
  assert.equal(existsSync(destDir), false);
});

test('slotCopyDir reports the remote file path on per-file copy failure', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-slot-io-remote-copy-fail-'));
  const destDir = path.join(root, 'dest');
  const remoteDir = '/repo/artifacts';
  const failingPath = '/repo/artifacts/blocked.txt';
  const fakeWs = new FakeNodeWebSocket({
    onExists: () => ({ exists: true }),
    onRealpath: ({ path: requestedPath }) => ({ path: requestedPath }),
    onList: () => ({ entries: [{ name: 'blocked.txt', type: 'file', size: 10 }] }),
    onReadBase64: ({ path: requestedPath }) => {
      if (requestedPath === failingPath) throw new Error('EACCES');
      return { content: '' };
    },
  });
  registerNode('remote-copy-fail-machine', 123, fakeWs as any);

  t.after(async () => {
    unregisterByWs(fakeWs as any);
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () =>
      slotCopyDir(
        {
          host: '203.0.113.11',
          machine: 'remote-copy-fail-machine',
          sshTarget: 'tester@203.0.113.11',
        },
        remoteDir,
        destDir,
      ),
    (err) =>
      err instanceof SlotCopyDirEntryError &&
      err.sourcePath === failingPath &&
      /EACCES/.test(err.message),
  );
});

test('slotCopyDir local path forwards per-file failures to onEntryFailure and keeps copying', async (t) => {
  // chmod-based EACCES is a no-op for uid 0; skip when running as root so the
  // assertion does not falsely pass via the bypass branch.
  if (process.getuid?.() === 0) {
    t.skip('cannot exercise EACCES as root');
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-slot-io-local-onfail-'));
  const sourceDir = path.join(root, 'source');
  const destDir = path.join(root, 'dest');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, 'a.txt'), 'a', 'utf-8');
  const blockedPath = path.join(sourceDir, 'blocked.bin');
  await writeFile(blockedPath, 'b', 'utf-8');
  await writeFile(path.join(sourceDir, 'c.txt'), 'c', 'utf-8');
  await chmod(blockedPath, 0o000);

  t.after(async () => {
    await chmod(blockedPath, 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const failures: SlotCopyDirEntryError[] = [];
  const copied = await slotCopyDir(
    { host: 'localhost', machine: 'test-machine', sshTarget: 'localhost' },
    sourceDir,
    destDir,
    {
      onEntryFailure: (err) => {
        failures.push(err);
      },
    },
  );

  assert.equal(copied, 2);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].sourcePath, blockedPath);
  assert(failures[0] instanceof SlotCopyDirEntryError);
  assert.equal(await readFile(path.join(destDir, 'a.txt'), 'utf-8'), 'a');
  assert.equal(await readFile(path.join(destDir, 'c.txt'), 'utf-8'), 'c');
  assert.equal(existsSync(path.join(destDir, 'blocked.bin')), false);
});

test('slotCopyDir local path keeps copying after a nested per-file failure', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('cannot exercise EACCES as root');
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-slot-io-local-onfail-nested-'));
  const sourceDir = path.join(root, 'source');
  const subDir = path.join(sourceDir, 'sub');
  const destDir = path.join(root, 'dest');
  await mkdir(subDir, { recursive: true });
  await writeFile(path.join(sourceDir, 'top.txt'), 'top', 'utf-8');
  const blockedNested = path.join(subDir, 'blocked.bin');
  await writeFile(blockedNested, 'b', 'utf-8');
  await writeFile(path.join(subDir, 'sibling.txt'), 'sibling', 'utf-8');
  await chmod(blockedNested, 0o000);

  t.after(async () => {
    await chmod(blockedNested, 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const failures: SlotCopyDirEntryError[] = [];
  const copied = await slotCopyDir(
    { host: 'localhost', machine: 'test-machine', sshTarget: 'localhost' },
    sourceDir,
    destDir,
    {
      onEntryFailure: (err) => {
        failures.push(err);
      },
    },
  );

  assert.equal(copied, 2);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].sourcePath, blockedNested);
  assert.equal(await readFile(path.join(destDir, 'top.txt'), 'utf-8'), 'top');
  assert.equal(await readFile(path.join(destDir, 'sub', 'sibling.txt'), 'utf-8'), 'sibling');
  assert.equal(existsSync(path.join(destDir, 'sub', 'blocked.bin')), false);
});

test('remote slotCopyFile uses one-shot fs.readBase64 below the small-file threshold', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-slot-copy-small-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dest = path.join(dir, 'out.bin');
  const payload = Buffer.from('hello-small');
  const fakeWs = new FakeNodeWebSocket({
    onStat: () => ({ size: payload.byteLength, isFile: true, isDirectory: false, mtimeMs: 1 }),
    onReadBase64: () => ({ content: payload.toString('base64') }),
  });
  registerNode('copy-small-machine', 1, fakeWs as any);
  t.after(() => unregisterByWs(fakeWs as any));

  await slotCopyFile(
    { host: '203.0.113.9', machine: 'copy-small-machine', sshTarget: 't@203.0.113.9' },
    '/remote/small.bin',
    dest,
  );

  assert.equal(await readFile(dest, 'utf-8'), 'hello-small');
  assert.ok(fakeWs.calls.some((c) => c.method === 'fs.readBase64'));
  assert.equal(
    fakeWs.calls.filter((c) => c.method === 'fs.readChunk').length,
    0,
    'small files must not use chunked path',
  );
});

test('remote slotCopyFile uses chunked fs.readChunk above the small-file threshold', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-slot-copy-large-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dest = path.join(dir, 'out.bin');
  // 3 * 100 bytes with a tiny threshold forces multi-chunk without huge fixtures.
  const payload = Buffer.alloc(300, 7);
  const fakeWs = new FakeNodeWebSocket({
    onStat: () => ({ size: payload.byteLength, isFile: true, isDirectory: false, mtimeMs: 1 }),
    onReadChunk: (params) => {
      const offset = params.offset ?? 0;
      const length = params.length ?? 0;
      const slice = payload.subarray(offset, offset + length);
      return {
        content: slice.toString('base64'),
        size: payload.byteLength,
        offset,
        bytesRead: slice.byteLength,
        eof: offset + slice.byteLength >= payload.byteLength,
      };
    },
  });
  registerNode('copy-large-machine', 1, fakeWs as any);
  t.after(() => unregisterByWs(fakeWs as any));

  const events: unknown[] = [];
  setFileTransferBroadcast((_e, payload) => events.push(payload));
  t.after(() => setFileTransferBroadcast(() => {}));

  await slotCopyFile(
    { host: '203.0.113.9', machine: 'copy-large-machine', sshTarget: 't@203.0.113.9' },
    '/remote/large.bin',
    dest,
    {
      forceChunked: true,
      smallFileThresholdBytes: 50,
      phase: 'mirror',
      label: 'large.bin',
      verifyRemoteHash: false,
    },
  );

  assert.deepEqual(await readFile(dest), payload);
  assert.ok(fakeWs.calls.some((c) => c.method === 'fs.readChunk'));
  assert.equal(
    fakeWs.calls.filter((c) => c.method === 'fs.readBase64').length,
    0,
    'large files must not use one-shot readBase64',
  );
  assert.ok(events.length >= 3, `expected progress events, got ${events.length}`);
});

test('slotReadFileBuffer preserves bounded root/relPath for remote reads', async (t) => {
  const payload = Buffer.alloc(80, 3);
  const fakeWs = new FakeNodeWebSocket({
    onStat: (params) => {
      assert.equal(params.root, '/repo/artifacts');
      assert.equal(params.relPath, 'shots/after.mp4');
      assert.notEqual(params.root, '/');
      return {
        size: payload.byteLength,
        isFile: true,
        isDirectory: false,
        mtimeMs: 1,
      };
    },
    onReadBase64: (params) => {
      assert.equal(params.root, '/repo/artifacts');
      assert.equal(params.relPath, 'shots/after.mp4');
      return { content: payload.toString('base64') };
    },
  });
  registerNode('read-buffer-root-machine', 1, fakeWs as any);
  t.after(() => unregisterByWs(fakeWs as any));

  const transports: Array<{ mode: string; root?: string; relPath?: string }> = [];
  const buf = await slotReadFileBuffer(
    {
      host: '203.0.113.9',
      machine: 'read-buffer-root-machine',
      sshTarget: 't@203.0.113.9',
    },
    '/repo/artifacts/shots/after.mp4',
    {
      root: '/repo/artifacts',
      relPath: 'shots/after.mp4',
      maxBytes: 1024,
      onTransport: (info) => transports.push(info),
    },
  );

  assert.deepEqual(buf, payload);
  assert.equal(transports[0]?.mode, 'oneshot');
  assert.equal(transports[0]?.root, '/repo/artifacts');
  assert.equal(transports[0]?.relPath, 'shots/after.mp4');
  assert.ok(fakeWs.calls.every((c) => c.params.root === '/repo/artifacts'));
  assert.ok(fakeWs.calls.every((c) => c.params.root !== '/'));
});

test('slotReadFileBuffer chunked path reports readChunkCount and bounded root', async (t) => {
  const { FILE_TRANSFER_CHUNK_MAX_BYTES } = await import('@farmslot/protocol');
  // Two full chunks so readChunkCount is observably multi-RPC (not size-inferred).
  const payload = Buffer.alloc(FILE_TRANSFER_CHUNK_MAX_BYTES * 2 + 32, 9);
  const fakeWs = new FakeNodeWebSocket({
    onStat: (params) => {
      assert.equal(params.root, '/repo');
      assert.equal(params.relPath, 'large.bin');
      return {
        size: payload.byteLength,
        isFile: true,
        isDirectory: false,
        mtimeMs: 1,
      };
    },
    onReadChunk: (params) => {
      assert.equal(params.root, '/repo');
      assert.equal(params.relPath, 'large.bin');
      const offset = params.offset ?? 0;
      const length = params.length ?? 0;
      const slice = payload.subarray(offset, offset + length);
      return {
        content: slice.toString('base64'),
        size: payload.byteLength,
        offset,
        bytesRead: slice.byteLength,
        eof: offset + slice.byteLength >= payload.byteLength,
      };
    },
  });
  registerNode('read-buffer-chunk-machine', 1, fakeWs as any);
  t.after(() => unregisterByWs(fakeWs as any));

  let transport: { mode: string; readChunkCount: number; root?: string } | undefined;
  const buf = await slotReadFileBuffer(
    {
      host: '203.0.113.9',
      machine: 'read-buffer-chunk-machine',
      sshTarget: 't@203.0.113.9',
    },
    '/repo/large.bin',
    {
      root: '/repo',
      relPath: 'large.bin',
      forceChunked: true,
      maxBytes: payload.byteLength + 1,
      onTransport: (info) => {
        transport = info;
      },
    },
  );

  assert.deepEqual(buf, payload);
  assert.equal(transport?.mode, 'chunked');
  assert.ok((transport?.readChunkCount ?? 0) >= 2);
  assert.equal(transport?.root, '/repo');
  assert.ok(fakeWs.calls.filter((c) => c.method === 'fs.readChunk').length >= 2);
});
