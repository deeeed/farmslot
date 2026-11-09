import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import fs, {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { openRunBundleStore } from '@farmslot/run-bundle';

import {
  migratePaths,
  type MigrationOptions,
  type MigrationPlan,
  planMigration,
} from './paths-migrate.js';
import { info, inventory } from './paths-migrate-io.js';
import { files, json } from './paths-migrate-plan.js';

async function put(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}
async function fixture(t: TestContext) {
  const started = performance.now();
  t.after(() =>
    assert.ok(performance.now() - started < 5000, 'new migration test must stay under 5 s'),
  );
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'farm-migrate-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'checkout');
  const runs = path.join(checkout, '.runs');
  const archive = path.join(root, 'old-archive');
  const current = path.join(home, 'run-archive');
  await mkdir(home);
  await mkdir(archive);
  await mkdir(current);
  const options: MigrationOptions = {
    home,
    checkoutRoot: checkout,
    userHome: root,
    env: {
      HOME: root,
      FARMSLOT_HOME: home,
      GATEWAY_PORT: '65419',
      CANARY_HOME: path.join(root, 'canary'),
    },
  };
  const store = await openRunBundleStore({ home, runsDir: runs, create: true });
  await put(path.join(home, 'run-bundle-retention.json'), {
    runBundleRetention: { storeRoot: store.root },
  });
  const payload = path.join(archive, 'run-a/old-generation/payload.txt');
  await put(payload, 'archived proof\n');
  const manifest = path.join(archive, 'run-a/manifest.json');
  await put(manifest, {
    runId: 'run-a',
    entries: [
      {
        source: path.join(home, 'task-pins/old-pin'),
        staged: path.join(home, 'task-pins/.retention-old'),
        partial: payload + '.copy',
        destination: payload,
        store: 'task-pins',
        state: 'archived',
        completedAt: '2026-01-01',
      },
    ],
  });
  await put(path.join(runs, 'run-a.json'), {
    id: 'run-a',
    status: 'done',
    links: [{ label: 'Storage archive', url: manifest }],
  });
  await put(path.join(runs, 'run-b.json'), { id: 'run-b', status: 'cancelled' });
  await put(path.join(home, 'run-bundles/sha256/digest/availability.json'), {
    archivedPaths: { 'proof.png': payload },
  });
  await put(path.join(home, 'task-pins/pin/provenance.json'), {
    receipt: {
      pin: path.join(home, 'task-pins/pin'),
      source: { packageRoot: path.join(home, 'task-pins/pin/package') },
    },
    taskDir: path.join(checkout, 'tasks/run-a'),
  });
  await put(path.join(checkout, 'tasks/run-a/artifacts/harness-provenance.json'), {
    pin: path.join(home, 'task-pins/pin'),
  });
  await put(path.join(checkout, 'slot/.farmslot-runtime/context.json'), { checkout });
  await put(path.join(home, 'state/feedback-ledger.json'), { entries: ['learning must survive'] });
  const snapshot = new Map<string, Buffer>();
  for (const file of await files(root)) snapshot.set(file, await readFile(file));
  return {
    root,
    home,
    checkout,
    archive,
    current,
    runs,
    store,
    options,
    snapshot,
    manifest,
    payload,
  };
}
async function assertLegacy(f: Awaited<ReturnType<typeof fixture>>) {
  for (const [file, body] of f.snapshot) assert.deepEqual(await readFile(file), body, file);
  assert.equal(await info(path.join(f.home, 'config/instance.json')), undefined);
}
async function assertMigrated(f: Awaited<ReturnType<typeof fixture>>, plan: MigrationPlan) {
  const paths = resolveFarmPaths({ home: f.home, role: 'gateway', env: {} });
  assert.equal(paths.layout, 2);
  assert.equal(paths.data.root, plan.dataRoot);
  assert.equal(
    (await openRunBundleStore({ home: f.home, runsDir: paths.state.runs })).root,
    paths.data.runBundles,
  );
  assert.deepEqual(
    await readFile(path.join(paths.data.runArchive, 'run-a/old-generation/payload.txt')),
    f.snapshot.get(f.payload),
  );
  const manifest = (await json(path.join(paths.data.runArchive, 'run-a/manifest.json'))) as {
    entries: { destination: string; partial: string; staged: string }[];
  };
  assert.ok(manifest.entries.every((entry) => entry.destination.startsWith(paths.data.runArchive)));
  for (const entry of manifest.entries) await readFile(entry.destination);
  const run = (await json(path.join(paths.state.runs, 'run-a.json'))) as {
    links: { url: string }[];
  };
  assert.equal(run.links[0].url, path.join(paths.data.runArchive, 'run-a/manifest.json'));
  await readFile(run.links[0].url);
  const availability = (await json(
    path.join(paths.data.runBundles, 'sha256/digest/availability.json'),
  )) as { archivedPaths: Record<string, string> };
  assert.equal(
    availability.archivedPaths['proof.png'],
    path.join(paths.data.runArchive, 'run-a/old-generation/payload.txt'),
  );
  const provenance = (await json(path.join(paths.state.taskPins, 'pin/provenance.json'))) as {
    receipt: { pin: string };
  };
  assert.equal(provenance.receipt.pin, path.join(paths.state.taskPins, 'pin'));
  const receipt = (await json(
    path.join(f.checkout, 'tasks/run-a/artifacts/harness-provenance.json'),
  )) as { pin: string };
  assert.equal(receipt.pin, provenance.receipt.pin);
  await readFile(path.join(receipt.pin, 'provenance.json'));
  assert.deepEqual(
    await readFile(path.join(f.checkout, 'slot/.farmslot-runtime/context.json')),
    f.snapshot.get(path.join(f.checkout, 'slot/.farmslot-runtime/context.json')),
  );
  const rewritten = new Set(
    plan.steps.filter((step) => step.kind === 'write').map((step) => step.target),
  );
  for (const step of plan.steps)
    if (step.kind === 'move') {
      const actual = await inventory(step.target);
      for (const [relative, expected] of Object.entries(step.expected))
        if (!rewritten.has(path.join(step.target, relative)))
          assert.deepEqual(actual[relative], expected, path.join(step.target, relative));
    }
}

test('plan is read-only; apply rewrites all owners and rollback restores legacy bytes', async (t) => {
  const f = await fixture(t);
  const before = await readdir(f.root, { recursive: true });
  const plan = await migratePaths(f.options, 'plan');
  assert.deepEqual(plan.conflicts, []);
  assert.ok(
    plan.steps.some((step) => step.kind === 'move' && step.bytes > 0 && step.method === 'rename'),
  );
  for (const name of [
    'bundle-store.json',
    'store.json',
    'run-bundle-retention.json',
    'availability.json',
    'provenance.json',
    'harness-provenance.json',
  ])
    assert.ok(
      plan.steps.some((step) => step.kind === 'write' && step.target.endsWith(name)),
      name,
    );
  assert.ok(plan.stays.some((entry) => entry.reason.includes('slot checkouts')));
  assert.deepEqual(await readdir(f.root, { recursive: true }), before);
  const applied = await migratePaths(f.options, 'apply');
  await assertMigrated(f, applied);
  assert.equal((await migratePaths(f.options, 'apply')).id, applied.id);
  await migratePaths(f.options, 'rollback');
  await assertLegacy(f);
  assert.equal((await migratePaths(f.options, 'rollback')).status, 'rolled-back');
});

test('two archive roots merge the same run and never drop duplicate entries', async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.current, 'run-a/new-generation/new.txt');
  await put(destination, 'new archive proof');
  const entry = { destination, state: 'archived', completedAt: '2026-01-02' };
  await put(path.join(f.current, 'run-a/manifest.json'), {
    runId: 'run-a',
    entries: [entry, entry],
  });
  const original = await readFile(path.join(f.current, 'run-a/manifest.json'));
  const plan = await migratePaths(f.options, 'apply');
  await assertMigrated(f, plan);
  const merged = (await json(path.join(plan.dataRoot, 'run-archive/run-a/manifest.json'))) as {
    entries: unknown[];
  };
  assert.equal(merged.entries.length, 3);
  await migratePaths(f.options, 'rollback');
  await assertLegacy(f);
  assert.deepEqual(await readFile(path.join(f.current, 'run-a/manifest.json')), original);
});

