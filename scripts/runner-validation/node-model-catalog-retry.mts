// Manual, synthetic-only proof on a disposable gateway and remote node. No live gateway calls.
// Run: nice -n 15 env -u TMUX TSX_TSCONFIG_PATH=services/gateway/tsconfig.json \
//   node --import tsx scripts/runner-validation/node-model-catalog-retry.mts /tmp/catalog-proof
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NativeSessionCatalogResult } from '../../packages/protocol/src/index.js';

import { cleanupOnExit, poll, startReaper } from './lib/isolated-stack.mjs';
import { startRemoteNodeStack } from './lib/remote-node-stack.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.resolve(process.argv[2] ?? '/tmp/node-model-catalog-retry-proof');
await mkdir(evidence, { recursive: true });
const machine = 'catalog-proof-node';
const project = 'catalog-proof';
const marker = path.join(evidence, 'pi-listings.jsonl');
await writeFile(marker, '');
const reaper = startReaper();
let stopStack: (() => Promise<string[]>) | undefined;
const cleanup = cleanupOnExit(async () => {
  const errors = (await stopStack?.()) ?? [];
  assert.deepEqual(errors, [], 'isolated stack teardown');
  reaper.done();
});

try {
  const stack = await startRemoteNodeStack({
    root,
    evidence,
    machine,
    slots: [`${project}-1`],
    projects: () => [{ name: project, projectJson: {}, files: {} }],
    seeds: { [project]: { 'README.md': 'Synthetic catalog retry fixture.\n' } },
    cliSnapshots: path.join(evidence, 'unused-cli-snapshots'),
    // No run is dispatched; the node only executes fixture listing commands, so no CLI build.
    cliSnapshot: root,
    ownerTag: 'node-model-catalog-retry',
    reaper,
    onCleanup: (stop) => {
      stopStack = stop;
    },
    log: async (event, detail) => console.log(event, JSON.stringify(detail ?? {})),
    binFiles: () => ({
      pi: `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] !== '--list-models') process.exit(2);
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ at: Date.now() }) + '\\n');
process.stdout.write('provider model context max-out thinking images\\nlitellm fixture-model 1M 64K yes yes\\n');
`,
      opencode: '#!/bin/sh\nprintf "litellm/fixture-model\\n"\n',
    }),
  });
  await stack.restartGateway({
    nodeAwayMs: 18_000,
    whileDown: async () => {
      // Force the slot execution path to use the fixture binary even under a login shell.
      for (const directory of ['pool', 'node-pool']) {
        const file = path.join(stack.fixture, directory, `${project}.json`);
        const pool = JSON.parse(await readFile(file, 'utf8'));
        pool.pi_path = path.join(stack.fixture, 'bin', 'pi');
        pool.opencode_path = path.join(stack.fixture, 'bin', 'opencode');
        await writeFile(file, JSON.stringify(pool));
      }
      await writeFile(marker, '');
    },
  });
  const log = await readFile(path.join(evidence, 'gateway-2.log'), 'utf8');
  assert.match(log, /pi model list on catalog-proof-node failed.*node is not connected/);
  assert.equal(await readFile(marker, 'utf8'), '', 'node connected before its first retry');

  // Observe the command's own marker first. No catalog RPC or resource observation warms it.
  await poll(
    'an automatic Pi listing after reconnect',
    async () => {
      return (await readFile(marker, 'utf8')).trim() ? true : undefined;
    },
    45_000,
  );
  // This RPC projects cached listings only. It never requests a runner.modelCatalog sample.
  const models = await poll(
    'the cached native Pi catalog to contain the fixture model',
    async () => {
      const catalog = await stack.call<NativeSessionCatalogResult>('native.session.catalog');
      const listed = catalog.runners.find((runner) => runner.runner === 'pi')?.nodeModels?.[
        machine
      ];
      return listed?.includes('litellm/fixture-model') ? listed : undefined;
    },
    5000,
  );
  assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1);
  const result = { passed: true, machine, models, nodeAwayMs: 18_000, catalogCollectionReads: 0 };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await cleanup();
}
