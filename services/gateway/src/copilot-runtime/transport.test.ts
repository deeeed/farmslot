import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { testController } from './test-helpers.js';

test('chat transport reports accepted, deferred, and failed delivery without TUI parsing', async () => {
  for (const [outcome, expected] of [
    [true, 'accepted'],
    [false, 'deferred'],
  ] as const) {
    const home = await mkdtemp(path.join(tmpdir(), `copilot-transport-${expected}-`));
    const { controller } = testController({
      home,
      checkout: process.cwd(),
      sendInstruction: async () => outcome,
    });
    await controller.start({ runner: 'cursor', model: 'test-model' });
    const result = await controller.send({ sessionId: 'global', message: `deliver-${expected}` });
    assert.equal(result.delivery?.state, expected);
    await controller.stop({ reason: 'test-complete' });
  }

  const home = await mkdtemp(path.join(tmpdir(), 'copilot-transport-failed-'));
  const { controller } = testController({
    home,
    checkout: process.cwd(),
    sendInstruction: async () => {
      throw new Error('transport unavailable');
    },
  });
  await controller.start({ runner: 'cursor', model: 'test-model' });
  const failed = await controller.send({ sessionId: 'global', message: 'deliver-failed' });
  assert.equal(failed.delivery?.state, 'failed');
  assert.match(failed.delivery?.reason ?? '', /transport unavailable/);
  await controller.stop({ reason: 'test-complete' });
});

test('abort uses the injected registered capability and production imports safe transport', async () => {
  let interrupted = 0;
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-abort-'));
  const { controller } = testController({
    home,
    checkout: process.cwd(),
    interrupt: async () => {
      interrupted += 1;
      return true;
    },
  });
  await controller.start({ runner: 'cursor', model: 'test-model' });
  assert.deepEqual(await controller.abort(), { ok: true });
  assert.equal(interrupted, 1);
  await controller.stop({ reason: 'test-complete' });

  const source = await readFile(new URL('./controller.ts', import.meta.url), 'utf8');
  assert.match(source, /sendRunnerInstructionSafely/);
  assert.match(source, /interruptRunnerTurn/);
  assert.doesNotMatch(source, /runner\s*===|['"]claude['"]|['"]codex['"]|['"]grok['"]/);
});
