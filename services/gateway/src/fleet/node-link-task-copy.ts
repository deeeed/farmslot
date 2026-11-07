import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  NODE_LINK_LIMITS,
  type NodeLinkAuthority,
  NodeLinkFailure,
  type NodeLinkOperationRequest,
  type Run,
} from '@farmslot/protocol';

import { assertCleanupCurrent, trackCleanupCommand } from '../core/cleanup-scope.js';
import type { SlotVars } from '../core/config.js';
import { readSlotRow } from '../core/state.js';
import { getRun } from '../runs/store.js';
import { currentSessionOriginator } from '../security/work-originator.js';
import { isWorkerMirrorEntry, TASK_ROOT_SIDECARS } from '../tasks/sidecars.js';

import { getNode } from './machine-registry.js';
import { invokeNodeLink } from './node-link.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const rowFence = (row: Readonly<Record<string, unknown>>) =>
  JSON.stringify([
    row.slot_epoch,
    row.current_run_id ?? null,
    row.handoff_run_id ?? null,
    row.cleanup_run_id ?? null,
  ]);

export interface NodeLinkTaskSource {
  runId?: string;
  taskFile: string;
}

/** Task staging keeps the existing workspace epoch/owner fence and immutable task inputs. */
export async function createNodeLinkTaskStager(
  source: NodeLinkTaskSource,
  vars: SlotVars,
  taskDir: string,
  workerTask: string,
  excludeRelativePaths: readonly string[] = [],
) {
  const row = await readSlotRow(vars.slotId);
  const epoch = row?.slot_epoch;
  if (!row || typeof epoch !== 'number' || !Number.isSafeInteger(epoch))
    throw new NodeLinkFailure(
      'STALE_AUTHORITY',
      'Task staging needs its existing workspace epoch.',
    );
  if (
    (row.current_run_id &&
      (!source.runId ||
        (row.current_run_id !== source.runId && row.handoff_run_id !== source.runId))) ||
    (row.handoff_run_id && !source.runId) ||
    (row.cleanup_run_id && row.cleanup_run_id !== source.runId)
  )
    throw new NodeLinkFailure('STALE_AUTHORITY', 'Task staging cannot replace another run owner.');
  const expected = rowFence(row);
  const taskFile = source.taskFile;
  const identity = source.runId ?? hash(path.resolve(taskFile));
  const leaseOwner =
    typeof row.current_run_id === 'string'
      ? row.current_run_id
      : typeof row.handoff_run_id === 'string'
        ? row.handoff_run_id
        : undefined;
  const node = getNode(vars.machine);
  if (!node?.nodePrincipal)
    throw new NodeLinkFailure('UNSUPPORTED_OPERATION', 'Node identity is unavailable.');
  const originator = currentSessionOriginator();
  const authority: NodeLinkAuthority = {
    requester:
      originator.kind === 'principal'
        ? { principalId: originator.principalId, generation: originator.principalGeneration ?? 0 }
        : { kind: 'system' },
    executor: node.nodePrincipal,
    grantId: `task:${identity}:${epoch}`,
    approvalId: `task-inputs:${identity}:${epoch}`,
    approval: 'framework',
    ...(leaseOwner
      ? {
          lease: {
            runId: leaseOwner,
            contextId: 'workspace',
            leaseId: `workspace:${vars.slotId}:${epoch}`,
            generation: String(epoch),
          },
        }
      : {}),
  };
  const assertCurrent = async () => {
    assertCleanupCurrent();
    const current = source.runId ? getRun(source.runId) : undefined;
    const actual = await readSlotRow(vars.slotId);
    if (
      (source.runId &&
        (!current ||
          current.slotId !== vars.slotId ||
          current.taskFile !== taskFile ||
          ['cancelled', 'failed', 'done'].includes(current.status))) ||
      !actual ||
      rowFence(actual) !== expected
    )
      throw new NodeLinkFailure(
        'STALE_AUTHORITY',
        'Task source or workspace ownership changed during staging.',
      );
  };
  const root = vars.remoteRepo;
  const relative = path.relative(root, workerTask);
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
    throw new NodeLinkFailure(
      'POLICY_REFUSED',
      'Task staging destination must stay inside its workspace.',
    );
  const call = async (request: NodeLinkOperationRequest, readOnly = false) => {
    await assertCurrent();
    const commandId = readOnly
      ? randomUUID()
      : hash(JSON.stringify([identity, epoch, authority.requester, authority.executor, request]));
    const receipt = await trackCleanupCommand(
      invokeNodeLink(request, {
        commandId,
        target: { nodeId: vars.machine, resourceId: vars.slotId },
        authority,
        root,
        assertCurrent,
      }),
    );
    if (receipt.state !== 'completed')
      throw new NodeLinkFailure(
        receipt.error?.code ?? 'TASK_COPY_FAILED',
        receipt.error?.message ?? 'Node task staging did not complete.',
      );
    return receipt.result;
  };
  const destination = (file: string) => path.join(relative, file);
  const upload = async (source: string, file: string, createOnly: boolean) => {
    const info = await lstat(source);
    if (!info.isFile())
      throw new NodeLinkFailure('POLICY_REFUSED', 'Task upload requires a regular source file.');
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (before.size <= NODE_LINK_LIMITS.chunkBytes) {
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead)
            throw new NodeLinkFailure('SOURCE_CHANGED', 'Task source shrank during its read.');
          offset += read.bytesRead;
        }
        const after = await handle.stat();
        if (
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        )
          throw new NodeLinkFailure('SOURCE_CHANGED', 'Task source changed during its read.');
        await call({
          operation: 'file.write-files',
          input: {
            root,
            relPath: '.',
            createOnly,
            files: [
              {
                path: destination(file),
                content: bytes.toString('base64'),
                mode: file === 'mark' ? 0o755 : info.mode & 0o777,
              },
            ],
          },
        });
        return;
      }
      const fingerprint = createHash('sha256');
      const buffer = Buffer.alloc(NODE_LINK_LIMITS.chunkBytes);
      for (let offset = 0; offset < before.size; ) {
        const read = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (!read.bytesRead)
          throw new NodeLinkFailure('SOURCE_CHANGED', 'Task source shrank during hashing.');
        fingerprint.update(buffer.subarray(0, read.bytesRead));
        offset += read.bytesRead;
      }
      const digest = fingerprint.digest('hex');
      const staged = path.join(
        '.node-link-staging',
        hash(JSON.stringify([identity, epoch, file, digest])),
        'payload',
      );
      await call({ operation: 'file.mkdir', input: { root, relPath: path.dirname(staged) } });
      for (let offset = 0; offset < before.size; ) {
        const read = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (!read.bytesRead)
          throw new NodeLinkFailure('SOURCE_CHANGED', 'Task source shrank during transfer.');
        await call({
          operation: 'file.write-range',
          input: {
            root,
            relPath: staged,
            offset,
            content: buffer.subarray(0, read.bytesRead).toString('base64'),
            truncate: offset === 0,
            mode: file === 'mark' ? 0o755 : info.mode & 0o777,
          },
        });
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new NodeLinkFailure('SOURCE_CHANGED', 'Task source changed during transfer.');
      await call({
        operation: 'file.commit',
        input: {
          root,
          stagedRelPath: staged,
          destinationRelPath: destination(file),
          sha256: digest,
          size: before.size,
          createOnly,
        },
      });
    } finally {
      await handle.close();
    }
  };
  const walk = async (
    directory: string,
    prefix: string,
    createOnly: boolean,
    ancestors: string[] = [],
  ) => {
    const canonical = await realpath(directory);
    if (ancestors.includes(canonical) || ancestors.length >= 12)
      throw new NodeLinkFailure(
        'POLICY_REFUSED',
        'Task source directory has a cycle or exceeds the depth limit.',
      );
    const sourceRoot = await realpath(taskDir);
    if (canonical !== sourceRoot && !canonical.startsWith(sourceRoot + path.sep))
      throw new NodeLinkFailure('POLICY_REFUSED', 'Task source link leaves the admitted tree.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name),
        file = path.join(prefix, entry.name);
      if (isWorkerMirrorEntry(entry.name) || excludeRelativePaths.includes(file)) continue;
      if (entry.isDirectory()) await walk(source, file, createOnly, [...ancestors, canonical]);
      else if (entry.isFile()) await upload(source, file, createOnly);
      else
        throw new NodeLinkFailure(
          'POLICY_REFUSED',
          'Task source contains an unsupported link or entry.',
        );
    }
  };
  return { call, upload, walk, root, relative };
}

