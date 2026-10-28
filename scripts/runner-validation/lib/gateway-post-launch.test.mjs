import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { mock, test } from 'node:test';

let snippet;
mock.module('node:child_process', {
  namedExports: {
    spawnSync(_command, args) {
      snippet = args.at(-1);
      return { status: 0, stdout: '{"state":null}\n', stderr: '' };
    },
    execFileSync() {
      throw new Error('Pure guard test must not start a process');
    },
  },
});
const { runGatewayTurnState } = await import('./gateway-post-launch.mjs');
const { dispatchSmokeLaunchCommand } = await import('../scenarios/dispatch-prompt-smoke.mjs');
const claudeAdapter = await import('../runners/claude.mjs');
const codexAdapter = await import('../runners/codex.mjs');

test('a model option never becomes a Claude initial prompt', (t) => {
  t.mock.method(fs, 'existsSync', () => true);
  const command = dispatchSmokeLaunchCommand(claudeAdapter, '/private-proof', 'sonnet');
  assert.match(command, /--model 'opus'/);
  assert.doesNotMatch(command, /'sonnet'/);
});

test('the Codex adapter receives the explicitly selected model', (t) => {
  t.mock.method(fs, 'existsSync', () => true);
  const command = dispatchSmokeLaunchCommand(codexAdapter, '/private-proof', 'gpt-5.6-terra');
  assert.match(command, /--model 'gpt-5\.6-terra'/);
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const prompt = 'Read "temp/tasks/long-task-path/DISPATCH-PROMPT.md" and follow its instructions.';
const acceptance = {
  value: true,
  exactPromptMatch: true,
  source: 'signal',
  confidence: 'high',
  observedAt: 100,
  sessionId: 'session-1',
  turnToken: 'session-1:turn-2',
};
const turn = {
  value: 'idle',
  source: 'signal',
  confidence: 'high',
  observedAt: 200,
  turnToken: 'session-1:turn-2',
};

async function evaluate(ack, state) {
  runGatewayTurnState({
    repo: '/private-proof',
    target: '%701',
    runner: 'codex',
    prompt,
    sinceMs: 90,
  });
  const body = snippet.replace(/^import .*;$/gm, '');
  let result;
  await new AsyncFunction('os', 'getRunnerObservability', 'readRunnerTurnState', 'process', body)(
    os,
    () => ({
      async getSessionBinding(_vars, target) {
        assert.equal(target, '%701');
        return { sessionId: 'session-1', sessionPath: '/private-proof/session.jsonl' };
      },
      async promptAcceptedInSession(_vars, target, id, file, text, since) {
        assert.equal(target, '%701');
        assert.equal(id, 'session-1');
        assert.equal(file, '/private-proof/session.jsonl');
        assert.equal(text, prompt);
        assert.equal(since, 90);
        return ack;
      },
    }),
    async (_vars, target, runner, expectedTurn) => {
      assert.equal(target, '%701');
      assert.equal(runner, 'codex');
      assert.equal(expectedTurn, ack?.turnToken);
      return state;
    },
    {
      stdout: {
        write(raw) {
          result = JSON.parse(raw).state;
        },
      },
    },
  );
  return result;
}

test('native completion uses the exact full prompt and the same acknowledged turn', async () => {
  assert.deepEqual(await evaluate(acceptance, turn), { ...turn, acceptance });
});
for (const [name, ack, state] of [
  ['missing acceptance', null, turn],
  ['prefix-only acknowledgement', { ...acceptance, exactPromptMatch: false }, turn],
  ['unverified acknowledgement', { ...acceptance, confidence: 'low' }, turn],
  ['pane evidence', { ...acceptance, source: 'pane' }, turn],
  [
    'missing turn identity',
    { ...acceptance, turnToken: undefined },
    { ...turn, turnToken: undefined },
  ],
  ['another completed turn', acceptance, { ...turn, turnToken: 'session-1:turn-3' }],
]) {
  test(`native completion refuses ${name}`, async () =>
    assert.equal(await evaluate(ack, state), null));
}
