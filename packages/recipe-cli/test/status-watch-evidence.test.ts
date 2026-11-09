import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

import { runStatusWatch, type StatusWatchDeps } from '../src/harness/commands/status-watch.js';

/** Let pending promise work run; fake timers never move on their own. */
async function settle(until: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !until(); turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(until(), 'the watch reached the expected state');
}

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRun(runs: string, id: string, startedAt: string): void {
  fs.mkdirSync(path.join(runs, id), { recursive: true });
  fs.writeFileSync(
    path.join(runs, id, 'recipe-invocation.json'),
    JSON.stringify({ version: 1, startedAt }),
  );
}

/** The task env the recipe writer reads; each test sets its own and restores the caller's. */
function taskEnv(t: TestContext, value: string | undefined): void {
  const saved = { recipe: process.env.RECIPE_TASK_DIR, farmslot: process.env.FARMSLOT_TASK_DIR };
  delete process.env.FARMSLOT_TASK_DIR;
  if (value === undefined) delete process.env.RECIPE_TASK_DIR;
  else process.env.RECIPE_TASK_DIR = value;
  t.after(() => {
    for (const [name, previous] of [
      ['RECIPE_TASK_DIR', saved.recipe],
      ['FARMSLOT_TASK_DIR', saved.farmslot],
    ] as const) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
}

/** A terminal watch whose keys, page server and opener the test drives. */
function watch(t: TestContext, target: string, overrides: Partial<StatusWatchDeps> = {}) {
  mock.timers.enable({ apis: ['setTimeout'] });
  const frames: string[] = [];
  const opened: string[] = [];
  const served: string[] = [];
  const state = { onKey: undefined as ((key: string) => void) | undefined };
  let unsubscribed = false;
  let closed = false;
  const watching = runStatusWatch(
    { target, json: false, watch: true },
    {
      now: () => 0,
      isTty: true,
      write: (text) => frames.push(text),
      wait: (ms, signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
      keys: (listener) => {
        state.onKey = listener;
        return () => {
          unsubscribed = true;
        };
      },
      serveEvidence: async (dir) => {
        served.push(dir);
        return {
          url: 'http://127.0.0.1:4100/',
          close: async () => {
            closed = true;
          },
        };
      },
      openUrl: (url) => opened.push(url),
      ...overrides,
    },
  );
  // Whatever an assertion does, the watch ends and its timers go back.
  t.after(async () => {
    state.onKey?.('\u0003');
    await watching;
    mock.timers.reset();
  });
  return {
    frames,
    opened,
    served,
    watching,
    key: (key: string) => state.onKey!(key),
    ready: () => settle(() => frames.length >= 1 && state.onKey !== undefined),
    get unsubscribed() {
      return unsubscribed;
    },
    get closed() {
      return closed;
    },
  };
}

test('status --watch opens the live evidence page for the current run on v', async (t) => {
  taskEnv(t, undefined);
  const target = tempDir(t);
  const runs = path.join(target, 'temp/recipe/runs');
  writeRun(runs, 'older', '2026-01-01T00:00:00.000Z');
  writeRun(runs, 'current', '2026-01-02T00:00:00.000Z');
  const session = watch(t, target);
  await session.ready();
  assert.match(session.frames[0]!, /v {2}open the live run evidence page/u);

  session.key('v');
  await settle(() => session.frames.length === 2);
  assert.deepEqual(session.served, [runs]);
  assert.deepEqual(session.opened, ['http://127.0.0.1:4100/runs/current/#story']);
  assert.match(session.frames[1]!, /evidence http:\/\/127\.0\.0\.1:4100\/runs\/current\/#story/u);

  // The page stays up across redraws and opens once per key press.
  mock.timers.tick(2_000);
  await settle(() => session.frames.length === 3);
  assert.equal(session.served.length, 1);
  assert.equal(session.opened.length, 1);

  // Raw mode delivers Ctrl-C as a key: it ends the watch and closes the page server.
  session.key('\u0003');
  assert.equal(await session.watching, 0);
  assert.ok(session.unsubscribed);
  assert.ok(session.closed);
});

test('status --watch opens the run the recipe writer owns, not a retained task', async (t) => {
  taskEnv(t, undefined);
  const target = tempDir(t);
  // A finished task stays on display, but an unbound run writes under the checkout.
  const retained = path.join(target, 'temp/tasks/dev/task');
  fs.mkdirSync(path.join(retained, 'inputs'), { recursive: true });
  fs.writeFileSync(
    path.join(retained, 'inputs/handoff.json'),
    JSON.stringify({ schemaVersion: 1, surface: 'farmslot', startedAt: '2026-01-01T00:00:00Z' }),
  );
  fs.writeFileSync(path.join(retained, 'SIGNAL.json'), JSON.stringify({ status: 'complete' }));
  writeRun(path.join(retained, 'artifacts/recipe-runs'), 'history', '2026-01-03T00:00:00.000Z');
  const runs = path.join(target, 'temp/recipe/runs');
  writeRun(runs, 'current', '2026-01-02T00:00:00.000Z');
  const session = watch(t, target);
  await session.ready();
  session.key('v');
  await settle(() => session.frames.length === 2);
  assert.deepEqual(session.served, [runs]);
  assert.deepEqual(session.opened, ['http://127.0.0.1:4100/runs/current/#story']);
});

test('status --watch opens the run of a task bound outside the watched checkout', async (t) => {
  const target = tempDir(t);
  const bound = tempDir(t);
  taskEnv(t, bound);
  const runs = path.join(bound, 'artifacts/recipe-runs');
  writeRun(runs, 'bound', '2026-01-02T00:00:00.000Z');
  writeRun(path.join(target, 'temp/recipe/runs'), 'unbound', '2026-01-03T00:00:00.000Z');
  const session = watch(t, target);
  await session.ready();
  session.key('v');
  await settle(() => session.frames.length === 2);
  assert.deepEqual(session.served, [runs]);
  assert.deepEqual(session.opened, ['http://127.0.0.1:4100/runs/bound/#story']);
});

test('status --watch says when no recipe run exists yet', async (t) => {
  taskEnv(t, undefined);
  const target = tempDir(t);
  const session = watch(t, target, {
    serveEvidence: async () => assert.fail('no run to serve'),
    openUrl: () => assert.fail('nothing to open'),
  });
  await session.ready();
  session.key('v');
  await settle(() => session.frames.length === 2);
  assert.match(session.frames[1]!, /no recipe run yet under .*temp\/recipe\/runs/u);
});
