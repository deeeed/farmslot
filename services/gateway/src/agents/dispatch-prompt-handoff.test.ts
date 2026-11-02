// F331: recovery asks the runner's own evidence whether an interrupted DISPATCH's prompt arrived.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

// Imported after the mocks below: these fixtures load the real probe's modules.
const SENT_AT = '2026-11-02T14:03:52.000Z';
const SENT_AT_MS = Date.parse(SENT_AT);
const SIGNAL_PATH = 'tasks/fix/SIGNAL.json';
const PROMPT = 'demo: read tasks/fix/TASK.md';
let hooks: string;
let signal: string | undefined;
const fileWrites: string[] = [];

const execution = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: async (_vars: unknown, command: string) => {
      const stdout = command.includes(SIGNAL_PATH)
        ? signal === undefined
          ? '__FARMSLOT_SIGNAL_MISSING__\n'
          : `1788000000000000000\n${signal}`
        : command.includes('hooks.jsonl')
          ? hooks
          : command.includes('list-panes')
            ? '%7\n'
            : '';
      return { exitCode: 0, stdout, stderr: '' };
    },
  },
});
const slotIo = await import('../core/slot-io.js');
mock.module('../core/slot-io.js', {
  namedExports: {
    ...slotIo,
    slotWriteFiles: async (_vars: unknown, dir: string, files: Array<{ path: string }>) => {
      fileWrites.push(...files.map((file) => `${dir}/${file.path}`));
    },
  },
});
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => makeVars({ slotId: 'slot-1', projectName: 'demo' }),
    resolveProjectRuntimeDir: async () => 'runtime',
  },
});
const prompts = await import('../runners/worker-prompt.js');
mock.module('../runners/worker-prompt.js', {
  namedExports: {
    ...prompts,
    resolveWorkerDispatchPrompt: async (project: string, vars: { taskFile: string }) =>
      `${project}: read ${vars.taskFile}`,
  },
});
const { makeRun } = await import('../run-engine/test-fixtures.js');
const { runnerPromptDigest } = await import('../runners/observability-prompt-digest.js');
const { workerDispatchPrompt } = await import('../runners/registry.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const { dispatchPromptHandoffProven } = await import('./runtime-recovery.js');

const worker: AgentContext = {
  id: 'fix-bug',
  role: 'fix-bug',
  label: 'Worker',
  status: 'working',
  slotId: 'slot-1',
  runId: 'run-f331',
  runner: 'claude',
  promptDeliveryStartedAt: SENT_AT,
  taskFile: 'tasks/fix/TASK.md',
  signalFile: SIGNAL_PATH,
  target: { session: 'slot-1', window: 'worker', pane: null, target: 'slot-1:worker' },
};
const run = makeRun({ id: 'run-f331', flowType: 'fix-bug', slotId: 'slot-1' });

function promptHook(observedAt: number, message = PROMPT): string {
  return `${JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    observedAt,
    tmuxPane: '%7',
    session_id: 'session-1',
    runnerPromptDigest: runnerPromptDigest(message),
  })}\n`;
}

function arrange(state: { hooks?: string; signal?: string }): void {
  hooks = state.hooks ?? '';
  signal = state.signal;
}

const signalAt = (timestamp: string) => JSON.stringify({ status: 'complete', timestamp });

test('a hook digest of the exact prompt at or after the marker is proof', async () => {
  arrange({ hooks: promptHook(SENT_AT_MS + 1_000) });
  assert.equal(await dispatchPromptHandoffProven(run, worker), true);
});

test('a digest from before the marker, or of another prompt, is not', async () => {
  arrange({ hooks: promptHook(SENT_AT_MS - 1_000) });
  assert.equal(await dispatchPromptHandoffProven(run, worker), false);
  arrange({ hooks: promptHook(SENT_AT_MS + 1_000, 'another prompt') });
  assert.equal(await dispatchPromptHandoffProven(run, worker), false);
});

test('a signal this attempt wrote is proof; an earlier attempt left over is not', async () => {
  arrange({ signal: signalAt(new Date(SENT_AT_MS + 1_000).toISOString()) });
  assert.equal(await dispatchPromptHandoffProven(run, worker), true);
  arrange({ signal: signalAt(new Date(SENT_AT_MS - 1_000).toISOString()) });
  assert.equal(await dispatchPromptHandoffProven(run, worker), false);
  arrange({ signal: JSON.stringify({ status: 'complete' }) });
  assert.equal(await dispatchPromptHandoffProven(run, worker), false, 'no timestamp, no proof');
});

test('no evidence, and a worker with nothing to probe, is not proof', async () => {
  arrange({});
  assert.equal(await dispatchPromptHandoffProven(run, worker), false);
  arrange({ hooks: promptHook(SENT_AT_MS + 1_000) });
  assert.equal(await dispatchPromptHandoffProven(run, { ...worker, target: undefined }), false);
  assert.equal(await dispatchPromptHandoffProven(run, { ...worker, taskFile: undefined }), false);
});

test('recovery derives the exact prompt dispatch types, without writing to the slot', async () => {
  const vars = makeVars({ slotId: 'slot-1', projectName: 'demo' });
  const task = { taskFile: 'tasks/fix/TASK.md', taskDir: 'tasks/fix' };
  for (const runner of ['claude', 'codex']) {
    fileWrites.length = 0;
    const derived = await workerDispatchPrompt(vars, runner, task, { materialize: false });
    assert.deepEqual(fileWrites, [], runner);
    assert.equal(
      derived,
      await workerDispatchPrompt(vars, runner, task, { materialize: true }),
      runner,
    );
  }
  assert.equal(fileWrites.length, 1, 'only dispatch writes the file-backed prompt');
  assert.match(fileWrites[0]!, /tasks\/fix\/DISPATCH-PROMPT\.md$/);
});

test('the probe writes nothing for a file-backed prompt', async () => {
  arrange({});
  fileWrites.length = 0;
  await dispatchPromptHandoffProven(run, { ...worker, runner: 'codex' });
  assert.deepEqual(fileWrites, []);
});
