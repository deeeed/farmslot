import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotVars } from '../../core/index.js';

import {
  autoRefreshSessionName,
  buildAutoRefreshCommand,
  buildMonitorCommand,
  buildReopenCommand,
  buildShowScript,
  buildSoftRefreshCommand,
  validateHarnessRoot,
} from './helpers.js';

function makeVars(overrides: Partial<SlotVars> = {}): SlotVars {
  return {
    slotId: 'macwork-ff-1',
    machine: 'macwork',
    platform: 'cli',
    host: 'localhost',
    sshUser: '',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'ff-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: '',
    remoteRepo: '/repo',
    projectName: 'farmslot-farm',
    resourceVars: {},
    ...overrides,
  } as SlotVars;
}

test('buildMonitorCommand embeds slot identity, task dir, repo, session, and runner pattern', () => {
  const cmd = buildMonitorCommand(makeVars(), '.task', 'claude|codex|scripted-runner');
  assert.match(cmd, /=== Monitor: macwork-ff-1 on macwork \(cli\) ===/);
  assert.match(cmd, /find '\/repo\/\.task' -name TASK\.md/);
  assert.match(cmd, /git -C '\/repo' rev-parse --abbrev-ref HEAD/);
  assert.match(cmd, /tmux has-session -t 'ff-1'/);
  assert.match(cmd, /tmux capture-pane -p -J -t 'ff-1' -S -30/);
  // Runner-liveness pattern comes from the runner registry, not inline runner ids.
  assert.match(cmd, /root="\$PANE_PID"/);
  assert.match(cmd, /grep -Eq 'claude\|codex\|scripted-runner'/);
  assert.match(cmd, /pgrep -P "\$parent"/);
  assert.match(cmd, /\) >\/dev\/null 2>&1; then/);
});

test('validateHarnessRoot accepts the default and rejects escape attempts', () => {
  assert.doesNotThrow(() => validateHarnessRoot('temp/recipe/harness'));
  assert.throws(() => validateHarnessRoot(''), /invalid RECIPE_HARNESS_ROOT/);
  assert.throws(() => validateHarnessRoot('/abs/path'), /invalid RECIPE_HARNESS_ROOT/);
  assert.throws(() => validateHarnessRoot('a;b'), /invalid RECIPE_HARNESS_ROOT/);
  assert.throws(() => validateHarnessRoot('../escape'), /must not contain/);
  assert.throws(() => validateHarnessRoot('a/./b'), /must not contain/);
});

test('buildSoftRefreshCommand cds to the recipes dir and passes cdp + slot', () => {
  const cmd = buildSoftRefreshCommand(
    '/repo/temp/recipe/harness/extension/runner/recipes',
    '9328',
    'macwork-ff-1',
  );
  assert.equal(
    cmd,
    "cd '/repo/temp/recipe/harness/extension/runner/recipes' && node soft-refresh.js --cdp-port '9328' --slot-id 'macwork-ff-1'",
  );
});

test('buildReopenCommand includes optional cdp/watcher only when provided', () => {
  const full = buildReopenCommand({
    reopenScript: '/repo/.agent/reopen-browser.sh',
    slotId: 'macwork-ff-1',
    repo: '/repo',
    runtimeDir: '.agent',
    cdpPort: '9328',
    watcherPort: '8808',
  });
  assert.equal(
    full,
    "bash '/repo/.agent/reopen-browser.sh' --slot-id 'macwork-ff-1' --repo '/repo' --cdp-port '9328' --runtime-dir '.agent' --watcher-port '8808'",
  );
  const bare = buildReopenCommand({
    reopenScript: '/repo/.agent/reopen-browser.sh',
    slotId: 'macwork-ff-1',
    repo: '/repo',
    runtimeDir: '.agent',
  });
  assert.doesNotMatch(bare, /--cdp-port/);
  assert.doesNotMatch(bare, /--watcher-port/);
});

test('autoRefreshSessionName sanitizes non-alphanumeric slot chars', () => {
  assert.equal(autoRefreshSessionName('macwork-ff-1'), 'autorefresh-macwork-ff-1');
  assert.equal(autoRefreshSessionName('runner.mobile/2'), 'autorefresh-runner-mobile-2');
});

test('buildAutoRefreshCommand: stop only kills, start kills then spawns', () => {
  const session = 'autorefresh-macwork-ff-1';
  const stop = buildAutoRefreshCommand({
    action: 'stop',
    session,
    projectDir: '/farmslot',
    scriptPath: '/farmslot/projects/farmslot-farm/setup/auto-refresh.sh',
    slotId: 'macwork-ff-1',
    repo: '/repo',
  });
  assert.equal(stop, "tmux kill-session -t 'autorefresh-macwork-ff-1' 2>/dev/null || true");

  const start = buildAutoRefreshCommand({
    action: 'start',
    session,
    projectDir: '/farmslot',
    scriptPath: '/farmslot/projects/farmslot-farm/setup/auto-refresh.sh',
    slotId: 'macwork-ff-1',
    repo: '/repo',
    cdpPort: '9328',
  });
  assert.ok(
    start.startsWith(
      "tmux kill-session -t 'autorefresh-macwork-ff-1' 2>/dev/null || true; tmux new-session -d -s",
    ),
  );
  assert.ok(start.includes('exec bash'));
  assert.ok(start.includes('--slot-id'));
  assert.ok(start.includes('--cdp-port'));
  assert.ok(start.includes('9328'));
});

test('buildShowScript targets the avd + adb serial and detaches the emulator', () => {
  const script = buildShowScript('Pixel_7_API_34', 'emulator-5554', 'runner-a');
  assert.match(script, /=== show-slot: Pixel_7_API_34 \(emulator-5554\) ===/);
  assert.match(script, /nohup emulator -avd 'Pixel_7_API_34'/);
  assert.match(script, /disown "\$NEW_PID"/);
  assert.match(script, /adb -s 'emulator-5554' wait-for-device/);
  assert.match(script, /connect VNC client to runner-a:5900/);
});
