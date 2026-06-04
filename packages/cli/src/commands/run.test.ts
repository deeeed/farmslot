import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRunCreateParams, parseTaskPath } from './run.js';

test('run create builds params from a GitHub/Jira ticket source', () => {
  assert.deepEqual(
    buildRunCreateParams({
      project: 'audiolab-farm',
      flowType: 'dev',
      ticket: 'https://github.com/deeeed/audiolab/issues/414',
      slot: 'mini-audiolab-1',
      runner: 'codex',
    }),
    {
      project: 'audiolab-farm',
      flowType: 'dev',
      ticketOrPr: 'https://github.com/deeeed/audiolab/issues/414',
      slotId: 'mini-audiolab-1',
      runner: 'codex',
      skipPrepare: undefined,
      mode: undefined,
      model: undefined,
      app: undefined,
    },
  );
});

test('run create builds params from an existing task file source', () => {
  assert.deepEqual(
    buildRunCreateParams({
      task: 'projects/audiolab-farm/tasks/dev/demo-414-0604/TASK.md',
      slot: 'mini-audiolab-1',
    }),
    {
      project: 'audiolab-farm',
      flowType: 'dev',
      ticketOrPr: 'DEMO-414',
      taskFile: 'projects/audiolab-farm/tasks/dev/demo-414-0604/TASK.md',
      slotId: 'mini-audiolab-1',
      skipPrepare: undefined,
      mode: undefined,
      runner: undefined,
      model: undefined,
      app: undefined,
    },
  );
});

test('run create rejects ambiguous input sources', () => {
  assert.throws(
    () =>
      buildRunCreateParams({
        project: 'audiolab-farm',
        flowType: 'dev',
        ticket: 'DEMO-414',
        task: 'projects/audiolab-farm/tasks/dev/demo-414-0604/TASK.md',
      }),
    /either --ticket or --task/,
  );
});

test('parseTaskPath maps task directories to run fields', () => {
  assert.deepEqual(parseTaskPath('/tmp/repo/projects/foo/tasks/fix/proj-2483-0409/TASK.md'), {
    project: 'foo',
    flowType: 'fix-bug',
    ticketOrPr: 'PROJ-2483',
    relativePath: 'projects/foo/tasks/fix/proj-2483-0409/TASK.md',
  });
});

test('parseTaskPath uses generated task provenance over folder naming', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/audiolab-farm/tasks/feat/414-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'audiolab-farm',
    flowType: 'dev',
    ticketOrPr: 'deeeed/audiolab#414',
    relativePath: 'projects/audiolab-farm/tasks/feat/414-0604-141246/TASK.md',
  });
});

test('run create canonicalizes an absolute task file to the gateway-relative path', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/audiolab-farm/tasks/feat/414-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.equal(
    buildRunCreateParams({ task: taskFile }).taskFile,
    'projects/audiolab-farm/tasks/feat/414-0604-141246/TASK.md',
  );
});

test('parseTaskPath ignores unrelated parent directories named projects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-parent-projects-'));
  const taskDir = path.join(
    root,
    'projects',
    'farmslot',
    'projects/audiolab-farm/tasks/feat/414-0604-141246',
  );
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'audiolab-farm',
    flowType: 'dev',
    ticketOrPr: 'deeeed/audiolab#414',
    relativePath: 'projects/audiolab-farm/tasks/feat/414-0604-141246/TASK.md',
  });
});

test('parseTaskPath ignores earlier parent projects tasks sequences', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-parent-projects-tasks-'));
  const taskDir = path.join(
    root,
    'projects',
    'parent',
    'tasks',
    'not-a-flow',
    'not-a-task',
    'projects/audiolab-farm/tasks/feat/414-0604-141246',
  );
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/template-provenance.json'),
    JSON.stringify({ flowType: 'dev' }),
  );
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ githubIssue: 'deeeed/audiolab#414' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'audiolab-farm',
    flowType: 'dev',
    ticketOrPr: 'deeeed/audiolab#414',
    relativePath: 'projects/audiolab-farm/tasks/feat/414-0604-141246/TASK.md',
  });
});

test('parseTaskPath uses generated Jira key metadata over folder naming', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/metamask-mobile/tasks/fix/3215-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(
    path.join(taskDir, 'inputs/bug-input.json'),
    JSON.stringify({ jiraKey: 'TAT-3215' }),
  );

  assert.deepEqual(parseTaskPath(taskFile), {
    project: 'metamask-mobile',
    flowType: 'fix-bug',
    ticketOrPr: 'TAT-3215',
    relativePath: 'projects/metamask-mobile/tasks/fix/3215-0604-141246/TASK.md',
  });
});

test('parseTaskPath reports malformed task metadata with file context', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-'));
  const taskDir = path.join(root, 'projects/audiolab-farm/tasks/feat/414-0604-141246');
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(taskFile, '# Task\n');
  writeFileSync(path.join(taskDir, 'inputs/template-provenance.json'), '{bad json');

  assert.throws(() => parseTaskPath(taskFile), /Invalid task metadata .*template-provenance\.json/);
});
