import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AgentContext, Run } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';

import type { RunnerTaskProgressInput, SlotVars } from './observability-types.js';

await import('../runtime/mock-pty.test-support.js');
const { readScriptedCommandProgress } = await import('./scripted-progress.js');
const { readRunProgress } = await import('./run-progress.js');
const { readRunnerTaskProgress } = await import('./registry.js');

interface ReceiptFixture extends RunnerTaskProgressInput {
  run: Run;
  context: AgentContext;
  result: Record<string, unknown>;
  provenance: Record<string, unknown>;
  signal: Record<string, unknown>;
  resultTime: number;
  missing?: string;
  malformed?: boolean;
}

async function fixture() {
  const repo = await mkdtemp(path.join(tmpdir(), 'scripted-progress-'));
  const context: AgentContext = {
    id: 'primary',
    role: 'primary',
    runId: 'run-1',
    slotId: 'slot-1',
    label: 'Command',
    runner: 'scripted',
    status: 'waiting',
    taskFile: 'tasks/current/TASK.md',
    signalFile: 'tasks/current/SIGNAL.json',
    target: { target: '%owned', session: 'owned' },
  };
  const signal = {
    status: 'complete',
    outcome: 'success',
    timestamp: '2026-10-14T00:00:03.000Z',
  };
  const run: Run = {
    ...makeRun({
      project: 'command-project',
      steps: [
        { name: 'dispatch', status: 'done', startedAt: '2026-10-14T00:00:00.000Z' },
        {
          name: 'monitor',
          status: 'done',
          outputs: { workerSignal: { ...signal, role: 'primary', contextId: 'primary' } },
        },
      ],
    }),
    scripted: { mode: 'command', commandRef: 'verify' },
    agentContexts: [context],
  };
  const binding = { project: run.project, commandRef: 'verify', cwd: path.join(repo, 'app') };
  return {
    run,
    context,
    vars: {
      remoteRepo: repo,
      slotId: 'slot-1',
      projectName: run.project,
      host: 'localhost',
      machine: 'local',
    } as SlotVars,
    result: { ...binding, exitCode: 0, signal: null, timedOut: false },
    provenance: {
      ...binding,
      kind: 'farmslot-scripted-runner',
      mode: 'command',
      startedAt: '2026-10-14T00:00:01.000Z',
    },
    signal,
    resultTime: Date.parse('2026-10-14T00:00:02.000Z'),
  } satisfies ReceiptFixture;
}

async function writeReceipts(f: ReceiptFixture) {
  const dir = path.join(f.vars.remoteRepo, 'tasks/current');
  await mkdir(path.join(dir, 'artifacts'), { recursive: true });
  for (const [file, value] of [
    ['artifacts/scripted-command-result.json', f.result],
    ['artifacts/scripted-runner-provenance.json', f.provenance],
    ['SIGNAL.json', f.signal],
  ] as const) {
    if (file === f.missing) continue;
    await writeFile(
      path.join(dir, file),
      f.malformed && file.endsWith('result.json') ? '{' : JSON.stringify(value),
    );
  }
  if (f.missing !== 'artifacts/scripted-command-result.json') {
    await utimes(
      path.join(dir, 'artifacts/scripted-command-result.json'),
      f.resultTime / 1000,
      f.resultTime / 1000,
    );
  }
}

const declaredCommand = async () => ({ command: 'node verify.mjs', cwd: 'app' });

test('current successful command receipt proves idle with its declared cwd', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.vars.remoteRepo, { recursive: true, force: true }));
  await writeReceipts(f);
  assert.equal(await readScriptedCommandProgress(f, declaredCommand), 'idle');
  const progress = await readRunProgress(f.run, {
    slot: async () => f.vars,
    taskProgress: (input) => readScriptedCommandProgress(input, declaredCommand),
    target: async () => {
      throw new Error('Command receipt must not inspect tmux');
    },
  });
  assert.equal(progress.kind, 'idle');
});

