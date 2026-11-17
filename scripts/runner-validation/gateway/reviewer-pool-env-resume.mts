// Two real native reviewer rounds through the isolated gateway; no external publication.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isRecord,
  type NativeSessionReadResult,
  type NodeHealthResult,
  type Run,
} from '../../../packages/protocol/src/index.js';
import {
  projectPacks,
  REVIEW_PROJECT,
  reviewRunParams,
  SEED,
  slotCli,
} from '../canary/fixtures.mjs';
import { cleanupOnExit, poll, startReaper } from '../lib/isolated-stack.mjs';
import { type RemoteNodeStack, startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(
  process.argv[2] ?? path.join(root, 'temp/reviewer-pool-env-evidence'),
);
await mkdir(evidence, { recursive: true });
const reaper = startReaper();
let stack: RemoteNodeStack | undefined;
let runId: string | undefined;
const cleanup = cleanupOnExit(async () => {
  try {
    if (stack) {
      const errors = await stack.cleanup();
      await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ errors }, null, 2));
      assert.deepEqual(errors, []);
    }
  } finally {
    reaper.done();
  }
});
const reviewer = { runner: 'claude', model: 'opus', effort: null, mode: 'cold' };
try {
  stack = await startRemoteNodeStack({
    root,
    evidence,
    machine: 'reviewer-env-proof',
    slots: [REVIEW_PROJECT + '-1'],
    projects: (holds) =>
      projectPacks(holds)
        .filter((pack) => pack.name === REVIEW_PROJECT)
        .map((pack) => {
          const scripted = pack.projectJson.scripted;
          assert.ok(
            isRecord(scripted) && isRecord(scripted.commands) && isRecord(scripted.commands.work),
          );
          const work = scripted.commands.work;
          assert.ok(typeof work.command === 'string');
          const producerDone = path.join(holds, 'producer-complete');
          const phaseCheck = 'if [ -e "$task/artifacts/pr-description.md" ]; then';
          assert.ok(work.command.includes(phaseCheck));
          const command =
            work.command.replace(phaseCheck, `if [ -e '${producerDone}' ]; then`) +
            `\ntouch '${producerDone}'`;
          return {
            ...pack,
            projectJson: {
              ...pack.projectJson,
              scripted: {
                ...scripted,
                commands: { ...scripted.commands, work: { ...work, command } },
              },
              review: {
                enabled: true,
                runner: 'claude',
                model: 'opus',
                mode: 'warm',
                max_retries: 1,
                review_timeout_min: 10,
              },
            },
          };
        }),
    seeds: { [REVIEW_PROJECT]: SEED },
    slotFiles: slotCli(root),
    cliSnapshots: path.join(evidence, 'cli-snapshots'),
    nodeBin: path.dirname(process.execPath),
    ownerTag: 'reviewer-pool-env',
    reaper,
    gatewayEnv: { FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'refuse' },
    nodeEnv: {
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_USE_VERTEX: undefined,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'),
    },
    log: async (event, detail) => console.log(event, JSON.stringify(detail ?? {})),
  });
  const active = stack;
  const health = await poll(
    'first live node pressure sample',
    async () => {
      const result = await active.call<NodeHealthResult>('node.health', {
        machine: 'reviewer-env-proof',
      });
      return result.health?.system ? result.health : undefined;
    },
    90_000,
  );
  await writeFile(path.join(evidence, 'health-before.json'), JSON.stringify(health, null, 2));
  await writeFile(path.join(active.holds, 'fix'), 'hold the real fix before its completion signal');
  const created = await active.call<{ run: Run }>('run.create', {
    ...reviewRunParams(REVIEW_PROJECT + '-1'),
    reviewValidationDepth: 'full-live',
    reviewSequence: [reviewer],
  });
  runId = created.run.id;
  await writeFile(path.join(evidence, 'run-id'), runId);
  const read = async () => (await active.call<{ run: Run }>('run.get', { runId })).run;
  await poll(
    'scripted producer monitoring',
    async () => {
      const run = await read();
      assert.ok(!['failed', 'blocked', 'cancelled'].includes(run.status), run.error);
      return run.status === 'monitoring' ? true : undefined;
    },
    90_000,
  );
  await writeFile(path.join(active.holds, 'monitoring'), 'gateway confirmed monitoring\n');

  const first = await poll(
    'validated first review and held fix',
    async () => {
      const run = await read();
      assert.ok(!['failed', 'blocked', 'cancelled'].includes(run.status), run.error);
      const context = run.agentContexts?.find(
        (entry) => entry.role === 'review' && entry.reviewResultValidatedAt && entry.nativeSession,
      );
      const fix = run.agentContexts?.find(
        (entry) => entry.role === 'review-fix' && entry.status === 'working',
      );
      return context && fix && existsSync(path.join(active.holds, 'fix.hit'))
        ? { run, context }
        : undefined;
    },
    300_000,
  );
  await writeFile(path.join(evidence, 'first.json'), JSON.stringify(first, null, 2));
  const envChange = {
    ASDF_DATA_DIR: path.join(homedir(), '.asdf'),
    ASDF_CONFIG_FILE: path.join(active.fixture, 'proof-asdfrc'),
  };
  await writeFile(envChange.ASDF_CONFIG_FILE, 'legacy_version_file = yes\n');
  for (const directory of ['pool', 'node-pool']) {
    const file = path.join(active.fixture, directory, REVIEW_PROJECT + '.json');
    const pool = JSON.parse(await readFile(file, 'utf8'));
    const next = file + '.next';
    await writeFile(next, JSON.stringify({ ...pool, env: { ...pool.env, ...envChange } }, null, 2));
    await rename(next, file);
  }
  await active.call('fleet.refresh');
  await writeFile(
    path.join(evidence, 'pool-change.json'),
    JSON.stringify({ runId, envChange, firstContextId: first.context.id }, null, 2),
  );
  await unlink(path.join(active.holds, 'fix'));
  const second = await poll(
    'warm native re-review after pool edit',
    async () => {
      const run = await read();
      assert.ok(!['failed', 'cancelled'].includes(run.status), run.error);
      const step = run.steps.find((entry) => entry.name === 'review');
      assert.notEqual(step?.status, 'failed', step?.detail);
      const contexts =
        run.agentContexts?.filter(
          (entry) =>
            entry.role === 'review' && entry.reviewResultValidatedAt && entry.nativeSession,
        ) ?? [];
      return contexts.length === 2 && step?.status === 'done' ? { run, contexts } : undefined;
    },
    300_000,
  );
  const resumed = second.contexts.find((entry) => entry.id !== first.context.id)!;
  assert.equal(second.run.steps.find((entry) => entry.name === 'review')?.outputs?.verdict, 'pass');
  assert.equal(resumed.nativeSession!.sessionId, first.context.nativeSession!.sessionId);
  assert.equal(resumed.runnerSessionId, first.context.runnerSessionId);
  assert.notEqual(resumed.nativeSession!.leaseId, first.context.nativeSession!.leaseId);
  assert.ok(resumed.nativeSession!.acceptedAt);
  assert.ok(resumed.nativeSession!.launchDigest?.startsWith('reviewer-v1:'));
  const snapshot = await active.call<NativeSessionReadResult>('native.session.read', {
    sessionId: resumed.nativeSession!.sessionId,
    executionNodeId: resumed.nativeSession!.executionNodeId,
    worker: {
      runId,
      contextId: resumed.id,
      generation: resumed.nativeSession!.generation,
      leaseId: resumed.nativeSession!.leaseId,
    },
  });
  assert.equal(snapshot.session.nativeSessionId, first.context.runnerSessionId);
  assert.equal(snapshot.session.workerLaunchDigest, resumed.nativeSession!.launchDigest);
  assert.ok(
    snapshot.commands.some(
      (command) => command.commandId === resumed.nativeSession!.commandId && command.accepted,
    ),
  );
  await writeFile(path.join(evidence, 'second.json'), JSON.stringify(second, null, 2));
  await writeFile(
    path.join(evidence, 'proof.json'),
    JSON.stringify(
      {
        pass: true,
        runId,
        poolEnvironmentChanged: true,
        confirmedDigest: snapshot.session.workerLaunchDigest,
        nativeSessionId: resumed.nativeSession!.sessionId,
        runnerSessionId: resumed.runnerSessionId,
        firstLease: first.context.nativeSession!.leaseId,
        secondLease: resumed.nativeSession!.leaseId,
        accepted: true,
        published: false,
      },
      null,
      2,
    ),
  );
  console.log('PASS', runId, resumed.nativeSession!.sessionId);
} finally {
  await cleanup();
}