test('cross-volume journal verifies files and tree bytes before deleting; rollback copies back', async (t) => {
  const f = await fixture(t);
  const plan = await planMigration(f.options);
  for (const step of plan.steps) if (step.kind === 'move') step.method = 'copy';
  await put(plan.journal, plan);
  await assertMigrated(f, await migratePaths(f.options, 'apply'));
  await migratePaths(f.options, 'rollback');
  await assertLegacy(f);
});

for (const stop of ['move', 'write'] as const)
  test(`killed apply after a ${stop} step resumes the saved journal`, async (t) => {
    const f = await fixture(t);
    const child = fork(
      fileURLToPath(new URL('./paths-migrate.fixture.ts', import.meta.url)),
      [JSON.stringify(f.options), stop],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const event = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error(stderr);
      }),
    ]);
    assert.ok(event);
    child.kill('SIGKILL');
    await once(child, 'exit');
    const resumed = await migratePaths(f.options, 'apply');
    await assertMigrated(f, resumed);
    await migratePaths(f.options, 'rollback');
    await assertLegacy(f);
  });

for (const refusal of [
  'gateway-pid',
  'node-pid',
  'non-terminal',
  'staged-archive',
  'bundle-retention',
  'symlink-target',
  'space',
  'conflict',
] as const)
  test(`apply refuses ${refusal} without moving legacy files`, async (t) => {
    const f = await fixture(t);
    if (refusal === 'gateway-pid')
      await put(path.join(f.runs, 'gateway-65419.pid'), String(process.pid));
    if (refusal === 'node-pid') await put(path.join(f.home, 'node.pid'), String(process.pid));
    if (refusal === 'non-terminal')
      await put(path.join(f.runs, 'run-b.json'), { id: 'run-b', status: 'blocked' });
    if (refusal === 'staged-archive')
      await put(f.manifest, { runId: 'run-a', entries: [{ state: 'staged', staged: f.payload }] });
    if (refusal === 'bundle-retention')
      await mkdir(path.join(f.store.root, 'sha256/.retention-held'), { recursive: true });
    if (refusal === 'symlink-target') {
      await mkdir(path.join(f.root, 'redirect'));
      await symlink(path.join(f.root, 'redirect'), path.join(f.home, 'state/runs'));
    }
    if (refusal === 'conflict')
      await put(path.join(f.home, 'state/runs/run-a.json'), 'do not overwrite');
    const expected = {
      'gateway-pid': /running/,
      'node-pid': /running/,
      'non-terminal': /Non-terminal/,
      'staged-archive': /Staged/,
      'bundle-retention': /retention/,
      'symlink-target': /symlink/,
      space: /free space/,
      conflict: /Target exists/,
    }[refusal];
    await assert.rejects(
      migratePaths(
        f.options,
        'apply',
        refusal === 'space' ? { availableBytes: async () => 0 } : {},
      ),
      expected,
    );
    assert.equal(await info(path.join(f.home, 'config/instance.json')), undefined);
    assert.deepEqual(
      await readFile(path.join(f.runs, 'run-a.json')),
      f.snapshot.get(path.join(f.runs, 'run-a.json')),
    );
  });

