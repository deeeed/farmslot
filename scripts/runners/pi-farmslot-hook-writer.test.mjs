import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  piMessageTokenUsage,
  piTurnFailure,
  runnerPromptDigest,
  writePiHook,
} from './pi-farmslot-hook-writer.mjs';

test('only nonzero native assistant usage advances the token clock within a turn', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-token-clock-'));
  t.after(() => fs.rmSync(obsDir, { recursive: true, force: true }));
  const input = { obsDir, sessionId: 'worker', env: { TMUX_PANE: '%7' } };
  const start = writePiHook({ ...input, event: 'UserPromptSubmit' });
  t.mock.timers.tick(300_000);
  const tool = writePiHook({ ...input, event: 'PostToolUse' });
  assert.equal(tool.lastTokenProgressAt, start.lastTokenProgressAt);
  const zero = piMessageTokenUsage({ role: 'assistant', usage: { totalTokens: 0 } });
  const failed = writePiHook({ ...input, event: 'TokenUsage', usageTokens: zero });
  assert.equal(failed.lastTokenProgressAt, start.lastTokenProgressAt);
  const usageTokens = piMessageTokenUsage({ role: 'assistant', usage: { totalTokens: 137 } });
  const usage = writePiHook({ ...input, event: 'TokenUsage', usageTokens });
  assert.equal(usage.lastTokenProgressAt, Date.now());
  assert.equal(usage.turnActive, true);
  assert.equal(piMessageTokenUsage({ role: 'toolResult', usage: { totalTokens: 100 } }), 0);
  assert.equal(writePiHook({ ...input, event: 'Stop' }).turnActive, false);
});

test('Pi session hooks retain the native transcript path through prompt and stop snapshots', (t) => {
  const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-hook-'));
  t.after(() => fs.rmSync(obsDir, { recursive: true, force: true }));
  const sessionId = '2026-10-28T12-56-59-228Z_pi-session';
  const transcriptPath = path.join(obsDir, `${sessionId}.jsonl`);
  writePiHook({
    obsDir,
    event: 'SessionStart',
    sessionId,
    transcriptPath,
    env: { TMUX_PANE: '%7' },
  });
  writePiHook({ obsDir, event: 'UserPromptSubmit', sessionId, env: { TMUX_PANE: '%7' } });
  writePiHook({ obsDir, event: 'Stop', sessionId, env: { TMUX_PANE: '%7' } });
  const session = JSON.parse(
    fs.readFileSync(path.join(obsDir, 'sessions', `${sessionId}.json`), 'utf8'),
  );
  const pane = JSON.parse(fs.readFileSync(path.join(obsDir, 'panes', '%257.json'), 'utf8'));
  assert.equal(session.transcript_path, transcriptPath);
  assert.equal(pane.transcript_path, transcriptPath);
  assert.equal(session.session_id, sessionId);
});

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

test('a failed native Pi turn retains its OAuth failure reason instead of a normal idle stop', (t) => {
  const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auth-failure-'));
  t.after(() => fs.rmSync(obsDir, { recursive: true, force: true }));
  const failure = 'OAuth refresh failed for anthropic: invalid_grant, refresh token expired';
  const record = writePiHook({
    obsDir,
    sessionId: 'pi-task',
    event: 'StopFailure',
    failure,
    env: { TMUX_PANE: '%fixture', FARMSLOT_RUNNER: 'pi' },
  });
  assert.equal(record.failure, failure);
  const panes = fs.readdirSync(path.join(obsDir, 'panes'));
  assert.equal(panes.length, 1);
  const stopped = JSON.parse(fs.readFileSync(path.join(obsDir, 'panes', panes[0]), 'utf8'));
  assert.equal(stopped.failure, failure);
  assert.equal(stopped.turnActive, false);
});

test('native failed outcomes retain the auth error and a later healthy turn clears it', () => {
  const failed = {
    role: 'assistant',
    stopReason: 'error',
    errorMessage: 'OAuth refresh failed for anthropic: invalid_grant',
  };
  assert.equal(piTurnFailure([failed]), failed.errorMessage);
  assert.equal(piTurnFailure([failed, { role: 'assistant', stopReason: 'stop' }]), null);
  assert.equal(piTurnFailure([{ role: 'user', content: 'error: not a runner outcome' }]), null);
});

test('Pi tool progress survives non-tool hooks without becoming a heartbeat', (t) => {
  const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tool-progress-'));
  t.after(() => fs.rmSync(obsDir, { recursive: true, force: true }));
  const base = { obsDir, sessionId: 'progress' };
  assert.equal(writePiHook({ ...base, event: 'UserPromptSubmit' }).lastToolProgressAt, null);
  const tool = writePiHook({ ...base, event: 'PreToolUse', toolName: 'bash' });
  assert.equal(tool.lastToolProgressAt, tool.observedAt);
  assert.equal(writePiHook({ ...base, event: 'Notification' }).lastToolProgressAt, tool.observedAt);
  assert.equal(writePiHook({ ...base, event: 'UserPromptSubmit' }).lastToolProgressAt, null);
});