const invalidCases: Array<[string, (f: ReceiptFixture) => void]> = [
  [
    'signal alone',
    (f) => {
      f.missing = 'artifacts/scripted-command-result.json';
    },
  ],
  [
    'missing provenance',
    (f) => {
      f.missing = 'artifacts/scripted-runner-provenance.json';
    },
  ],
  [
    'missing actual signal',
    (f) => {
      f.missing = 'SIGNAL.json';
    },
  ],
  [
    'malformed result',
    (f) => {
      f.malformed = true;
    },
  ],
  [
    'previous invocation',
    (f) => {
      f.provenance.startedAt = '2026-10-13T23:59:59.000Z';
    },
  ],
  [
    'result left by previous invocation',
    (f) => {
      f.resultTime = Date.parse('2026-10-14T00:00:00.000Z');
    },
  ],
  [
    'result newer than signal',
    (f) => {
      f.resultTime = Date.parse('2026-10-14T00:00:04.000Z');
    },
  ],
  [
    'stale monitor signal',
    (f) => {
      f.signal.timestamp = '2026-10-14T00:00:03.001Z';
    },
  ],
  [
    'wrong command',
    (f) => {
      f.result.commandRef = 'other';
    },
  ],
  [
    'wrong project',
    (f) => {
      f.provenance.project = 'other';
    },
  ],
  [
    'wrong checkout',
    (f) => {
      f.result.cwd = f.vars.remoteRepo;
    },
  ],
  [
    'wrong context',
    (f) => {
      f.signal.contextId = 'other';
    },
  ],
  [
    'wrong role',
    (f) => {
      f.signal.role = 'review';
    },
  ],
  [
    'nonzero exit',
    (f) => {
      f.result.exitCode = 1;
    },
  ],
  [
    'signal termination',
    (f) => {
      f.result.signal = 'SIGTERM';
    },
  ],
  [
    'timeout',
    (f) => {
      f.result.timedOut = true;
    },
  ],
  [
    'unfinished monitor',
    (f) => {
      f.run.steps[1].status = 'running';
    },
  ],
  [
    'missing dispatch start',
    (f) => {
      delete f.run.steps[0].startedAt;
    },
  ],
  [
    'wrong slot',
    (f) => {
      f.context.slotId = 'other';
    },
  ],
];

for (const [name, invalidate] of invalidCases) {
  test(`${name} remains unproven through aggregate progress`, async (t) => {
    const f: ReceiptFixture = await fixture();
    t.after(() => rm(f.vars.remoteRepo, { recursive: true, force: true }));
    invalidate(f);
    await writeReceipts(f);
    const progress = await readRunProgress(f.run, {
      slot: async () => f.vars,
      taskProgress: (input) => readScriptedCommandProgress(input, declaredCommand),
    });
    assert.equal(progress.kind, 'unproven');
  });
}

test('command idle cannot override an active or uncertain sibling', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.vars.remoteRepo, { recursive: true, force: true }));
  await writeReceipts(f);
  f.run.agentContexts!.push({
    ...f.context,
    id: 'review',
    role: 'review',
    runner: 'codex',
    status: 'working',
  });
  for (const active of [true, false]) {
    const progress = await readRunProgress(f.run, {
      slot: async () => f.vars,
      taskProgress: (input) =>
        input.context?.id === 'primary'
          ? readScriptedCommandProgress(input, declaredCommand)
          : Promise.resolve(null),
      target: async () => ({ target: '%review', session: 'owned' }),
      activity: async () =>
        active
          ? { value: 'tool-running', source: 'hook', confidence: 'high', observedAt: 1 }
          : null,
      turn: async () => null,
    });
    assert.equal(progress.kind, active ? 'making-progress' : 'unproven');
  }
});

test('scenario mode and ordinary runners preserve their observation path', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.vars.remoteRepo, { recursive: true, force: true }));
  f.run.scripted = { mode: 'scenario', scenario: 'success' };
  assert.equal(await readScriptedCommandProgress(f, declaredCommand), null);
  assert.equal(await readRunnerTaskProgress(f), null);
  f.context.runner = 'codex';
  assert.equal(await readRunnerTaskProgress(f), null);
});
