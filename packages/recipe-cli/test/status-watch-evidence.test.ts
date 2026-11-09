import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { runStatusWatch } from '../src/harness/commands/status-watch.js';

/** Let pending promise work run; fake timers never move on their own. */
async function settle(until: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !until(); turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(until(), 'the watch reached the expected state');
}

test('status --watch opens the live evidence page for the current run on v', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-evidence-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const runs = path.join(target, 'temp/recipe/runs');
  for (const [id, startedAt] of [
    ['older', '2026-01-01T00:00:00.000Z'],
    ['current', '2026-01-02T00:00:00.000Z'],
  ]) {
    fs.mkdirSync(path.join(runs, id), { recursive: true });
    fs.writeFileSync(
      path.join(runs, id, 'recipe-invocation.json'),
      JSON.stringify({ version: 1, startedAt }),
    );
  }

  const frames: string[] = [];
  const opened: string[] = [];
  const served: string[] = [];
  let onKey: ((key: string) => void) | undefined;
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
        onKey = listener;
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
    },
  );

  await settle(() => frames.length === 1 && onKey !== undefined);
  assert.match(frames[0]!, /v {2}open the live run evidence page/u);

  onKey!('v');
  await settle(() => frames.length === 2);
  assert.deepEqual(served, [runs]);
  assert.deepEqual(opened, ['http://127.0.0.1:4100/runs/current/#story']);
  assert.match(frames[1]!, /evidence http:\/\/127\.0\.0\.1:4100\/runs\/current\/#story/u);

  // The page stays up across redraws and opens once per key press.
  mock.timers.tick(2_000);
  await settle(() => frames.length === 3);
  assert.equal(served.length, 1);
  assert.equal(opened.length, 1);

  // Raw mode delivers Ctrl-C as a key: it ends the watch and closes the page server.
  onKey!('\u0003');
  assert.equal(await watching, 0);
  assert.ok(unsubscribed);
  assert.ok(closed);
});

test('status --watch says when no recipe run exists yet', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-evidence-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const frames: string[] = [];
  let onKey: ((key: string) => void) | undefined;
  const watching = runStatusWatch(
    { target, json: false, watch: true },
    {
      now: () => 0,
      isTty: true,
      write: (text) => frames.push(text),
      wait: (_ms, signal) =>
        new Promise((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        ),
      keys: (listener) => {
        onKey = listener;
        return () => undefined;
      },
      serveEvidence: async () => assert.fail('no run to serve'),
      openUrl: () => assert.fail('nothing to open'),
    },
  );
  await settle(() => frames.length === 1 && onKey !== undefined);
  onKey!('v');
  await settle(() => frames.length === 2);
  assert.match(frames[1]!, /no recipe run yet under .*temp\/recipe\/runs/u);
  onKey!('\u0003');
  assert.equal(await watching, 0);
});