test('apply refuses a listening instance port', async (t) => {
  const f = await fixture(t);
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  f.options.env = { ...f.options.env, GATEWAY_PORT: String(address.port) };
  await assert.rejects(migratePaths(f.options, 'apply'), /port is listening/);
});

test('archive payload collisions refuse rather than losing an entry', async (t) => {
  const f = await fixture(t);
  await put(path.join(f.current, 'run-a/old-generation/payload.txt'), 'different bytes');
  await assert.rejects(migratePaths(f.options, 'apply'), /Target exists/);
});

test('a bundle store already under the data root stays and its runs owner is rewritten', async (t) => {
  const f = await fixture(t);
  const data = path.join(f.root, 'volume');
  const target = path.join(data, 'run-bundles');
  const { rename } = await import('node:fs/promises');
  await mkdir(data);
  await rename(f.store.root, target);
  const binding = { ...f.store, root: target };
  await put(path.join(f.runs, 'bundle-store.json'), binding);
  await put(path.join(target, 'store.json'), binding);
  await put(path.join(f.home, 'run-bundle-retention.json'), {
    runBundleRetention: { storeRoot: target },
  });
  f.options.data = data;
  const plan = await migratePaths(f.options, 'apply');
  assert.ok(!plan.steps.some((step) => step.kind === 'move' && step.source === target));
  assert.ok(plan.stays.some((entry) => entry.path === target));
  assert.equal(
    (await openRunBundleStore({ home: f.home, runsDir: path.join(f.home, 'state/runs') })).root,
    target,
  );
  await migratePaths(f.options, 'rollback');
  assert.deepEqual(await json(path.join(target, 'store.json')), binding);
});

