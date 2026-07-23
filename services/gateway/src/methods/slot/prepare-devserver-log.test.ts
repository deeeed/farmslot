import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectVars, RawProjectJson, SlotVars } from '../../core/index.js';

import {
  buildCloseDevServerLogTailWindowCommand,
  buildDevServerLogTailWindowCommand,
  DEVSERVER_LOG_WINDOW_NAME,
  resolveDevServerLogPath,
} from './prepare-devserver-log.js';

function makeSlotVars(overrides: Partial<SlotVars> = {}): SlotVars {
  return {
    machine: 'macwork',
    platform: 'macos',
    host: 'localhost',
    sshUser: 'deeeed',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/tmp/repo',
    remoteRepo: '/tmp/repo',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    slotId: 'mm-2',
    session: 'mm-2',
    projectName: 'metamask-mobile-farm',
    resourceVars: {},
    ...overrides,
  } as SlotVars;
}

function makeProjectVars(overrides: Partial<ProjectVars> = {}): ProjectVars {
  return {
    projectName: 'metamask-mobile-farm',
    projectConfig: '/tmp/project.json',
    projectFixturesDir: '/tmp/fixtures',
    projectTemplatesDir: '/tmp/templates',
    projectJson: {},
    runtimeDir: '.agent',
    artifactDir: '.task',
    ...overrides,
  };
}

test('resolveDevServerLogPath returns null when the project configures no dev-server log', () => {
  const projectJson: RawProjectJson = { health: {} };
  assert.equal(resolveDevServerLogPath(projectJson, makeSlotVars(), makeProjectVars()), null);
});

test('resolveDevServerLogPath expands templates and anchors the path to the slot repo', () => {
  const projectJson: RawProjectJson = {
    health: { dev_server_log: '{{runtime_dir}}/metro.log' },
  };
  const resolved = resolveDevServerLogPath(
    projectJson,
    makeSlotVars({ remoteRepo: '/home/dev/mm' }),
    makeProjectVars({ runtimeDir: 'temp/recipe/runtime' }),
  );
  assert.equal(resolved, '/home/dev/mm/temp/recipe/runtime/metro.log');
});

test('resolveDevServerLogPath returns null when the configured value expands to empty', () => {
  const projectJson: RawProjectJson = { health: { dev_server_log: '{{port}}' } };
  assert.equal(resolveDevServerLogPath(projectJson, makeSlotVars(), makeProjectVars()), null);
});

test('buildDevServerLogTailWindowCommand replaces any prior window then opens a detached tail', () => {
  const command = buildDevServerLogTailWindowCommand(
    'mm-2',
    '/home/dev/mm/temp/recipe/runtime/metro.log',
    '/home/dev/mm',
  );

  // Idempotent replace: kill every exact-name match by index before recreating
  // it, avoiding tmux's ambiguous name targeting when duplicates already exist.
  assert.match(command, /-v want='devserver-log'/);
  assert.match(command, /kill-window -t 'mm-2':"\$idx"/);
  // Detached window so it never steals operator focus.
  assert.match(command, /new-window -d -t 'mm-2:'/);
  assert.match(command, /-n 'devserver-log'/);
  assert.match(command, /-c '\/home\/dev\/mm'/);
  // tail -F survives a missing/rotated log without crashing the window. The tail
  // command is shell-quoted as the new-window argument, so it is nested-quoted.
  assert.match(command, /tail -F /);
  assert.match(command, /\/home\/dev\/mm\/temp\/recipe\/runtime\/metro\.log/);
});

test('buildDevServerLogTailWindowCommand honours a custom window name', () => {
  const command = buildDevServerLogTailWindowCommand('mm-2', '/tmp/metro.log', '/tmp', 'metro');
  assert.match(command, /-v want='metro'/);
  assert.match(command, /-n 'metro'/);
});

test('buildCloseDevServerLogTailWindowCommand closes the tail window and never fails', () => {
  const command = buildCloseDevServerLogTailWindowCommand('mm-2');
  assert.match(command, /-v want='devserver-log'/);
  assert.match(command, /kill-window -t 'mm-2':"\$idx" 2>\/dev\/null \|\| true/);
});

test('DEVSERVER_LOG_WINDOW_NAME is the stable default handle', () => {
  assert.equal(DEVSERVER_LOG_WINDOW_NAME, 'devserver-log');
});
