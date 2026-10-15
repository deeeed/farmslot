import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

await import('../runtime/mock-pty.test-support.js');
const { buildCursorTurnProbeCommand, readCursorTurnState } =
  await import('./cursor-observability.js');
const { makeVars } = await import('./test-fixtures.js');
const { readRunProgress } = await import('./run-progress.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');

const turnEvent = (message: string, request: string, outcome?: string) =>
  '[2026-10-15T13:37:20.201Z] structured-log.info ' +
  JSON.stringify({
    key: 'agent_cli',
    message: `agent_cli.turn.${message}`,
    metadata: { request_id: request, ...(outcome ? { outcome } : {}) },
  }) +
  '\n';
const complete = turnEvent('start', 'turn-1') + turnEvent('outcome', 'turn-1', 'success');
const cases = [
  { name: 'successful native turn', text: complete, state: 'idle' },
  { name: 'later native start', text: complete + turnEvent('start', 'turn-2'), state: 'active' },
  { name: 'partial native write', text: complete + '[partial', state: null },
  { name: 'terminal text without native records', text: 'Ready for instructions\n', state: null },
  { name: 'unknown native outcome', text: turnEvent('outcome', 'turn-1', 'unknown'), state: null },
  {
    name: 'history beyond the read ceiling',
    text: complete + 'x'.repeat(8 * 1024 * 1024) + '\n',
    state: null,
  },
  { name: 'foreign process header', text: complete, state: null, pid: 999 },
];
for (const scenario of cases) {
  test(`Cursor lifecycle: ${scenario.name}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-native-turn-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const logs = path.join(root, 'cursor-agent-logs-test');
    await mkdir(logs);
    const log = path.join(logs, 'session-test-123-1.log');
    const header =
      JSON.stringify({ event: 'debug-session-start', pid: scenario.pid ?? 123, logFile: log }) +
      '\n';
    await writeFile(log, header + scenario.text);
    const result = JSON.parse(
      execFileSync('bash', ['-c', buildCursorTurnProbeCommand('123', log)], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      }),
    );
    assert.equal(result?.state ?? null, scenario.state);
    if (scenario.state) {
      assert.equal(result.observedAt, Date.parse('2026-10-15T13:37:20.201Z'));
      assert.equal(result.turnToken, scenario.state === 'idle' ? '123:turn-1' : '123:turn-2');
    }
  });
}

test('Cursor idle is bound to the current pane-owned process and reaches run progress', async () => {
  const vars = makeVars();
  const pane = { paneId: '%1', panePid: '10' };
  const readers = {
    pane: async () => pane,
    process: async () => ({ state: 'present' as const, pid: '123' }),
    exec: async (_vars: unknown, command: string) => ({
      exitCode: 0,
      stdout: command.includes('LSOF_BIN=')
        ? 'p123\nn/tmp/cursor-agent-logs-test/session-test-123-1.log\n'
        : JSON.stringify({
            state: 'idle',
            observedAt: 1000,
            turnToken: '123:turn-1',
          }),
      stderr: '',
    }),
  };
  const reading = await readCursorTurnState(vars, '%1', readers);
  assert.equal(reading?.value, 'idle');
  assert.equal(reading?.confidence, 'high');
  const run = {
    ...makeRun(),
    agentContexts: [
      {
        id: 'dev',
        role: 'dev' as const,
        runId: 'run-1',
        slotId: 'slot-1',
        label: 'Dev',
        runner: 'cursor',
        status: 'waiting' as const,
        target: { target: '%1', session: 'owned' },
      },
    ],
  };
  assert.equal(
    (
      await readRunProgress(run, {
        slot: async () => vars,
        target: async () => ({ target: '%1', session: 'owned' }),
        activity: async () => null,
        turn: async () => reading,
      })
    ).kind,
    'idle',
  );
  let probes = 0;
  assert.equal(
    await readCursorTurnState(vars, '%1', {
      ...readers,
      process: async () => ({ state: 'present', pid: ++probes === 1 ? '123' : '124' }),
    }),
    null,
  );
  assert.equal(
    await readCursorTurnState(vars, '%1', {
      ...readers,
      process: async () => ({ state: 'unknown', code: 'probe-timeout', reason: 'timeout' }),
    }),
    null,
  );
});
