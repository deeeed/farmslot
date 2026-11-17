// Reproduce a recorded static reviewer handoff after an unrelated project command_env change.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeResumeUnavailableReason } from '../../../packages/agent-runtime/src/native/claude.js';
import { resolveNativeExecutable } from '../../../packages/agent-runtime/src/native/manager.js';

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
const policyFile = process.env.FARMSLOT_REVIEW_PROOF_PROJECT_CONFIG;
assert.ok(policyFile, 'FARMSLOT_REVIEW_PROOF_PROJECT_CONFIG must name the real pack project.json');
const policyBytes = await readFile(policyFile);
const policy: unknown = JSON.parse(policyBytes.toString('utf8'));
assert.ok(isRecord(policy));
const safetyTier = policy.default_safety_tier;
assert.ok(safetyTier === 'sandboxed' || safetyTier === 'full-auto' || safetyTier === 'dangerous');
await writeFile(
  path.join(evidence, 'production-review-policy.json'),
  JSON.stringify(
    {
      source: path.resolve(policyFile),
      sha256: createHash('sha256').update(policyBytes).digest('hex'),
      default_safety_tier: safetyTier,
    },
    null,
    2,
  ),
);
const poolPolicyFile = process.env.FARMSLOT_REVIEW_PROOF_POOL_CONFIG;
assert.ok(poolPolicyFile, 'FARMSLOT_REVIEW_PROOF_POOL_CONFIG must name the real node pool');
const poolPolicyBytes = await readFile(poolPolicyFile);
const poolPolicy: unknown = JSON.parse(poolPolicyBytes.toString('utf8'));
assert.ok(isRecord(poolPolicy) && typeof poolPolicy.claude_path === 'string');
const claudePath = poolPolicy.claude_path;
assert.ok(path.isAbsolute(claudePath), 'the real node pool must select an absolute executable');
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
              default_safety_tier: safetyTier,
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
      // Use normal retained task/configuration copies. Scripted installed-input
      // reuse requires the live project bytes to stay fixed for the whole stack.
      // The slot shim delegates to command mode, which needs no scenario flag.
      FARMSLOT_ENABLE_SCRIPTED_SCENARIOS: '0',
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_USE_VERTEX: undefined,
      CLAUDE_CONFIG_DIR: path.join(homedir(), '.claude'),
    },
    log: async (event, detail) => console.log(event, JSON.stringify(detail ?? {})),
  });
  const active = stack;
  // This proof runs on the execution node. Use the host's own resolver before
  // starting a reviewer, then require its actual session readback to agree.
  const runnerPreflight = await resolveNativeExecutable(
    claudePath,
    active.slotRepo(REVIEW_PROJECT + '-1'),
  );
  assert.equal(runnerPreflight.executable, await realpath(claudePath));
  assert.equal(claudeResumeUnavailableReason(runnerPreflight.version), undefined);
  for (const directory of ['pool', 'node-pool']) {
    const file = path.join(active.fixture, directory, REVIEW_PROJECT + '.json');
    const pool = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file + '.next', JSON.stringify({ ...pool, claude_path: claudePath }, null, 2));
    await rename(file + '.next', file);
  }
  await active.call('fleet.refresh');
  await writeFile(
    path.join(evidence, 'production-runner-selection.json'),
    JSON.stringify(
      {
        source: path.resolve(poolPolicyFile),
        sha256: createHash('sha256').update(poolPolicyBytes).digest('hex'),
        claude_path: claudePath,
        resolvedBeforeRoundOne: runnerPreflight,
      },
      null,
      2,
    ),
  );
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
  await writeFile(
    path.join(active.holds, 'large-leftover'),
    'exercise the existing full re-review path\n',
  );
  const created = await active.call<{ run: Run }>('run.create', {
    ...reviewRunParams(REVIEW_PROJECT + '-1'),
    safetyTier,
    reviewSequence: [reviewer],
  });
  runId = created.run.id;
  await writeFile(path.join(evidence, 'run-id'), runId);
  const read = async () => (await active.call<{ run: Run }>('run.get', { runId })).run;
  await poll(
    'scripted producer monitoring',
    async () => {
      const run = await read();
      await writeFile(path.join(evidence, 'last-run.json'), JSON.stringify(run, null, 2));
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
      await writeFile(path.join(evidence, 'last-run.json'), JSON.stringify(run, null, 2));
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
  const firstBinding = first.context.nativeSession!;
  const firstNative = await active.call<NativeSessionReadResult>('native.session.read', {
    sessionId: firstBinding.sessionId,
    executionNodeId: firstBinding.executionNodeId,
    worker: {
      runId,
      contextId: first.context.id,
      generation: firstBinding.generation,
      leaseId: firstBinding.leaseId,
    },
  });
  assert.equal(firstNative.session.executable, runnerPreflight.executable);
  assert.equal(firstNative.session.version, runnerPreflight.version);
  await writeFile(path.join(evidence, 'first-native.json'), JSON.stringify(firstNative, null, 2));
  const taskRoot = path.join(
    active.slotRepo(REVIEW_PROJECT + '-1'),
    path.dirname(first.context.taskFile!),
  );
  const taskProvenance = JSON.parse(
    await readFile(path.join(taskRoot, 'artifacts/harness-provenance.json'), 'utf8'),
  );
  assert.equal(taskProvenance.source.kind, 'task-retained');
  assert.equal(first.context.reviewValidationDepth, 'static-code');
  assert.equal(first.context.nativeSession!.safetyTier, safetyTier);
  const projectFile = path.join(active.fixture, 'projects', REVIEW_PROJECT, 'project.json');
  const projectBefore = await readFile(projectFile, 'utf8');
  const project = JSON.parse(projectBefore);
  const pools = await Promise.all(
    ['pool', 'node-pool'].map(async (directory) => ({
      file: path.join(active.fixture, directory, REVIEW_PROJECT + '.json'),
      bytes: await readFile(path.join(active.fixture, directory, REVIEW_PROJECT + '.json'), 'utf8'),
    })),
  );
  const envChange = { ASDF_NODEJS_LEGACY_FILE_DYNAMIC_STRATEGY: 'latest_installed' };
  assert.equal(project.command_env?.set?.ASDF_NODEJS_LEGACY_FILE_DYNAMIC_STRATEGY, undefined);
  const updated = {
    ...project,
    command_env: {
      ...project.command_env,
      set: { ...project.command_env?.set, ...envChange },
    },
  };
  await writeFile(projectFile + '.next', JSON.stringify(updated, null, 2));
  await rename(projectFile + '.next', projectFile);
  for (const pool of pools) assert.equal(await readFile(pool.file, 'utf8'), pool.bytes);
  await writeFile(
    path.join(evidence, 'project-env-change.json'),
    JSON.stringify(
      {
        runId,
        envChange,
        firstContextId: first.context.id,
        projectBefore: JSON.parse(projectBefore),
        projectAfter: updated,
        poolFilesUnchanged: true,
      },
      null,
      2,
    ),
  );
  await unlink(path.join(active.holds, 'fix'));
  const second = await poll(
    'warm static native re-review after the recorded project env change',
    async () => {
      const run = await read();
      await writeFile(path.join(evidence, 'last-run.json'), JSON.stringify(run, null, 2));
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
  assert.equal(resumed.reviewValidationDepth, 'static-code');
  assert.equal(resumed.nativeSession!.safetyTier, safetyTier);
  assert.equal(resumed.reviewFallback, undefined);
  assert.equal(resumed.nativeSession!.launchDigest, first.context.nativeSession!.launchDigest);
  assert.notEqual(resumed.nativeSession!.generation, first.context.nativeSession!.generation);
  assert.equal(resumed.nativeSession!.sessionId, first.context.nativeSession!.sessionId);
  assert.equal(resumed.runnerSessionId, first.context.runnerSessionId);
  assert.notEqual(resumed.nativeSession!.leaseId, first.context.nativeSession!.leaseId);
  assert.ok(resumed.nativeSession!.acceptedAt);
  assert.ok(resumed.nativeSession!.launchDigest?.startsWith('reviewer-v1:'));
  const request = {
    sessionId: resumed.nativeSession!.sessionId,
    executionNodeId: resumed.nativeSession!.executionNodeId,
    worker: {
      runId,
      contextId: resumed.id,
      generation: resumed.nativeSession!.generation,
      leaseId: resumed.nativeSession!.leaseId,
    },
    limit: 200,
  };
  let snapshot = await active.call<NativeSessionReadResult>('native.session.read', request);
  const events = [...snapshot.events];
  while (snapshot.hasMore) {
    const cursor = snapshot.cursor;
    snapshot = await active.call<NativeSessionReadResult>('native.session.read', {
      ...request,
      after: cursor,
    });
    assert.ok(snapshot.cursor > cursor, 'owned history cursor must advance');
    events.push(...snapshot.events);
  }
  assert.equal(snapshot.session.executable, runnerPreflight.executable);
  assert.equal(snapshot.session.version, runnerPreflight.version);
  assert.equal(snapshot.session.nativeSessionId, first.context.runnerSessionId);
  assert.equal(snapshot.session.workerLaunchDigest, resumed.nativeSession!.launchDigest);
  const command = snapshot.commands.find(
    (entry) => entry.commandId === resumed.nativeSession!.commandId,
  );
  assert.ok(command?.accepted);
  assert.equal(command.outcome, 'completed');
  await writeFile(
    path.join(evidence, 'native-history.json'),
    JSON.stringify({ ...snapshot, events }, null, 2),
  );
  await writeFile(path.join(evidence, 'second.json'), JSON.stringify(second, null, 2));
  await writeFile(
    path.join(evidence, 'proof.json'),
    JSON.stringify(
      {
        pass: true,
        runId,
        projectCommandEnvironmentChanged: envChange,
        poolFilesUnchanged: true,
        taskInputPolicy: taskProvenance.source.kind,
        launchPath: 'runNativeReviewAgent/dispatchNativeWorker/prepareNativeWorkerLaunch',
        confirmedDigest: snapshot.session.workerLaunchDigest,
        nativeSessionId: resumed.nativeSession!.sessionId,
        runnerSessionId: resumed.runnerSessionId,
        firstLease: first.context.nativeSession!.leaseId,
        secondLease: resumed.nativeSession!.leaseId,
        executable: snapshot.session.executable,
        version: snapshot.session.version,
        accepted: true,
        published: false,
      },
      null,
      2,
    ),
  );
  console.log('PASS', runId, resumed.nativeSession!.sessionId);
} catch (error) {
  await writeFile(path.join(evidence, 'proof-error.txt'), String(error));
  throw error;
} finally {
  await cleanup();
}
