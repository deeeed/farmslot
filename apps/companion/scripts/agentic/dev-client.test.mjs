import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { preparedDevMenuPreferences } from './prepare-dev-client.mjs';
import { devClientUrl } from './simulator-dev-client.mjs';

test('dev-client launch binds Metro and skips first-run onboarding', () => {
  const url = new URL(devClientUrl('http://localhost:41234'));
  assert.equal(url.searchParams.get('url'), 'http://localhost:41234');
  assert.equal(url.searchParams.get('disableOnboarding'), '1');
});

test('dev-menu preparation preserves other preferences and is idempotent', () => {
  const before =
    '<map><boolean name="showFab" value="true" /><boolean name="touchGestureEnabled" value="true" /></map>';
  const after = preparedDevMenuPreferences(before);
  assert(after.includes('<boolean name="showFab" value="false" />'));
  assert(after.includes('<boolean name="touchGestureEnabled" value="true" />'));
  assert(after.includes('<boolean name="isOnboardingFinished" value="true" />'));
  assert(after.includes('<boolean name="showsAtLaunch" value="false" />'));
  assert.equal(preparedDevMenuPreferences(after), after);
  assert(preparedDevMenuPreferences('<map />').includes('isOnboardingFinished'));
});

test('recipe wrapper requests prompt provider-owned idle cleanup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-recipe-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'recipe');
  fs.writeFileSync(
    executable,
    `#!${process.execPath}\nconsole.log(JSON.stringify({runner:process.env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS,daemon:process.env.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS,args:process.argv.slice(2)}));\n`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    'bash',
    [fileURLToPath(new URL('./run-recipe.sh', import.meta.url)), 'manifest'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FARMSLOT_SLOT_ID: '',
        METRO_PORT: '41234',
        GATEWAY_PORT: '41235',
        COMPANION_ADAPTER_RN_BIN: executable,
      },
      timeout: 3000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    runner: '100',
    daemon: '10000',
    args: ['manifest'],
  });
});

test('Metro lease clears inherited CI and replaces its legacy non-watching session', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, '.agent'));
  const state = path.join(root, 'session');
  const receipt = path.join(root, 'receipt.json');
  fs.writeFileSync(state, 'legacy');
  fs.writeFileSync(path.join(root, '.agent/metro-41234.env'), 'legacy non-watching marker');
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/bash\n[[ -f "$WATCH_TEST_STATE" ]]\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    `#!/bin/bash
case "$1" in
  has-session) [[ -f "$WATCH_TEST_STATE" ]] ;;
  kill-session) rm "$WATCH_TEST_STATE" ;;
  new-session) for metro_command; do :; done; bash -c "$metro_command" && touch "$WATCH_TEST_STATE" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'yarn'),
    `#!${process.execPath}
require('node:fs').writeFileSync(process.env.WATCH_TEST_RECEIPT, JSON.stringify({ci:process.env.CI??null,args:process.argv.slice(2)}));
`,
    { mode: 0o755 },
  );
  const source = fs.readFileSync(new URL('./prepare-profile.sh', import.meta.url), 'utf8');
  const functionSource = source.slice(
    source.indexOf('metro_listening()'),
    source.indexOf('check_gateway()'),
  );
  const result = spawnSync('bash', ['-c', `${functionSource}\nstart_metro_background`], {
    encoding: 'utf8',
    timeout: 3000,
    env: {
      ...process.env,
      CI: '1',
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      WATCH_TEST_STATE: state,
      WATCH_TEST_RECEIPT: receipt,
      APP_DIR: root,
      APP_VARIANT: 'development',
      METRO_PORT: '41234',
      GATEWAY_PORT: '41235',
      COMPANION_GATEWAY_URL: 'ws://localhost:41235',
      COMPANION_PACKAGER_HOSTNAME: 'localhost',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const launched = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(launched.ci, null);
  assert.deepEqual(launched.args, ['expo', 'start', '--dev-client', '--port', '41234', '--lan']);
  assert(fs.readFileSync(path.join(root, '.agent/metro-41234.env'), 'utf8').includes('WATCH=1'));
});
