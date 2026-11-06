import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  changedLines,
  readTaskView,
  renderTaskView,
  runStatusWatch,
} from '../src/harness/commands/status-watch.js';
import type { TaskRunLifecycle } from '../src/harness/task-run.js';
import { collectTaskView } from '../src/harness/task-view.js';

function task(t: TestContext, branch: string, surface = 'farmslot') {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lifecycle-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const dir = path.join(target, 'temp/tasks/dev/task');
  fs.mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', branch, target]);
  fs.writeFileSync(path.join(target, 'seed'), 'seed');
  const git = (args: string[]) => execFileSync('git', ['-C', target, ...args], { stdio: 'ignore' });
  git(['add', 'seed']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'test: fixture',
  ]);
  fs.writeFileSync(
    path.join(dir, 'inputs/handoff.json'),
    JSON.stringify({
      schemaVersion: 1,
      surface,
      attemptId: 'run-1',
      project: 'example',
      startedAt: new Date().toISOString(),
      task: { ticket: 'TAT-4475', title: 'Status' },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'inputs/recipe-binding.json'),
    JSON.stringify({ identity: { target }, checkoutRoot: target }),
  );
  fs.writeFileSync(
    path.join(dir, 'SIGNAL.json'),
    JSON.stringify({ status: 'complete', timestamp: new Date().toISOString() }),
  );
  return { target, dir };
}

for (const branch of ['feat/tat-4475-pixel6-profile', 'comparison/profile-a']) {
  test(`the recorded checkout binding owns a completed worker on ${branch} while its run reviews`, (t) => {
    const { target, dir } = task(t, branch);
    const view = collectTaskView(target, dir, Date.now(), {
      id: 'run-1',
      project: 'example',
      status: 'reviewing',
      terminal: false,
    });
    assert.equal(view.activity.ongoing, true);
    assert.equal(view.run?.status, 'reviewing');
    assert.equal('branchCarriesTicket' in view.activity, false);
  });
}

test('a binding to a different checkout is not ongoing even with a matching ticket branch', (t) => {
  const { target, dir } = task(t, 'feat/TAT-4475', 'skill');
  fs.writeFileSync(
    path.join(dir, 'SIGNAL.json'),
    JSON.stringify({ status: 'running', timestamp: new Date().toISOString() }),
  );
  fs.writeFileSync(
    path.join(dir, 'inputs/recipe-binding.json'),
    JSON.stringify({ identity: { target: path.join(target, 'other') } }),
  );
  assert.deepEqual(collectTaskView(target, dir, Date.now()).activity.reason, 'foreign-task');
});

test('managed worker completion with unavailable lifecycle is unknown, not finished', (t) => {
  const { target, dir } = task(t, 'comparison/a');
  assert.equal(collectTaskView(target, dir, Date.now()).activity.reason, 'run-unavailable');
});

test('parent completion and skill-only worker completion keep their normal terminal result', (t) => {
  const { target, dir } = task(t, 'comparison/a');
  const done = collectTaskView(target, dir, Date.now(), {
    id: 'run-1',
    project: 'example',
    status: 'done',
    terminal: true,
  });
  assert.equal(done.activity.ongoing, false);
  assert.equal(done.run?.status, 'done');
  const skill = task(t, 'comparison/b', 'skill');
  assert.equal(collectTaskView(skill.target, skill.dir, Date.now()).activity.reason, 'finished');
});

test('the same watch follows reviewing and fixing after worker completion until the run ends', async (t) => {
  const { target, dir } = task(t, 'comparison/profile');
  let state: TaskRunLifecycle = {
    id: 'run-1',
    project: 'example',
    status: 'reviewing',
    terminal: false,
  };
  let opens = 0,
    closes = 0,
    ticks = 0;
  const frames: string[] = [];
  await runStatusWatch(
    { target, taskDir: dir, json: true, watch: true },
    {
      now: () => Date.now(),
      isTty: false,
      write: (text) => frames.push(text),
      observeRun: async () => {
        opens++;
        return {
          current: () => state,
          close: async () => {
            closes++;
          },
        };
      },
      wait: async () => {
        ticks++;
        assert.ok(ticks < 3);
        state = { ...state, status: ticks === 1 ? 'fixing' : 'done', terminal: ticks === 2 };
      },
    },
  );
  assert.equal(opens, 1);
  assert.equal(closes, 1);
  assert.equal(ticks, 2);
  assert.deepEqual(
    frames.map((line) => JSON.parse(line).run.status),
    ['reviewing', 'fixing', 'done'],
  );
});

