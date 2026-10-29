import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

interface ScanProbe {
  root: string;
  active: number;
  peak: number;
  started: number;
  finished: number;
  failures: number;
  expected: number;
  gate?: Promise<void>;
  entered?: () => void;
  drained?: () => void;
}
let probe: ScanProbe | undefined;

async function track<T>(file: string, stat: boolean, operation: () => Promise<T>): Promise<T> {
  const current = probe;
  if (!current || (file !== current.root && !file.startsWith(`${current.root}${path.sep}`)))
    return operation();
  current.active++;
  current.peak = Math.max(current.peak, current.active);
  const fail = stat && current.failures > 0;
  if (stat) {
    current.started++;
    if (fail) current.failures--;
    current.entered?.();
  }
  try {
    if (stat) await current.gate;
    if (fail) throw Object.assign(new Error('historical stat denied'), { code: 'EACCES' });
    return await operation();
  } finally {
    current.active--;
    if (stat && ++current.finished === current.expected) current.drained?.();
  }
}

mock.module('node:fs/promises', {
  namedExports: {
    ...fs,
    stat: (...args: Parameters<typeof fs.stat>) =>
      track(String(args[0]), true, () => fs.stat(...args)),
    readdir: (...args: Parameters<typeof fs.readdir>) =>
      track(String(args[0]), false, () => fs.readdir(...args)),
  },
});
const { DEFAULT_RUN_BUNDLE_RETENTION, openRunBundleStore, reserveRunBundleMetadata } =
  await import('./retained.js');

async function fixture(t: TestContext, nested: boolean) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'retained-concurrency-'));
  const projects = process.env.FARMSLOT_PROJECTS_DIR;
  process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
  t.after(async () => {
    probe = undefined;
    if (projects === undefined) delete process.env.FARMSLOT_PROJECTS_DIR;
    else process.env.FARMSLOT_PROJECTS_DIR = projects;
    await fs.rm(root, { recursive: true, force: true });
  });
  const taskRoot = path.join(root, '.sandbox/tasks');
  await fs.mkdir(taskRoot, { recursive: true });
  for (let i = 0; i < 100; i++)
    await fs.writeFile(path.join(taskRoot, `media-${i}`), Buffer.alloc(8192));
  if (nested) {
    const directory = path.join(taskRoot, 'nested/inner');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'first'), Buffer.alloc(13));
    await fs.writeFile(path.join(directory, 'second'), Buffer.alloc(17));
  }
  const outside = path.join(root, 'outside');
  await fs.writeFile(outside, Buffer.alloc(32_768));
  await fs.symlink(outside, path.join(taskRoot, 'outside-link'));
  const store = await openRunBundleStore({
    runsDir: path.join(root, 'runs'),
    home: path.join(root, 'home'),
    create: true,
  });
  return {
    root,
    taskRoot,
    store,
    bytes: 100 * 8192 + (nested ? 30 : 0),
    files: nested ? 102 : 100,
  };
}

function gatedProbe(root: string, expected: number, failures = 0) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let drain!: () => void;
  const drained = new Promise<void>((resolve) => {
    drain = resolve;
  });
  const current: ScanProbe = {
    root,
    expected,
    active: 0,
    peak: 0,
    started: 0,
    finished: 0,
    failures,
    gate,
    entered: enter,
    drained: drain,
  };
  probe = current;
  return { current, entered, drained, release };
}

test(
  'historical accounting queues more than 64 reads, bounds them and charges nested bytes exactly',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t, true);
    const storeBytes = (await fs.stat(path.join(f.store.root, 'store.json'))).size;
    const reserve = 1024 ** 2;
    const exact = storeBytes + reserve + f.bytes;
    const policy = {
      ...DEFAULT_RUN_BUNDLE_RETENTION,
      metadataReserveBytes: reserve,
      maxStoreBytes: exact - 1,
    };
    const gate = gatedProbe(f.taskRoot, f.files);
    const refused = assert.rejects(
      reserveRunBundleMetadata(f.store, 'over-budget', policy, f.root),
      /capacity is exhausted/,
    );
    try {
      await gate.entered;
      assert.equal(gate.current.peak, 64, 'the historical tree must exercise the permit queue');
      assert.ok(gate.current.started < f.files, 'excess work must wait for permits');
    } finally {
      gate.release();
      await refused;
    }
    assert.equal(
      gate.current.finished,
      f.files,
      'every regular file, including nested files, is charged',
    );
    assert.equal(gate.current.active, 0);
    assert.equal(gate.current.peak, 64);
    await reserveRunBundleMetadata(
      f.store,
      'exact-budget',
      { ...policy, maxStoreBytes: exact },
      f.root,
    );
    const admitted = JSON.parse(
      await fs.readFile(path.join(f.store.root, 'reservations/exact-budget.json'), 'utf8'),
    );
    assert.equal(admitted.bytes, reserve, 'the exact sum fits, while one byte less did not');
  },
);

test(
  'failed filesystem reads hand permits to queued work and do not poison a fresh scan',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t, false);
    const gate = gatedProbe(f.taskRoot, f.files, 64);
    const refused = assert.rejects(reserveRunBundleMetadata(f.store, 'denied', undefined, f.root), {
      code: 'EACCES',
    });
    try {
      await gate.entered;
      assert.equal(gate.current.peak, 64);
    } finally {
      gate.release();
    }
    await refused;
    await gate.drained;
    assert.equal(
      gate.current.started,
      f.files,
      'queued reads receive permits even when every first-batch read fails',
    );
    assert.equal(gate.current.active, 0);
    assert.equal(gate.current.peak, 64);
    probe = undefined;
    await reserveRunBundleMetadata(f.store, 'recovered', undefined, f.root);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(f.store.root, 'reservations/recovered.json'), 'utf8'))
        .runId,
      'recovered',
    );
  },
);
