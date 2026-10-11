import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');
for (const [file, args, input, expected, status] of [
  ['pane-state.sh', ['%fixture', 'claude'], '', 'shell', 0],
  ['send-and-verify.sh', ['%fixture', 'claude'], 'prompt', 'wrong_runner', 2],
  ['answer-question.sh', ['%fixture', 'claude', 'fingerprint'], '["Enter"]', 'wrong_runner', 2],
  ['flush-queued.sh', ['%fixture', 'claude'], 'prompt', 'wrong_runner', 2],
  ['ack-acceptance.sh', ['%fixture', 'claude', 'receipt'], '', 'wrong_runner', 2],
]) {
  test(`${file} resolves the checkout loader from an unrelated caller directory`, () => {
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-wrapper-test-'));
    try {
      const env = {
        ...process.env,
        TMUX_PANE_STATE_CURRENT_COMMAND: 'bash',
        TMUX_PANE_STATE_CURRENT_PATH: caller,
        TMUX_PANE_STATE_SESSION_NAME: 'fixture',
        TMUX_PANE_STATE_PANE_TITLE: '',
        TMUX_PANE_STATE_PANE_PID: '',
        TMUX_PANE_STATE_TAIL_CAPTURE: '',
        TMUX_MODEL_DRIVER_STATE_DIR: path.join(caller, 'state'),
      };
      const result = spawnSync('bash', [path.join(scripts, file), ...args], {
        cwd: caller,
        env,
        input,
        encoding: 'utf8',
      });
      assert.equal(result.status, status, result.stderr);
      const json = JSON.parse(result.stdout);
      assert.equal(json.verification || json.state, expected);
    } finally {
      fs.rmSync(caller, { recursive: true });
    }
  });
}
