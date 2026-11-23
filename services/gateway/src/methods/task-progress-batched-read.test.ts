import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { WebSocket } from 'ws';

// mock.module replaces a module wholesale, so the real namespaces are spread in
// and only the fixtures these tests need are overridden.
import * as realConfig from '../core/config.js';
import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import * as realFleetState from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'gw-progress-batch-'));
const taskDir = path.join(root, '.task', 'dev', 'demo');
/** Every node request a read makes, by method. */
const requests: string[] = [];

function enoent(file: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), {
    code: 'ENOENT',
  });
}

function readNodeFile(params: { root: string; relPath: string }): string {
  const file = path.join(params.root, params.relPath);
  if (!existsSync(file)) throw enoent(file);
  return readFileSync(file, 'utf-8');
}

/** The node's fs methods over the local disk, as a remote slot's node answers them. */
async function nodeRequest(method: string, raw: unknown): Promise<unknown> {
  requests.push(method);
  const params = raw as { root: string; relPath: string };
  switch (method) {
    case 'fs.read':
      return { content: readNodeFile(params) };
    case 'fs.exists':
      return { exists: existsSync(path.join(params.root, params.relPath)) };
    case 'fs.list': {
      const dir = path.join(params.root, params.relPath);
      if (!existsSync(dir)) throw enoent(dir);
      return {
        entries: readdirSync(dir, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isFile() ? 'file' : 'directory',
        })),
      };
    }
    case 'fs.readFiles':
      return {
        files: (raw as { files: Array<{ root: string; relPath: string }> }).files.map((file) => {
          try {
            return { content: readNodeFile(file) };
          } catch {
            return { missing: true };
          }
        }),
      };
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

const vars = {
  remoteRepo: root,
  host: 'remote-batch.example',
  machine: 'remote-batch',
  sshTarget: 'remote-batch.example',
  slotId: 'slot-batch',
  projectName: 'farmslot',
  nodeRequest,
};

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => vars,
    resolveTaskPaths: async () => ({
      vars,
      taskDirName: '.task',
      taskDir,
      taskMdPath: path.join(taskDir, 'TASK.md'),
      signalPath: path.join(taskDir, 'SIGNAL.json'),
    }),
  },
});

mock.module('../fleet/state.js', {
  namedExports: {
    ...realFleetState,
    loadFleetStatus: async () => ({
      slots: [{ slot: 'slot-batch', taskFile: 'dev/demo', lifecycle: 'busy' }],
    }),
  },
});

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    getRun: () => undefined,
    listRuns: () => ({ runs: [] }),
  },
});

const { taskProgress } = await import('./task.js');

/** The connected node, declaring `batchReads` or not; reads go through `vars.nodeRequest`. */
let socket: WebSocket | undefined;
function connectNode(batchReads: boolean): void {
  if (socket) unregisterByWs(socket);
  socket = { readyState: 1 } as WebSocket;
  registerNode(
    vars.machine,
    1,
    socket,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      files: 1,
      ...(batchReads ? { batchReads: 1 as const } : {}),
    },
  );
}

test.after(() => {
  if (socket) unregisterByWs(socket);
  rmSync(root, { recursive: true, force: true });
});

mkdirSync(path.join(taskDir, 'subtasks'), { recursive: true });
writeFileSync(
  path.join(taskDir, 'CHECKLIST.md'),
  ['# Worker', '', '- [x] **1. read the ticket**', '- [ ] **2. run the review skill**', ''].join(
    '\n',
  ),
);
writeFileSync(
  path.join(taskDir, 'subtasks', 'index.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    units: [
      {
        id: 'review',
        parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
        checklist: 'subtasks/review.md',
        signal: 'subtasks/review-SIGNAL.json',
        source: { kind: 'skill', ref: 'skills/review.md', sha256: 'aa', renderedSha256: 'bb' },
        registeredAt: '2026-11-23T09:00:00Z',
      },
    ],
  })}\n`,
);
writeFileSync(
  path.join(taskDir, 'subtasks', 'review.md'),
  ['# Review', '', '- [x] **1. read the diff**', '- [ ] **2. write findings**', ''].join('\n'),
);

async function readCounted() {
  requests.length = 0;
  const result = await taskProgress({ slotId: 'slot-batch' });
  return { result, requests: [...requests] };
}

test('a remote progress read fetches its files in batches, with the same result', async () => {
  connectNode(false);
  const perFile = await readCounted();
  assert(!perFile.requests.includes('fs.readFiles'), 'an older node is asked file by file');
  assert.equal(perFile.result.structured?.completedSteps, 1);
  assert.equal(
    perFile.result.structured?.phases[0]?.steps[1]?.subtask?.progress.completedSteps,
    1,
    'the child unit is read',
  );

  connectNode(true);
  const batched = await readCounted();
  assert.deepEqual(
    batched.result,
    perFile.result,
    'the batched read returns what per-file reads return',
  );
  assert.deepEqual(
    batched.requests,
    ['fs.readFiles', 'fs.readFiles', 'fs.list'],
    `per-file: ${perFile.requests.join(', ')}`,
  );
  assert(batched.requests.length < perFile.requests.length);

  requests.length = 0;
  const summary = await taskProgress({ slotId: 'slot-batch', summary: true });
  assert.equal(summary.summary?.completedSteps, 1);
  assert.deepEqual(requests, ['fs.readFiles'], 'a summary reads its checklist in one request');
});
