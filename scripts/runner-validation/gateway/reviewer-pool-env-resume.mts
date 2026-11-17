// Real native repeat-review through the gateway; only GitHub reads use a loopback fixture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isRecord,
  type NativeSessionReadResult,
  type NodeHealthResult,
  type Run,
} from '../../../packages/protocol/src/index.js';
import { projectPacks, REVIEW_PROJECT, SEED } from '../canary/fixtures.mjs';
import { cleanupOnExit, poll, startReaper } from '../lib/isolated-stack.mjs';
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
            static_review: { template_id: 'review-pr/retained-proof', instruction_files: [] },
          },
          files: {
            ...pack.files,
            'templates/shared/review-pr/retained-proof.md': `---
platforms: [cli]
---
# Retained native review proof

- [ ] Start this task through its mark helper, then mark step 1.
- [ ] Inspect the frozen diff and record your real assessment in artifacts/review-draft.md. Mark step 2. For the INITIAL request stop here, end your turn and wait. Leave the parent task running; do not complete the checklist or author the final report yet.
- [ ] ONLY after the explicit operator continuation, preserve your assessment, finish all generated report and coverage requirements from TASK.md, and complete through mark complete --mark-last.
`,
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
  // Managed review support is bundled from this fixture, so its runtime scripts
  // must be concrete copies inside the owned root, like the framework scripts.
  const runtimeScripts = path.join(active.fixture, packages / agent - runtime / scripts);
  assert.equal(await realpath(path.dirname(runtimeScripts)), path.dirname(runtimeScripts));
  await rm(runtimeScripts, { recursive: true, force: true });
  await cp(path.join(root, packages / agent - runtime / scripts), runtimeScripts, {
    recursive: true,
    dereference: true,
  });
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
  for (const directory of ['pool', 'node-pool']) {
    const file = path.join(active.fixture, directory, REVIEW_PROJECT + '.json');
    const pool = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(
      file + '.next',
      JSON.stringify({ ...pool, review_workspaces: { max_concurrent: 1 } }, null, 2),
    );
    await rename(file + '.next', file);
  }
  await active.call('fleet.refresh');
  const created = (
    await active.call<{ run: Run }>('run.create', {
      flowType: 'review-pr',
      project: REVIEW_PROJECT,
      ticketOrPr: 'example/app#42',
      reviewWorkspaceTarget: { machine: 'reviewer-env-proof' },
      transport: 'native',
      runner: 'claude',
      model: 'opus',
      mode: 'autonomous',
      reviewMode: 'cold',
      reviewAutoFinish: false,
      completionPolicy: 'artifact-only',
    })
  ).run;
  await writeFile(path.join(evidence, 'run-id'), created.id);
  const read = async () => (await active.call<{ run: Run }>('run.get', { runId: created.id })).run;
  const nativeRead = async (run: Run) => {
    const reviewer = context(run);
    const binding = reviewer.nativeSession!;
    const request = {
      sessionId: binding.sessionId,
      executionNodeId: binding.executionNodeId,
      worker: {
        runId: run.id,
        contextId: reviewer.id,
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
  const first = await poll(
    'materialized initial reviewer turn and draft',
    async () => {
      const run = await read();
      await writeFile(path.join(evidence, 'last-run.json'), JSON.stringify(run, null, 2));
      assert.ok(!['failed', 'cancelled', 'blocked'].includes(run.status), run.error);
      const reviewer = run.agentContexts?.find((item) => item.id === 'review');
      if (!reviewer?.nativeSession?.acceptedAt || !reviewer.runnerSessionId || !run.reviewWorkspace)
        return undefined;
      const native = await nativeRead(run);
      const command = native.commands.find(
        (item) => item.commandId === reviewer.nativeSession!.commandId,
      );
      if (native.session.state !== 'idle' || command?.outcome !== 'completed') return undefined;
      const draftPath = path.join(run.reviewWorkspace.taskPath, 'artifacts/review-draft.md');
      const draft = await readFile(draftPath, 'utf8');
      assert.ok(draft.trim());
      assert.equal(
        run.reviewResult,
        undefined,
        'first phase must stop without a validated verdict',
      );
      return { run, reviewer, native, draftPath, draft };
    },
    240_000,
  );
  const firstBinding = first.reviewer.nativeSession!;
  assert.equal(first.run.slotId, null);
  assert.equal(first.native.session.nativeSessionHasInput, true);
  assert.equal(first.native.session.workerLaunchDigest, firstBinding.launchDigest);
  await writeFile(path.join(evidence, 'first.json'), JSON.stringify(first, null, 2));
  const closed = await active.call<{ session: NativeSessionReadResult['session'] }>(
    'native.session.close',
    {
      sessionId: firstBinding.sessionId,
      executionNodeId: firstBinding.executionNodeId,
      worker: {
        runId: created.id,
        contextId: first.reviewer.id,
        generation: firstBinding.generation,
        leaseId: firstBinding.leaseId,
      },
    },
  );
  assert.equal(closed.session.processStopped, true);
  const failed = await poll(
    'genuine stopped incomplete review retained for recovery',
    async () => {
      const run = await read();
      return run.status === 'failed' ? run : undefined;
    },
    30_000,
  );
  assert.equal(failed.reviewResult, undefined);
  assert.ok(failed.reviewWorkspace && !failed.reviewWorkspace.cleanedAt);
  assert.equal(failed.reviewWorkspace.workspaceId, first.run.reviewWorkspace!.workspaceId);
  await writeFile(path.join(evidence, 'stopped.json'), JSON.stringify(failed, null, 2));
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
  await active.call('run.replayStep', {
    runId: created.id,
    stepName: 'dispatch',
    triggeredBy: 'operator',
  });
  const resumed = await poll(
    'resumed native reviewer completes the real continuation',
    async () => {
      const run = await read();
      await writeFile(path.join(evidence, 'last-run.json'), JSON.stringify(run, null, 2));
      assert.ok(!['failed', 'cancelled', 'blocked'].includes(run.status), run.error);
      const reviewer = run.agentContexts?.find((item) => item.id === 'review');
      if (
        !reviewer?.nativeSession?.acceptedAt ||
        reviewer.nativeSession.commandId === firstBinding.commandId
      )
        return undefined;
      const native = await nativeRead(run);
      const command = native.commands.find(
        (item) => item.commandId === reviewer.nativeSession!.commandId,
      );
      if (command?.outcome !== 'completed' || !command.accepted || !run.reviewResult)
        return undefined;
      return { run, reviewer, native, command };
    },
    240_000,
  );
  const next = resumed.reviewer.nativeSession!;
  assert.equal(next.sessionId, firstBinding.sessionId);
  assert.equal(resumed.reviewer.runnerSessionId, first.reviewer.runnerSessionId);
  assert.equal(
    next.leaseId,
    firstBinding.leaseId,
    'retained repair preserves its original task lease',
  );
  assert.notEqual(next.generation, firstBinding.generation);
  assert.equal(next.launchDigest, firstBinding.launchDigest);
  assert.equal(resumed.native.session.workerLaunchDigest, next.launchDigest);
  assert.equal(resumed.run.reviewWorkspace!.workspaceId, first.run.reviewWorkspace!.workspaceId);
  assert.equal(resumed.run.reviewWorkspace!.checkoutPath, first.run.reviewWorkspace!.checkoutPath);
  assert.equal(resumed.run.reviewWorkspace!.taskPath, first.run.reviewWorkspace!.taskPath);
  assert.equal(await readFile(first.draftPath, 'utf8'), first.draft);
  const providerAfter = JSON.parse(await readFile(providerState, 'utf8'));
  assert.equal(providerAfter.posts, 0);
  assert.equal(providerAfter.slotReport, undefined);
  assert.equal(providerAfter.slotComments, undefined);
  assert.equal(providerAfter.viewedMutations, undefined);
  await writeFile(path.join(evidence, 'second.json'), JSON.stringify(resumed, null, 2));
  await writeFile(
    path.join(evidence, 'proof.json'),
    JSON.stringify(
      {
        pass: true,
        runId: created.id,
        nativeSessionId: next.sessionId,
        runnerSessionId: resumed.reviewer.runnerSessionId,
        taskLease: next.leaseId,
        firstGeneration: firstBinding.generation,
        resumedGeneration: next.generation,
        confirmedDigest: resumed.native.session.workerLaunchDigest,
        workspaceId: resumed.run.reviewWorkspace!.workspaceId,
        poolEnvironmentChanged: true,
        continuation: 'retained-dispatch-replay',
        accepted: resumed.command.accepted,
        completed: resumed.command.outcome === 'completed',
        providerPosts: providerAfter.posts,
        published: false,
      },
      null,
      2,
    ),
  );
  console.log('PASS', created.id, next.sessionId);
} catch (error) {
  await writeFile(path.join(evidence, proof - error.txt), String(error));
  throw error;
} finally {
  await cleanup();
}
