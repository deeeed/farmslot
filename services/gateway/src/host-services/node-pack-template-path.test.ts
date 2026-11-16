import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { isRecord, type Run } from '@farmslot/protocol';
import { resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';

const root = await mkdtemp(path.join(os.tmpdir(), 'node-catalog-path-'));
after(() => rm(root, { recursive: true, force: true }));
const projects = path.join(root, 'installed-projects');
const template = path.join(projects, 'fixture/templates/worker/fix-bug.md');
await mkdir(path.dirname(template), { recursive: true });
const current = '# Current frozen template\n';
const expected = createHash('sha256').update(current).digest('hex');
const paths = resolveFarmPaths({
  role: 'node',
  checkoutRoot: path.join(root, 'node-install'),
  home: path.join(root, 'node-home'),
  env: { FARMSLOT_PROJECTS_DIR: projects },
  instanceConfig: null,
});
const run: Run = {
  id: 'fixture-run',
  familyId: 'fixture-family',
  parentRunId: null,
  familyRootTicketOrPr: 'fixture',
  lane: 'production',
  flowType: 'fix-bug',
  mode: 'autonomous',
  status: 'writing-task',
  project: 'fixture',
  ticketOrPr: 'fixture',
  slotId: 'fixture-1',
  branch: 'fix/fixture',
  taskFile: null,
  steps: [],
  decisions: [],
  metrics: {
    nudgeCount: 0,
    model: 'scripted',
    runner: 'scripted',
    runnerSessionId: null,
    runnerSessionPath: null,
  },
  createdAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
  executionTemplate: {
    sourceId: 'project:fixture',
    id: 'fix-bug/default',
    flow: 'fix-bug',
    platforms: ['*'],
    labels: [],
    relativePath: 'fix-bug.md',
    sha256: expected,
  },
};
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => ({ host: 'fixture.invalid', machine: 'fixture' }),
  },
});
const slots = await import('@farmslot/slot-config');
mock.module('@farmslot/slot-config', {
  namedExports: {
    ...slots,
    currentProjectSources: () => undefined,
    reportedFarmPaths: () => paths,
  },
});
let reads = 0;
const rpc = await import('../fleet/node-rpc.js');
mock.module('../fleet/node-rpc.js', {
  namedExports: {
    ...rpc,
    waitForNode: async () => ({ machine: 'fixture' }),
    sendNodeRequest: async (_node: unknown, method: string, params: unknown) => {
      assert.equal(method, 'fs.hash');
      assert(isRecord(params));
      assert.equal(params.root, path.dirname(template));
      assert.equal(params.relPath, 'fix-bug.md');
      reads++;
      return {
        sha256: createHash('sha256')
          .update(await readFile(template))
          .digest('hex'),
        size: 1,
      };
    },
  },
});
let syncs = 0;
const transfer = await import('./task-transfer.js');
mock.module('./task-transfer.js', {
  namedExports: {
    ...transfer,
    runTaskTransfer: async (command: string) => {
      assert(command.includes("'--packs-only'"));
      assert(command.includes(`'--home' '${paths.home}'`));
      syncs++;
      await writeFile(template, current);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  },
});
const { ensureRunNodePackTemplate } = await import('./node-pack-template.js');

test('admission hashes the node-reported copied catalog and syncs that instance once', async () => {
  await writeFile(template, '# Old copied template\n');
  await ensureRunNodePackTemplate(run);
  assert.deepEqual({ reads, syncs }, { reads: 2, syncs: 1 });
  assert.equal(await readFile(template, 'utf8'), current);

  await ensureRunNodePackTemplate(run);
  assert.deepEqual({ reads, syncs }, { reads: 3, syncs: 1 }, 'matching admission does not sync');
});
