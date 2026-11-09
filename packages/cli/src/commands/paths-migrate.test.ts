import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
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

import type { FleetStatus } from '@farmslot/protocol';
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
  await put(path.join(home, 'run-bundles/availability/digest.json'), {
    archivedPaths: { 'proof.png': payload },
  });
  await put(path.join(home, 'task-pins/pin/provenance.json'), {
    receipt: {
      pin: path.join(home, 'task-pins/pin'),
      source: { packageRoot: path.join(home, 'task-pins/pin/package') },
    },
    taskDir: path.join(home, 'task-pins/pin/task'),
  });
  await put(path.join(home, 'task-pins/pin/task/artifacts/harness-provenance.json'), {
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
    path.join(paths.data.runBundles, 'availability/digest.json'),
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
    path.join(paths.state.taskPins, 'pin/task/artifacts/harness-provenance.json'),
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
    'digest.json',
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

for (const originalKind of ['absolute', 'relative'] as const)
  test(`legacy bin links follow moved CLI distribution and roll back: ${originalKind}`, async (t) => {
    const f = await fixture(t);
    const bin = path.join(f.root, '.local/bin');
    const cli = path.join(
      f.root,
      '.local/share/farmslot-cli/revision/packages/cli/bin/farmslot.mjs',
    );
    await put(cli, 'synthetic CLI entrypoint');
    await mkdir(bin, { recursive: true });
    const link = path.join(bin, 'farmslot');
    const original = originalKind === 'relative' ? path.relative(bin, cli) : cli;
    await symlink(original, link);
    const unrelated = path.join(bin, 'other');
    await symlink(path.join(f.checkout, 'slot/.farmslot-runtime/context.json'), unrelated);
    const plan = await planMigration(f.options);
    assert.deepEqual(plan.conflicts, []);
    assert.ok(plan.steps.some((step) => step.kind === 'symlink' && step.target === link));
    assert.ok(!plan.steps.some((step) => step.target === unrelated));
    await put(plan.journal, plan);
    await migratePaths(f.options, 'apply');
    assert.equal(
      await fs.readlink(link),
      path.join(f.home, 'code/cli/revision/packages/cli/bin/farmslot.mjs'),
    );
    assert.equal(await readFile(link, 'utf8'), 'synthetic CLI entrypoint');
    assert.equal(
      await fs.readlink(unrelated),
      path.join(f.checkout, 'slot/.farmslot-runtime/context.json'),
    );
    await migratePaths(f.options, 'rollback');
    assert.equal(await fs.readlink(link), original);
    assert.equal(await readFile(link, 'utf8'), 'synthetic CLI entrypoint');
    assert.equal(
      await fs.readlink(unrelated),
      path.join(f.checkout, 'slot/.farmslot-runtime/context.json'),
    );
  });

for (const resume of ['apply', 'rollback'] as const)
  for (const replaced of [false, true])
    test(`bin link rewrite recovers an interrupted rename: ${resume}, replaced=${replaced}`, async (t) => {
      const f = await fixture(t);
      const cli = path.join(f.root, '.local/share/farmslot-cli/revision/cli.mjs');
      const link = path.join(f.root, '.local/bin/farmslot');
      await put(cli, 'synthetic CLI entrypoint');
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(cli, link);
      const original = fs.rename;
      const patched = mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
        if (args[1] === link) {
          if (replaced) await original(...args);
          throw new Error('interrupted link replacement');
        }
        return original(...args);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(migratePaths(f.options, 'apply'), /interrupted link replacement/);
      } finally {
        patched.mock.restore();
        syncBuiltinESMExports();
      }
      await migratePaths(f.options, resume);
      assert.equal(await readFile(link, 'utf8'), 'synthetic CLI entrypoint');
      assert.equal(
        await fs.readlink(link),
        resume === 'apply' ? path.join(f.home, 'code/cli/revision/cli.mjs') : cli,
      );
      if (resume === 'apply') await migratePaths(f.options, 'rollback');
      assert.equal(await fs.readlink(link), cli);
    });

test('changed legacy bin link refuses before migration mutation', async (t) => {
  const f = await fixture(t);
  const cli = path.join(f.root, '.local/share/farmslot-cli/revision/cli.mjs');
  const link = path.join(f.root, '.local/bin/farmslot');
  await put(cli, 'synthetic CLI entrypoint');
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(cli, link);
  const plan = await planMigration(f.options);
  await put(plan.journal, plan);
  await rm(link);
  await symlink(f.payload, link);
  const before = await inventory(f.root);
  await assert.rejects(migratePaths(f.options, 'apply'), /Migration link changed/);
  assert.deepEqual(await inventory(f.root), before);
});

for (const location of ['slot', 'other-lane'] as const)
  test(`historical task receipt outside farm roots is retained: ${location}`, async (t) => {
    const f = await fixture(t);
    const taskDir = path.join(location === 'slot' ? f.checkout : f.root, location, '.agent/task');
    const receipt = path.join(taskDir, 'artifacts/harness-provenance.json');
    const raw = JSON.stringify({ pin: path.join(f.home, 'task-pins/pin') }) + '\n';
    await put(receipt, raw);
    await put(path.join(f.home, 'task-pins/pin/provenance.json'), {
      taskDir,
      pin: path.join(f.home, 'task-pins/pin'),
    });
    if (location === 'slot')
      await put(path.join(f.checkout, 'pool/machine.json'), {
        slots: [{ repo: path.join(f.checkout, 'slot') }],
      });
    const plan = await planMigration(f.options);
    assert.deepEqual(plan.conflicts, []);
    assert.ok(
      plan.stays.some(
        (entry) =>
          entry.path === receipt && entry.reason === 'historical receipt outside farm roots',
      ),
    );
    assert.ok(!plan.steps.some((step) => step.kind === 'write' && step.source === receipt));
    await migratePaths(f.options, 'apply');
    assert.equal(await readFile(receipt, 'utf8'), raw);
    assert.deepEqual(await json(path.join(f.home, 'state/task-pins/pin/provenance.json')), {
      taskDir,
      pin: path.join(f.home, 'state/task-pins/pin'),
    });
  });

test('plan ignores checkout JSONC and arbitrary task artifacts', async (t) => {
  const f = await fixture(t);
  const evidenceManifest = path.join(
    f.checkout,
    'projects/pack/tasks/fix/task/artifacts/manifest.json',
  );
  const ignored = [
    [path.join(f.home, 'task-pins/pin/cli/.vscode/settings.json'), '// checkout settings\n{}'],
    [path.join(f.checkout, 'projects/pack/tasks/fix/task/artifacts/empty.json'), ''],
    [
      path.join(f.checkout, 'projects/pack/tasks/fix/task/artifacts/failure.json'),
      'Recipe artifact failure',
    ],
    [path.join(f.home, 'review-workspaces/review/node_modules/pkg/data.json'), '{invalid'],
    [path.join(f.checkout, '.backups/old.json'), '{invalid'],
    [evidenceManifest, 'Recipe artifact manifest'],
    [path.join(f.home, 'sources.json'), '{opaque declaration}'],
    [
      path.join(f.checkout, 'projects/pack/tasks/fix/task/artifacts/proof.json'),
      JSON.stringify({ path: f.home + '/task-pins/pin' }),
    ],
    [path.join(f.home, 'task-pins/pin/cli/node_modules/pkg/data.json'), '{invalid'],
  ];
  for (const [file, body] of ignored) await put(file, body);
  const run = await json(path.join(f.runs, 'run-a.json'));
  assert.ok(run && typeof run === 'object' && 'links' in run && Array.isArray(run.links));
  run.links.push({ label: 'Evidence', url: evidenceManifest });
  await put(path.join(f.runs, 'run-a.json'), run);
  const opened: string[] = [];
  const original = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof readFile>) => {
    opened.push(String(args[0]));
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const plan = await planMigration(f.options);
  assert.deepEqual(plan.conflicts, []);
  for (const [file] of ignored) {
    assert.ok(!plan.steps.some((step) => step.kind === 'write' && step.source === file), file);
    // Move inventories hash bytes through streams; document discovery must not open these.
    assert.ok(!opened.includes(file), file);
  }
});

test('archived evidence keeps its bytes and manifest digest after apply', async (t) => {
  const f = await fixture(t);
  const evidence = path.join(f.archive, 'run-a/old-generation/evidence.json');
  const raw = `{ "path": "${f.home}/task-pins/pin", "proof": true }\n`;
  await put(evidence, raw);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const identity = (await inventory(evidence))[''];
  const verifiedCopy = { '': `${identity.mode}:${sha256}` };
  const manifest = await json(f.manifest);
  assert.ok(manifest && typeof manifest === 'object' && 'entries' in manifest);
  assert.ok(Array.isArray(manifest.entries));
  manifest.entries.push({
    destination: evidence,
    verifiedCopy,
    state: 'archived',
    completedAt: '2026-01-01',
  });
  await put(f.manifest, manifest);
  // Nested manifests are evidence too, even when they look like storage manifests.
  const nested = path.join(f.archive, 'run-a/old-generation/task/manifest.json');
  await put(nested, { runId: 'task', entries: [{ destination: evidence }], path: f.home });
  const nestedBytes = await readFile(nested);
  const opaque = path.join(f.archive, 'run-a/old-generation/task/artifacts/manifest.json');
  await put(opaque, 'Recipe artifact ' + f.home);
  const opaqueBytes = await readFile(opaque);
  const plan = await migratePaths(f.options, 'apply');
  const moved = path.join(plan.dataRoot, 'run-archive/run-a/old-generation/evidence.json');
  assert.equal(await readFile(moved, 'utf8'), raw);
  assert.deepEqual(
    await readFile(
      path.join(plan.dataRoot, 'run-archive/run-a/old-generation/task/artifacts/manifest.json'),
    ),
    opaqueBytes,
  );
  const migrated = await json(path.join(plan.dataRoot, 'run-archive/run-a/manifest.json'));
  assert.ok(migrated && typeof migrated === 'object' && 'entries' in migrated);
  assert.ok(Array.isArray(migrated.entries));
  const entry = migrated.entries.find(
    (entry: { destination: string }) => entry.destination === moved,
  );
  assert.equal(
    createHash('sha256')
      .update(await readFile(moved))
      .digest('hex'),
    entry.verifiedCopy[''].split(':')[1],
  );
  assert.deepEqual(
    await readFile(path.join(plan.dataRoot, 'run-archive/run-a/old-generation/task/manifest.json')),
    nestedBytes,
  );
});

for (const relative of [
  'checkout/pool/local.json',
  'checkout/projects/pack/project.json',
  'home/run-bundle-retention.json',
  'checkout/.runs/bundle-store.json',
  'home/run-bundles/store.json',
  'home/git-identity.json',
  'home/provider-accounts.json',
  'checkout/.backlog.json',
  'checkout/.dispatch-queue.json',
  'checkout/.farm-status.json',
  'checkout/.work-graphs/graph.json',
  'checkout/.runs/review-workspace-tasks/run-a/snapshot.json',
  'checkout/.runs/review-workspace-support/admissions/run-a.json',
  'checkout/.runs/machine-parking-batches/operation.json',
  'home/review-workspaces/owner/operations/operation/operation.json',
  'home/native-sessions/sessions/session.journal',
  'home/native-sessions/nodes/node-a/sessions/session.journal',
  'checkout/.runs/retained-acceptance-links/task.json',
  'home/sources/runtime-settings/pack.json',
  'home/sources/gateway/receipts/digest.json',
  'home/sources/node/receipts/digest.json',
  'checkout/.runs/run-a.json',
  'checkout/.runs/archive/run-c.json',
  'checkout/.runs/run-a.decisions.jsonl',
  'home/run-bundles/availability/digest.json',
  'old-archive/run-a/manifest.json',
  'home/task-pins/pin/provenance.json',
  'home/task-pins/pin/task/artifacts/harness-provenance.json',
])
  test(`malformed owned document is a named conflict before mutation: ${relative}`, async (t) => {
    const f = await fixture(t);
    const file = path.join(f.root, relative);
    await put(file, '{invalid owned document');
    const before = await inventory(f.root);
    const plan = await migratePaths(f.options, 'plan');
    assert.ok(plan.conflicts.some((conflict) => conflict.includes(file)));
    await assert.rejects(migratePaths(f.options, 'apply'), /Migration conflicts/);
    assert.deepEqual(await inventory(f.root), before);
  });

test('owned configuration, source receipts and run history references still rewrite', async (t) => {
  const f = await fixture(t);
  const old = path.join(f.home, 'task-pins/pin');
  const owners = [
    [path.join(f.checkout, 'pool/local.json'), { slots: [], runtime_dir: old }],
    [path.join(f.checkout, 'projects/pack/project.json'), { repo: old }],
    [path.join(f.home, 'git-identity.json'), { 'user.signingkey': old }],
    [path.join(f.checkout, '.work-graphs/graph.json'), { reference: { ref: old } }],
    [
      path.join(f.home, 'sources/runtime-settings/pack.json'),
      { values: { backlog: { root: old } } },
    ],
    [path.join(f.home, 'sources/gateway/receipts/digest.json'), { roots: { source: old } }],
    [path.join(f.home, 'sources/node/receipts/digest.json'), { receiptPath: old }],
    [path.join(f.runs, 'archive/run-c.json'), { id: 'run-c', status: 'done', taskFile: old }],
    [
      path.join(f.runs, 'run-a.decisions.jsonl'),
      JSON.stringify({ artifacts: [{ path: old }] }) + '\n',
    ],
    [
      path.join(f.runs, 'archive/run-c.decisions.jsonl'),
      JSON.stringify({ artifacts: [{ path: old }] }) + '\n',
    ],
  ] as const;
  for (const [file, value] of owners) await put(file, value);
  const plan = await migratePaths(f.options, 'plan');
  assert.deepEqual(plan.conflicts, []);
  for (const [file] of owners) {
    const step = plan.steps.find((step) => step.kind === 'write' && step.source === file);
    assert.ok(step?.kind === 'write', file);
    assert.ok(step.body.includes(path.join(f.home, 'state/task-pins/pin')), file);
    assert.ok(!step.body.includes(old), file);
  }
});

test('pass 2: native provider profiles retain their moved runner directory', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.home, 'runner-profiles/codex/work');
  await put(path.join(directory, 'auth.json'), '{ opaque native credentials }');
  await put(path.join(f.home, 'provider-accounts.json'), {
    version: 1,
    accounts: {},
    nativeProfiles: {
      work: {
        id: 'work',
        runner: 'codex',
        directory,
        accountContextId: '12345678-1234-1234-1234-123456789abc',
        state: 'active',
      },
    },
  });
  await migratePaths(f.options, 'apply');
  const config = await json(path.join(f.home, 'config/provider-accounts.json'));
  assert.ok(config && typeof config === 'object' && 'nativeProfiles' in config);
  assert.deepEqual(config.nativeProfiles, {
    work: {
      id: 'work',
      runner: 'codex',
      directory: path.join(f.home, 'config/runner-profiles/codex/work'),
      accountContextId: '12345678-1234-1234-1234-123456789abc',
      state: 'active',
    },
  });
  await readFile(path.join(f.home, 'config/runner-profiles/codex/work/auth.json'));
});

