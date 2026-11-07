// Real private gateway/node lifecycle with the persistent link enabled. No public farm state.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Run } from '../../../packages/protocol/src/index.js';
import { PIPE_PROJECT, projectPacks, SEED, slotCli, pipeRunParams } from '../canary/fixtures.mjs';
import { cleanupOnExit, poll, startReaper } from '../lib/isolated-stack.mjs';
import { startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(process.argv[2] ?? path.join(root, 'temp/node-link-run'));
const cliSnapshot = process.argv[3] ?? process.env.FARMSLOT_VALIDATION_CLI_SNAPSHOT;
assert(
  cliSnapshot,
  'Pass an existing immutable CLI snapshot; this proof never builds or selects one.',
);
await mkdir(evidence, { recursive: true });
const reaper = startReaper();
let stack: Awaited<ReturnType<typeof startRemoteNodeStack>> | undefined;
const cleanup = cleanupOnExit(async () => {
  if (stack) assert.deepEqual(await stack.cleanup(), []);
  reaper.done();
});
let pass = false;
try {
  const slotId = `${PIPE_PROJECT}-1`;
  stack = await startRemoteNodeStack({
    root,
    evidence,
    machine: 'node-link-run-proof',
    slots: [slotId],
    nodeLink: true,
    projects: (holds) => projectPacks(holds).filter((pack) => pack.name === PIPE_PROJECT),
    seeds: { [PIPE_PROJECT]: SEED },
    slotFiles: slotCli(cliSnapshot),
    cliSnapshots: path.join(evidence, 'unused-cli-cache'),
    cliSnapshot,
    ownerTag: 'node-link-run',
    reaper,
    log: async (event, detail) => console.log(event, JSON.stringify(detail ?? {})),
  });
  const { run } = await stack.call<{ run: Run }>('run.create', {
    ...pipeRunParams(slotId),
    completionPolicy: 'artifact-only',
    pipelineReview: 'none',
  });
  let monitoringReleased = false;
  const atGate = await poll(
    'scripted worker reaches completion over the node link',
    async () => {
      const current = (await stack!.call<{ run: Run }>('run.get', { runId: run.id })).run;
      if (current.status === 'monitoring' && !monitoringReleased) {
        await writeFile(path.join(stack!.holds, 'monitoring'), 'ready');
        monitoringReleased = true;
      }
      if (current.status === 'failed' || current.status === 'blocked') {
        await writeFile(path.join(evidence, 'failed-run.json'), JSON.stringify(current, null, 2));
        throw new Error('Private run failed; inspect failed-run.json');
      }
      assert.equal(
        (current.agentContexts ?? []).some((context) => context.role === 'review'),
        false,
        'The transport fixture must not launch a model reviewer.',
      );
      const complete = current.steps.find((step) => step.name === 'complete');
      return complete && ['running', 'done'].includes(complete.status) ? current : undefined;
    },
    180_000,
  );
  assert.equal(atGate.pipelineReview, 'none');
  assert.equal(
    atGate.steps.find((step) => step.name === 'review')?.outputs?.reason,
    'pipeline-review-off',
  );
  await writeFile(path.join(evidence, 'gate-run.json'), JSON.stringify(atGate, null, 2));
  const transport = path.join(stack.fixture, 'remote-shim.log');
  let calls = '';
  try {
    calls = await readFile(transport, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  assert.equal(calls.trim(), '', 'Node-control SSH/SCP/rsync must not run in the enabled pilot.');
  pass = true;
  await writeFile(
    path.join(evidence, 'PASS.json'),
    JSON.stringify(
      {
        pass,
        runId: run.id,
        sourceMode: 'unpublished private candidate',
        cliSnapshot,
        runStatus: atGate.status,
        completionStarted: true,
        managedSsh: 0,
        pipelineReview: atGate.pipelineReview,
        reviewerCount: (atGate.agentContexts ?? []).filter((context) => context.role === 'review')
          .length,
        liveFarmChanged: false,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    if (stack)
      await cp(path.join(stack.fixture, 'runs'), path.join(evidence, 'runs'), { recursive: true });
  } finally {
    await cleanup();
  }
  await writeFile(
    path.join(evidence, 'CLEANUP.json'),
    JSON.stringify({ pass, publicServicesChanged: false }),
  );
}
