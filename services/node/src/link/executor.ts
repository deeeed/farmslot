import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type ExecResult,
  isNodeLinkAuthority,
  isNodeLinkTarget,
  NODE_LINK_LIMITS,
  type NodeLinkCommand,
  NodeLinkFailure,
  type NodeLinkGrant,
  type NodeLinkPrincipal,
  type NodeLinkProcessSummary,
  type NodeLinkProcessUpdate,
  type NodeLinkTerminalSize,
} from '@farmslot/protocol';

import { exec, resolveLoginPath } from '../commands/exec.js';
import {
  fsDelete,
  fsExists,
  fsHash,
  fsMkdir,
  fsRead,
  fsReadChunk,
  fsRename,
  fsStat,
  fsWrite,
  fsWriteChunk,
} from '../commands/fs.js';
import { executeTaskRuntime } from '../commands/task-runtime.js';

import { NodeLinkCommands } from './commands.js';
import {
  NODE_LINK_OPERATIONS,
  parseNodeLinkOperation,
  parseNodeLinkProcess,
  parseNodeLinkTask,
} from './operations.js';
import { type NodeLinkTerminal, openNodeLinkTerminal } from './terminal.js';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = isDeepStrictEqual;

function processSummary(result: ExecResult): NodeLinkProcessSummary {
  const digest = (text: string) => ({
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  return {
    kind: 'streamed-process-result',
    exitCode: result.exitCode,
    stdout: digest(result.stdout),
    stderr: digest(result.stderr),
  };
}

function grantValue(value: unknown): NodeLinkGrant {
  if (
    !object(value) ||
    !isNodeLinkAuthority(value.authority) ||
    !isNodeLinkTarget(value.target) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    !Array.isArray(value.operations) ||
    value.operations.length < 1 ||
    !value.operations.every((operation) => NODE_LINK_OPERATIONS.includes(operation)) ||
    (value.root !== undefined &&
      (typeof value.root !== 'string' || !path.isAbsolute(value.root))) ||
    Object.keys(value).some(
      (key) =>
        !['target', 'authority', 'expiresAt', 'operations', 'root', 'process', 'task'].includes(
          key,
        ),
    )
  )
    throw new NodeLinkFailure('INVALID_PARAMS', 'Invalid server resource grant.');
  return {
    target: value.target,
    authority: value.authority,
    expiresAt: value.expiresAt,
    operations: value.operations,
    ...(typeof value.root === 'string' ? { root: value.root } : {}),
    ...(value.process !== undefined ? { process: parseNodeLinkProcess(value.process) } : {}),
    ...(value.task !== undefined ? { task: parseNodeLinkTask(value.task) } : {}),
  };
}

/** Grants are socket-local and replaceable; durable command outcomes are not. */
export class NodeLinkExecutor {
  readonly commands: NodeLinkCommands;
  private readonly grants = new Map<string, NodeLinkGrant>();
  private readonly resourceOwners = new Map<
    string,
    { lease: NodeLinkGrant['authority']['lease']; executor: NodeLinkPrincipal }
  >();
  private closed = false;
  private readonly terminals = new Map<string, NodeLinkTerminal>();

  constructor(
    root: string,
    private readonly nodeId: string,
    private readonly principal: NodeLinkPrincipal,
    private readonly current: () => boolean,
    private readonly output?: (
      command: NodeLinkCommand,
      update: NodeLinkProcessUpdate,
      signal: AbortSignal,
    ) => void | Promise<void>,
  ) {
    this.commands = new NodeLinkCommands(root, {
      authorize: (command) => {
        this.authorize(command);
      },
      authorizeCloseout: (command) => this.authorizeCloseout(command),
      isReadOnly: (command) =>
        [
          'system.which',
          'file.exists',
          'file.inspect',
          'file.hash',
          'file.read',
          'file.read-range',
        ].includes(command.operation),
      execute: (command, signal) => this.execute(command, signal),
    });
  }

  bind(value: unknown): { granted: true } {
    this.assertCurrent();
    this.pruneGrants();
    const grant = grantValue(value);
    if (
      grant.target.nodeId !== this.nodeId ||
      !equal(grant.authority.executor, this.principal) ||
      grant.expiresAt <= Date.now()
    )
      throw new NodeLinkFailure(
        'STALE_AUTHORITY',
        'Grant does not belong to this node identity or validity window.',
      );
    if (
      this.grants.size >= NODE_LINK_LIMITS.inFlight &&
      !this.grants.has(this.grantKey(grant.target.resourceId, grant.authority.grantId))
    )
      throw new NodeLinkFailure('CAPACITY', 'Node resource grant capacity reached.');
    if (grant.operations.some((operation) => operation.startsWith('file.')) && !grant.root)
      throw new NodeLinkFailure('INVALID_PARAMS', 'File operations require an admitted root.');
    if (grant.operations.includes('process.run') && !grant.process)
      throw new NodeLinkFailure(
        'INVALID_PARAMS',
        'Process operations require exact approved argv and limits.',
      );
    if (grant.operations.includes('task.runtime') && !grant.task)
      throw new NodeLinkFailure(
        'INVALID_PARAMS',
        'Task operations require an exact approved call.',
      );
    const owner = { lease: grant.authority.lease, executor: grant.authority.executor };
    const previous = this.resourceOwners.get(grant.target.resourceId);
    if (previous && !equal(previous, owner)) {
      for (const [key, existing] of this.grants)
        if (existing.target.resourceId === grant.target.resourceId) this.grants.delete(key);
    }
    this.resourceOwners.set(grant.target.resourceId, structuredClone(owner));
    this.grants.set(
      this.grantKey(grant.target.resourceId, grant.authority.grantId),
      structuredClone(grant),
    );
    return { granted: true };
  }

  /** Old socket authority ends immediately; original executions retain closeout responsibility. */
  async retire(): Promise<void> {
    this.closed = true;
    this.grants.clear();
    this.resourceOwners.clear();
    await this.commands.retire();
  }

  release(command: NodeLinkCommand): void {
    this.authorizeCloseout(command);
    const key = this.grantKey(command.target.resourceId, command.authority.grantId);
    const grant = this.grants.get(key);
    if (
      grant &&
      (!equal(command.target, grant.target) || !equal(command.authority, grant.authority))
    )
      throw new NodeLinkFailure('STALE_AUTHORITY', 'Release cannot change another grant.');
    this.grants.delete(key);
    this.dropUnusedOwner(command.target.resourceId);
  }

  private dropUnusedOwner(resourceId: string): void {
    if (![...this.grants.values()].some((current) => current.target.resourceId === resourceId))
      this.resourceOwners.delete(resourceId);
  }

  private pruneGrants(): void {
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt > Date.now()) continue;
      this.grants.delete(key);
      this.dropUnusedOwner(grant.target.resourceId);
    }
  }

  private grantKey(resourceId: string, grantId: string): string {
    return JSON.stringify([resourceId, grantId]);
  }

  private assertCurrent(): void {
    if (this.closed || !this.current())
      throw new NodeLinkFailure(
        'STALE_SOCKET',
        'Node link is not the current authenticated connection.',
      );
  }

  /** Digest-bound cancellation stops only the original execution, never a successor resource. */
  authorizeCloseout(command: NodeLinkCommand): void {
    this.assertCurrent();
    const typed = parseNodeLinkOperation(command);
    if (typed.target.nodeId !== this.nodeId || !equal(typed.authority.executor, this.principal))
      throw new NodeLinkFailure(
        'STALE_AUTHORITY',
        'Cleanup command belongs to another node execution identity.',
      );
  }

  authorize(command: NodeLinkCommand): NodeLinkGrant {
    this.assertCurrent();
    const typed = parseNodeLinkOperation(command);
    const grant = this.grants.get(this.grantKey(typed.target.resourceId, typed.authority.grantId));
    if (
      !grant ||
      grant.expiresAt <= Date.now() ||
      typed.expiresAt > grant.expiresAt ||
      !equal(typed.target, grant.target) ||
      !equal(typed.authority, grant.authority) ||
      !grant.operations.includes(typed.operation)
    )
      throw new NodeLinkFailure(
        'STALE_AUTHORITY',
        'Command grant, owner, lease or validity changed.',
      );
    if (typed.operation === 'process.run') {
      if (!equal(typed.input, grant.process))
        throw new NodeLinkFailure(
          'POLICY_REFUSED',
          'Process input differs from its exact approved policy.',
        );
    } else if (typed.operation === 'task.runtime') {
      if (!equal(typed.input, grant.task))
        throw new NodeLinkFailure(
          'POLICY_REFUSED',
          'Task input differs from its exact approved policy.',
        );
    } else if (typed.operation !== 'system.which' && typed.input.root !== grant.root) {
      throw new NodeLinkFailure('POLICY_REFUSED', 'File input cannot replace its admitted root.');
    }
    return grant;
  }

  resizeTerminal(command: NodeLinkCommand, size: NodeLinkTerminalSize): void {
    this.authorize(command);
    const terminal = this.terminals.get(command.commandId);
    if (!terminal)
      throw new NodeLinkFailure('TERMINAL_UNAVAILABLE', 'No active attachment for this command.');
    terminal.resize(size);
  }

  /** Refuse static parent/final symlinks as well as lexical escapes before reusing file adapters. */
  private async checkPath(root: string, relative: string): Promise<void> {
    if ((await realpath(root)) !== path.resolve(root))
      throw new NodeLinkFailure('POLICY_REFUSED', 'Admitted file root must be canonical.');
    let current = root;
    for (const part of relative.split('/').filter((part) => part && part !== '.')) {
      current = path.join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new NodeLinkFailure(
            'POLICY_REFUSED',
            'File operation refuses a symlink component.',
          );
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      }
    }
  }

  private async sync(file: string): Promise<void> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async execute(command: NodeLinkCommand, signal: AbortSignal): Promise<unknown> {
    const grant = this.authorize(command);
    const typed = parseNodeLinkOperation(command);
    signal.throwIfAborted();
    if (typed.operation === 'task.runtime') {
      const result = await executeTaskRuntime(typed.input, signal);
      if (Buffer.byteLength(JSON.stringify(result)) <= 128 * 1024) return result;
      for (const stream of ['stdout', 'stderr'] as const) {
        for (let offset = 0; offset < result[stream].length; offset += 16 * 1024)
          await this.output?.(
            command,
            {
              kind: 'output',
              stream,
              text: result[stream].slice(offset, offset + 16 * 1024),
            },
            signal,
          );
      }
      return processSummary(result);
    }
    if (typed.operation === 'process.run') {
      if (typed.input.terminal) {
        const terminal = await openNodeLinkTerminal(
          typed.input,
          signal,
          async (update, deliverySignal) => {
            await this.output?.(command, update, deliverySignal);
          },
        );
        this.terminals.set(command.commandId, terminal);
        try {
          return await terminal.result;
        } finally {
          if (this.terminals.get(command.commandId) === terminal)
            this.terminals.delete(command.commandId);
        }
      }
      const result = await exec(
        {
          argv: typed.input.argv,
          cwd: typed.input.cwd,
          requestScoped: true,
          timeout: Math.min(typed.input.timeoutMs, Math.max(1, typed.expiresAt - Date.now())),
          maxBuffer: typed.input.maxOutputBytes,
          closeoutTimeoutMs: typed.input.closeoutTimeoutMs,
          ...(typed.input.environment ? { environment: typed.input.environment } : {}),
        },
        (stream, text, deliverySignal) =>
          this.output?.(command, { kind: 'output', stream, text }, deliverySignal),
        signal,
      );
      if (Buffer.byteLength(JSON.stringify(result)) <= 128 * 1024) return result;
      return processSummary(result);
    }
    if (typed.operation === 'system.which') {
      const directories = (await resolveLoginPath()).split(path.delimiter).filter(Boolean);
      const paths: Record<string, string | null> = Object.create(null);
      for (const program of typed.input.programs) {
        paths[program] = null;
        for (const directory of directories) {
          const candidate = path.join(directory, program);
          try {
            await access(candidate, constants.X_OK);
            if (!(await stat(candidate)).isFile()) continue;
            paths[program] = candidate;
            break;
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              ['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(error.code))
            )
              continue;
            throw error;
          }
        }
      }
      return { paths };
    }
    if (!grant.root) throw new NodeLinkFailure('POLICY_REFUSED', 'Missing admitted file root.');
    const roots =
      typed.operation === 'file.rename'
        ? [typed.input.oldRelPath, typed.input.newRelPath]
        : typed.operation === 'file.commit'
          ? [typed.input.stagedRelPath, typed.input.destinationRelPath]
          : [typed.input.relPath];
    for (const relative of roots) await this.checkPath(grant.root, relative);
    this.authorize(command);
    signal.throwIfAborted();
    switch (typed.operation) {
      case 'file.exists':
        return fsExists(typed.input);
      case 'file.inspect':
        return fsStat(typed.input);
      case 'file.hash':
        return fsHash(typed.input);
      case 'file.read': {
        if ((await fsStat(typed.input)).size > NODE_LINK_LIMITS.chunkBytes)
          throw new NodeLinkFailure('RESULT_TOO_LARGE', 'Use an explicit bounded file range.');
        return fsRead(typed.input);
      }
      case 'file.read-range':
        return fsReadChunk(typed.input);
      case 'file.write':
        return fsWrite(typed.input);
      case 'file.write-range':
        return fsWriteChunk(typed.input);
      case 'file.write-files': {
        let count = 0;
        const transfer = createHash('sha256').update(command.commandId).digest('hex');
        for (const [index, file] of typed.input.files.entries()) {
          const relative = path.join(typed.input.relPath, file.path);
          const staged = path.join('.node-link-staging', transfer, String(index));
          await this.checkPath(grant.root, relative);
          await this.checkPath(grant.root, staged);
          this.authorize(command);
          signal.throwIfAborted();
          await mkdir(path.dirname(path.join(grant.root, staged)), { recursive: true });
          await this.checkPath(grant.root, staged);
          await fsWriteChunk({
            root: grant.root,
            relPath: staged,
            offset: 0,
            content: file.content,
            truncate: true,
            ...(file.mode !== undefined ? { mode: file.mode } : {}),
          });
          await mkdir(path.dirname(path.join(grant.root, relative)), { recursive: true });
          await this.checkPath(grant.root, relative);
          this.authorize(command);
          signal.throwIfAborted();
          await this.sync(path.join(grant.root, staged));
          if (typed.input.createOnly) {
            try {
              await link(path.join(grant.root, staged), path.join(grant.root, relative));
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
                throw error;
              await unlink(path.join(grant.root, staged));
              continue;
            }
            await unlink(path.join(grant.root, staged));
          } else await rename(path.join(grant.root, staged), path.join(grant.root, relative));
          await this.sync(path.dirname(path.join(grant.root, relative)));
          count++;
        }
        return { ok: true, count };
      }
      case 'file.commit': {
        const input = typed.input;
        const fingerprint = await fsHash({ root: input.root, relPath: input.stagedRelPath });
        if (fingerprint.sha256 !== input.sha256 || fingerprint.size !== input.size)
          throw new NodeLinkFailure(
            'TRANSFER_INTEGRITY',
            'Staged file differs from its admitted source.',
          );
        this.authorize(command);
        signal.throwIfAborted();
        const staged = path.join(input.root, input.stagedRelPath);
        const destination = path.join(input.root, input.destinationRelPath);
        await mkdir(path.dirname(destination), { recursive: true });
        await this.checkPath(input.root, input.destinationRelPath);
        await this.sync(staged);
        if (input.createOnly) {
          try {
            await link(staged, destination);
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
              throw error;
            await unlink(staged);
            return { committed: false, sha256: input.sha256 };
          }
          await unlink(staged);
        } else await rename(staged, destination);
        await this.sync(path.dirname(destination));
        return { committed: true, sha256: input.sha256 };
      }
      case 'file.mkdir':
        return fsMkdir(typed.input);
      case 'file.delete': {
        try {
          return await fsDelete(typed.input);
        } catch (error) {
          // Unconditional staging cleanup keeps rm -f semantics; a hash precondition must still fail.
          if (
            typed.input.expectedHash === undefined &&
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            return { ok: true };
          throw error;
        }
      }
      case 'file.rename':
        return fsRename(typed.input);
    }
  }
}