export async function copyTaskThroughNodeLink(
  run: Run,
  vars: SlotVars,
  taskDir: string,
  workerTask: string,
  artifactsOnly = false,
): Promise<void> {
  const { call, upload, walk, root, relative } = await createNodeLinkTaskStager(
    { runId: run.id, taskFile: run.taskFile ?? path.join(taskDir, 'TASK.md') },
    vars,
    taskDir,
    workerTask,
  );
  await call({ operation: 'file.mkdir', input: { root, relPath: relative } });
  if (!artifactsOnly) await upload(path.join(taskDir, 'TASK.md'), 'TASK.md', false);
  for (const subdir of artifactsOnly ? ['artifacts'] : ['assets', 'inputs', 'artifacts']) {
    try {
      await lstat(path.join(taskDir, subdir));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    await walk(path.join(taskDir, subdir), subdir, subdir === 'artifacts');
  }
  if (!artifactsOnly) {
    // Publish the executable marker last, after all documents and immutable inputs.
    for (const sidecar of [...TASK_ROOT_SIDECARS.filter((file) => file !== 'mark'), 'mark']) {
      const source = path.join(taskDir, sidecar);
      try {
        await lstat(source);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        if (sidecar === 'checklist-target.json')
          await call({
            operation: 'file.delete',
            input: { root, relPath: path.join(relative, sidecar) },
          });
        continue;
      }
      await upload(source, sidecar, false);
    }
  }
}
