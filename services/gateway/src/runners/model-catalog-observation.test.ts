import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { RunnerModelCatalogResult } from '@farmslot/protocol';

import { runnerModelCatalog } from '../methods/runner-models.js';

import {
  parseCursorModelCatalog,
  type RunnerModelCatalogCommandSource,
  type RunnerModelCatalogSource,
} from './model-catalog.js';
import {
  RUNNER_MODEL_CATALOG_TICK_MS,
  RUNNER_MODEL_CATALOG_TTL_MS,
  RunnerModelCatalogObservation,
} from './model-catalog-observation.js';
import { getRunnerDefinition } from './registry.js';

const managed = { legacyInterest: false };
const command = (path: string, args = ['--list-models']): RunnerModelCatalogCommandSource => ({
  command: path,
  args,
  parse: parseCursorModelCatalog,
});
const ready = (...ids: string[]): RunnerModelCatalogResult => ({
  runner: 'cursor',
  status: 'ready',
  source: 'catalog-command',
  models: ids.map((id) => ({
    id,
    label: id.toUpperCase(),
    reasoningModes: ['high'],
    listed: true,
  })),
});
const failed = (): RunnerModelCatalogResult => ({
  runner: 'cursor',
  status: 'unavailable',
  source: 'catalog-command',
  detail: 'Runner catalog command failed (code: 1, signal: none, killed: false).',
  models: [],
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const ids = (result: RunnerModelCatalogResult) => result.models.map((model) => model.id);

test('passive cadence is at least one minute', () => {
  assert.ok(RUNNER_MODEL_CATALOG_TICK_MS >= 60_000);
  assert.ok(RUNNER_MODEL_CATALOG_TTL_MS >= RUNNER_MODEL_CATALOG_TICK_MS);
});

test('readers and the interested tick share one completion; managed warm reads never renew it', async () => {
  let now = 1000;
  const completions: Array<(result: RunnerModelCatalogResult) => void> = [];
  const notices: string[] = [];
  const owner = new RunnerModelCatalogObservation({
    runners: () => ['cursor'],
    select: async () => command('/fake/cursor-agent'),
    sample: () => new Promise((resolve) => completions.push(resolve)),
    hasInterest: () => true,
    changed: (runner) => notices.push(runner),
    now: () => now,
  });
  const first = owner.read('cursor', managed);
  const second = owner.read('cursor', managed);
  const tick = owner.tick();
  await settle();
  assert.equal(completions.length, 1);
  now = 2000;
  completions[0](ready('model-one'));
  await tick;
  assert.deepEqual(await first, await second);
  assert.deepEqual((await first).observation, { status: 'ready', observedAt: 2000 });
  assert.deepEqual(notices, ['cursor']);
  now += RUNNER_MODEL_CATALOG_TTL_MS;
  const warm = await owner.read('cursor', managed);
  assert.equal(completions.length, 1);
  assert.deepEqual(warm.observation, { status: 'stale', observedAt: 2000 });
  // Legacy readers keep their former sample-per-read behavior.
  const legacy = owner.read('cursor');
  await settle();
  assert.equal(completions.length, 2);
  completions[1](ready('model-one'));
  assert.equal((await legacy).observation?.observedAt, now);
});

test('source errors retain sanitized last-success models with their original age and no cold success', async () => {
  let now = 1000;
  let next: () => Promise<RunnerModelCatalogResult> = async () => failed();
  const owner = new RunnerModelCatalogObservation({
    runners: () => ['cursor'],
    select: async () => command('/fake/cursor-agent'),
    sample: () => next(),
    hasInterest: () => false,
    changed: () => {},
    now: () => now,
  });
  const cold = await owner.read('cursor');
  assert.equal(cold.status, 'unavailable');
  assert.deepEqual(cold.models, []);
  assert.equal(cold.observation?.status, 'error');
  assert.equal(cold.observation?.observedAt, undefined);
  assert.equal(cold.observation?.error?.code, 'RUNNER_MODEL_CATALOG_UNAVAILABLE');

  now = 2000;
  next = async () => ({
    ...ready('model-one'),
    // Parser output is projected; extra source fields never reach readers.
    models: [{ id: 'model-one', reasoningModes: [], listed: true, raw: 'stdout' } as never],
  });
  assert.deepEqual((await owner.read('cursor')).models, [
    { id: 'model-one', reasoningModes: [], listed: true },
  ]);

  now = 3000;
  next = async () => failed();
  const stale = await owner.read('cursor');
  assert.equal(stale.status, 'unavailable');
  assert.deepEqual(ids(stale), ['model-one']);
  assert.equal(stale.detail, failed().detail);
  assert.deepEqual(stale.observation, {
    status: 'stale',
    observedAt: 2000,
    error: { code: 'RUNNER_MODEL_CATALOG_UNAVAILABLE', message: failed().detail },
  });

  next = async () => {
    throw Object.assign(
      new Error("EACCES: permission denied, open '/Users/private/.cursor/token'"),
      {
        code: 'EACCES',
      },
    );
  };
  const thrown = await owner.read('cursor');
  assert.equal(thrown.detail, 'Runner model catalog source failed (EACCES).');
  assert.doesNotMatch(JSON.stringify(thrown), /private|token/);
  assert.equal(thrown.observation?.observedAt, 2000);

  now = 4000;
  next = async () => ready('model-two');
  const recovered = await owner.read('cursor');
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.detail, undefined);
  assert.deepEqual(recovered.observation, { status: 'ready', observedAt: 4000 });
});

test('a changed command or argv starts a new owner and fences the superseded reply', async () => {
  let source: RunnerModelCatalogSource = command('/fake/one');
  const completions = new Map<string, (result: RunnerModelCatalogResult) => void>();
  let notices = 0;
  const owner = new RunnerModelCatalogObservation({
    runners: () => ['cursor'],
    select: async () => source,
    sample: (_runner, selected) => {
      const { command: path, args } = selected as RunnerModelCatalogCommandSource;
      return new Promise((resolve) => completions.set([path, ...args].join(' '), resolve));
    },
    hasInterest: () => false,
    changed: () => notices++,
    now: () => 1000,
  });
  const superseded = owner.read('cursor', managed);
  await settle();
  source = command('/fake/two');
  const current = owner.read('cursor', managed);
  await settle();
  assert.deepEqual([...completions.keys()], ['/fake/one --list-models', '/fake/two --list-models']);
  completions.get('/fake/one --list-models')!(ready('old-model'));
  await settle();
  assert.equal(notices, 0);
  completions.get('/fake/two --list-models')!(ready('new-model'));
  assert.deepEqual(ids(await superseded), ['new-model']);
  assert.deepEqual(ids(await current), ['new-model']);
  assert.equal(notices, 1);

  source = command('/fake/two', ['--list-models', '--format', 'text']);
  const argv = owner.read('cursor', managed);
  await settle();
  assert.equal(completions.size, 3);
  completions.get('/fake/two --list-models --format text')!(ready('argv-model'));
  assert.deepEqual(ids(await argv), ['argv-model']);
  // The same selection again joins its owner instead of sampling.
  assert.deepEqual(ids(await owner.read('cursor', managed)), ['argv-model']);
  assert.equal(completions.size, 3);
});

test('passive work needs admitted interest per runner and samples only when due', async () => {
  let now = 1000;
  let interested = false;
  let selections = 0;
  let calls = 0;
  const owner = new RunnerModelCatalogObservation({
    runners: () => ['cursor', 'codex'],
    select: async () => {
      selections++;
      return command('/fake/cursor-agent');
    },
    sample: async () => {
      calls++;
      return ready('model-one');
    },
    hasInterest: (runner) => interested && runner === 'cursor',
    changed: () => {},
    now: () => now,
  });
  await owner.tick();
  assert.deepEqual([selections, calls], [0, 0]);
  interested = true;
  await owner.tick();
  assert.deepEqual([selections, calls], [1, 1]);
  now += RUNNER_MODEL_CATALOG_TTL_MS - 1;
  await owner.tick();
  assert.equal(calls, 1);
  now++;
  await owner.tick();
  assert.equal(calls, 2);
  interested = false;
  now += RUNNER_MODEL_CATALOG_TTL_MS;
  await owner.tick();
  assert.equal(calls, 2);
});

test('stop drains in-flight work and blocks late publication and new samples', async () => {
  let complete!: (result: RunnerModelCatalogResult) => void;
  let calls = 0;
  let notices = 0;
  const owner = new RunnerModelCatalogObservation({
    runners: () => ['cursor'],
    select: async () => command('/fake/cursor-agent'),
    sample: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    hasInterest: () => true,
    changed: () => notices++,
    now: () => 1000,
  });
  owner.start();
  const pending = owner.read('cursor', managed);
  await settle();
  let drained = false;
  const stopping = owner.stop().then(() => {
    drained = true;
  });
  await settle();
  assert.equal(drained, false);
  complete(ready('late-model'));
  await Promise.all([pending, stopping]);
  await owner.tick();
  const stopped = await owner.read('cursor');
  assert.equal(calls, 1);
  assert.equal(notices, 0);
  assert.deepEqual(stopped.models, []);
  owner.start();
  const restarted = owner.read('cursor', managed);
  await settle();
  complete(ready('fresh-model'));
  assert.deepEqual(ids(await restarted), ['fresh-model']);
  assert.equal(calls, 2);
});

// Real fs watchers: waits end on the actual event. The ceiling only reports a hang.
const HANG_GUARD_MS = 20_000;
const pace = () => new Promise((resolve) => setTimeout(resolve, 50));

/** macOS arms fs.watch asynchronously. Repeat a distinct real change until it is reported. */
async function untilReported(reported: () => boolean, change: (attempt: number) => void) {
  const deadline = Date.now() + HANG_GUARD_MS;
  for (let attempt = 0; !reported(); attempt++) {
    if (Date.now() > deadline) throw new Error('The real watcher never reported a change');
    change(attempt);
    await pace();
  }
}

test('an interested structured catalog observes replacement, removal, malformed data and recovery', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'runner-catalog-watch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = getRunnerDefinition('codex').modelCatalog!;
  const directory = join(home, '.codex');
  const path = join(directory, 'models_cache.json');
  const catalog = (slug: string) => JSON.stringify({ models: [{ slug, visibility: 'list' }] });
  mkdirSync(directory);
  writeFileSync(path, catalog('one'));
  let interested = true;
  let notices = 0;
  let waiter: (() => void) | undefined;
  const owner = new RunnerModelCatalogObservation({
    runners: () => ['codex'],
    select: async () => source,
    hasInterest: () => interested,
    changed: () => {
      notices++;
      waiter?.();
    },
    home,
  });
  t.after(() => owner.stop());
  // Nothing else samples here: reads are warm and no tick runs, so each notice is the watcher's.
  const nextNotice = (change: () => void) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Catalog notice hung')), HANG_GUARD_MS);
      waiter = () => {
        clearTimeout(timer);
        waiter = undefined;
        resolve();
      };
      change();
    });
  const replace = (slug: string) => {
    writeFileSync(`${path}.external`, catalog(slug));
    renameSync(`${path}.external`, path);
  };

  await owner.tick();
  assert.deepEqual(ids(await owner.read('codex', managed)), ['one']);
  const armed = notices;
  await untilReported(
    () => notices > armed,
    (attempt) => replace(`warm-${attempt}`),
  );

  await nextNotice(() => replace('two'));
  const two = await owner.read('codex', managed);
  assert.deepEqual(ids(two), ['two']);

  await nextNotice(() => unlinkSync(path));
  const removed = await owner.read('codex', managed);
  assert.equal(removed.status, 'unavailable');
  assert.match(removed.detail ?? '', /ENOENT/);
  assert.deepEqual(ids(removed), ['two']);
  assert.equal(removed.observation?.status, 'stale');
  assert.equal(removed.observation?.observedAt, two.observation?.observedAt);
  assert.equal(JSON.stringify(removed).includes(home), false);

  await nextNotice(() => writeFileSync(path, '{'));
  assert.match((await owner.read('codex', managed)).detail ?? '', /not valid JSON/);

  await nextNotice(() => writeFileSync(path, catalog('three')));
  const recovered = await owner.read('codex', managed);
  assert.equal(recovered.status, 'ready');
  assert.deepEqual(ids(recovered), ['three']);

  // No interest closes the watcher. A live barrier watcher on the same directory proves the
  // catalog change and later events were delivered to this process without a refresh.
  interested = false;
  await owner.tick();
  const seen = new Set<string>();
  const barrier = watch(directory, (_event, name) => seen.add(String(name)));
  t.after(() => barrier.close());
  const marker = (name: string) =>
    untilReported(
      () => seen.has(name),
      (attempt) => writeFileSync(join(directory, name), String(attempt)),
    );
  await marker('barrier-armed');
  const quiet = notices;
  writeFileSync(path, catalog('four'));
  await marker('barrier-after-change');
  await settle();
  assert.equal(notices, quiet);
  assert.deepEqual(ids(await owner.read('codex', managed)), ['three']);
});

test('the catalog method keeps alias handling and unsupported runners need no source', async () => {
  const claude = await runnerModelCatalog({ runner: 'claude-code' });
  assert.equal(claude.runner, 'claude');
  assert.equal(claude.status, 'unsupported');
  assert.equal(claude.observation, undefined);
  await assert.rejects(runnerModelCatalog({ runner: 'unknown-runner' }), /Unknown runner/);
});
