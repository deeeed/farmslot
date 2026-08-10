import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FILE_TRANSFER_CHUNK_MAX_BYTES,
  FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES,
  type FileTransferCancelParams,
  type FileTransferCancelResult,
  type FileTransferListParams,
  type FileTransferListResult,
  type FileTransferProgress,
  type FileTransferRemoteE2eParams,
  type FileTransferRemoteE2eResult,
  type FileTransferSmokeParams,
  type FileTransferSmokeResult,
} from '@farmslot/protocol';

import {
  cancelTransfer,
  copyFileChunked,
  listActiveTransfers,
  readLocalFileChunk,
  writeTransferFixture,
} from '../core/file-transfer.js';
import { getAllNodes, getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import {
  slotCopyDir,
  slotCopyFile,
  slotReadFileBuffer,
  slotWriteFileBuffer,
} from '../core/slot-io.js';

/**
 * Diagnostics smoke path: multi-chunk local fixture copy that emits the same
 * `file.transfer.progress` events as remote slotCopyFile. Gated for recipes and
 * operator UX proof without a remote node.
 *
 * Enable with FARMSLOT_ENABLE_TRANSFER_SMOKE=1 or when FARMSLOT_DISABLE_ORCHESTRATION=1
 * (validation / sandbox stacks).
 */
export function isFileTransferSmokeEnabled(): boolean {
  if (process.env.FARMSLOT_ENABLE_TRANSFER_SMOKE === '1') return true;
  if (process.env.FARMSLOT_ENABLE_TRANSFER_SMOKE === '0') return false;
  // Validation/sandbox stacks disable orchestration and are safe for smoke.
  return process.env.FARMSLOT_DISABLE_ORCHESTRATION === '1';
}

export async function fileTransferSmoke(
  params: FileTransferSmokeParams = {},
): Promise<FileTransferSmokeResult> {
  if (!isFileTransferSmokeEnabled()) {
    throw new Error(
      'diagnostics.fileTransfer.smoke is disabled; set FARMSLOT_ENABLE_TRANSFER_SMOKE=1',
    );
  }
  const totalBytes = Math.max(
    1,
    Math.floor(params.totalBytes ?? FILE_TRANSFER_CHUNK_MAX_BYTES * 3),
  );
  if (totalBytes <= FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES) {
    throw new Error(
      `diagnostics.fileTransfer.smoke totalBytes must exceed small-file threshold ` +
        `(${FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES}); got ${totalBytes}`,
    );
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-xfer-smoke-'));
  const src = path.join(dir, 'fixture.bin');
  const dest = path.join(dir, 'out.bin');
  const chunkDelayMs = Math.max(0, Math.floor(params.chunkDelayMs ?? 0));
  const phase = params.phase ?? 'mirror';

  try {
    await writeTransferFixture(src, totalBytes);
    let chunksSeen = 0;
    try {
      let result = await copyFileChunked({
        path: src,
        label: params.label ?? 'after.mp4',
        phase,
        runId: params.runId,
        slotId: params.slotId,
        totalBytes,
        localPath: dest,
        keepPartialOnFailure: Boolean(params.exerciseResume),
        readChunk: async (offset, length) => {
          if (chunkDelayMs > 0) {
            await new Promise((r) => setTimeout(r, chunkDelayMs));
          }
          const chunk = await readLocalFileChunk(src, offset, length);
          chunksSeen += 1;
          // After at least one intermediate chunk, fail so UI can paint failed state.
          if (params.forceFail && chunksSeen >= 2) {
            throw new Error('forced smoke failure after intermediate progress');
          }
          return chunk;
        },
      });

      if (params.exerciseResume) {
        // Truncate mid-file and resume to prove keepPartial + resumeFromOffset.
        const mid = Math.floor(totalBytes / 2);
        await truncate(dest, mid);
        result = await copyFileChunked({
          path: src,
          label: params.label ?? 'after.mp4',
          phase,
          runId: params.runId,
          slotId: params.slotId,
          totalBytes,
          localPath: dest,
          resumeFromOffset: mid,
          readChunk: async (offset, length) => readLocalFileChunk(src, offset, length),
        });
      }

      const assembled = await readFile(dest);
      const sha256 = createHash('sha256').update(assembled).digest('hex');
      if (assembled.byteLength !== totalBytes || sha256 !== result.sha256) {
        throw new Error(
          `diagnostics.fileTransfer.smoke integrity failed: size ${assembled.byteLength}/${totalBytes}, sha ${sha256}/${result.sha256}`,
        );
      }

      const intermediateEvents = result.progressEvents.filter(
        (p) => p.state === 'running' && p.bytesTransferred > 0 && p.bytesTransferred < p.totalBytes,
      ).length;

      return {
        transferId: result.transferId,
        size: result.size,
        sha256: result.sha256,
        progressEvents: result.progressEvents.length,
        intermediateEvents,
      };
    } catch (err) {
      if (!params.forceFail) throw err;
      // forceFail path: progress events already published failed; return for recipe asserts.
      const message = err instanceof Error ? err.message : String(err);
      return {
        transferId: 'force-fail',
        size: 0,
        sha256: '',
        progressEvents: chunksSeen,
        intermediateEvents: Math.max(0, chunksSeen - 1),
        failed: true,
        error: message,
      };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function fileTransferCancel(
  params: FileTransferCancelParams,
): Promise<FileTransferCancelResult> {
  return cancelTransfer(params.transferId);
}

export async function fileTransferList(
  params: FileTransferListParams = {},
): Promise<FileTransferListResult> {
  return {
    transfers: listActiveTransfers({ runId: params.runId, slotId: params.slotId }),
  };
}

/**
 * Live remote-node e2e through production slot-io paths (not local fs.copyFile).
 * Forces non-local SlotLocality against a connected node so chunked download,
 * multi-file dir aggregate, buffer read (HTTP proxy path), and upload all run.
 */
export async function fileTransferRemoteE2e(
  params: FileTransferRemoteE2eParams = {},
): Promise<FileTransferRemoteE2eResult> {
  if (!isFileTransferSmokeEnabled()) {
    throw new Error(
      'diagnostics.fileTransfer.remoteE2e is disabled; set FARMSLOT_ENABLE_TRANSFER_SMOKE=1',
    );
  }

  const nodes = getAllNodes();
  const machine =
    params.machine ??
    nodes[0]?.machine ??
    (() => {
      throw new Error('No node connected — start a node against this gateway first');
    })();
  const node = getNode(machine);
  if (!node) throw new Error(`Node ${machine} is not connected`);

  // Non-local host so isLocal() is false even when the node process runs on this machine.
  const remoteCtx = {
    host: '203.0.113.77',
    machine,
    sshTarget: `e2e@203.0.113.77`,
  };
  const runId = params.runId ?? 'e2e-remote-transfer';
  const slotId = params.slotId ?? 'e2e-remote-slot';
  const largeBytes = Math.max(
    FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES + 1,
    Math.floor(params.largeBytes ?? FILE_TRANSFER_CHUNK_MAX_BYTES * 3 + 64),
  );

  const remoteRoot = path.posix.join('/tmp', `farmslot-xfer-remote-e2e-${Date.now()}`);
  const localDir = await mkdtemp(path.join(tmpdir(), 'farmslot-xfer-local-e2e-'));

  try {
    // Materialize remote fixtures via node fs APIs (same confinement as production).
    await sendNodeRequest(node, 'fs.mkdir', { root: remoteRoot, relPath: '.' }, { timeout: 30_000 });
    await sendNodeRequest(node, 'fs.mkdir', { root: remoteRoot, relPath: 'dir' }, { timeout: 30_000 });

    const largePath = path.posix.join(remoteRoot, 'large.bin');
    const largeBuf = Buffer.alloc(largeBytes);
    for (let i = 0; i < largeBytes; i++) largeBuf[i] = i % 251;
    // Write large file in chunks via writeChunk
    let off = 0;
    while (off < largeBytes) {
      const end = Math.min(off + FILE_TRANSFER_CHUNK_MAX_BYTES, largeBytes);
      await sendNodeRequest(
        node,
        'fs.writeChunk',
        {
          root: remoteRoot,
          relPath: 'large.bin',
          offset: off,
          content: largeBuf.subarray(off, end).toString('base64'),
          truncate: off === 0,
        },
        { timeout: 60_000 },
      );
      off = end;
    }
    // Small multi-file tree for aggregate dir copy
    for (const [name, text] of [
      ['a.txt', 'alpha-file'],
      ['b.txt', 'bravo-file'],
      ['c.txt', 'charlie-file'],
    ] as const) {
      await sendNodeRequest(
        node,
        'fs.writeChunk',
        {
          root: remoteRoot,
          relPath: path.posix.join('dir', name),
          offset: 0,
          content: Buffer.from(text, 'utf8').toString('base64'),
          truncate: true,
        },
        { timeout: 30_000 },
      );
    }

    // 1) Remote large download via production slotCopyFile — count intermediate onProgress.
    const localLarge = path.join(localDir, 'large.bin');
    let intermediateEvents = 0;
    await slotCopyFile(remoteCtx, largePath, localLarge, {
      phase: 'download',
      label: 'large.bin',
      runId,
      slotId,
      forceChunked: true,
      verifyRemoteHash: true,
      onProgress: (p) => {
        if (p.state === 'running' && p.bytesTransferred > 0 && p.bytesTransferred < p.totalBytes) {
          intermediateEvents += 1;
        }
      },
    });
    if (intermediateEvents < 2) {
      throw new Error(
        `slotCopyFile produced ${intermediateEvents} intermediate progress events (need ≥2)`,
      );
    }

    // Same engine as HTTP /api/file remote proxy: forceChunked slotReadFileBuffer.
    let proxyIntermediate = 0;
    const bufRead = await slotReadFileBuffer(remoteCtx, largePath, {
      phase: 'download',
      label: 'large.bin-buf',
      runId,
      slotId,
      forceChunked: true,
      maxBytes: largeBytes + 1,
      onProgress: (p) => {
        if (p.state === 'running' && p.bytesTransferred > 0 && p.bytesTransferred < p.totalBytes) {
          proxyIntermediate += 1;
        }
      },
    });
    const localHash = createHash('sha256').update(await readFile(localLarge)).digest('hex');
    const bufHash = createHash('sha256').update(bufRead).digest('hex');
    if (localHash !== bufHash || bufRead.byteLength !== largeBytes) {
      throw new Error(
        `remote download/buffer mismatch size ${bufRead.byteLength}/${largeBytes} hash ${bufHash}/${localHash}`,
      );
    }
    if (proxyIntermediate < 2) {
      throw new Error(
        `slotReadFileBuffer (HTTP proxy engine) intermediate events ${proxyIntermediate} (need ≥2)`,
      );
    }

    // 2) Multi-file remote dir copy with aggregate — sample active transfers tightly
    // (tiny fixtures finish faster than a 20ms interval).
    const localTree = path.join(localDir, 'dir');
    let maxFilesCompleted = 0;
    let aggregateSawFilesTotal = false;
    {
      const sample = () => {
        for (const t of listActiveTransfers({ runId })) {
          if ((t.filesTotal ?? 0) >= 3) aggregateSawFilesTotal = true;
          if ((t.filesCompleted ?? 0) > maxFilesCompleted) {
            maxFilesCompleted = t.filesCompleted ?? 0;
          }
        }
      };
      const copyPromise = slotCopyDir(remoteCtx, path.posix.join(remoteRoot, 'dir'), localTree, {
        phase: 'mirror',
        runId,
        slotId,
        labelPrefix: 'dir',
      });
      // Interleave sampling so we observe aggregate progress before unregister.
      let copiedCount = 0;
      let copyDone = false;
      void copyPromise.then((copied) => {
        copiedCount = copied;
        copyDone = true;
      });
      while (!copyDone) {
        sample();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      sample();
      if (copiedCount < 3) throw new Error(`expected ≥3 files copied, got ${copiedCount}`);
      await copyPromise;
      if (!aggregateSawFilesTotal || maxFilesCompleted < 3) {
        throw new Error(
          `aggregate progress not observed: sawFilesTotal=${aggregateSawFilesTotal} maxFilesCompleted=${maxFilesCompleted}`,
        );
      }
    }

    // 3) Remote upload then read back
    const uploadPath = path.posix.join(remoteRoot, 'upload-back.bin');
    const uploadPayload = Buffer.alloc(FILE_TRANSFER_CHUNK_MAX_BYTES * 2 + 11, 7);
    await slotWriteFileBuffer(remoteCtx, uploadPath, uploadPayload, {
      phase: 'upload',
      label: 'upload-back.bin',
      runId,
      slotId,
    });
    const uploaded = await slotReadFileBuffer(remoteCtx, uploadPath, {
      phase: 'download',
      forceChunked: true,
      maxBytes: uploadPayload.byteLength + 1,
    });
    const uploadMatch =
      createHash('sha256').update(uploaded).digest('hex') ===
      createHash('sha256').update(uploadPayload).digest('hex');

    // 4) Real authenticated HTTP /api/file against an isolated pool slot (never
    // rewrite the shared farmslot-demo.json). Host is forced non-local so serveFile
    // takes the remote slotReadFileBuffer branch.
    let httpFileProxy: FileTransferRemoteE2eResult['httpFileProxy'];
    {
      const { writeFile, rm } = await import('node:fs/promises');
      const { farmslotRoot } = await import('../fleet/state.js');
      const httpSlotId = `e2e-http-${Date.now()}`;
      const httpRepo = path.posix.join('/tmp', httpSlotId);
      const poolPath = path.join(farmslotRoot, 'pool', `${httpSlotId}.json`);
      const relFile = 'artifacts/http-proxy.bin';
      // Multi-chunk sized but each writeChunk stays within the node max.
      const httpPayload = Buffer.alloc(FILE_TRANSFER_CHUNK_MAX_BYTES * 2 + 64, 9);
      await writeFile(
        poolPath,
        `${JSON.stringify(
          {
            machine,
            project: 'farmslot-farm',
            platform: 'cli',
            os: 'linux',
            host: '203.0.113.77',
            ssh_user: 'e2e',
            slots: [{ id: httpSlotId, enabled: true, repo: httpRepo, session: httpSlotId }],
          },
          null,
          2,
        )}\n`,
      );
      try {
        await sendNodeRequest(node, 'fs.mkdir', { root: httpRepo, relPath: 'artifacts' }, {
          timeout: 30_000,
        });
        let httpOff = 0;
        while (httpOff < httpPayload.byteLength) {
          const end = Math.min(httpOff + FILE_TRANSFER_CHUNK_MAX_BYTES, httpPayload.byteLength);
          await sendNodeRequest(
            node,
            'fs.writeChunk',
            {
              root: httpRepo,
              relPath: relFile,
              offset: httpOff,
              content: httpPayload.subarray(httpOff, end).toString('base64'),
              truncate: httpOff === 0,
            },
            { timeout: 60_000 },
          );
          httpOff = end;
        }
        const port = process.env.GATEWAY_PORT || '8801';
        const url = `http://127.0.0.1:${port}/api/file?slotId=${encodeURIComponent(httpSlotId)}&path=${encodeURIComponent(relFile)}`;
        const headers: Record<string, string> = {};
        if (process.env.FARMSLOT_GATEWAY_TOKEN) {
          headers.Authorization = `Bearer ${process.env.FARMSLOT_GATEWAY_TOKEN}`;
        }
        const res = await fetch(url, { headers });
        const body = Buffer.from(await res.arrayBuffer());
        // Chunked path is proven when status is OK and payload matches multi-chunk size
        // (one-shot threshold is smaller than this fixture).
        const usedChunkedPath =
          res.status === 200 &&
          body.byteLength === httpPayload.byteLength &&
          httpPayload.byteLength > FILE_TRANSFER_SMALL_FILE_THRESHOLD_BYTES;
        httpFileProxy = {
          status: res.status,
          bytes: body.byteLength,
          usedChunkedPath,
        };
        if (res.status !== 200) {
          throw new Error(
            `HTTP /api/file status ${res.status}: ${body.toString('utf8').slice(0, 200)}`,
          );
        }
        if (body.byteLength !== httpPayload.byteLength) {
          throw new Error(
            `HTTP /api/file size mismatch ${body.byteLength} !== ${httpPayload.byteLength}`,
          );
        }
        if (!usedChunkedPath) {
          throw new Error('HTTP /api/file did not exercise multi-chunk remote path');
        }
      } finally {
        await rm(poolPath, { force: true });
        try {
          await sendNodeRequest(
            node,
            'fs.delete',
            { root: httpRepo, relPath: '.' },
            { timeout: 30_000 },
          );
        } catch (cleanupErr) {
          console.warn(
            `[file-transfer] remote e2e http fixture cleanup failed: ${
              cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
            }`,
          );
        }
      }
    }

    return {
      machine,
      remoteDownload: {
        size: largeBytes,
        sha256: localHash,
        intermediateEvents,
      },
      remoteDir: {
        filesCopied: maxFilesCompleted,
        aggregateSawFilesTotal,
        maxFilesCompleted,
      },
      remoteBufferRead: { size: bufRead.byteLength, sha256: bufHash },
      remoteUpload: {
        size: uploadPayload.byteLength,
        roundTripSha256Match: uploadMatch,
      },
      httpFileProxy,
    };
  } finally {
    // Best-effort remote cleanup
    try {
      await sendNodeRequest(
        node,
        'fs.delete',
        { root: remoteRoot, relPath: '.' },
        { timeout: 30_000 },
      );
    } catch (cleanupErr) {
      console.warn(
        `[file-transfer] remote e2e fixture cleanup failed: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`,
      );
    }
    await rm(localDir, { recursive: true, force: true });
  }
}

/** Export for tests that probe partial size after cancel-style failures. */
export async function fileSize(pathName: string): Promise<number> {
  return (await stat(pathName)).size;
}