test('rollback reverses an interrupted apply without needing to finish it', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    migratePaths(f.options, 'apply', {
      checkpoint: async (plan, index) => {
        if (plan.steps[index].kind === 'write' && plan.steps[index].status === 'done')
          throw new Error('simulated interruption');
      },
    }),
    /simulated interruption/,
  );
  await migratePaths(f.options, 'rollback');
  await assertLegacy(f);
});

test('copy verification refuses mutated bytes and preserves the source', async (t) => {
  const f = await fixture(t);
  const plan = await planMigration(f.options);
  const move = plan.steps.find((step) => step.kind === 'move');
  assert.ok(move && move.kind === 'move');
  move.method = 'copy';
  await put(plan.journal, plan);
  const file = (await files(move.source))[0];
  await writeFile(file, 'changed after planning');
  await assert.rejects(migratePaths(f.options, 'apply'), /bytes changed/);
  assert.equal(await readFile(file, 'utf8'), 'changed after planning');
  assert.equal(await info(move.target), undefined);
});

test('a directly launched node without a pid file refuses migration', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.checkout, 'services/node/dist/index.js');
  await put(script, 'process.send({ready:true}); setInterval(() => {}, 1000);');
  const child = fork(script, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await once(child, 'message');
  await assert.rejects(migratePaths(f.options, 'apply'), /node is running/);
  child.kill('SIGKILL');
  await once(child, 'exit');
});

test('slot checkouts nested under projects remain at their original path', async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.checkout, 'projects/fixture/slot');
  const runtime = path.join(repo, '.farmslot-runtime/context.json');
  await put(runtime, { repo });
  await put(path.join(f.checkout, 'pool/machine.json'), { slots: [{ id: 'slot', repo }] });
  const body = await readFile(runtime);
  const result = await migratePaths(f.options, 'apply');
  assert.ok(result.stays.some((entry) => entry.path === repo));
  assert.deepEqual(await readFile(runtime), body);
  const pool = (await json(path.join(f.home, 'pool/machine.json'))) as {
    slots: { repo: string }[];
  };
  assert.equal(pool.slots[0].repo, repo);
  await migratePaths(f.options, 'rollback');
  assert.deepEqual(await readFile(runtime), body);
});

test('rollback handles a journal persisted before the first move', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    migratePaths(f.options, 'apply', {
      checkpoint: async () => {
        throw new Error('interrupted before mutation');
      },
    }),
    /interrupted before mutation/,
  );
  await migratePaths(f.options, 'rollback');
  await assertLegacy(f);
});

test('home-expanded retention settings are rewritten to the new store', async (t) => {
  const f = await fixture(t);
  const { homedir } = await import('node:os');
  const root = `~/${path.relative(homedir(), f.store.root)}`;
  await put(path.join(f.home, 'run-bundle-retention.json'), {
    runBundleRetention: { storeRoot: root },
  });
  const plan = await migratePaths(f.options, 'apply');
  await assertMigrated(f, plan);
  await migratePaths(f.options, 'rollback');
  const restored = (await json(path.join(f.home, 'run-bundle-retention.json'))) as {
    runBundleRetention: { storeRoot: string };
  };
  assert.equal(restored.runBundleRetention.storeRoot, root);
});

test('migrated layout-2 account selection runs through the provider script', async (t) => {
  const f = await fixture(t);
  await put(path.join(f.home, 'provider-accounts.json'), {
    version: 1,
    accounts: { seat: { provider: 'codex', authPath: path.join(f.root, 'seat-auth.json') } },
    slotBindings: { slot: 'seat' },
  });
  await migratePaths(f.options, 'apply');
  const paths = resolveFarmPaths({ home: f.home, role: 'node', env: {} });
  const script = fileURLToPath(
    new URL('../../../../scripts/provider-account-cli.mjs', import.meta.url),
  );
  const selected = JSON.parse(
    execFileSync(process.execPath, [script, 'resolve', '--slot-id', 'slot'], {
      env: { ...process.env, FARMSLOT_HOME: f.home, FARMSLOT_CONFIG_DIR: paths.config },
      encoding: 'utf8',
    }),
  );
  assert.equal(selected.label, 'seat');
  assert.equal(selected.authPath, path.join(f.root, 'seat-auth.json'));
});

