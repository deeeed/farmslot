import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isRecord, type Run } from '@farmslot/protocol';

import { execLocal, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { getNode } from '../fleet/machine-registry.js';
import { loadPoolConfigs } from '../fleet/state.js';
import type { RetentionSplit } from '../methods/run/retention.js';
import { reclaimReviewWorkspaceStorage } from '../review-workspaces/storage-use.js';
import { hasTaskAdmissions, runTaskDirectories } from '../runs/store.js';
import type {
  TaskPinProtection,
  TaskPinShareInput,
  TaskPinShareResult,
  TaskPinStage,
  TaskPinSweepInput,
} from '../runs/task-pins.cjs';

import { backgroundHost } from './background/client.js';
import { BACKGROUND_OPERATIONS } from './background/protocol.js';
import { runBackgroundCommand } from './background-command.js';

export interface NodePinTarget {
  machine: string;
  host: string;
  sshUser: string;
  root: string;
}
export type NodePinRequest =
  | ({ op: 'stage' } & TaskPinSweepInput)
  | { op: 'purge'; root: string; result: TaskPinStage }
  | ({ op: 'share' } & TaskPinShareInput);

/** Pins one pass links into the shared store per node (ADR-039 Amendment 12). */
export const TASK_PIN_SHARE_LIMIT = 8;

export interface NodePinRetentionDeps {
  targets(): Promise<NodePinTarget[]>;
  /** Every run split by the retention rule, read inside the admission fence. */
  split(): Promise<RetentionSplit>;
  execute(target: NodePinTarget, payload: NodePinRequest): Promise<unknown>;
  fence(operation: () => Promise<string[]>): Promise<string[]>;
}

/** Task directories a run reads: its own, its review workspace's and a park recovery's. */
function pinTaskDirs(run: Run): string[] {
  const dirs = runTaskDirectories(run).map((dir) => path.resolve(dir));
  if (run.reviewWorkspace?.taskPath) dirs.push(path.resolve(run.reviewWorkspace.taskPath));
  const recovery = run.park?.recoveryHandle;
  if (recovery?.version === 1 && recovery.taskDir) dirs.push(path.resolve(recovery.taskDir));
  return dirs;
}

/**
 * A pin follows its run's retention (ADR-039 Amendment 12). Held runs keep their pins, so live
 * runs and open-PR reviews always can replay; a parked run keeps its recovery's pin whatever
 * its hold. Missing task directories do not remove the ownership held by replay or publication.
 */
export function taskPinProtection(split: RetentionSplit): {
  protection: TaskPinProtection;
  releasedTaskDirs: string[];
} {
  const taskDirs = new Set<string>();
  for (const run of split.held) for (const dir of pinTaskDirs(run)) taskDirs.add(dir);
  for (const run of split.released)
    if (run.park) for (const dir of pinTaskDirs(run)) taskDirs.add(dir);
  const released = new Set<string>();
  for (const run of split.released)
    for (const dir of pinTaskDirs(run)) if (!taskDirs.has(dir)) released.add(dir);
  return {
    protection: {
      taskDirs: [...taskDirs],
      taskNames: [...new Set([...taskDirs].map((dir) => path.basename(dir)))],
      pinIds: [],
    },
    releasedTaskDirs: [...released],
  };
}

let program: Promise<string> | undefined;
async function execute(target: NodePinTarget, payload: NodePinRequest): Promise<unknown> {
  program ??= readFile(new URL('../runs/task-pins.cjs', import.meta.url), 'utf8');
  const source = `${await program}\nconst input = JSON.parse(process.argv[1]);\n(input.op === 'stage' ? stageTaskPins(input) : input.op === 'share' ? shareTaskPins(input) : purgeTaskPins(input.root,input.result)).then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode=1; });`;
  const nodeCommand = `node -e ${shellQuote(source)} ${shellQuote(JSON.stringify(payload))}`;
  const local = isLocal(target.host, target.machine);
  const command = local
    ? nodeCommand
    : `ssh -o BatchMode=yes -o ConnectTimeout=10 ${shellQuote(target.sshUser ? `${target.sshUser}@${target.host}` : target.host)} ${shellQuote(nodeCommand)}`;
  const params = {
    command,
    cwd: process.cwd(),
    // Sharing hashes up to TASK_PIN_SHARE_LIMIT whole pins, about 3 GB on a busy node.
    timeout: payload.op === 'share' ? 900_000 : payload.op === 'purge' ? 120_000 : 30_000,
    maxBuffer: 1024 * 1024,
  };
  const result = backgroundHost.active()
    ? await runBackgroundCommand(BACKGROUND_OPERATIONS.taskPins, params)
    : await execLocal(command, params);
  if (result.exitCode !== 0)
    throw new Error(
      `Task-pin ${target.machine} command failed (${result.exitCode}): ${result.stderr.slice(-500)}`,
    );
  return JSON.parse(result.stdout);
}

/** `split` comes from the retention pass, which owns the run context (methods/run/retention). */
export const NODE_PIN_RETENTION_DEPS: Omit<NodePinRetentionDeps, 'split'> = {
  async targets() {
    const targets = new Map<string, NodePinTarget>();
    for (const pool of await loadPoolConfigs()) {
      const root = getNode(pool.machine)?.farmPaths?.state.taskPins;
      // Never guess another node's selected home, or mistake a disconnected node for an orphan.
      if (root && !targets.has(pool.machine))
        targets.set(pool.machine, {
          machine: pool.machine,
          host: pool.host,
          sshUser: pool.sshUser,
          root,
        });
    }
    return [...targets.values()];
  },
  execute,
  fence: async (operation) => (hasTaskAdmissions() ? [] : reclaimReviewWorkspaceStorage(operation)),
};
function decodeStage(value: unknown): TaskPinStage {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.inspected) ||
    typeof value.inspected !== 'number' ||
    value.inspected < 0 ||
    value.inspected > 32 ||
    !(value.stage === null || typeof value.stage === 'string') ||
    !Array.isArray(value.staged) ||
    value.staged.length > 8 ||
    !value.staged.every((id): id is string => typeof id === 'string') ||
    !(
      value.swept === undefined ||
      (typeof value.swept === 'number' && Number.isInteger(value.swept) && value.swept >= 0)
    )
  )
    throw new Error('Invalid node task-pin staging receipt');
  return {
    inspected: value.inspected,
    stage: value.stage,
    staged: value.staged,
    ...(typeof value.swept === 'number' ? { swept: value.swept } : {}),
  };
}

