import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  Events,
  FILE_TRANSFER_CHUNK_MAX_BYTES,
  FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES,
} from '@farmslot/protocol';

import {
  cancelTransfer,
  copyFileChunked,
  emitFileTransferProgress,
  FileTransferCancelledError,
  FileTransferIdleTimeoutError,
  FileTransferIntegrityError,
  readLocalFileChunk,
  setFileTransferBroadcast,
  writeTransferFixture,
} from './file-transfer.js';
import { FILE_TRANSFER_CHUNK_MAX_BYTES as SLOT_CHUNK } from './slot-io.js';

test('CHUNK_MAX_BYTES is exported and stays well under the 100 MiB WS payload budget', () => {
  assert.equal(FILE_TRANSFER_CHUNK_MAX_BYTES, SLOT_CHUNK);
  assert.ok(FILE_TRANSFER_CHUNK_MAX_BYTES > 0);
  // Base64 expands ~4/3; leave headroom for JSON envelope under 100 MiB.
  assert.ok(FILE_TRANSFER_CHUNK_MAX_BYTES * 2 < 100 * 1024 * 1024);
});

test('copyFileChunked emits ≥2 intermediate progress events before done for multi-chunk fixture', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-xfer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const size = FILE_TRANSFER_CHUNK_MAX_BYTES * 3 + 17;
  const src = path.join(dir, 'src.bin');
  const dest = path.join(dir, 'dest.bin');
  await writeTransferFixture(src, size);

  const broadcast: Array<{ event: string; payload: unknown }> = [];
  setFileTransferBroadcast((event, payload) => broadcast.push({ event, payload }));
  t.after(() => setFileTransferBroadcast(() => {}));

  const result = await copyFileChunked({
    path: src,
    label: 'src.bin',
    phase: 'download',
    totalBytes: size,
    localPath: dest,
    readChunk: (offset, length) => readLocalFileChunk(src, offset, length),
  });

  assert.equal(result.size, size);
  assert.equal(await readFile(dest).then((b) => b.byteLength), size);
  assert.equal(
    result.sha256,
    createHash('sha256')
      .update(await readFile(src))
      .digest('hex'),
  );

  const intermediates = result.progressEvents.filter(
    (p) => p.state === 'running' && p.bytesTransferred > 0 && p.bytesTransferred < p.totalBytes,
  );
  assert.ok(
    intermediates.length >= 2,
    `expected ≥2 intermediate events, got ${intermediates.length}`,
  );
  assert.equal(result.progressEvents.at(-1)?.state, 'done');
  assert.ok(broadcast.some((b) => b.event === Events.FILE_TRANSFER_PROGRESS));
});