for (const copy of [false, true])
  test(`archive task trees preserve links, empty directories and modes, copy=${copy}`, async (t) => {
    const f = await fixture(t);
    const task = path.join(f.archive, 'run-a/old-generation/task');
    await mkdir(path.join(task, 'empty'), { recursive: true });
    await put(path.join(task, 'script'), 'proof');
    await fs.chmod(task, 0o750);
    await fs.chmod(path.join(task, 'empty'), 0o700);
    await fs.chmod(path.join(task, 'script'), 0o751);
    await symlink('script', path.join(task, 'link'));
    const originalTarget = `${task}/empty/../script`;
    await symlink(originalTarget, path.join(task, 'absolute-link'));
    await symlink('absolute-link', path.join(task, 'chain-link'));
    const outside = path.join(f.checkout, 'outside.txt');
    await put(outside, 'outside proof');
    await symlink(outside, path.join(task, 'outside-link'));
    if (!copy) {
      await mkdir(path.join(f.archive, 'empty'));
      await symlink('run-a/old-generation/payload.txt', path.join(f.archive, 'loose-link'));
    }
    const expected = await inventory(task);
    const plan = await planMigration(f.options);
    if (copy) for (const step of plan.steps) if (step.kind === 'move') step.method = 'copy';
    await put(plan.journal, plan);
    await migratePaths(f.options, 'apply');
    const movedTask = path.join(plan.dataRoot, 'run-archive/run-a/old-generation/task');
    for (const [link, body] of [
      ['link', 'proof'],
      ['chain-link', 'proof'],
      ['absolute-link', 'proof'],
      ['outside-link', 'outside proof'],
    ])
      assert.equal(await readFile(path.join(movedTask, link), 'utf8'), body);
    assert.equal(
      await fs.readlink(path.join(movedTask, 'absolute-link')),
      path.join(movedTask, 'script'),
    );
    const migrated = await inventory(movedTask);
    assert.deepEqual(migrated, {
      ...expected,
      'absolute-link': { ...expected['absolute-link'], digest: path.join(movedTask, 'script') },
    });
    if (!copy) {
      assert.equal(
        await fs.readlink(path.join(plan.dataRoot, 'run-archive/loose-link')),
        'run-a/old-generation/payload.txt',
      );
      assert.equal(
        await readFile(path.join(plan.dataRoot, 'run-archive/loose-link'), 'utf8'),
        'archived proof\n',
      );
      assert.ok((await fs.lstat(path.join(plan.dataRoot, 'run-archive/empty'))).isDirectory());
    }
    await migratePaths(f.options, 'rollback');
    if (!copy) {
      assert.equal(
        await fs.readlink(path.join(f.archive, 'loose-link')),
        'run-a/old-generation/payload.txt',
      );
      assert.equal(await readFile(path.join(f.archive, 'loose-link'), 'utf8'), 'archived proof\n');
    }
    for (const [link, body] of [
      ['link', 'proof'],
      ['chain-link', 'proof'],
      ['absolute-link', 'proof'],
      ['outside-link', 'outside proof'],
    ])
      assert.equal(await readFile(path.join(task, link), 'utf8'), body);
    assert.equal(await fs.readlink(path.join(task, 'absolute-link')), originalTarget);
    assert.deepEqual(await inventory(task), expected);
    await assertLegacy(f);
  });

