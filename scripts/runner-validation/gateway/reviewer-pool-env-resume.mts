// Real native repeat-review through the gateway; only GitHub reads use a loopback fixture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isRecord,
  type AgentContext,
  type NativeSessionReadResult,
  type NodeHealthResult,
  type Run,
} from '../../../packages/protocol/src/index.js';
import { projectPacks, REVIEW_PROJECT, SEED } from '../canary/fixtures.mjs';
import { cleanupOnExit, poll, startReaper } from '../lib/isolated-stack.mjs';
import { writeNativeFixtureTask } from '../lib/native-task.mjs';
import { type RemoteNodeStack, startRemoteNodeStack } from '../lib/remote-node-stack.mjs';
import {
  startReviewProviderFixture,
  type ReviewProviderFixture,
} from '../review-provider-fixture.cjs';

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

const providerState = path.join(evidence, 'provider-state.json');
process.env.PUBLICATION_FIXTURE_STATE = providerState;
const reaper = startReaper();
let stack: RemoteNodeStack | undefined;
let provider: ReviewProviderFixture | undefined;
const cleanup = cleanupOnExit(async () => {
  try {
    if (stack) {
      const errors = await stack.cleanup();
      await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ errors }, null, 2));
      assert.deepEqual(errors, []);
    }
  } finally {
    await provider?.close();
    reaper.done();
  }
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const context = (run: Run) => {
  const value = run.agentContexts?.find((item) => item.role === 'review');
  assert.ok(value?.nativeSession && value.runnerSessionId);
  return value;
};
try {
  await writeFile(
    providerState,
    JSON.stringify({
      author: 'author',
      head: '0'.repeat(40),
      base: '0'.repeat(40),
      files: [],
      reviews: [],
      posts: 0,
    }),
  );
  provider = await startReviewProviderFixture();
  const gh = `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,[${JSON.stringify(path.join(root, 'scripts/runner-validation/review-provider-fixture.cjs'))},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);\n`;
  stack = await startRemoteNodeStack({
    root,
    evidence,
    machine: 'reviewer-env-proof',
    slots: [REVIEW_PROJECT + '-1'],
    projects: (holds) =>
      projectPacks(holds)
        .filter((pack) => pack.name === REVIEW_PROJECT)
        .map((pack) => ({
          ...pack,
          projectJson: {
            ...pack.projectJson,
            default_safety_tier: safetyTier,
            ci: { repo: 'example/app' },
            review: { enabled: false },
          },
        })),
    seeds: { [REVIEW_PROJECT]: { ...SEED, 'fixture.txt': 'Initial fixture.\n' } },
    binFiles: () => ({ gh }),
    cliSnapshots: path.join(evidence, 'cli-snapshots'),
    nodeBin: path.dirname(process.execPath),
    ownerTag: 'reviewer-pool-env',
    reaper,
    gatewayEnv: {
      FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'refuse',
      FARMSLOT_GITHUB_API_URL: provider.origin,
      PUBLICATION_FIXTURE_STATE: providerState,
    },
    nodeEnv: {
      PUBLICATION_FIXTURE_STATE: providerState,
      FARMSLOT_GITHUB_API_URL: provider.origin,
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
  const cwd = active.slotRepo(REVIEW_PROJECT + '-1');
  git(cwd, 'switch', '-c', 'reviewed');
  const base = git(cwd, 'rev-parse', 'main');
  await writeFile(path.join(cwd, 'fixture.txt'), 'Reviewed fixture.\n');
  git(cwd, 'add', 'fixture.txt');
  git(
    cwd,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'test: change review fixture',
  );
  const localOrigin = git(cwd, 'remote', 'get-url', 'origin');
  assert.ok(path.isAbsolute(localOrigin) && localOrigin.startsWith(active.fixture + path.sep));
  git(cwd, 'push', 'origin', 'reviewed', 'HEAD:refs/pull/42/head');
  const head = git(cwd, 'rev-parse', 'HEAD');
  await writeFile(
    providerState,
    JSON.stringify({
      author: 'author',
      head,
      base,
      reviews: [],
      posts: 0,
      files: [
        {
          filename: 'fixture.txt',
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: '@@ -1 +1 @@\n-Initial fixture.\n+Reviewed fixture.',
        },
      ],
    }),
  );
  const token = randomUUID();
  const reports =
    'In this task directory write artifacts/review.md with Recommendation: COMMENT, explicitly describing a transport-continuity check rather than a review of the upstream PR. Write artifacts/line-comments.json as {"recommendation":"COMMENT","comments":[]} and artifacts/learnings.md. Use this task mark helper after each step, then mark complete --mark-last. Do not publish, commit, contact services or edit other files.';
  const firstTask = path.join(
    active.fixture,
    'projects',
    REVIEW_PROJECT,
    'tasks/review-pr',
    'first-' + Date.now(),
    'TASK.md',
  );
  await writeNativeFixtureTask(
    firstTask,
    '# Worker: review-pr\n\n## Checklist\n\n- [ ] Read fixture.txt and write artifacts/memory.txt in THIS task directory containing exactly ' +
      token +
      '.\n- [ ] Write the local review artifacts and complete this task.\n\n' +
      reports,
    REVIEW_PROJECT,
  );
  const parameters = {
    flowType: 'review-pr',
    project: REVIEW_PROJECT,
    ticketOrPr: 'example/app#42',
    slotId: REVIEW_PROJECT + '-1',
    allowedSlots: [REVIEW_PROJECT + '-1'],
    runner: 'claude',
    model: 'opus',
    mode: 'interactive',
    skipPrepare: true,
    safetyTier,
    completionPolicy: 'artifact-only',
    lane: 'comparison',
    variant: 'pool-env-' + Date.now(),
    branch: 'reviewed',
  };
  const first = (
    await active.call<{ run: Run }>('run.createNative', { ...parameters, taskFile: firstTask })
  ).run;
  await writeFile(path.join(evidence, 'first-run-id'), first.id);
  const read = async (runId: string) => (await active.call<{ run: Run }>('run.get', { runId })).run;
  const completed = async (runId: string) =>
    poll(
      'native review completion ' + runId,
      async () => {
        const run = await read(runId);
        await writeFile(path.join(evidence, 'last-run.json'), JSON.stringify(run, null, 2));
        assert.ok(!['failed', 'blocked', 'cancelled'].includes(run.status), run.error);
        return run.status === 'done' ? run : undefined;
      },
      240_000,
    );
  const firstDone = await completed(first.id);
  const prior = context(firstDone);
  assert.equal(prior.nativeSession!.safetyTier, safetyTier);
  assert.equal(
    prior.reviewValidationDepth,
    undefined,
    'primary review uses its normal pool environment, not the base-pipeline static filter',
  );
  assert.equal(firstDone.reviewResult?.recommendation, 'COMMENT');
  const marker = path.join(cwd, path.dirname(prior.taskFile!), 'artifacts/memory.txt');
  assert.equal((await readFile(marker, 'utf8')).trim(), token);
  const nativeRead = async (runId: string, value: AgentContext) => {
    const binding = value.nativeSession!;
    const request = {
      sessionId: binding.sessionId,
      executionNodeId: binding.executionNodeId,
      worker: {
        runId,
        contextId: value.id,
        generation: binding.generation,
        leaseId: binding.leaseId,
      },
      limit: 200,
    };
    let page = await active.call<NativeSessionReadResult>('native.session.read', request);
    const events = [...page.events];
    while (page.hasMore) {
      const cursor = page.cursor;
      page = await active.call<NativeSessionReadResult>('native.session.read', {
        ...request,
        after: cursor,
      });
      assert.ok(page.cursor > cursor, 'owned history cursor must advance');
      events.push(...page.events);
    }
    return { ...page, events };
  };
  let stopped = await nativeRead(first.id, prior);
  if (!stopped.session.processStopped) {
    await active.call('slot.release', { slotId: REVIEW_PROJECT + '-1', keepWork: true });
    stopped = await nativeRead(first.id, prior);
  }
  assert.equal(stopped.session.processStopped, true);
  await writeFile(
    path.join(evidence, 'first.json'),
    JSON.stringify({ run: firstDone, context: prior, native: stopped }, null, 2),
  );
  const envChange = {
    ASDF_DATA_DIR: path.join(homedir(), '.asdf'),
    ASDF_CONFIG_FILE: path.join(active.fixture, 'proof-asdfrc'),
  };
  await writeFile(envChange.ASDF_CONFIG_FILE, 'legacy_version_file = yes\n');
  for (const directory of ['pool', 'node-pool']) {
    const file = path.join(active.fixture, directory, REVIEW_PROJECT + '.json');
    const pool = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(
      file + '.next',
      JSON.stringify({ ...pool, env: { ...pool.env, ...envChange } }, null, 2),
    );
    await rename(file + '.next', file);
  }
  await active.call('fleet.refresh');
  await writeFile(path.join(evidence, 'pool-change.json'), JSON.stringify(envChange, null, 2));
  const secondTask = path.join(
    active.fixture,
    'projects',
    REVIEW_PROJECT,
    'tasks/review-pr',
    'second-' + Date.now(),
    'TASK.md',
  );
  await writeNativeFixtureTask(
    secondTask,
    '# Worker: review-pr\n\n## Checklist\n\n- [ ] Write artifacts/memory.txt in THIS task directory with the exact token from the first task, using conversation memory. Do not read previous tasks, artifacts or transcripts.\n- [ ] Write the local review artifacts and complete this task.\n\n' +
      reports,
    REVIEW_PROJECT,
  );
  const second = (
    await active.call<{ run: Run }>('run.createNative', {
      ...parameters,
      parentRunId: first.id,
      familyId: firstDone.familyId,
      taskFile: secondTask,
    })
  ).run;
  await writeFile(path.join(evidence, 'second-run-id'), second.id);
  const choosing = await poll(
    'normal repeat-review continuation decision',
    async () => {
      const run = await read(second.id);
      assert.ok(!['failed', 'cancelled', 'blocked'].includes(run.status), run.error);
      return run.decisions.some(
        (decision) => !decision.resolvedAt && decision.type === 'engine_review_continuation',
      )
        ? run
        : undefined;
    },
    90_000,
  );
  const decision = choosing.decisions.find(
    (item) => !item.resolvedAt && item.type === 'engine_review_continuation',
  )!;
  await active.call('run.resolveDecision', {
    runId: second.id,
    decisionId: decision.id,
    actionId: 'reuse-incremental-static',
  });
  const secondDone = await completed(second.id);
  const next = context(secondDone);
  assert.equal(secondDone.repeatReviewContext?.priorRunId, first.id);
  const continuation = secondDone.repeatReviewContext;
  const sessionTrace = continuation?.session;
  assert.ok(sessionTrace);
  assert.equal(sessionTrace.mode, 'warm');
  assert.equal(sessionTrace.continuity, 'resumed');
  assert.equal(next.nativeSession!.sessionId, prior.nativeSession!.sessionId);
  assert.equal(next.runnerSessionId, prior.runnerSessionId);
  assert.notEqual(next.nativeSession!.leaseId, prior.nativeSession!.leaseId);
  assert.notEqual(next.nativeSession!.generation, prior.nativeSession!.generation);
  assert.equal(next.nativeSession!.safetyTier, safetyTier);
  assert.ok(next.nativeSession!.acceptedAt);
  const after = await nativeRead(second.id, next);
  assert.equal(after.session.nativeSessionId, prior.runnerSessionId);
  assert.equal(after.session.workerLaunchDigest, next.nativeSession!.launchDigest);
  assert.equal(after.commands.length, 1);
  assert.equal(after.commands[0]!.accepted, true);
  assert.equal(
    (
      await readFile(path.join(cwd, path.dirname(next.taskFile!), 'artifacts/memory.txt'), 'utf8')
    ).trim(),
    token,
  );
  const original = await nativeRead(first.id, prior);
  assert.deepEqual(original.events, stopped.events);
  assert.deepEqual(original.commands, stopped.commands);
  const providerAfter = JSON.parse(await readFile(providerState, 'utf8'));
  assert.equal(providerAfter.posts, 0);
  assert.equal(providerAfter.slotReport, undefined);
  assert.equal(providerAfter.slotComments, undefined);
  assert.equal(providerAfter.viewedMutations, undefined);
  await writeFile(
    path.join(evidence, 'second.json'),
    JSON.stringify({ run: secondDone, context: next, native: after }, null, 2),
  );
  await writeFile(
    path.join(evidence, 'proof.json'),
    JSON.stringify(
      {
        pass: true,
        firstRunId: first.id,
        secondRunId: second.id,
        nativeSessionId: next.nativeSession!.sessionId,
        runnerSessionId: next.runnerSessionId,
        firstLease: prior.nativeSession!.leaseId,
        secondLease: next.nativeSession!.leaseId,
        confirmedDigest: after.session.workerLaunchDigest,
        policyTier: safetyTier,
        poolEnvironmentChanged: true,
        continuity: sessionTrace.continuity,
        accepted: true,
        providerPosts: providerAfter.posts,
        published: false,
      },
      null,
      2,
    ),
  );
  console.log('PASS', first.id, second.id, next.nativeSession!.sessionId);
} finally {
  await cleanup();
}
