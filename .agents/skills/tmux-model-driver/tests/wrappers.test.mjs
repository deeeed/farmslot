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

test('wrapper resolves source aliases from its checkout, not the caller config', () => {
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-source-alias-'));
  try {
    const checkout = path.join(caller, 'checkout');
    const driver = path.join(checkout, '.agents/skills/tmux-model-driver/scripts');
    const gateway = path.join(checkout, 'services/gateway');
    fs.mkdirSync(driver, { recursive: true });
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(checkout, 'package.json'), '{"type":"module"}');
    fs.symlinkSync(
      path.resolve(scripts, '../../../../node_modules'),
      path.join(checkout, 'node_modules'),
    );
    fs.copyFileSync(path.join(scripts, 'run-driver.sh'), path.join(driver, 'run-driver.sh'));
    fs.writeFileSync(path.join(gateway, 'source.ts'), "export const owner = 'checkout';\n");
    fs.writeFileSync(
      path.join(gateway, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { paths: { '@driver-test/source': ['./source.ts'] } },
      }),
    );
    fs.writeFileSync(path.join(caller, 'tsconfig.json'), '{}');
    fs.writeFileSync(
      path.join(driver, 'driver.mjs'),
      "import { owner } from '@driver-test/source'; process.stdout.write(owner);\n",
    );
    const result = spawnSync('bash', [path.join(driver, 'run-driver.sh'), 'state'], {
      cwd: caller,
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(caller, 'tsconfig.json') },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'checkout');
  } finally {
    fs.rmSync(caller, { recursive: true });
  }
});
