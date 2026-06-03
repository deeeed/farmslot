import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotVars } from './config.js';
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
      model: 'composer-2',
      taskPrompt: 'Read TASK.md',
      safetyFlags: '--sandbox enabled',
    }),
    'cd /repo && cursor /usr/local/bin/agent /usr/local/bin/agent --sandbox enabled --model composer-2 Read TASK.md',
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