test('copyFileChunked idle timeout fails with last bytesTransferred/totalBytes snapshot', async () => {
  let now = 1_000;
  const clock = {
    now: () => now,
    sleep: async () => {},
  };

  await assert.rejects(
    () =>
      copyFileChunked({
        path: '/remote/big.bin',
        label: 'big.bin',
        phase: 'mirror',
        totalBytes: FILE_TRANSFER_CHUNK_MAX_BYTES * 4,
        idleTimeoutMs: 50,
        clock,
        readChunk: async () => {
          // Simulate a stall: advance clock past the idle limit before returning.
          now += 200;
          return {
            content: Buffer.alloc(1).toString('base64'),
            size: FILE_TRANSFER_CHUNK_MAX_BYTES * 4,
            offset: 0,
            bytesRead: 1,
            eof: false,
          };
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof FileTransferIdleTimeoutError);
      assert.match(err.message, /idle timeout/i);
      assert.match(err.message, /last progress/);
      assert.equal(err.bytesTransferred, 0);
      assert.equal(err.totalBytes, FILE_TRANSFER_CHUNK_MAX_BYTES * 4);
      return true;
    },
  );
});

test('copyFileChunked translates unresolved/rejected production RPC timeout into idle snapshot', async () => {
  const size = FILE_TRANSFER_CHUNK_MAX_BYTES * 2;
  let now = 5_000;
  const clock = {
    now: () => now,
    // No-op sleep: race with idle budget must still surface last-progress idle error.
    sleep: async () => {
      now += 10_000;
    },
  };
  await assert.rejects(
    () =>
      copyFileChunked({
        path: '/remote/stall.bin',
        phase: 'download',
        totalBytes: size,
        idleTimeoutMs: 100,
        clock,
        readChunk: async () => {
          throw new Error('Node mini timeout after 60000ms');
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof FileTransferIdleTimeoutError);
      assert.equal(err.bytesTransferred, 0);
      assert.equal(err.totalBytes, size);
      assert.match(err.message, /last progress 0\//);
      return true;
    },
  );
});

test('copyFileChunked stages into sibling partial and preserves prior-good final on failure/cancel', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-xfer-stage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dest = path.join(dir, 'dest.bin');
  const prior = Buffer.from('previous-good-destination-bytes');
  await writeFile(dest, prior);

  // Failure mid-transfer must not remove or truncate the prior-good final path.
  await assert.rejects(
    () =>
      copyFileChunked({
        path: '/remote/x.bin',
        phase: 'download',
        totalBytes: FILE_TRANSFER_CHUNK_MAX_BYTES * 2,
        localPath: dest,
        readChunk: async (offset) => {
          if (offset > 0) throw new Error('forced later-chunk failure');
          return {
            content: Buffer.alloc(FILE_TRANSFER_CHUNK_MAX_BYTES, 9).toString('base64'),
            size: FILE_TRANSFER_CHUNK_MAX_BYTES * 2,
            offset: 0,
            bytesRead: FILE_TRANSFER_CHUNK_MAX_BYTES,
            eof: false,
          };
        },
      }),
    /forced later-chunk failure/,
  );
  assert.equal(await readFile(dest, 'utf8'), prior.toString('utf8'));
  assert.ok(!existsSync(`${dest}.farmslot-partial`));

  // Cancel after at least one chunk is on disk: keep sibling partial, leave final alone.
  await writeFile(dest, prior);
  const transferId = 'stage-cancel-1';
  const copyPromise = copyFileChunked({
    path: '/remote/y.bin',
    phase: 'download',
    totalBytes: FILE_TRANSFER_CHUNK_MAX_BYTES * 3,
    transferId,
    localPath: dest,
    keepPartialOnFailure: true,
    readChunk: async (offset, length) => {
      await new Promise((r) => setTimeout(r, 20));
      const n = Math.min(length, FILE_TRANSFER_CHUNK_MAX_BYTES * 3 - offset);
      return {
        content: Buffer.alloc(n, 3).toString('base64'),
        size: FILE_TRANSFER_CHUNK_MAX_BYTES * 3,
        offset,
        bytesRead: n,
        eof: false,
      };
    },
    onProgress: (p) => {
      if (p.state === 'running' && p.bytesTransferred > 0) {
        cancelTransfer(transferId);
      }
    },
  });
  await assert.rejects(() => copyPromise, /cancelled/i);
  assert.equal(await readFile(dest, 'utf8'), prior.toString('utf8'));
  assert.ok(
    existsSync(`${dest}.farmslot-partial`),
    'cancelled transfer must retain sibling partial for resume',
  );
  assert.ok((await stat(`${dest}.farmslot-partial`)).size > 0);
});

test('copyFileChunked rejects dropped/reordered chunks', async () => {
  await assert.rejects(
    () =>
      copyFileChunked({
        path: '/remote/bad.bin',
        phase: 'download',
        totalBytes: 100,
        readChunk: async () => ({
          content: Buffer.alloc(10).toString('base64'),
          size: 100,
          offset: 5, // wrong — should be 0
          bytesRead: 10,
          eof: false,
        }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof FileTransferIntegrityError);
      assert.match(err.message, /offset mismatch/i);
      return true;
    },
  );
});

test('healthy multi-chunk transfer longer than 30s wall clock succeeds when progress flows', async (t) => {
  // Use a fake clock so we don't actually wait >30s. Each chunk advances "time"
  // by 12s; three chunks = 36s total elapsed with continuous progress.
  let now = 0;
  const clock = {
    now: () => now,
    sleep: async () => {},
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-xfer-slow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const size = FILE_TRANSFER_CHUNK_MAX_BYTES * 3;
  const src = path.join(dir, 'src.bin');
  const dest = path.join(dir, 'dest.bin');
  await writeTransferFixture(src, size);

  const result = await copyFileChunked({
    path: src,
    phase: 'download',
    totalBytes: size,
    localPath: dest,
    idleTimeoutMs: 60_000,
    clock,
    readChunk: async (offset, length) => {
      now += 12_000; // each chunk "takes" 12s
      return readLocalFileChunk(src, offset, length);
    },
  });

  assert.ok(now > 30_000, `simulated elapsed ${now}ms should exceed 30s`);
  assert.equal(result.size, size);
  assert.equal(result.progressEvents.at(-1)?.state, 'done');
});

test('emitFileTransferProgress fans out via the configured broadcaster', () => {
  const seen: unknown[] = [];
  setFileTransferBroadcast((_e, payload) => seen.push(payload));
  emitFileTransferProgress({
    transferId: 't1',
    path: '/x',
    phase: 'upload',
    bytesTransferred: 1,
    totalBytes: 2,
    state: 'running',
  });
  setFileTransferBroadcast(() => {});
  assert.equal(seen.length, 1);
});

test('small-file threshold is below multi-chunk fixture sizes used in tests', () => {
  assert.ok(FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES < FILE_TRANSFER_CHUNK_MAX_BYTES * 2);
});

test('cancelTransfer aborts a running multi-chunk copy', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-xfer-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const size = FILE_TRANSFER_CHUNK_MAX_BYTES * 4;
  const src = path.join(dir, 'src.bin');
  const dest = path.join(dir, 'dest.bin');
  await writeTransferFixture(src, size);

  let transferId = '';
  const copyPromise = copyFileChunked({
    path: src,
    phase: 'download',
    totalBytes: size,
    localPath: dest,
    keepPartialOnFailure: true,
    readChunk: async (offset, length) => {
      await new Promise((r) => setTimeout(r, 30));
      return readLocalFileChunk(src, offset, length);
    },
    onProgress: (p) => {
      transferId = p.transferId;
      if (p.state === 'running' && p.bytesTransferred > 0) {
        cancelTransfer(p.transferId);
      }
    },
  });

  await assert.rejects(copyPromise, (err: unknown) => {
    assert.ok(err instanceof FileTransferCancelledError || (err as Error).name === 'FileTransferCancelledError');
    return true;
  });
  assert.ok(transferId);
});

test('size-scaled idle timeout grows with totalBytes', async () => {
  const { fileTransferIdleTimeoutMs, FILE_TRANSFER_IDLE_TIMEOUT_MS } = await import(
    '@farmslot/protocol'
  );
  assert.ok(fileTransferIdleTimeoutMs(10 * 1024 * 1024) > FILE_TRANSFER_IDLE_TIMEOUT_MS);
});

test('emitFileTransferProgress broadcasts intermediate chunk progress to subscribers', async () => {
  const broadcasts: Array<{ bytes: number; state: string }> = [];
  setFileTransferBroadcast((_e, payload) => {
    const p = payload as { bytesTransferred: number; state: string; transferId: string };
    broadcasts.push({ bytes: p.bytesTransferred, state: p.state });
  });
  try {
    const size = FILE_TRANSFER_CHUNK_MAX_BYTES * 3;
    let offset = 0;
    await copyFileChunked({
      path: '/remote/x.bin',
      phase: 'download',
      totalBytes: size,
      transferId: 'broadcast-test-1',
      readChunk: async (off, length) => {
        const n = Math.min(length, size - off);
        offset = off + n;
        return {
          content: Buffer.alloc(n, 1).toString('base64'),
          size,
          offset: off,
          bytesRead: n,
          eof: offset >= size,
        };
      },
    });
    const intermediate = broadcasts.filter(
      (b) => b.state === 'running' && b.bytes > 0 && b.bytes < size,
    );
    assert.ok(
      intermediate.length >= 2,
      `expected ≥2 intermediate broadcasts, got ${JSON.stringify(broadcasts)}`,
    );
  } finally {
    setFileTransferBroadcast(() => {});
  }
});

test('readRemoteFileChunkedToBuffer rejects early EOF when totalBytes is known', async () => {
  const { readRemoteFileChunkedToBuffer } = await import('./file-transfer.js');
  await assert.rejects(
    () =>
      readRemoteFileChunkedToBuffer({
        path: '/remote/trunc.bin',
        phase: 'download',
        totalBytes: 100,
        readChunk: async () => ({
          content: Buffer.alloc(10, 2).toString('base64'),
          size: 100,
          offset: 0,
          bytesRead: 10,
          eof: true,
        }),
      }),
    /Assembled size 10 !== totalBytes 100|Early EOF/,
  );
});

test('readRemoteFileChunkedToBuffer races hung reads against idle timeout', async () => {
  const { readRemoteFileChunkedToBuffer } = await import('./file-transfer.js');
  await assert.rejects(
    () =>
      readRemoteFileChunkedToBuffer({
        path: '/remote/hang.bin',
        phase: 'download',
        totalBytes: 100,
        idleTimeoutMs: 40,
        readChunk: async () =>
          new Promise(() => {
            /* never resolves — wall-clock idle must fire */
          }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof FileTransferIdleTimeoutError);
      assert.equal(err.bytesTransferred, 0);
      assert.equal(err.totalBytes, 100);
      return true;
    },
  );
});

test('readRemoteFileChunkedToBuffer rejects oversize chunk responses', async () => {
  const { readRemoteFileChunkedToBuffer } = await import('./file-transfer.js');
  await assert.rejects(
    () =>
      readRemoteFileChunkedToBuffer({
        path: '/remote/fat.bin',
        phase: 'download',
        totalBytes: 100,
        chunkMaxBytes: 4,
        readChunk: async () => ({
          content: Buffer.alloc(8, 1).toString('base64'),
          size: 100,
          offset: 0,
          bytesRead: 8,
          eof: false,
        }),
      }),
    /Invalid bytesRead 8 \(chunk max 4\)/,
  );
});

test('copyFileChunked cleans drain/error listeners under multi-chunk backpressure', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-xfer-backpressure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // >10 chunks so a leaked per-chunk error listener would trip MaxListenersExceededWarning.
  const chunkCount = 14;
  const chunkSize = 64 * 1024;
  const size = chunkCount * chunkSize;
  const src = path.join(dir, 'src.bin');
  const dest = path.join(dir, 'dest.bin');
  await writeTransferFixture(src, size);

  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    warnings.push(warning);
  };
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));

  // Exercise the production path (createWriteStream inside copyFileChunked) with
  // more than 10 chunks; a leaked per-chunk error listener trips MaxListeners.
  const result = await copyFileChunked({
    path: src,
    label: 'backpressure.bin',
    phase: 'download',
    totalBytes: size,
    localPath: dest,
    chunkMaxBytes: chunkSize,
    readChunk: (offset, length) => readLocalFileChunk(src, offset, length),
  });

  assert.equal(result.size, size);
  assert.equal((await readFile(dest)).byteLength, size);
  const maxListenerWarnings = warnings.filter(
    (w) => w.name === 'MaxListenersExceededWarning' || /MaxListenersExceeded/i.test(w.message),
  );
  assert.equal(
    maxListenerWarnings.length,
    0,
    `unexpected MaxListenersExceededWarning after ${chunkCount}-chunk copy: ${maxListenerWarnings
      .map((w) => w.message)
      .join('; ')}`,
  );
});