test('pass 2: backlog specPath stays inside the migrated spec directory', async (t) => {
  const f = await fixture(t);
  const specPath = path.join(f.checkout, '.backlog/specs/x.md');
  await put(specPath, '# Acceptance criteria\n- Works\n');
  await put(path.join(f.checkout, '.backlog.json'), [{ id: 'item', specPath }]);
  await migratePaths(f.options, 'apply');
  const paths = resolveFarmPaths({ home: f.home, role: 'gateway', env: {} });
  assert.deepEqual(await json(paths.state.backlogFile), [
    { id: 'item', specPath: path.join(paths.state.backlogSpecs, 'x.md') },
  ]);
  await readFile(path.join(paths.state.backlogSpecs, 'x.md'));
});

test('pass 3: relative backlog specPath reads, enqueues and rolls back its original bytes', async (t) => {
  const started = performance.now();
  t.after(() =>
    assert.ok(performance.now() - started < 5000, 'spec migration must stay under 5 s'),
  );
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'farm-migrate-spec-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'checkout');
  await mkdir(home);
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
  const f = { root, home, checkout, options };
  await put(path.join(f.checkout, 'projects/test/project.json'), { name: 'test' });
  const specPath = '.backlog/specs/x.md';
  const markdown = '# Spec\n\n## Acceptance Criteria\n- Works\n';
  await put(path.join(f.checkout, specPath), markdown);
  const backlogFile = path.join(f.checkout, '.backlog.json');
  await put(backlogFile, [
    {
      id: 'item',
      project: 'test',
      title: 'Relative spec',
      sourceKind: 'manual',
      sourceRef: 'MANUAL-000001',
      flowType: 'dev',
      status: 'ready',
      priority: 10,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      specPath,
      notes: specPath,
    },
    { id: 'outside', specPath: 'tasks/unmoved.md' },
  ]);
  const before = await readFile(backlogFile);
  await migratePaths(f.options, 'apply');
  const paths = resolveFarmPaths({ home: f.home, role: 'gateway', env: {} });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('FARMSLOT_')) delete env[key];
  delete env.TMUX;
  Object.assign(env, {
    HOME: f.root,
    FARMSLOT_HOME: f.home,
    FARMSLOT_ROOT: f.checkout,
    TMUX_TMPDIR: f.root,
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    NODE_TEST_CONTEXT: '1',
    TSX_TSCONFIG_PATH: fileURLToPath(
      new URL('../../../../services/gateway/tsconfig.json', import.meta.url),
    ),
  });
  const migratedBytes = await readFile(paths.state.backlogFile);
  const migrated = await json(paths.state.backlogFile);
  assert.ok(Array.isArray(migrated));
  assert.equal(migrated[0].notes, specPath);
  assert.deepEqual(migrated[1], { id: 'outside', specPath: 'tasks/unmoved.md' });
  const fleet = {
    checkedAt: new Date().toISOString(),
    slots: [],
    summary: {
      total: 0,
      ready: 0,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  } satisfies FleetStatus;
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import * as backlog from './services/gateway/src/backlog/store.ts';
    import * as queue from './services/gateway/src/backlog/dispatch-queue.ts';
    import { setCachedFleetForTests } from './services/gateway/src/fleet/state.ts';
    setCachedFleetForTests(${JSON.stringify(fleet)});
    queue.initDispatchQueue(() => {}, async () => {});
    await backlog.loadBacklog();
    const spec = await backlog.getBacklogSpec({ itemId: 'item' });
    assert.equal(spec.content, ${JSON.stringify(markdown)});
    assert.equal(spec.path, ${JSON.stringify(path.join(paths.state.backlogSpecs, 'x.md'))});
    const result = await backlog.enqueueBacklogItem(
      { itemId: 'item' }, { dispatchOriginator: { kind: 'system' } }, { kind: 'system' },
    );
    assert.equal(result.item.status, 'queued');
    assert.deepEqual(result.queueItem.ticketData.acceptanceCriteria, ['Works']);
    await backlog.flushBacklogForTests();
    await queue.persistQueueNow();
  `,
    ],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env,
      encoding: 'utf8',
    },
  );
  // Enqueue mutates the backlog; restore the applied bytes before testing migration rollback.
  await writeFile(paths.state.backlogFile, migratedBytes);
  await migratePaths(f.options, 'rollback');
  assert.deepEqual(await readFile(backlogFile), before);
  assert.equal(await readFile(path.join(f.checkout, specPath), 'utf8'), markdown);
});

test('pass 2: review task snapshot matches the migrated Run workspace identity', async (t) => {
  const f = await fixture(t);
  const workspace = {
    workspaceId: 'review',
    checkoutPath: path.join(f.home, 'review-workspaces/review/repo'),
    taskPath: path.join(f.home, 'review-workspaces/review/task'),
    artifactPath: path.join(f.home, 'review-workspaces/review/task/artifacts'),
  };
  await put(path.join(f.runs, 'review.json'), {
    id: 'review',
    status: 'done',
    reviewWorkspace: workspace,
  });
  await put(path.join(f.runs, 'review-workspace-tasks/review/snapshot.json'), {
    version: 1,
    runId: 'review',
    workspace,
    prompt: `Read '${workspace.taskPath}/TASK.md'. Run '${workspace.taskPath}/mark' start before reviewing.`,
    files: [{ path: 'inputs/review-subject.json', sha256: 'frozen' }],
  });
  const frozen = path.join(
    f.runs,
    'review-workspace-tasks/review/bundle/inputs/review-subject.json',
  );
  const bytes = JSON.stringify({ checkoutPath: workspace.checkoutPath });
  await put(frozen, bytes);
  await migratePaths(f.options, 'apply');
  const paths = resolveFarmPaths({ home: f.home, role: 'gateway', env: {} });
  const run = await json(path.join(paths.state.runs, 'review.json'));
  const snapshot = await json(
    path.join(paths.state.runs, 'review-workspace-tasks/review/snapshot.json'),
  );
  assert.ok(run && typeof run === 'object' && 'reviewWorkspace' in run);
  assert.ok(snapshot && typeof snapshot === 'object' && 'workspace' in snapshot);
  assert.deepEqual(snapshot.workspace, run.reviewWorkspace);
  assert.ok('prompt' in snapshot);
  assert.equal(
    snapshot.prompt,
    `Read '${f.home}/state/review-workspaces/review/task/TASK.md'. Run '${f.home}/state/review-workspaces/review/task/mark' start before reviewing.`,
  );
  assert.equal(
    await readFile(
      path.join(
        paths.state.runs,
        'review-workspace-tasks/review/bundle/inputs/review-subject.json',
      ),
      'utf8',
    ),
    bytes,
  );
});

for (const stagedExists of [false, true])
  test(`pass 2: merged manifest already at destination refuses staged entry, staged file ${stagedExists}`, async (t) => {
    const f = await fixture(t);
    await rm(f.current, { recursive: true });
    const data = path.join(f.root, 'external-data');
    const archive = path.join(data, 'run-archive');
    const target = path.join(archive, 'run-a/manifest.json');
    const staged = path.join(f.root, 'staged-payload');
    if (stagedExists) await put(staged, 'staged bytes');
    await put(target, {
      runId: 'run-a',
      entries: [
        {
          state: stagedExists ? 'archived' : 'staged',
          staged,
          destination: path.join(archive, 'run-a/payload'),
        },
      ],
    });
    const options = {
      ...f.options,
      data,
      env: { ...f.options.env, FARMSLOT_RUN_ARCHIVE_ROOT: archive },
    };
    const plan = await planMigration(options);
    assert.deepEqual(plan.conflicts, []);
    assert.ok(
      plan.steps.some(
        (step) => step.kind === 'write' && step.target === target && step.source?.includes(', '),
      ),
    );
    const before = await inventory(f.root);
    await assert.rejects(migratePaths(options, 'apply'), /Staged storage-archive entry/);
    assert.deepEqual(await inventory(f.root), before);
  });

test('pass 2: availability sidecar alone discovers historical media archive root', async (t) => {
  const f = await fixture(t);
  const archive = path.join(f.root, 'historical-media');
  const payload = path.join(archive, 'run-bundle-media/digest/proof.png');
  await put(payload, 'historical image bytes');
  await put(path.join(f.home, 'run-bundles/availability/only-sidecar.json'), {
    archivedPaths: { 'proof.png': payload },
  });
  const plan = await migratePaths(f.options, 'apply');
  const moved = path.join(plan.dataRoot, 'run-archive/run-bundle-media/digest/proof.png');
  assert.deepEqual(
    await json(path.join(plan.dataRoot, 'run-bundles/availability/only-sidecar.json')),
    {
      archivedPaths: { 'proof.png': moved },
    },
  );
  assert.equal(await readFile(moved, 'utf8'), 'historical image bytes');
});

for (const relative of [
  'checkout/.dispatch-queue.json',
  'checkout/.farm-status.json',
  'checkout/.runs/machine-parking-batches/operation.json',
  'home/review-workspaces/operations/operation/operation.json',
  'home/review-workspaces/owner/operations/operation/operation.json',
  'home/native-sessions/nodes/review-workspaces/owner/operations/operation/operation.json',
])
  test(`pass 2 producer audit: recovery metadata rewrites ${relative}`, async (t) => {
    const f = await fixture(t);
    const file = path.join(f.root, relative);
    if (relative.includes('/nodes/review-workspaces/'))
      await put(path.join(f.runs, 'node-review.json'), {
        id: 'node-review',
        status: 'done',
        reviewWorkspace: {
          checkoutPath: path.join(
            f.home,
            'native-sessions/nodes/review-workspaces/owner/runs/review/source',
          ),
        },
      });
    const source = path.join(f.home, 'review-workspaces/operations/previous');
    await put(path.join(f.home, 'runner-profiles/codex/work/auth.json'), 'opaque credentials');
    await put(file, {
      previousPath: source,
      records: [
        {
          recoveryHandle: {
            sessionPath: path.join(f.home, 'runner-profiles/codex/work/session.jsonl'),
          },
        },
      ],
      evalCell: { experimentManifestPath: path.join(f.runs, 'experiment.json') },
    });
    const plan = await planMigration(f.options);
    assert.deepEqual(plan.conflicts, []);
    const step = plan.steps.find((step) => step.kind === 'write' && step.source === file);
    assert.ok(step?.kind === 'write', file);
    assert.equal(
      JSON.parse(step.body).previousPath,
      path.join(f.home, 'state/review-workspaces/operations/previous'),
    );
    assert.equal(
      JSON.parse(step.body).records[0].recoveryHandle.sessionPath,
      path.join(f.home, 'config/runner-profiles/codex/work/session.jsonl'),
    );
  });

test('pass 2 producer audit: encoded support admission identity matches the migrated Run', async (t) => {
  const f = await fixture(t);
  const workspace = {
    workspaceId: 'review',
    taskPath: path.join(f.home, 'review-workspaces/review/task'),
  };
  const run = { id: 'review', status: 'done', reviewWorkspace: workspace };
  await put(path.join(f.runs, 'review.json'), run);
  const file = path.join(f.runs, 'review-workspace-support/admissions/review.json');
  await put(file, {
    identity: JSON.stringify({ workspace }),
    fingerprint: 'frozen',
    digest: 'digest',
  });
  const frozen = path.join(f.runs, 'review-workspace-support/bundles/digest/manifest.json');
  const bytes = JSON.stringify({ path: workspace.taskPath });
  await put(frozen, bytes);
  await migratePaths(f.options, 'apply');
  const paths = resolveFarmPaths({ home: f.home, role: 'gateway', env: {} });
  const admitted = await json(
    path.join(paths.state.reviewWorkspaceSupport, 'admissions/review.json'),
  );
  assert.ok(admitted && typeof admitted === 'object' && 'identity' in admitted);
  assert.equal(
    admitted.identity,
    JSON.stringify({
      workspace: {
        ...workspace,
        taskPath: path.join(f.home, 'state/review-workspaces/review/task'),
      },
    }),
  );
  assert.equal(
    await readFile(
      path.join(paths.state.reviewWorkspaceSupport, 'bundles/digest/manifest.json'),
      'utf8',
    ),
    bytes,
  );
});

for (const scope of ['sessions', 'nodes/node-a/sessions'])
  test(`pass 2 producer audit: native ${scope} journal relocates metadata and preserves events`, async (t) => {
    const f = await fixture(t);
    const directory = path.join(f.home, 'runner-profiles/codex/work');
    await put(path.join(directory, 'auth.json'), 'opaque credentials');
    const file = path.join(f.home, 'native-sessions', scope, 'session.journal');
    const event = { type: 'tool.completed', path: directory, text: directory };
    const commands = [{ text: directory, commandId: 'command' }];
    await put(
      file,
      JSON.stringify({
        info: { cwd: directory },
        context: { profileDirectory: directory },
        event,
        commands,
      }) + '\n',
    );
    const plan = await planMigration(f.options);
    assert.deepEqual(plan.conflicts, []);
    const step = plan.steps.find((step) => step.kind === 'write' && step.source === file);
    assert.ok(step?.kind === 'write', file);
    const row = JSON.parse(step.body);
    assert.equal(
      row.context.profileDirectory,
      path.join(f.home, 'config/runner-profiles/codex/work'),
    );
    assert.equal(row.info.cwd, path.join(f.home, 'config/runner-profiles/codex/work'));
    assert.deepEqual(row.event, event);
    assert.deepEqual(row.commands, commands);
    assert.ok(step.body.includes(JSON.stringify(event)));
    assert.ok(step.body.includes(JSON.stringify(commands)));
    const original = await readFile(file);
    await migratePaths(f.options, 'apply');
    const paths = resolveFarmPaths({ home: f.home, role: 'gateway', env: {} });
    const migrated = await readFile(
      path.join(paths.state.nativeSessions, scope, 'session.journal'),
      'utf8',
    );
    assert.equal(migrated, step.body);
    await migratePaths(f.options, 'rollback');
    assert.deepEqual(await readFile(file), original);
  });

test('pass 2 producer audit: retained acceptance sidecar rekeys its moved task directory', async (t) => {
  const f = await fixture(t);
  const taskDir = path.join(f.home, 'review-workspaces/owner/runs/review/task');
  const relative = 'artifacts/evidence-manifest.json';
  const evidence = JSON.stringify({ taskDir });
  await put(path.join(taskDir, relative), evidence);
  const oldKey = createHash('sha256').update(taskDir).digest('hex');
  await put(path.join(f.runs, 'retained-acceptance-links', oldKey + '.json'), {
    version: 1,
    taskDir,
    artifacts: [{ path: relative, sha256: createHash('sha256').update(evidence).digest('hex') }],
  });
  await migratePaths(f.options, 'apply');
  const paths = resolveFarmPaths({ home: f.home, role: 'gateway', env: {} });
  const moved = path.join(paths.state.reviewWorkspaces, 'owner/runs/review/task');
  const newKey = createHash('sha256').update(moved).digest('hex');
  const snapshot = await json(
    path.join(paths.state.runs, 'retained-acceptance-links', newKey + '.json'),
  );
  assert.ok(snapshot && typeof snapshot === 'object' && 'taskDir' in snapshot);
  assert.equal(snapshot.taskDir, moved);
  assert.equal(await readFile(path.join(moved, relative), 'utf8'), evidence);
  await migratePaths(f.options, 'rollback');
  assert.equal(await readFile(path.join(taskDir, relative), 'utf8'), evidence);
  await readFile(path.join(f.runs, 'retained-acceptance-links', oldKey + '.json'));
});

test('pass 2 producer audit: native journal preserves raw evidence rows and fields', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.home, 'runner-profiles/codex/work');
  await put(path.join(directory, 'auth.json'), 'opaque credentials');
  const file = path.join(f.home, 'native-sessions/sessions/session.journal');
  const event = `{ "text" : "${directory}", "escaped": "\\u0061", "nested": { "context": "${directory}" } }`;
  const history = `{ "event": ${event}, "processesAdded" : [ { "pid": 1 } ] }\n\n`;
  const metadata = `{ "event": ${event}, "context" : {"profileDirectory":"${directory}"}, "commands": [{ "text" : "${directory}" }] }\n`;
  await put(file, history + metadata);
  const plan = await planMigration(f.options);
  assert.deepEqual(plan.conflicts, []);
  const step = plan.steps.find((step) => step.kind === 'write' && step.source === file);
  assert.ok(step?.kind === 'write');
  assert.equal(
    step.body,
    history +
      metadata.replace(
        `{"profileDirectory":"${directory}"}`,
        JSON.stringify({
          profileDirectory: path.join(f.home, 'config/runner-profiles/codex/work'),
        }),
      ),
  );
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
      await symlink(outside, path.join(f.archive, 'loose-link'));
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
      assert.equal(await fs.readlink(path.join(plan.dataRoot, 'run-archive/loose-link')), outside);
      assert.equal(
        await readFile(path.join(plan.dataRoot, 'run-archive/loose-link'), 'utf8'),
        'outside proof',
      );
      assert.ok((await fs.lstat(path.join(plan.dataRoot, 'run-archive/empty'))).isDirectory());
    }
    await migratePaths(f.options, 'rollback');
    if (!copy) {
      assert.equal(await fs.readlink(path.join(f.archive, 'loose-link')), outside);
      assert.equal(await readFile(path.join(f.archive, 'loose-link'), 'utf8'), 'outside proof');
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

test('sibling alias traversal refuses at plan without mutation', async (t) => {
  const f = await fixture(t);
  const task = path.join(f.archive, 'task');
  await put(path.join(task, 'dir/proof.txt'), 'sibling proof');
  await symlink('task/dir', path.join(f.archive, 'alias'));
  await symlink('../alias', path.join(task, 'through'));
  await symlink(`${task}/through/proof.txt`, path.join(task, 'proof-link'));
  assert.equal(await readFile(path.join(task, 'proof-link'), 'utf8'), 'sibling proof');
  const before = await inventory(f.root);
  const plan = await planMigration(f.options);
  assert.match(plan.conflicts.join('\n'), /symlink traverses another migration source/);
  assert.deepEqual(await inventory(f.root), before);
  await assert.rejects(
    migratePaths(f.options, 'apply'),
    /symlink traverses another migration source/,
  );
  assert.deepEqual(await inventory(f.root), before);
});

for (const partial of [false, true])
  test(`sibling alias journal refuses apply and rollback identically, partial=${partial}`, async (t) => {
    const f = await fixture(t);
    const task = path.join(f.archive, 'task');
    await put(path.join(task, 'dir/proof.txt'), 'sibling proof');
    await symlink('task/dir', path.join(f.archive, 'alias'));
    await symlink('../alias', path.join(task, 'through'));
    await symlink(`${task}/through/proof.txt`, path.join(task, 'proof-link'));
    const plan = await planMigration(f.options);
    // Reproduce a journal accepted by the previous implementation.
    plan.conflicts = [];
    const alias = plan.steps.find(
      (step) => step.kind === 'move' && step.source === path.join(f.archive, 'alias'),
    );
    assert.ok(alias && alias.kind === 'move');
    if (partial) {
      await mkdir(path.dirname(alias.target), { recursive: true });
      await fs.rename(alias.source, alias.target);
      alias.status = 'done';
      plan.status = 'applying';
    }
    await put(plan.journal, plan);
    const before = await inventory(f.root);
    const refusal = {
      message: `Migration symlink traverses another migration source: ${alias.source}`,
    };
    for (const mode of ['apply', 'rollback'] as const) {
      await assert.rejects(migratePaths(f.options, mode), refusal);
      assert.deepEqual(await inventory(f.root), before);
    }
  });

for (const copy of [false, true])
  test(`internal alias chain resumes between sibling moves and rolls back, copy=${copy}`, async (t) => {
    const f = await fixture(t);
    const sibling = path.join(f.archive, 'a-sibling');
    const task = path.join(f.archive, 'task');
    await put(sibling, 'first sibling');
    await put(path.join(task, 'dir/proof.txt'), 'internal proof');
    await symlink('dir', path.join(task, 'alias'));
    await symlink('alias', path.join(task, 'through'));
    const original = `${task}/through/proof.txt`;
    await symlink(original, path.join(task, 'proof-link'));
    const expected = await inventory(task);
    const plan = await planMigration(f.options);
    assert.deepEqual(plan.conflicts, []);
    if (copy) for (const step of plan.steps) if (step.kind === 'move') step.method = 'copy';
    await put(plan.journal, plan);
    await assert.rejects(
      migratePaths(f.options, 'apply', {
        async checkpoint(saved, index) {
          const step = saved.steps[index];
          if (step.kind === 'move' && step.source === sibling && step.status === 'done')
            throw new Error('interrupted between siblings');
        },
      }),
      /interrupted between siblings/,
    );
    assert.equal(await info(sibling), undefined);
    assert.equal(await readFile(path.join(task, 'proof-link'), 'utf8'), 'internal proof');
    const resumed = await migratePaths(f.options, 'apply');
    const movedTask = path.join(resumed.dataRoot, 'run-archive/task');
    for (const link of ['alias/proof.txt', 'through/proof.txt', 'proof-link'])
      assert.equal(await readFile(path.join(movedTask, link), 'utf8'), 'internal proof');
    assert.equal(
      await fs.readlink(path.join(movedTask, 'proof-link')),
      path.join(movedTask, 'dir/proof.txt'),
    );
    await migratePaths(f.options, 'rollback');
    for (const link of ['alias/proof.txt', 'through/proof.txt', 'proof-link'])
      assert.equal(await readFile(path.join(task, link), 'utf8'), 'internal proof');
    assert.equal(await fs.readlink(path.join(task, 'proof-link')), original);
    assert.deepEqual(await inventory(task), expected);
    assert.equal(await readFile(sibling, 'utf8'), 'first sibling');
    await assertLegacy(f);
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
