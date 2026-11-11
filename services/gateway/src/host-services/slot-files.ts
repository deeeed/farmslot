// Typed service for reading and stat-ing slot files.
// Transport is chosen per slot: in-process fs for local slots, the node-daemon RPC for
// capable remote nodes, and a shell read as the last resort for older or unreachable nodes.
// slot-files-node.ts owns the node transport; this module calls it, not the other way.
import { open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { SlotVars } from '../core/config.js';
import { slotFilesReadInProcess } from '../core/exec.js';
import { readSlotProbe } from '../core/read-probes.js';
import {
  isShellHomePath,
  normalizeRemotePath,
  shellExpressionForRemotePath,
} from '../core/remote-paths.js';
import { registerHostOperations, withHostOperation } from '../observability/performance.js';

import {
  readSlotTextThroughNode,
  slotFilesReadThroughNode,
  slotIsFileThroughNode,
} from './slot-files-node.js';

/** Stable operation-name constants for per-operation metric attribution. */
export const OP_SLOT_FILES_READ = 'slotFiles.read' as const;
export const OP_SLOT_FILES_TAIL = 'slotFiles.tail' as const;
export const OP_SLOT_FILES_IS_FILE = 'slotFiles.isFile' as const;

export interface SlotFilesService {
  /** Read a slot file in full. Missing or unreadable returns ''. */
  read(vars: SlotVars, file: string, key: string, timeout?: number): Promise<string>;
  /** Read the last `tailBytes` bytes of a slot file. Missing or unreadable returns ''. */
  tail(
    vars: SlotVars,
    file: string,
    key: string,
    tailBytes: number,
    timeout?: number,
  ): Promise<string>;
  /** True when the path exists as a regular file on the slot. */
  isFile(vars: SlotVars, file: string, key: string, timeout?: number): Promise<boolean>;
}

// ── Local helpers ─────────────────────────────────────────────────────────────
// The shell reads discard errors (2>/dev/null || true): a file that is missing or
// unreadable reads as empty. The in-process reads keep that contract for the same failures.
const UNREADABLE = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR']);
const unreadable = (error: unknown) => UNREADABLE.has((error as NodeJS.ErrnoException).code ?? '');

/** A slot path as the slot's shell would resolve it: `~` is the home, relative is the repo. */
function localPath(vars: Pick<SlotVars, 'remoteRepo'>, file: string): string {
  const normalized = normalizeRemotePath(file);
  if (isShellHomePath(normalized)) return path.join(homedir(), normalized.slice(1));
  return path.resolve(vars.remoteRepo, normalized);
}

async function isLocalFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (unreadable(error)) return false;
    throw error;
  }
}

// ── Default timeout used for all transport paths ──────────────────────────────
const DEFAULT_TIMEOUT = 10_000;

// ── Service implementation ────────────────────────────────────────────────────

const transports: SlotFilesService = {
  async read(vars, file, key, timeout = DEFAULT_TIMEOUT): Promise<string> {
    if (slotFilesReadInProcess(vars)) {
      try {
        return await readFile(localPath(vars, file), 'utf8');
      } catch (error) {
        if (unreadable(error)) return '';
        throw error;
      }
    }
    if (slotFilesReadThroughNode(vars)) {
      return readSlotTextThroughNode(vars, file, timeout);
    }
    const expression = shellExpressionForRemotePath(file);
    return (await readSlotProbe(vars, `cat ${expression} 2>/dev/null || true`, key, timeout))
      .stdout;
  },

  async tail(vars, file, key, tailBytes, timeout = DEFAULT_TIMEOUT): Promise<string> {
    if (slotFilesReadInProcess(vars)) {
      try {
        const handle = await open(localPath(vars, file), 'r');
        try {
          const { size } = await handle.stat();
          const length = Math.min(size, tailBytes);
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, size - length);
          return buffer.toString('utf8');
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (unreadable(error)) return '';
        throw error;
      }
    }
    if (slotFilesReadThroughNode(vars)) {
      return readSlotTextThroughNode(vars, file, timeout, tailBytes);
    }
    const expression = shellExpressionForRemotePath(file);
    return (
      await readSlotProbe(
        vars,
        `tail -c ${tailBytes} ${expression} 2>/dev/null || true`,
        key,
        timeout,
      )
    ).stdout;
  },

  async isFile(vars, file, key, timeout = DEFAULT_TIMEOUT): Promise<boolean> {
    if (slotFilesReadInProcess(vars)) {
      return isLocalFile(localPath(vars, file));
    }
    if (slotFilesReadThroughNode(vars)) {
      return slotIsFileThroughNode(vars, file, timeout);
    }
    const probe = await readSlotProbe(
      vars,
      `if [ -f ${shellExpressionForRemotePath(file)} ]; then printf 1; fi`,
      key,
      timeout,
    );
    return probe.stdout.trim() === '1';
  },
};

registerHostOperations([OP_SLOT_FILES_READ, OP_SLOT_FILES_TAIL, OP_SLOT_FILES_IS_FILE]);

/** Each read's commands (the shell fallback, a node exec) are counted under its operation. */
const slotFiles: SlotFilesService = {
  read: (...args) => withHostOperation(OP_SLOT_FILES_READ, () => transports.read(...args)),
  tail: (...args) => withHostOperation(OP_SLOT_FILES_TAIL, () => transports.tail(...args)),
  isFile: (...args) => withHostOperation(OP_SLOT_FILES_IS_FILE, () => transports.isFile(...args)),
};

export default slotFiles;