test('AggregateTransferSession cancel aborts before done and keeps indeterminate total', async () => {
  const { AggregateTransferSession, cancelTransfer } = await import('./file-transfer.js');
  const events: Array<{ state: string; totalBytes: number; bytes: number }> = [];
  setFileTransferBroadcast((_e, payload) => {
    const p = payload as {
      state: string;
      totalBytes: number;
      bytesTransferred: number;
    };
    events.push({ state: p.state, totalBytes: p.totalBytes, bytes: p.bytesTransferred });
  });
  try {
    const agg = new AggregateTransferSession({
      path: '/remote/dir',
      phase: 'mirror',
      filesTotal: 3,
      // no totalBytes → indeterminate (0), not equal to current bytes
    });
    agg.noteFileProgress(1, 10);
    const mid = events.filter((e) => e.state === 'running' && e.bytes > 0);
    assert.ok(mid.length >= 1);
    assert.equal(mid[0]!.totalBytes, 0, 'unknown size must stay totalBytes=0');
    const cancel = cancelTransfer(agg.transferId);
    assert.equal(cancel.state, 'cancelled');
    assert.throws(() => agg.noteFileComplete(10), /cancelled/i);
    agg.complete();
    const terminal = events.filter((e) => e.state === 'cancelled' || e.state === 'done');
    assert.ok(
      terminal.some((e) => e.state === 'cancelled'),
      `expected cancelled terminal, got ${JSON.stringify(events)}`,
    );
    assert.ok(!terminal.some((e) => e.state === 'done'));
  } finally {
    setFileTransferBroadcast(() => {});
  }
});
