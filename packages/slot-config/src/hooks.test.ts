import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectVars, SlotVars } from './config.js';
import { expandDispatchCmd, expandTemplate } from './hooks.js';

test('expandTemplate exposes the full slot id for configured actions', () => {
  const slotVars: SlotVars = {
    slotId: 'runner-browser-1',
    machine: 'runner-local',
    platform: 'chrome-extension',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '/usr/local/bin/agent',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'browser-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-browser-farm',
    resourceVars: { cdp_port: '9222' },
  };

  assert.equal(
    expandTemplate('{{slot_id}} {{SLOT_ID}} {{session}} {{cdp_port}}', slotVars),
    'runner-browser-1 runner-browser-1 browser-1 9222',
  );
});

test('expandTemplate uses configured session when machine ids contain hyphens', () => {
  const slotVars: SlotVars = {
    slotId: 'macwork-lan-mm-1',
    machine: 'macwork-lan',
    platform: 'ios',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'mm-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-mobile-farm',
    resourceVars: {},
  };

  assert.equal(
    expandTemplate('{{slot_id}} {{session}} {{SESSION}}', slotVars),
    'macwork-lan-mm-1 mm-1 mm-1',
  );
});

test('expandTemplate renders missing optional resource placeholders as empty strings', () => {
  const slotVars: SlotVars = {
    slotId: 'macwork-mm-1',
    machine: 'macwork',
    platform: 'ios',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'mm-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-mobile-farm',
    resourceVars: { port: '8061', simulator: 'mm-1' },
  };

  assert.equal(
    expandTemplate('{{port}} {{simulator}} {{avd}} {{adb_serial}} {{ADB_SERIAL}}', slotVars),
    '8061 mm-1   ',
  );
});

test('expandDispatchCmd supports Cursor Agent runner path placeholders', () => {
  const slotVars: SlotVars = {
    slotId: 'runner-browser-1',
    machine: 'runner-local',
    platform: 'chrome-extension',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '/usr/local/bin/agent',
    grokPath: '',
    dispatchCmd:
      'cd {repo} && {runner} {runner_path} {cursor_path} {safety_flags} --model {model} {task_prompt}',
    recycleCmd: '',
    repo: '/repo',
    session: 'browser-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-browser-farm',
    resourceVars: { cdp_port: '9222' },
  };

  assert.equal(
    expandDispatchCmd(slotVars, {
      runner: 'cursor',
      model: 'composer-2.5',
      taskPrompt: 'Read TASK.md',
      safetyFlags: '--sandbox enabled',
    }),
    'cd /repo && cursor /usr/local/bin/agent /usr/local/bin/agent --sandbox enabled --model composer-2.5 Read TASK.md',
  );
});

test('expandDispatchCmd leaves Cursor Agent path placeholders empty when cursor_path is not configured', () => {
  const slotVars: SlotVars = {
    slotId: 'runner-browser-1',
    machine: 'runner-local',
    platform: 'chrome-extension',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '{runner_path} {cursor_path}',
    recycleCmd: '',
    repo: '/repo',
    session: 'browser-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-browser-farm',
    resourceVars: {},
  };

  assert.equal(expandDispatchCmd(slotVars, { runner: 'cursor' }), '');
});

test('expandDispatchCmd supports Grok runner path placeholders', () => {
  const slotVars: SlotVars = {
    slotId: 'runner-browser-1',
    machine: 'runner-local',
    platform: 'chrome-extension',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '/Users/deeeed/.grok/bin/grok',
    dispatchCmd:
      'cd {repo} && {runner} {runner_path} {grok_path} {safety_flags} --model {model} {task_prompt}',
    recycleCmd: '',
    repo: '/repo',
    session: 'browser-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-browser-farm',
    resourceVars: { cdp_port: '9222' },
  };

  assert.equal(
    expandDispatchCmd(slotVars, {
      runner: 'grok',
      model: 'grok-build',
      taskPrompt: 'Read TASK.md',
      safetyFlags: '--permission-mode auto',
    }),
    'cd /repo && grok /Users/deeeed/.grok/bin/grok /Users/deeeed/.grok/bin/grok --permission-mode auto --model grok-build Read TASK.md',
  );
});

test('expandTemplate substitutes {{repo}} with the shell-usable remote repo path', () => {
  const slotVars: SlotVars = {
    slotId: 'gohan-1',
    machine: 'gohan',
    platform: 'ios',
    host: 'gohan.local',
    sshUser: 'dev',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '~/dev/checkout',
    session: 's1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'dev@gohan.local',
    remoteRepo: '/Users/dev/dev/checkout',
    projectName: 'demo',
    resourceVars: {},
  };
  assert.equal(expandTemplate("cd '{{repo}}'", slotVars), "cd '/Users/dev/dev/checkout'");
});

test('{{domain}} precedence: extras > project vars > pool default > empty', () => {
  const base: SlotVars = {
    slotId: 's1',
    machine: 'm',
    platform: 'cli',
    host: 'localhost',
    sshUser: 'x',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/tmp/r',
    session: 's',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'x@localhost',
    remoteRepo: '/tmp/r',
    projectName: 'demo',
    resourceVars: {},
  };
  const projectVars = {
    projectName: 'demo',
    projectConfig: '/x/project.json',
    projectFixturesDir: '/x/fixtures',
    projectTemplatesDir: '/x/templates',
    projectJson: { vars: { domain: 'static' } },
    runtimeDir: '.agent',
    artifactDir: '.task',
  } as ProjectVars;
  assert.equal(expandTemplate('{{domain}}', base), '');
  assert.equal(expandTemplate('{{domain}}', { ...base, domain: 'pool' }), 'pool');
  assert.equal(expandTemplate('{{domain}}', base, projectVars), 'static');
  assert.equal(expandTemplate('{{domain}}', base, projectVars, { domain: 'runtime' }), 'runtime');
});
