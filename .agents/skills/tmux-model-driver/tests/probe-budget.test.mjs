import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCodexSessionBindingProbeCommand,
  parseCodexSessionBindingProbe,
} from '../../../../services/gateway/src/runners/codex-observability.ts';
import { nativeProbeTimeoutMs, nativeState } from '../scripts/native-evidence.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-probe-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const at = new Date().toISOString();
  const files = [];
  for (let i = 0; i < 8; i++) {
    const file = path.join(root, `rollout-${i}.jsonl`);
    const source = i === 0 ? 'cli' : { subagent: { parent_thread_id: 'parent' } };
    fs.writeFileSync(
      file,
      JSON.stringify({ type: 'session_meta', payload: { id: `session-${i}`, source } }) + '\n',
    );
    files.push(file);
  }
  fs.appendFileSync(
    files[0],
    JSON.stringify({
      type: 'event_msg',
      timestamp: at,
      payload: { type: 'task_started', turn_id: 'live-turn' },
    }) + '\n',
  );
  return { root, files };
}

test('one shell probe reads only large rollout headers', (t) => {
  const { files } = fixture(t);
  for (const file of files) {
    const fd = fs.openSync(file, 'r+');
    fs.ftruncateSync(fd, 64 * 1024 * 1024);
    fs.closeSync(fd);
  }
  const probe = (paths) =>
    parseCodexSessionBindingProbe(
      cp.execFileSync(
        'bash',
        ['-c', buildCodexSessionBindingProbeCommand(paths, undefined, true)],
        { encoding: 'utf8' },
      ),
    );
  const bound = probe(files);
  assert.equal(bound.status, 'matched');
  assert.equal(bound.sessionId, 'session-0');
  assert.equal(bound.sessionPath, fs.realpathSync(files[0]));
});

test('a header batch rejects ambiguous parent ownership', (t) => {
  const { files } = fixture(t);
  fs.writeFileSync(
    files[1],
    JSON.stringify({ type: 'session_meta', payload: { id: 'other-parent', source: 'cli' } }) + '\n',
  );
  const raw = cp.execFileSync(
    'bash',
    ['-c', buildCodexSessionBindingProbeCommand(files, undefined, true)],
    { encoding: 'utf8' },
  );
  assert.equal(parseCodexSessionBindingProbe(raw).status, 'unavailable');
});

test('pane and send native preflight share one binding subprocess and the configured budget', (t) => {
  const { root, files } = fixture(t);
  const saved = process.env.TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS;
  process.env.TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS = '12345';
  const calls = [];
  const spy = t.mock.method(cp, 'execFileSync', (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'bash' && args[1].includes('lsof'))
      return files.map((file) => `n${file}`).join('\n');
    if (command === 'bash' && args[1].includes('root_only'))
      return JSON.stringify({ status: 'matched', sessionId: 'session-0', sessionPath: files[0] });
    if (command === 'bash' && args[1].includes('reverse_lines'))
      return JSON.stringify({
        status: 'matched',
        state: 'active',
        turnId: 'live-turn',
        observedAt: Date.now(),
      });
    assert.fail('Unexpected probe');
  });
  syncBuiltinESMExports();
  try {
    const state = nativeState(
      { pane_id: '%1', process_started_at: 1, runner_pids: ['123'] },
      'codex',
      root,
    );
    assert.equal(state.session_id, 'session-0');
    assert.equal(state.phase, 'busy');
    assert.equal(state.turn_token, 'live-turn');
    assert.equal(calls.length, 3, 'open files, one header batch, and turn state only');
    assert.ok(calls.every((call) => call.options.timeout === 12345));
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    if (saved === undefined) delete process.env.TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS;
    else process.env.TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS = saved;
  }
});

test('native probe budget defaults independently of send verification and rejects invalid values', () => {
  const saved = process.env.TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS;
  try {
    delete process.env.TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS;
    assert.equal(nativeProbeTimeoutMs(), 10000);
    for (const value of ['', '0', '-1', 'NaN', '1.5', '2147483648']) {
      process.env.TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS = value;
      assert.throws(nativeProbeTimeoutMs, /positive integer/);
    }
  } finally {
    if (saved === undefined) delete process.env.TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS;
    else process.env.TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS = saved;
  }
});
