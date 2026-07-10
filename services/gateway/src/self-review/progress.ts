import { readFile } from 'node:fs/promises';

import { watch } from 'chokidar';

import { type AgentRole, Events } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { taskProgress } from '../methods/task.js';
import { getRun, updateRunStep } from '../runs/store.js';

import { debugSelfReviewLog } from './snapshots.js';

// ─── Progress watcher ───
// Watches SELF-REVIEW.md checkboxes and updates the run step detail in real-time.
// This surfaces self-review progress in the pipeline canvas.

type BroadcastFn = (event: string, payload: unknown) => void;
let broadcastFn: BroadcastFn = () => {};

export function initSelfReviewProgress(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

// Remote progress watcher registry — maps machine|path to the compute callback
// so node.fs.changed events can be dispatched to the right self-review watcher.
// Gateway has no local filesystem view of a node's repo, so remote slots need
// the node daemon's fs.watch to drive the same progress UI updates.
interface RemoteProgressEntry {
  machine: string;
  path: string;
  onContent: (content: string) => void;
}
const remoteProgressEntries = new Map<string, RemoteProgressEntry>();

export function handleSelfReviewFsChanged(payload: {
  machine: string;
  path: string;
  content: string;
}): boolean {
  for (const entry of remoteProgressEntries.values()) {
    if (entry.machine === payload.machine && entry.path === payload.path) {
      entry.onContent(payload.content);
      return true;
    }
  }
  return false;
}

export function startProgressWatcher(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  filePath: string,
  runId: string,
  label = 'Review',
  options: { contextId?: string; role?: AgentRole } = {},
): { stop: () => void } {
  let lastProgress = '';
  const fallbackContextId = label === 'Fix' ? 'self-review-fix' : 'self-review';
  const contextId = options.contextId ?? fallbackContextId;
  const role = options.role ?? (fallbackContextId as AgentRole);

  const compute = (content: string) => {
    const total = (content.match(/- \[[ x]\]/g) || []).length;
    const done = (content.match(/- \[x\]/gi) || []).length;
    const progress = `${done}/${total}`;
    if (progress === lastProgress) return;
    lastProgress = progress;
    updateRunStep(runId, 'self-review', { detail: `${label}: ${progress} steps` });
    broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
    void taskProgress({ slotId: vars.slotId, runId, contextId, role })
      .then((structuredProgress) => {
        broadcastFn(Events.TASK_PROGRESS_UPDATED, {
          slotId: vars.slotId,
          runId,
          role,
          contextId,
          progress: structuredProgress,
        });
      })
      .catch((err) => {
        console.warn(
          `[self-review] failed to broadcast ${contextId} task progress for ${runId.slice(0, 8)}: ${(err as Error).message}`,
        );
      });
  };

  if (isLocal(vars.host, vars.machine)) {
    const watcher = watch(filePath, { persistent: false, ignoreInitial: true });
    const onUpdate = async () => {
      try {
        compute(await readFile(filePath, 'utf-8'));
      } catch (err) {
        console.warn(
          `[self-review] progress file read skipped for ${filePath}: ${(err as Error).message}`,
        );
      }
    };
    watcher.on('change', onUpdate);
    onUpdate();
    return {
      stop: () => {
        watcher.close();
      },
    };
  }

  // Remote slot — register callback for node.fs.changed dispatch + start node-side watch
  const key = `${vars.machine}|${filePath}|${runId}|${label}`;
  remoteProgressEntries.set(key, { machine: vars.machine, path: filePath, onContent: compute });
  const node = getNode(vars.machine);
  let watchRequestId: string | undefined;
  if (node) {
    sendNodeRequest(
      node,
      'fs.watch',
      { path: filePath },
      {
        onRequestId: (id) => {
          watchRequestId = id;
        },
      },
    ).catch((err) => {
      debugSelfReviewLog(
        `[self-review] remote fs.watch failed for ${filePath}: ${(err as Error).message}`,
      );
    });
  } else {
    debugSelfReviewLog(
      `[self-review] no node for ${vars.machine} — progress updates will be silent`,
    );
  }
  return {
    stop: () => {
      remoteProgressEntries.delete(key);
      if (!watchRequestId) return;
      const liveNode = getNode(vars.machine);
      if (liveNode) {
        sendNodeRequest(liveNode, 'fs.watch.stop', { requestId: watchRequestId }).catch((err) => {
          debugSelfReviewLog(
            `[self-review] remote fs.watch.stop failed for ${filePath}: ${(err as Error).message}`,
          );
        });
      }
    },
  };
}