for (const copy of [false, true])
  test(`absolute links resolve symlinks before parent traversal, copy=${copy}`, async (t) => {
    const f = await fixture(t);
    const task = path.join(f.archive, 'run-a/old-generation/task');
    await mkdir(path.join(task, 'dir/nested'), { recursive: true });
    await put(path.join(task, 'proof.txt'), 'lexical decoy');
    await put(path.join(task, 'dir/proof.txt'), 'real target bytes');
    await symlink('dir/nested', path.join(task, 'alias'));
    const original = `${task}/alias/../proof.txt`;
    await symlink(original, path.join(task, 'proof-link'));
    assert.equal(await readFile(path.join(task, 'proof-link'), 'utf8'), 'real target bytes');
    const externalAlias = path.join(f.root, 'external-alias');
    await symlink(path.join(task, 'dir/nested'), externalAlias);
    await symlink(`${externalAlias}/../proof.txt`, path.join(task, 'external-alias-link'));
    const before = await inventory(task);
    const plan = await planMigration(f.options);
    if (copy) for (const step of plan.steps) if (step.kind === 'move') step.method = 'copy';
    await put(plan.journal, plan);
    await migratePaths(f.options, 'apply');
    const movedTask = path.join(plan.dataRoot, 'run-archive/run-a/old-generation/task');
    assert.equal(await readFile(path.join(movedTask, 'proof-link'), 'utf8'), 'real target bytes');
    assert.equal(
      await fs.readlink(path.join(movedTask, 'proof-link')),
      path.join(movedTask, 'dir/proof.txt'),
    );
    assert.equal(
      await readFile(path.join(movedTask, 'external-alias-link'), 'utf8'),
      'real target bytes',
    );
    await migratePaths(f.options, 'rollback');
    assert.equal(await readFile(path.join(task, 'proof-link'), 'utf8'), 'real target bytes');
    assert.equal(await fs.readlink(path.join(task, 'proof-link')), original);
    assert.equal(
      await readFile(path.join(task, 'external-alias-link'), 'utf8'),
      'real target bytes',
    );
    assert.deepEqual(await inventory(task), before);
  });

for (const target of [
  'missing',
  'cycle',
  'relative-escape',
  'moving-external',
  'missing-before-parent',
  'file-before-parent',
  'file-trailing-slash',
  'escaping-alias',
] as const)
  test(`dangling migration link refuses before mutation: ${target}`, async (t) => {
    const f = await fixture(t);
    const task = path.join(f.archive, 'run-a/old-generation/task');
    await mkdir(task);
    const link = path.join(task, 'bad-link');
    const outside = path.join(f.root, 'external');
    await mkdir(path.join(outside, 'nested'), { recursive: true });
    await put(path.join(outside, 'proof.txt'), 'external proof');
    await symlink(path.join(outside, 'nested'), path.join(task, 'alias'));
    const targets = {
      missing: path.join(task, 'missing'),
      'missing-before-parent': `${task}/missing/../proof.txt`,
      'file-before-parent': `${task}/proof.txt/../proof.txt`,
      'file-trailing-slash': `${task}/proof.txt/`,
      'escaping-alias': `${task}/alias/../proof.txt`,
      cycle: link,
      'relative-escape': '../../../../missing',
      'moving-external': path.join(f.home, 'task-pins/pin/provenance.json'),
    };
    await put(path.join(task, 'proof.txt'), 'proof');
    await symlink(targets[target], link);
    const before = await inventory(f.root);
    await assert.rejects(migratePaths(f.options, 'apply'), /symlink|link/i);
    assert.deepEqual(await inventory(f.root), before);
    await assertLegacy(f);
  });

test('rollback resumes after interruption during cross-volume target removal', async (t) => {
  const f = await fixture(t);
  const plan = await planMigration(f.options);
  for (const step of plan.steps) if (step.kind === 'move') step.method = 'copy';
  await put(plan.journal, plan);
  await migratePaths(f.options, 'apply');
  const move = plan.steps.find(
    (step) => step.kind === 'move' && step.source.endsWith('/task-pins'),
  );
  assert.ok(move && move.kind === 'move');
  const original = fs.rm;
  const patched = mock.method(
    fs,
    'rm',
    async (file: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
      if (file === move.target) {
        await original(path.join(move.target, 'pin/provenance.json'));
        throw new Error('interrupted target removal');
      }
      return original(file, options);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(migratePaths(f.options, 'rollback'), /interrupted target removal/);
  } finally {
    patched.mock.restore();
    syncBuiltinESMExports();
  }
  await migratePaths(f.options, 'rollback');
  await assertLegacy(f);
  assert.equal(await info(move.target), undefined);
});
