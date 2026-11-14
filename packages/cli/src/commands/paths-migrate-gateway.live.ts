// Slow pass-3 coverage kept out of the default suite: a gateway child loads the whole gateway graph
// cold after the migration. Run by `yarn test:release-live` before a release cut.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { FleetStatus } from '@farmslot/protocol';
import { resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';

import { migratePaths, type MigrationOptions } from './paths-migrate.js';
import { json } from './paths-migrate-plan.js';

async function put(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}

test('pass 3: relative backlog specPath reads, enqueues and rolls back its original bytes', async (t) => {
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
