import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runnerPromptDigest, writePiHook } from './pi-farmslot-hook-writer.mjs';

test('UserPromptSubmit matches the gateway sentinel digest then Stop closes the turn', () => {
  const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-hook-writer-'));
  const prompt = 'Read TASK.md and execute.';
  const digest = runnerPromptDigest(prompt);
  const sentDir = path.join(obsDir, 'sent');
  fs.mkdirSync(sentDir, { recursive: true });
  fs.writeFileSync(
    path.join(sentDir, `${digest}.json`),
    `${JSON.stringify({ digest, sentAt: 1, prompt })}\n`,
  );

  const submit = writePiHook({
    obsDir,
    event: 'UserPromptSubmit',
    sessionId: 'sess-1',
    promptText: prompt,
    env: { FARMSLOT_RUNNER: 'pi', FARMSLOT_SLOT_ID: 'slot-1' },
  });
  assert.equal(submit.runnerPromptDigest, digest);
  assert.equal(submit.hook_event_name, 'UserPromptSubmit');
  assert.equal(submit.turnActive, true);
  assert.equal(submit.paneText, undefined);
  assert.equal(submit.runner, 'pi');

  const stop = writePiHook({
    obsDir,
    event: 'Stop',
    sessionId: 'sess-1',
    env: { FARMSLOT_RUNNER: 'pi', FARMSLOT_SLOT_ID: 'slot-1' },
  });
  assert.equal(stop.hook_event_name, 'Stop');
  assert.equal(stop.turnActive, false);
  assert.equal(stop.paneText, undefined);

  const lines = fs
    .readFileSync(path.join(obsDir, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].runnerPromptDigest, digest);
  assert.equal(lines[1].hook_event_name, 'Stop');
});
