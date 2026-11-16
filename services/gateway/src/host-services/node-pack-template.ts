import path from 'node:path';

import { isRecord, type Run } from '@farmslot/protocol';
import { currentProjectSources, farmslotRoot, reportedFarmPaths } from '@farmslot/slot-config';

import { loadSlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { assertNodeReconnectCurrent, sendNodeRequest, waitForNode } from '../fleet/node-rpc.js';

import { runTaskTransfer } from './task-transfer.js';

interface NodePackTemplateCheck {
  project: string;
  expectedHash: string;
  readHash: () => Promise<string | null>;
  sync: () => Promise<void>;
}

/** A matching catalog costs one file hash, with no sync or second read. */
export async function ensureNodePackTemplateHash(check: NodePackTemplateCheck): Promise<void> {
  if ((await check.readHash()) === check.expectedHash) return;
  let syncError: unknown;
  try {
    await check.sync();
  } catch (error) {
    // A partial copy can fail. Recheck before reporting the actual catalog mismatch,
    // and retain the copy failure as its cause rather than hiding it.
    syncError = error;
  }
  const actual = await check.readHash();
  if (actual !== check.expectedHash)
    throw new Error(
      `node pack ${check.project} at ${actual ?? 'missing'}, gateway at ${check.expectedHash}`,
      { cause: syncError },
    );
  if (syncError) throw syncError;
}

// Concurrent admissions on the same node share its existing packs-only refresh.
const syncing = new Map<string, Promise<void>>();

async function syncNodePacks(machine: string, home: string): Promise<void> {
  const key = `${machine}\0${home}`;
  const pending = syncing.get(key);
  if (pending) return pending;
  const operation = (async () => {
    const result = await runTaskTransfer(
      [
        'bash',
        path.join(farmslotRoot(), 'scripts/deploy-node.sh'),
        machine,
        '--home',
        home,
        '--packs-only',
      ]
        .map(shellQuote)
        .join(' '),
      { timeout: 120_000 },
    );
    if (result.exitCode !== 0)
      throw new Error(
        `Pack sync for ${machine} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
  })();
  syncing.set(key, operation);
  try {
    await operation;
  } finally {
    syncing.delete(key);
  }
}

/** Check the installed project catalog task-init reads, before write-task has any output. */
export async function ensureRunNodePackTemplate(run: Run): Promise<void> {
  const template = run.executionTemplate;
  if (
    !run.slotId ||
    !template ||
    template.sourceId !== `project:${run.project}` ||
    currentProjectSources() ||
    (run.taskFile &&
      run.engineState?.taskInit?.taskFile === run.taskFile &&
      run.engineState.taskInit.status === 'initialized')
  )
    return;
  const slot = await loadSlotVars(run.slotId);
  // The local producer reads the gateway's same catalog. Source-locked runs use attestation.
  if (isLocal(slot.host, slot.machine)) return;
  const node = await waitForNode(slot.machine);
  const paths = reportedFarmPaths(slot.machine);
  if (!paths) throw new Error(`Node ${slot.machine} has not reported its catalog directory`);
  const relative = path.posix.normalize(template.relativePath);
  if (path.posix.isAbsolute(relative) || relative === '..' || relative.startsWith('../'))
    throw new Error('Execution-template path escapes its catalog');
  await ensureNodePackTemplateHash({
    project: run.project,
    expectedHash: template.sha256,
    readHash: async () => {
      assertNodeReconnectCurrent();
      let result: unknown;
      try {
        result = await sendNodeRequest(node, 'fs.hash', {
          root: path.posix.join(paths.projects, run.project, 'templates/worker'),
          relPath: relative,
        });
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') return null;
        throw error;
      }
      if (
        !isRecord(result) ||
        typeof result.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(result.sha256)
      )
        throw new Error(`Node ${slot.machine} returned an invalid catalog hash`);
      return result.sha256;
    },
    sync: () => syncNodePacks(slot.machine, paths.home),
  });
}