test('a watch retains the bound run through task-file cleanup while review continues', async (t) => {
  const { target, dir } = task(t, 'comparison/profile');
  let state: TaskRunLifecycle = {
    id: 'run-1',
    project: 'example',
    status: 'reviewing',
    terminal: false,
  };
  let ticks = 0;
  const frames: string[] = [];
  await runStatusWatch(
    { target, json: true, watch: true },
    {
      now: () => Date.now(),
      isTty: false,
      write: (text) => frames.push(text),
      observeRun: async () => ({ current: () => state, close: async () => {} }),
      wait: async () => {
        ticks++;
        assert.ok(ticks < 3, 'lost the bound run after cleanup');
        if (ticks === 1) fs.rmSync(dir, { recursive: true, force: true });
        else state = { ...state, status: 'done', terminal: true };
      },
    },
  );
  assert.equal(ticks, 2);
  assert.equal(JSON.parse(frames.at(-1)!).run.status, 'done');
});

test('an unavailable lifecycle is explicit without treating the worker signal as run completion', (t) => {
  const { target, dir } = task(t, 'comparison/profile');
  const text = renderTaskView(collectTaskView(target, dir, Date.now()), 'status').join('\n');
  assert.match(text, /lifecycle unavailable/);
  assert.doesNotMatch(text, /no ongoing task detected/);
});

test('lifecycle updates for a different binding never turn this task into an ongoing run', (t) => {
  const { target, dir } = task(t, 'comparison/profile');
  const view = collectTaskView(target, dir, Date.now(), {
    id: 'other',
    project: 'example',
    status: 'reviewing',
    terminal: false,
  });
  assert.equal(view.activity.reason, 'run-unavailable');
});

test('one-shot views use and close the same lifecycle source', async (t) => {
  const { target, dir } = task(t, 'comparison/profile');
  let closed = false;
  const view = await readTaskView(target, dir, Date.now(), async () => ({
    current: () => ({ id: 'run-1', project: 'example', status: 'reviewing', terminal: false }),
    close: async () => {
      closed = true;
    },
  }));
  assert.equal(view.run?.status, 'reviewing');
  assert.equal(view.activity.ongoing, true);
  assert.equal(closed, true);
});

test('a new bound run is a new watch context even when its path and phase match', (t) => {
  const { target, dir } = task(t, 'comparison/profile');
  const first = collectTaskView(target, dir, Date.now(), {
    id: 'run-1',
    project: 'example',
    status: 'reviewing',
    terminal: false,
  });
  const next = { ...first, run: { ...first.run!, id: 'run-2' } };
  assert.ok(changedLines(first, next).length > 0);
});

test('a bound skill task on a ticketless branch reports completion without a branch ownership warning', (t) => {
  const { target, dir } = task(t, 'comparison/profile', 'skill');
  const view = collectTaskView(target, dir, Date.now());
  assert.equal('branchCarriesTicket' in view.activity, false);
  assert.doesNotMatch(renderTaskView(view, 'status', true).join('\n'), /does not carry/);
});

test('checkout ownership uses the recorded checkout root when the runtime target is a nested app', (t) => {
  const { target, dir } = task(t, 'comparison/nested');
  fs.writeFileSync(
    path.join(dir, 'inputs/recipe-binding.json'),
    JSON.stringify({ checkoutRoot: target, identity: { target: path.join(target, 'apps/site') } }),
  );
  for (const selected of [target, path.join(target, 'apps/site')]) {
    fs.mkdirSync(selected, { recursive: true });
    const view = collectTaskView(selected, dir, Date.now(), {
      id: 'run-1',
      project: 'example',
      status: 'reviewing',
      terminal: false,
    });
    assert.equal(view.binding?.matchesCheckout, true);
    assert.equal(view.activity.ongoing, true);
  }
});

test('standalone skill and fast views add no lifecycle process', async (t) => {
  const skill = task(t, 'comparison/skill', 'skill');
  const connect = async () => assert.fail('unexpected lifecycle observation');
  assert.equal(
    (await readTaskView(skill.target, skill.dir, Date.now(), connect)).activity.reason,
    'finished',
  );
  const managed = task(t, 'comparison/fast');
  const frames: string[] = [];
  await runStatusWatch(
    { target: managed.target, taskDir: managed.dir, json: true, watch: false, fast: true },
    {
      now: () => Date.now(),
      isTty: false,
      write: (text) => frames.push(text),
      observeRun: connect,
      wait: async () => assert.fail('one-shot waited'),
    },
  );
  assert.equal(JSON.parse(frames[0]).activity.reason, 'run-unavailable');
});
