import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isRecord, type Run } from '@farmslot/protocol';

import { execLocal, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { getNode } from '../fleet/machine-registry.js';
import { loadPoolConfigs } from '../fleet/state.js';
import {
  reclaimReviewWorkspaceStorage,
  runNeedsExecutionStorage,
} from '../review-workspaces/storage-use.js';
import { getAllRunsWithArchived, hasTaskAdmissions, runTaskDirectories } from '../runs/store.js';
import type { TaskPinProtection, TaskPinStage, TaskPinSweepInput } from '../runs/task-pins.cjs';

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
  | { op: 'purge'; root: string; result: TaskPinStage };

export interface NodePinRetentionDeps {
  targets(): Promise<NodePinTarget[]>;
  runs(): Promise<Run[]>;
  execute(target: NodePinTarget, payload: NodePinRequest): Promise<unknown>;
  fence(operation: () => Promise<string[]>): Promise<string[]>;
}

/** Missing task directories do not remove the ownership held by replay or publication. */
export function taskPinProtection(runs: Run[]): TaskPinProtection {
  const taskDirs = new Set<string>();
  for (const run of runs) {
    // Terminal runs can still reactivate from their original pin until explicitly archived.
    if (run.archivedAt && !runNeedsExecutionStorage(run) && !run.park) continue;
    for (const dir of runTaskDirectories(run)) taskDirs.add(path.resolve(dir));
    if (run.reviewWorkspace?.taskPath) taskDirs.add(path.resolve(run.reviewWorkspace.taskPath));
    const recovery = run.park?.recoveryHandle;
    if (recovery?.version === 1 && recovery.taskDir) taskDirs.add(path.resolve(recovery.taskDir));
  }
  return {
    taskDirs: [...taskDirs],
    taskNames: [...new Set([...taskDirs].map((dir) => path.basename(dir)))],
    pinIds: [],
  };
}

let program: Promise<string> | undefined;
async function execute(target: NodePinTarget, payload: NodePinRequest): Promise<unknown> {
  program ??= readFile(new URL('../runs/task-pins.cjs', import.meta.url), 'utf8');
  const source = `${await program}\nconst input = JSON.parse(process.argv[1]);\n(input.op === 'stage' ? stageTaskPins(input) : purgeTaskPins(input.root,input.result)).then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode=1; });`;
  const nodeCommand = `node -e ${shellQuote(source)} ${shellQuote(JSON.stringify(payload))}`;
  const local = isLocal(target.host, target.machine);
  const command = local
    ? nodeCommand
    : `ssh -o BatchMode=yes -o ConnectTimeout=10 ${shellQuote(target.sshUser ? `${target.sshUser}@${target.host}` : target.host)} ${shellQuote(nodeCommand)}`;
  const params = {
    command,
    cwd: process.cwd(),
    timeout: payload.op === 'purge' ? 120_000 : 30_000,
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

export const NODE_PIN_RETENTION_DEPS: NodePinRetentionDeps = {
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
  runs: getAllRunsWithArchived,
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
    !value.staged.every((id): id is string => typeof id === 'string')
  )
    throw new Error('Invalid node task-pin staging receipt');
  return { inspected: value.inspected, stage: value.stage, staged: value.staged };
}

/** One bounded node batch per existing hourly retention tick. Purge never holds admission. */
export async function nodeTaskPinRetentionPass(
  now: number,
  ageMs: number,
  deps: NodePinRetentionDeps = NODE_PIN_RETENTION_DEPS,
): Promise<void> {
  for (const target of await deps.targets()) {
    try {
      let staged: TaskPinStage | undefined;
      await deps.fence(async () => {
        const protection = taskPinProtection(await deps.runs());
        staged = decodeStage(
          await deps.execute(target, { op: 'stage', root: target.root, now, ageMs, protection }),
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
        `[task-pin retention] ${target.machine} inspected=${staged.inspected} removed=${JSON.stringify(result.removed)}`,
      );
    } catch (error) {
      // A failed node retains its remaining or staged pins; healthy nodes still get their turn.
      console.error(
        `[task-pin retention] ${target.machine} retained on failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