function decodeShare(value: unknown): TaskPinShareResult {
  const ids = (list: unknown): list is string[] =>
    Array.isArray(list) &&
    list.length <= TASK_PIN_SHARE_LIMIT &&
    list.every((id) => typeof id === 'string');
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (
    !isRecord(value) ||
    !ids(value.pins) ||
    !ids(value.unverified) ||
    !count(value.shared) ||
    !count(value.inserted) ||
    !count(value.savedBytes) ||
    !isRecord(value.private) ||
    !Object.values(value.private).every(count)
  )
    throw new Error('Invalid node task-pin share receipt');
  const privateFiles: Record<string, number> = {};
  for (const [reason, files] of Object.entries(value.private))
    if (count(files)) privateFiles[reason] = files;
  return {
    pins: value.pins,
    unverified: value.unverified,
    shared: value.shared,
    inserted: value.inserted,
    savedBytes: value.savedBytes,
    private: privateFiles,
  };
}

/** One bounded node batch per existing hourly retention tick. Purge never holds admission. */
export async function nodeTaskPinRetentionPass(
  now: number,
  ageMs: number,
  deps: NodePinRetentionDeps,
): Promise<void> {
  for (const target of await deps.targets()) {
    try {
      let staged: TaskPinStage | undefined;
      await deps.fence(async () => {
        const { protection, releasedTaskDirs } = taskPinProtection(await deps.split());
        staged = decodeStage(
          await deps.execute(target, {
            op: 'stage',
            root: target.root,
            now,
            ageMs,
            protection,
            releasedTaskDirs,
          }),
        );
        return [];
      });
      if (!staged) continue; // An in-flight storage admission owns this turn.
      const result = await deps.execute(target, { op: 'purge', root: target.root, result: staged });
      if (
        !isRecord(result) ||
        !Array.isArray(result.removed) ||
        !result.removed.every((id) => typeof id === 'string' && staged?.staged.includes(id))
      )
        throw new Error('Invalid node task-pin purge receipt');
      console.log(
        `[task-pin retention] ${target.machine} inspected=${staged.inspected} removed=${JSON.stringify(result.removed)} store-swept=${staged.swept ?? 0}`,
      );
      // Outside the fence: linking never removes anything a task could still be admitted to read.
      const shared = decodeShare(
        await deps.execute(target, { op: 'share', root: target.root, limit: TASK_PIN_SHARE_LIMIT }),
      );
      if (shared.pins.length || shared.unverified.length)
        console.log(
          `[task-pin store] ${target.machine} pins=${JSON.stringify(shared.pins)} shared=${shared.shared} new=${shared.inserted} saved=${(shared.savedBytes / 2 ** 20).toFixed(0)}MB`,
        );
      for (const [reason, files] of Object.entries(shared.private))
        console.warn(
          reason === 'mismatch'
            ? `[task-pin store] ${target.machine} ${files} file(s) kept private: their store entry failed re-verification and was quarantined`
            : `[task-pin store] ${target.machine} ${files} file(s) kept as private read-only copies: hard link unavailable (${reason})`,
        );
      if (shared.unverified.length)
        console.error(
          `[task-pin store] ${target.machine} pins ${JSON.stringify(shared.unverified)} changed while sharing; left unrecorded for the next pass`,
        );
    } catch (error) {
      // A failed node retains its remaining or staged pins; healthy nodes still get their turn.
      console.error(
        `[task-pin retention] ${target.machine} retained on failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
