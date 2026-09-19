import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

// mock.module replaces a module wholesale, so a partial namedExports map deletes
// every export the subject's import graph still needs. The namespace imports are
// evaluated before mock.module runs, so they hold the real modules; spreading
// them keeps every export real and overrides only what these tests fix.
import * as realConfig from '../core/config.js';
import * as realExec from '../core/exec.js';

let taskDir = '';
let execCalls: string[] = [];

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => ({
      remoteRepo: path.dirname(taskDir),
      host: 'localhost',
      machine: 'local',
      sshTarget: '',
      slotId: 'slot-subtask-contract',
      projectName: 'farmslot',
    }),
  },
});

mock.module('../core/exec.js', {
  namedExports: {
    ...realExec,
    // The remote checker is not the subject here: record that the gateway got
    // far enough to reach it, and report the prerequisite probe as missing so the
    // call returns without spawning anything.
    execOnSlot: async (_vars: unknown, command: string) => {
      execCalls.push(command);
      return { exitCode: 1, stdout: '', stderr: '' };
    },
  },
});

const { validateTerminalSignalArtifacts } = await import('./worker-terminal-contract.js');

const CHILD_MARKDOWN = '- [ ] **1. read the failing job output**\n';

/** Overwrite the registry with text that cannot be a registry. */
function corruptRegistry(dir: string, body: string): void {
  writeFileSync(path.join(dir, 'subtasks', 'index.json'), body);
}

function writeTaskDir(childStatus: string | null): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-subtask-contract-'));
  const dir = path.join(root, 'task');
  mkdirSync(path.join(dir, 'subtasks'), { recursive: true });
  writeFileSync(path.join(dir, 'CHECKLIST.md'), '- [x] **1. run the review skill**\n');
  writeFileSync(
    path.join(dir, 'subtasks', 'index.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      units: [
        {
          id: 'perps-review',
          parent: { checklist: 'CHECKLIST.md', stepNumber: 1 },
          checklist: 'subtasks/perps-review.md',
          signal: 'subtasks/perps-review-SIGNAL.json',
          source: { kind: 'skill', ref: 'skills/review.md', sha256: 'aa', renderedSha256: 'bb' },
          registeredAt: '2026-09-19T10:00:00Z',
        },
      ],
    })}\n`,
  );
  writeFileSync(path.join(dir, 'subtasks', 'perps-review.md'), CHILD_MARKDOWN);
  if (childStatus) {
    writeFileSync(
      path.join(dir, 'subtasks', 'perps-review-SIGNAL.json'),
      `${JSON.stringify({
        role: 'subtask',
        contextId: 'perps-review',
        parent: { checklist: 'CHECKLIST.md', stepNumber: 1 },
        status: childStatus,
        timestamp: '2026-09-19T10:05:00Z',
      })}\n`,
    );
  }
  return dir;
}

const TERMINAL_SIGNAL = {
  status: 'complete' as const,
  outcome: 'success' as const,
  timestamp: '2026-09-19T11:00:00Z',
};

test('a terminal signal with a running child is an artifact-contract failure', async () => {
  taskDir = writeTaskDir('running');
  execCalls = [];
  try {
    const result = await validateTerminalSignalArtifacts(
      'slot-subtask-contract',
      path.join(taskDir, 'SIGNAL.json'),
      TERMINAL_SIGNAL,
      path.join(taskDir, 'CHECKLIST.md'),
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'artifact');
    assert.match(result.ok === false ? result.message : '', /perps-review \(running\)/);
    assert.match(result.ok === false ? result.message : '', /\.\/mark sub perps-review complete/);
    // The refusal lands before the remote checker runs: a parent `complete`
    // written around the mark engine cannot pass by reaching an older node.
    assert.deepEqual(execCalls, []);
  } finally {
    rmSync(path.dirname(taskDir), { recursive: true, force: true });
  }
});

test('a blocked child also fails the terminal contract — blocked is not settled', async () => {
  taskDir = writeTaskDir('blocked');
  execCalls = [];
  try {
    const result = await validateTerminalSignalArtifacts(
      'slot-subtask-contract',
      path.join(taskDir, 'SIGNAL.json'),
      TERMINAL_SIGNAL,
      path.join(taskDir, 'CHECKLIST.md'),
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /perps-review \(blocked\)/);
  } finally {
    rmSync(path.dirname(taskDir), { recursive: true, force: true });
  }
});

test('a registered child with no signal file fails rather than passing unproven', async () => {
  taskDir = writeTaskDir(null);
  execCalls = [];
  try {
    const result = await validateTerminalSignalArtifacts(
      'slot-subtask-contract',
      path.join(taskDir, 'SIGNAL.json'),
      TERMINAL_SIGNAL,
      path.join(taskDir, 'CHECKLIST.md'),
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /perps-review \(no signal\)/);
  } finally {
    rmSync(path.dirname(taskDir), { recursive: true, force: true });
  }
});

test('a settled child lets the terminal check continue to the artifact checker', async () => {
  taskDir = writeTaskDir('complete');
  execCalls = [];
  try {
    const result = await validateTerminalSignalArtifacts(
      'slot-subtask-contract',
      path.join(taskDir, 'SIGNAL.json'),
      TERMINAL_SIGNAL,
      path.join(taskDir, 'CHECKLIST.md'),
    );
    // The mocked prerequisite probe reports the checker missing, which is the
    // infrastructure branch — proof the open-child gate did not short-circuit.
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.kind, 'infrastructure');
    assert.equal(execCalls.length, 1);
    assert.match(execCalls[0], /check-task-artifact-contract\.mjs/);
  } finally {
    rmSync(path.dirname(taskDir), { recursive: true, force: true });
  }
});

test('a non-terminal signal is not gated on children at all', async () => {
  taskDir = writeTaskDir('running');
  execCalls = [];
  try {
    const result = await validateTerminalSignalArtifacts(
      'slot-subtask-contract',
      path.join(taskDir, 'SIGNAL.json'),
      { status: 'running', timestamp: '2026-09-19T11:00:00Z' },
      path.join(taskDir, 'CHECKLIST.md'),
    );
    assert.equal(result.ok, true);
  } finally {
    rmSync(path.dirname(taskDir), { recursive: true, force: true });
  }
});

test('an unreadable registry is an artifact-contract failure, not an unhandled error', async () => {
  for (const [label, body] of [
    ['not JSON', 'not json at all\n'],
    ['wrong shape', '{"schemaVersion":9,"units":[]}\n'],
    ['a bad unit', '{"schemaVersion":1,"units":[{"id":"BAD ID"}]}\n'],
  ] as const) {
    taskDir = writeTaskDir('complete');
    corruptRegistry(taskDir, body);
    execCalls = [];
    try {
      const result = await validateTerminalSignalArtifacts(
        'slot-subtask-contract',
        path.join(taskDir, 'SIGNAL.json'),
        TERMINAL_SIGNAL,
        path.join(taskDir, 'CHECKLIST.md'),
      );
      assert.equal(result.ok, false, `${label} must be a verdict, not a throw`);
      assert.equal(result.ok === false && result.kind, 'artifact');
      const message = result.ok === false ? result.message : '';
      // Names the file, carries the parse reason, and tells the worker who owns it.
      assert.match(message, /subtasks\/index\.json/, label);
      assert.match(message, /Only `mark sub` writes this file/, label);
      assert.match(message, /run \.\/mark complete again/, label);
      // The remote checker is never reached: completion cannot be proven.
      assert.deepEqual(execCalls, [], label);
    } finally {
      rmSync(path.dirname(taskDir), { recursive: true, force: true });
    }
  }
});
