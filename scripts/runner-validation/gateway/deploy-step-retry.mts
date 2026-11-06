// Real gateway + node. No synthetic refusal, no model, no live farm state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Run } from '../../../packages/protocol/src/index.js';
import { PIPE_PROJECT, projectPacks, SEED, slotCli, pipeRunParams } from '../canary/fixtures.mjs';
import { startReaper, cleanupOnExit, poll } from '../lib/isolated-stack.mjs';
import { NodeCloseoutProxy } from '../lib/node-closeout-proxy.mjs';
import { startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(process.argv[2] ?? '/tmp/deploy-step-retry-proof');
await mkdir(evidence, { recursive: true });
const proxy = new NodeCloseoutProxy();
const reaper = startReaper();
let stack: Awaited<ReturnType<typeof startRemoteNodeStack>> | undefined;
const cleanup = cleanupOnExit(async () => {
  if (stack) assert.deepEqual(await stack.cleanup(), []);
  await proxy.stop();
  reaper.done();
});
try {
  const slotId = `${PIPE_PROJECT}-1`;
  stack = await startRemoteNodeStack({
    root,
    evidence,
    machine: 'proof-node',
    slots: [slotId],
    projects: (holds) => projectPacks(holds).filter((pack) => pack.name === PIPE_PROJECT),
    seeds: { [PIPE_PROJECT]: SEED },
    slotFiles: slotCli(root),
    nodeProxy: proxy,
    cliSnapshots: path.resolve(process.argv[3] ?? path.join(evidence, 'cli-snapshots')),
    ownerTag: 'deploy-step-retry',
    reaper,
    log: async (event, detail) => console.log(event, JSON.stringify(detail ?? {})),
  });
  await writeFile(path.join(stack.holds, 'worker'), 'hold');
  const { run } = await stack.call<{ run: Run }>('run.create', pipeRunParams(slotId));
  const getRun = async () => (await stack!.call<{ run: Run }>('run.get', { runId: run.id })).run;
  await poll(
    'monitor',
    async () => {
      const current = await getRun();
      return current.steps.find((step) => step.name === 'monitor')?.status === 'running'
        ? current
        : undefined;
    },
    180000,
  );
  const current = await getRun();
  assert(current.taskFile);
  const relative = path.relative(
    path.join(stack.fixture, 'projects', PIPE_PROJECT, 'tasks'),
    path.dirname(current.taskFile),
  );
  const pointer = path.join(
    stack.slotRepo(slotId),
    '.task',
    relative,
    'artifacts/latest-valid-recipe-run.json',
  );
  proxy.holdExists(
    pointer,
    async () =>
      (await getRun()).steps.find((step) => step.name === 'complete')?.status === 'running',
  );
  await writeFile(path.join(stack.holds, 'monitoring'), 'ready');
  const { unlink } = await import('node:fs/promises');
  await unlink(path.join(stack.holds, 'worker'));
  await poll('held package request', async () => proxy.isHeld() || undefined, 60000);
  const held = await getRun();
  assert.equal(held.steps.find((step) => step.name === 'complete')?.status, 'running');
  const started = path.join(stack.fixture, 'closeout-started');
  const stopping = path.join(stack.fixture, 'closeout-stopping');
  proxy.startCloseout([
    process.execPath,
    '-e',
    `const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(stopping)},'stopping'));fs.writeFileSync(${JSON.stringify(started)},'started');setInterval(()=>{},1000);`,
  ]);
  await poll('owned scoped command', async () => existsSync(started) || undefined, 10000);
  await stack.restartNode(async () => {
    await poll('node command closeout', async () => existsSync(stopping) || undefined, 10000);
    proxy.release();
  });
  const recovered = await poll(
    'COMPLETE retry',
    async () => {
      const latest = await getRun();
      if (latest.steps.find((step) => step.name === 'complete')?.status === 'failed') return latest;
      return latest.steps.find((step) => step.name === 'complete')?.status === 'done'
        ? latest
        : undefined;
    },
    120000,
  );
  await writeFile(
    path.join(evidence, 'receipt.json'),
    JSON.stringify(
      {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
        runId: run.id,
        heldStep: 'complete',
        method: proxy.heldMethod,
        shutdownRefusals: proxy.shutdownRefusals,
        shutdownError: proxy.shutdownError,
        closeoutResult: proxy.closeoutResult,
        complete: recovered.steps.find((step) => step.name === 'complete'),
        status: recovered.status,
        error: recovered.error,
        gatewayWasNotRestarted: true,
        realNodeSignal: await readFile(stopping, 'utf8'),
      },
      null,
      2,
    ),
  );
  assert(proxy.shutdownRefusals > 0, 'real node must refuse the held request during closeout');
  assert.equal(proxy.closeoutResult?.ok, true, 'the accepted setup command confirmed closeout');
  assert.equal(
    recovered.steps.find((step) => step.name === 'complete')?.status,
    'done',
    recovered.error,
  );
  await stack.call('run.cancel', { runId: run.id });
  console.log('PASS', run.id);
} finally {
  await cleanup();
}
