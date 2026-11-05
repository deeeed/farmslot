import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, mock, test } from 'node:test';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import { builtinTerminalContract, refreshTaskAcceptanceInputs } from '@farmslot/agent-runtime';
import {
  type ArtifactRef,
  digestRecipeDocument,
  Methods,
  type Principal,
  type RecipeClaimLedger,
  type Run,
  type RunTicketData,
} from '@farmslot/protocol';

import {
  retainTaskExecution,
  verifyTaskExecutionProvenance,
} from '../../../../packages/agent-runtime/src/task-init/execution-provenance.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'ticket-refresh-'));
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
await import('../runtime/mock-pty.test-support.js');
const { createRun, getRun, updateRun, persistRunNow } = await import('../runs/store.js');
const { deleteTestRunIfPresent, makeReadyGatePackage, retainRunFixture } =
  await import('./test-fixtures.js');
const hashes = await import('../run-completion/ready-gate-package.js');
const { AUTHORIZATION_METHOD_CLASSIFICATION } =
  await import('../security/authorization-classification.generated.js');
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const prerequisites = await import('./gate-prerequisites.js');
const completion = await import('../run-completion/orchestrator.js');
const artifacts = await import('./task-artifacts.js');
const reviewed = await import('../review/reviewed-inputs.js');
const ticket = await import('./ticket-data.js');
const { certifyingReview } = await import('./review-claim.test-support.js');

const oldCriteria = [
  'The counter is one.',
  'The old client also works.',
  'Every old client agrees.',
];
const newCriteria = ['The counter is one.', 'Reference fixtures are exported.'];
const newTicket: RunTicketData = {
  source: 'jira',
  title: 'Example core scope',
  description: 'Client work moved to sibling tickets.',
  acceptanceCriteria: newCriteria,
  affectedArea: '',
  stepsToReproduce: [],
  screenshots: [],
  labels: [],
};
const person: Principal = {
  id: 'example-person',
  subject: { type: 'person', displayName: 'Example operator' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
let fetches = 0;
let fetchFailure = false;
let preparationFailure = false;
let loadedTicket = newTicket;
let fetchHook: ((runId: string) => void) | undefined;
afterEach(() => {
  fetchFailure = false;
  preparationFailure = false;
  loadedTicket = newTicket;
  fetchHook = undefined;
});
let activeEvidence: Awaited<ReturnType<typeof readRecordedEvidencePackage>>['input'];
const idle = async () => ({ kind: 'idle' as const });
const passed = async () => {};
const readers = {
  deterministic: passed,
  progress: idle,
  selectedEvidence: passed,
  publicationSecrets: passed,
  recordedEvidence: async () => [activeEvidence],
  reviewedInputsAwaitingReview: async () => null,
  reviewResults: async (run: Run) => run.engineState?.publishGate?.reviews ?? [],
  reviewResult: async () => JSON.stringify({ schemaVersion: 1, verdict: 'pass', issues: [] }),
};
mock.module('./ticket-data.js', {
  namedExports: {
    ...ticket,
    fetchTicketData: async (run: Parameters<typeof ticket.fetchTicketData>[0]) => {
      fetches++;
      fetchHook?.(run.id!);
      if (fetchFailure) throw new Error('Example ticket source unavailable');
      return structuredClone(loadedTicket);
    },
  },
});
mock.module('../review/reviewed-inputs.js', {
  namedExports: { ...reviewed, reviewedInputsChanged: async () => false },
});
mock.module('./task-artifacts.js', {
  namedExports: {
    ...artifacts,
    getDiffStat: async () => ({ files: 1, additions: 1, deletions: 0 }),
  },
});
mock.module('./gate-prerequisites.js', {
  namedExports: {
    ...prerequisites,
    reviewsWithValidResults: readers.reviewResults,
    refreshRunGateReadiness: (run: Run) => prerequisites.refreshRunGateReadiness(run, readers),
  },
});
mock.module('../run-completion/orchestrator.js', {
  namedExports: {
    ...completion,
    prepareCompletionPackageTransitionLocked: async (runId: string) => {
      if (preparationFailure) throw new Error('Example package capture failed');
      const run = getRun(runId)!;
      const old = run.decisions.find(
        (entry) => !entry.resolvedAt && entry.payload?.kind === 'ready',
      )!;
      assert.ok(old.payload?.kind === 'ready' && old.payload.prPackage);
      const prepared = {
        ...old.payload.prPackage,
        id: `pkg-${fetches}`,
        draftBody: run.ticketData!.acceptanceCriteria.join('\n'),
      };
      await retainRunFixture(run, prepared);
      prepared.packageInputHash = hashes.computeReadyGatePackageInputHash(prepared);
      prepared.reviewSubjectHash = hashes.computeReadyGateReviewSubjectHash(prepared);
      prepared.packageHash = hashes.computeReadyGatePackageHash(prepared);
      return {
        prPackage: prepared,
        reviews: run.engineState?.publishGate?.reviews ?? [],
        commit: async () => {
          updateRun(runId, {
            engineState: {
              ...run.engineState,
              publishGate: {
                ...run.engineState?.publishGate,
                packageId: prepared.id,
                packageHash: prepared.packageHash,
              },
            },
          });
        },
      };
    },
  },
});
const ticketRefreshModule: string = './ticket-refresh.js?ticket-scope-test';
const ticketRefreshOwner: typeof import('./ticket-refresh.js') = await import(ticketRefreshModule);
mock.module('./ticket-refresh.js', { namedExports: ticketRefreshOwner });
const { refreshPublishPackage }: typeof import('./publish-package-refresh.js') = await import(
  new URL('./publish-package-refresh.js?ticket-refresh', import.meta.url).href
);

async function fixture(t: import('node:test').TestContext, withEvidence = true) {
  const run = createRun({
    flowType: 'dev',
    project: 'example-ticket-refresh',
    ticketOrPr: 'EXAMPLE-42',
    ticketData: { ...newTicket, acceptanceCriteria: oldCriteria },
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  const taskDir = path.join(root, 'projects/example-ticket-refresh/tasks/feat', run.id);
  const directory = path.join(taskDir, 'artifacts/proof');
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(taskDir, 'inputs'));
  await writeFile(
    path.join(taskDir, 'TASK.md'),
    `# Example task\n\n## Acceptance Criteria\n\n${oldCriteria.map((text, i) => `- AC-${i + 1}: ${text}`).join('\n')}\n\n## Checklist\n\nKeep this section.\n`,
  );
  await writeFile(
    path.join(taskDir, 'inputs/handoff.json'),
    JSON.stringify({
      schemaVersion: 1,
      attemptId: run.id,
      surface: 'farmslot',
      project: run.project,
      flow: run.flowType,
      task: { acceptanceCriteria: oldCriteria },
      taskDocument: 'TASK.md',
    }),
  );
  await writeFile(
    path.join(taskDir, 'inputs/worker-terminal-contract.json'),
    JSON.stringify({
      ...builtinTerminalContract(run.flowType, { mode: run.mode ?? undefined }),
      recordedEvidenceContractVersion: run.recordedEvidenceContractVersion ?? 0,
    }),
  );
  const evidenceManifest: ArtifactRef[] = [];
  if (withEvidence) {
    const declarations = newCriteria.map((claim, index) => ({
      id: `AC-${index + 1}`,
      claim,
      proofMode: 'state' as const,
    }));
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Counter proof',
      description: 'Observe the counter and verify its value.',
      proofTargets: declarations,
      workflow: {
        entry: 'read',
        nodes: {
          read: { action: 'state_read', intent: 'Read counter', next: 'assert' },
          assert: {
            action: 'assert_output',
            source: 'read',
            assert: { path: '$.count', operator: 'eq', value: 1 },
            proves: declarations.map(({ id }) => id),
            intent: 'Verify counter',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    };
    const invocation = {
      version: 1,
      recipeDigest: digestRecipeDocument(recipe),
      recipeRunId: 'counter-proof',
      startedAt: '2026-10-12T00:00:00Z',
      params: {},
      redactedPaths: [],
    };
    const claims: RecipeClaimLedger = {
      schemaVersion: 2,
      recipeRunId: invocation.recipeRunId,
      criteria: declarations.map((declaration) => ({
        id: declaration.id,
        text: declaration.claim,
        kind: 'acceptance',
        proofMode: 'state',
        verdict: 'proven',
        recipeNodes: ['assert'],
        assertionIndices: [1],
        moments: [],
        evidence: [],
      })),
      recording: { status: 'not-required', segments: [] },
    };
    const documents = {
      'recipe.json': recipe,
      'recipe-invocation.json': invocation,
      'acceptance-status.json': claims,
      'recipe-resolution.json': {
        schema_version: 1,
        root: { ref: '$root', digest: digestRecipeDocument(recipe) },
        dependencies: [],
        edges: [],
      },
      'trace.json': {
        entries: [
          {
            nodeId: 'read',
            action: 'state_read',
            intent: 'Read counter',
            ok: true,
            output: { count: 1 },
          },
          {
            nodeId: 'assert',
            action: 'assert_output',
            intent: 'Verify counter',
            ok: true,
            output: { matched: true },
          },
          { nodeId: 'done', action: 'end', ok: true, status: 'pass' },
        ].map((entry) => ({
          ...entry,
          startedAt: invocation.startedAt,
          endedAt: invocation.startedAt,
          durationMs: 0,
        })),
      },
      'summary.json': {
        recipeRunId: invocation.recipeRunId,
        status: 'pass',
        total: 3,
        passed: 3,
        failed: 0,
        cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
        invocationDigest: digestRecipeDocument(invocation),
      },
      'artifact-manifest.json': {
        version: 1,
        runStatus: 'pass',
        artifacts: [
          { path: 'recipe.json', type: 'recipe' },
          { path: 'trace.json', type: 'trace' },
          { path: 'summary.json', type: 'summary' },
          { path: 'acceptance-status.json', type: 'json' },
        ],
      },
    };
    for (const [file, document] of Object.entries(documents)) {
      const bytes = JSON.stringify(document);
      await writeFile(path.join(directory, file), bytes);
      evidenceManifest.push({
        path: `artifacts/proof/${file}`,
        purpose: 'json',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    await writeFile(path.join(taskDir, 'artifacts/acceptance-status.json'), JSON.stringify(claims));
    activeEvidence = (await readRecordedEvidencePackage(directory)).input;
    assert.equal(
      validateRecordedEvidencePackage(activeEvidence).status,
      'valid',
      JSON.stringify(validateRecordedEvidencePackage(activeEvidence)),
    );
  }
  const prepared = makeReadyGatePackage({
    id: 'pkg-old',
    headSha: 'head',
    evidenceManifest,
    selectedEvidenceKeys: [],
    reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
    draftBody: oldCriteria.join('\n'),
  });
  if (withEvidence)
    await retainRunFixture({ ...run, taskFile: path.join(taskDir, 'TASK.md') }, prepared);
  prepared.packageInputHash = hashes.computeReadyGatePackageInputHash(prepared);
  prepared.reviewSubjectHash = hashes.computeReadyGateReviewSubjectHash(prepared);
  prepared.packageHash = hashes.computeReadyGatePackageHash(prepared);
  const review = certifyingReview(prepared);
  updateRun(run.id, {
    status: 'human-gating',
    slotId: null,
    taskFile: path.join(taskDir, 'TASK.md'),
    artifactBundle: prepared.artifactBundle,
    engineState: {
      publishGate: { packageId: prepared.id, packageHash: prepared.packageHash, reviews: [review] },
    },
    decisions: [
      {
        id: 'gate',
        type: 'engine_human_gate',
        title: 'Publish',
        description: '',
        createdAt: new Date().toISOString(),
        actions: [{ id: 'approve-publish', label: 'Publish', style: 'primary' }],
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: null,
          branch: prepared.branch,
          workerReport: '',
          diffStat: prepared.diffStat,
          prPackage: prepared,
        },
      },
    ],
  });
  await persistRunNow(getRun(run.id)!, 'example fixture');
  return { run: getRun(run.id)!, taskDir, prepared };
}

const refresh = (runId: string) =>
  runWithSessionOriginator(person, () => refreshPublishPackage({ runId, refreshTicket: true }));
const refreshInputs = (runId: string, originator = person) =>
  runWithSessionOriginator(originator, () => ticketRefreshOwner.refreshRunTicket(getRun(runId)!));

test('every retry persists the pending admission before changing task inputs', async (t) => {
  const { run, taskDir } = await fixture(t, false);
  const handoffPath = path.join(taskDir, 'inputs/handoff.json');
  const original = await readFile(handoffPath, 'utf8');
  const runsDir = path.join(root, 'runs');
  const savedRunsDir = path.join(root, 'saved-runs');
  await rename(runsDir, savedRunsDir);
  await writeFile(runsDir, 'Unavailable run storage');
  try {
    await assert.rejects(refreshInputs(run.id), /EEXIST|ENOTDIR/);
    const pending = getRun(run.id)!.ticketRefreshes![0];
    assert.equal(pending.appliedAt, undefined);
    assert.equal(pending.principalId, person.id);
    await assert.rejects(refreshInputs(run.id), /EEXIST|ENOTDIR/);
    assert.equal(await readFile(handoffPath, 'utf8'), original);
  } finally {
    await rm(runsDir);
    await rename(savedRunsDir, runsDir);
  }
  const before = fetches;
  loadedTicket = { ...newTicket, acceptanceCriteria: ['A later source edit.'] };
  await refreshInputs(run.id, { ...person, id: 'another-person' });
  assert.equal(fetches, before);
  const durable: Run = JSON.parse(await readFile(path.join(runsDir, `${run.id}.json`), 'utf8'));
  assert.equal(durable.ticketRefreshes?.length, 1);
  assert.equal(durable.ticketRefreshes?.[0].principalId, person.id);
  assert.deepEqual(durable.ticketRefreshes?.[0].previousCriteria, oldCriteria);
  assert.deepEqual(durable.ticketRefreshes?.[0].criteria, newCriteria);
  assert.ok(durable.ticketRefreshes?.[0].appliedAt);
});

test('an interrupted second file write leaves complete inputs that a retry repairs', async (t) => {
  const { run, taskDir } = await fixture(t, false);
  const taskPath = path.join(taskDir, 'TASK.md');
  const original = await readFile(taskPath, 'utf8');
  const originalWrite = fs.writeFile;
  const write = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    const [file] = args;
    if (
      typeof file === 'string' &&
      path.dirname(file) === taskDir &&
      path.basename(file).startsWith('TASK.md')
    ) {
      await originalWrite(file, '# Interrupted\n');
      throw new Error('Example interrupted task write');
    }
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  const restore = () => {
    write.mock.restore();
    syncBuiltinESMExports();
  };
  t.after(restore);
  await assert.rejects(refreshInputs(run.id), /Example interrupted task write/);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8')).task
      .acceptanceCriteria,
    newCriteria,
    'the first file has already been replaced',
  );
  assert.equal(await readFile(taskPath, 'utf8'), original);
  assert.equal(getRun(run.id)!.ticketRefreshes?.[0].appliedAt, undefined);
  restore();
  const before = fetches;
  await refreshInputs(run.id);
  assert.equal(fetches, before);
  assert.match(await readFile(taskPath, 'utf8'), /- Reference fixtures are exported\./);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(taskDir, 'inputs/bug-input.json'), 'utf8')),
    newTicket,
  );
  assert.ok(getRun(run.id)!.ticketRefreshes?.[0].appliedAt);
});

test('ticket scope split refreshes registration and makes the existing passing-review gate ready', async (t) => {
  const { run, taskDir, prepared } = await fixture(t);
  const registration = await prerequisites.readGateAcceptance(run);
  assert.equal(registration.error, undefined);
  const before = await prerequisites.collectRunGateReadiness(run, prepared, readers);
  assert.equal(before.state, 'not-ready');
  assert.ok(
    before.reasons.some(({ code }) => code === 'acceptance-incomplete'),
    JSON.stringify(before),
  );
  assert.ok(
    before.reasons.some(({ code }) => code === 'evidence-policy-unsatisfied'),
    JSON.stringify(before),
  );
  const ledgerBefore = await readFile(
    path.join(taskDir, 'artifacts/acceptance-status.json'),
    'utf8',
  );
  const result = await refresh(run.id);
  const gate = result.run.decisions.find(
    (entry) => !entry.resolvedAt && entry.payload?.kind === 'ready',
  )!;
  assert.ok(gate.payload?.kind === 'ready');
  assert.equal(
    gate.payload.gateReadiness?.state,
    'ready',
    JSON.stringify(gate.payload.gateReadiness),
  );
  assert.deepEqual(result.run.ticketData?.acceptanceCriteria, newCriteria);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8')).task
      .acceptanceCriteria,
    newCriteria,
  );
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/acceptance-status.json'), 'utf8'),
    ledgerBefore,
  );
  assert.equal(result.reviewSubjectHash, prepared.reviewSubjectHash);
  assert.notEqual(result.packageInputHash, prepared.packageInputHash);
  assert.equal(result.run.engineState?.publishGate?.reviews?.[0].verdict, 'pass');
  const history = result.run.ticketRefreshes!;
  assert.equal(history.length, 1);
  assert.equal(history[0].principalId, person.id);
  assert.deepEqual(history[0].previousCriteria, oldCriteria);
  assert.deepEqual(history[0].criteria, newCriteria);
  assert.ok(Number.isFinite(Date.parse(history[0].requestedAt)));
  assert.ok(history[0].appliedAt);
  assert.equal(
    JSON.parse(await readFile(path.join(root, 'runs', `${run.id}.json`), 'utf8')).ticketRefreshes
      .length,
    1,
  );
  assert.ok((await readFile(path.join(taskDir, 'TASK.md'), 'utf8')).includes('Keep this section.'));
  const oldPackage = result.run.decisions.find(
    (entry) => entry.resolvedAction === 'superseded-by-package-refresh',
  );
  assert.ok(oldPackage?.payload?.kind === 'ready');
  assert.deepEqual(oldPackage.payload.prPackage?.draftBody, oldCriteria.join('\n'));
});

test('ordinary package refresh leaves ticket registration unchanged', async (t) => {
  const { run } = await fixture(t);
  const before = fetches;
  const result = await refreshPublishPackage({ runId: run.id });
  assert.equal(fetches, before);
  assert.deepEqual(result.run.ticketData?.acceptanceCriteria, oldCriteria);
  assert.equal(result.run.ticketRefreshes, undefined);
});

for (const change of [
  { prNumber: 42 },
  { engineState: { publishGate: { publicationStatus: 'published_ready' as const } } },
  { engineState: { publishGate: { publicationStatus: 'pending_publish' as const } } },
]) {
  test(`publication ${JSON.stringify(change)} refuses before reading the ticket`, async (t) => {
    const { run, taskDir } = await fixture(t, false);
    const original = await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8');
    const before = fetches;
    updateRun(run.id, change);
    await assert.rejects(refresh(run.id), /already published a PR or publication is in progress/);
    assert.equal(fetches, before);
    assert.equal(getRun(run.id)!.ticketRefreshes, undefined);
    assert.equal(await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8'), original);
  });
}

test('ticket refresh requires a person and refuses an unavailable source without writes', async (t) => {
  const { run, taskDir } = await fixture(t, false);
  const original = await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8');
  const before = fetches;
  await assert.rejects(
    refreshPublishPackage({ runId: run.id, refreshTicket: true }),
    /authenticated person/,
  );
  await assert.rejects(
    runWithSessionOriginator(
      { ...person, subject: { type: 'service', displayName: 'Example service' } },
      () => refreshPublishPackage({ runId: run.id, refreshTicket: true }),
    ),
    /authenticated person/,
  );
  assert.equal(fetches, before);
  fetchFailure = true;
  await assert.rejects(refresh(run.id), /ticket source unavailable/);
  assert.equal(getRun(run.id)!.ticketRefreshes, undefined);
  assert.deepEqual(getRun(run.id)!.ticketData?.acceptanceCriteria, oldCriteria);
  assert.equal(await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8'), original);
});

test('package capture failure preserves the scope action and a retry repairs the gate', async (t) => {
  const { run } = await fixture(t);
  preparationFailure = true;
  await assert.rejects(refresh(run.id), /package capture failed/);
  const retained = getRun(run.id)!;
  assert.deepEqual(retained.ticketData?.acceptanceCriteria, newCriteria);
  assert.equal(retained.ticketRefreshes?.length, 1);
  assert.ok(retained.ticketRefreshes?.[0].appliedAt);
  preparationFailure = false;
  const result = await refresh(run.id);
  assert.equal(result.run.ticketRefreshes?.length, 1);
  const gate = result.run.decisions.find(
    (entry) => !entry.resolvedAt && entry.payload?.kind === 'ready',
  );
  assert.ok(gate?.payload?.kind === 'ready');
  assert.equal(gate.payload.gateReadiness?.state, 'ready');
});

test('new obligations without matching proof keep the refreshed gate not-ready', async (t) => {
  const { run, taskDir } = await fixture(t);
  loadedTicket = {
    ...newTicket,
    acceptanceCriteria: [...newCriteria, 'A new obligation still needs proof.'],
  };
  const before = await readFile(path.join(taskDir, 'artifacts/acceptance-status.json'), 'utf8');
  const result = await refresh(run.id);
  const gate = result.run.decisions.find(
    (entry) => !entry.resolvedAt && entry.payload?.kind === 'ready',
  );
  assert.ok(gate?.payload?.kind === 'ready');
  assert.equal(gate.payload.gateReadiness?.state, 'not-ready');
  assert.ok(
    gate.payload.gateReadiness?.reasons.some(({ code }) => code === 'acceptance-incomplete'),
  );
  assert.ok(
    gate.payload.gateReadiness?.reasons.some(({ code }) => code === 'evidence-policy-unsatisfied'),
  );
  assert.equal(
    await readFile(path.join(taskDir, 'artifacts/acceptance-status.json'), 'utf8'),
    before,
  );
});

test('task refresh preserves a valid execution receipt and updates the frozen replay input', async (t) => {
  const { run, taskDir } = await fixture(t);
  const distributionRoot = path.join(root, run.id, 'distribution');
  const executable = path.join(distributionRoot, 'entry.mjs');
  await mkdir(distributionRoot, { recursive: true });
  await writeFile(executable, 'export {};\n', { mode: 0o755 });
  await writeFile(
    path.join(distributionRoot, 'package.json'),
    JSON.stringify({ name: '@farmslot/cli', version: '1.0.0' }),
  );
  const receipt = retainTaskExecution(taskDir, {
    executable,
    distributionRoot,
    packageRoot: distributionRoot,
    bindingIdentity: null,
    inputs: [],
  });
  const receiptPath = path.join(taskDir, 'artifacts/harness-provenance.json');
  const before = await readFile(receiptPath, 'utf8');
  const frozenPath = path.join(taskDir, '.task-init.json');
  await writeFile(
    frozenPath,
    JSON.stringify({
      runId: run.id,
      slotId: null,
      input: {
        task: {
          taskDir,
          task: { title: 'Original title', acceptanceCriteria: oldCriteria },
          bugInput: run.ticketData,
        },
      },
    }),
  );
  await refresh(run.id);
  assert.equal(await readFile(receiptPath, 'utf8'), before);
  assert.deepEqual(verifyTaskExecutionProvenance(taskDir, null), receipt);
  assert.equal((await stat(frozenPath)).mode & 0o777, 0o600);
  const frozen = JSON.parse(await readFile(frozenPath, 'utf8'));
  assert.deepEqual(frozen.input.task.task.acceptanceCriteria, newCriteria);
  assert.deepEqual(frozen.input.task.bugInput, newTicket);
});

test('the task producer refuses a foreign identity or criteria unrelated to the admitted refresh', () => {
  const input = {
    handoff: JSON.stringify({
      attemptId: 'example-run',
      project: 'example',
      flow: 'dev',
      task: { acceptanceCriteria: oldCriteria },
    }),
    taskMarkdown: '## Acceptance Criteria\n\nOld scope\n',
    runId: 'example-run',
    project: 'example',
    flow: 'dev',
    previousCriteria: oldCriteria,
    criteria: newCriteria,
  };
  assert.throws(
    () => refreshTaskAcceptanceInputs({ ...input, runId: 'another-run' }),
    /identity is invalid/,
  );
  assert.throws(
    () => refreshTaskAcceptanceInputs({ ...input, previousCriteria: ['Unrelated criteria'] }),
    /criteria changed/,
  );
  assert.throws(
    () =>
      refreshTaskAcceptanceInputs({
        ...input,
        taskMarkdown: '# Authored task without a generated section',
      }),
    /generated acceptance criteria section/,
  );
});

test('an interrupted input refresh retries the admitted snapshot and retains its original person', async (t) => {
  const { run, taskDir } = await fixture(t);
  const handoffPath = path.join(taskDir, 'inputs/handoff.json');
  const original = await readFile(handoffPath, 'utf8');
  await writeFile(handoffPath, original.replace(run.id, 'another-run'));
  await assert.rejects(refresh(run.id), /handoff identity is invalid/);
  assert.equal(getRun(run.id)!.ticketRefreshes?.[0].appliedAt, undefined);
  const before = fetches;
  await writeFile(handoffPath, original);
  loadedTicket = {
    ...newTicket,
    acceptanceCriteria: ['A later edit must wait for a separate refresh.'],
  };
  await runWithSessionOriginator({ ...person, id: 'another-person' }, () =>
    refreshPublishPackage({ runId: run.id, refreshTicket: true }),
  );
  assert.equal(fetches, before, 'retry finishes the saved snapshot');
  assert.deepEqual(getRun(run.id)!.ticketData?.acceptanceCriteria, newCriteria);
  assert.equal(getRun(run.id)!.ticketRefreshes?.length, 1);
  assert.equal(getRun(run.id)!.ticketRefreshes?.[0].principalId, person.id);
  assert.ok(getRun(run.id)!.ticketRefreshes?.[0].appliedAt);
});

test('the task writer refreshes worker and gateway copies and revises the supported acceptance contract', async (t) => {
  const { run, taskDir } = await fixture(t);
  const workerRepo = path.join(root, run.id, 'worker');
  const workerTaskDir = path.join(workerRepo, 'tasks/feat', run.id);
  const slotId = `example-${run.id}`;
  await mkdir(path.join(root, 'pool'), { recursive: true });
  await writeFile(
    path.join(root, 'pool/local.json'),
    JSON.stringify({
      machine: 'local',
      host: 'localhost',
      project: run.project,
      platform: 'cli',
      slots: [{ id: slotId, repo: workerRepo, session: slotId }],
    }),
  );
  await writeFile(
    path.join(root, 'projects', run.project, 'project.json'),
    JSON.stringify({ name: run.project, task_dir: 'tasks', hooks: {} }),
  );
  await writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({
      slots: [
        {
          slot: slotId,
          current_run_id: run.id,
          lifecycle: 'busy',
          phase: 'working',
          slot_epoch: 1,
        },
      ],
    }),
  );
  const contractPath = path.join(taskDir, 'inputs/worker-terminal-contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  await writeFile(contractPath, JSON.stringify({ ...contract, acceptanceContractVersion: 1 }));
  await cp(taskDir, workerTaskDir, { recursive: true });
  await writeFile(
    path.join(taskDir, '.task-init.json'),
    JSON.stringify({
      runId: run.id,
      slotId,
      input: { task: { taskDir: workerTaskDir, task: { acceptanceCriteria: oldCriteria } } },
    }),
    { mode: 0o600 },
  );
  updateRun(run.id, { slotId, acceptanceContractVersion: 1 });
  await runWithSessionOriginator(person, () =>
    ticketRefreshOwner.refreshRunTicket(getRun(run.id)!),
  );
  for (const directory of [taskDir, workerTaskDir]) {
    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory, 'inputs/handoff.json'), 'utf8')).task
        .acceptanceCriteria,
      newCriteria,
    );
    const revision = JSON.parse(
      await readFile(path.join(directory, 'inputs/acceptance-contract.json'), 'utf8'),
    );
    assert.deepEqual(
      revision.proofModes.map(({ text }: { text: string }) => text),
      newCriteria,
    );
  }
  assert.equal(getRun(run.id)!.acceptanceExecutionContract?.revision, 1);
  await assert.rejects(readFile(path.join(workerTaskDir, '.task-init.json')), { code: 'ENOENT' });
  const before = fetches;
  await writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({ slots: [{ slot: slotId, current_run_id: 'another-run' }] }),
  );
  await assert.rejects(
    runWithSessionOriginator(person, () => ticketRefreshOwner.refreshRunTicket(getRun(run.id)!)),
    /task owner/,
  );
  assert.equal(fetches, before);
});

test('readiness collected before a scope refresh cannot overwrite its current gate', async (t) => {
  const { run, prepared } = await fixture(t);
  const before = await prerequisites.collectRunGateReadiness(run, prepared, {
    ...readers,
    progress: async () => {
      updateRun(run.id, {
        ticketRefreshes: [
          {
            principalId: person.id,
            requestedAt: new Date().toISOString(),
            previousCriteria: oldCriteria,
            criteria: newCriteria,
          },
        ],
      });
      return { kind: 'idle' };
    },
  });
  assert.ok(before.reasons.some(({ code }) => code === 'run-gate-superseded'));
});

test('ticket refresh retains the existing admin RPC classification', () => {
  assert.equal(
    AUTHORIZATION_METHOD_CLASSIFICATION[Methods.RUN_REFRESH_PUBLISH_PACKAGE].classification,
    'admin',
  );
});

test('a task ownership change during ticket loading refuses without admitting the refresh', async (t) => {
  const { run, taskDir } = await fixture(t, false);
  const original = await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8');
  fetchHook = (runId) => updateRun(runId, { taskFile: path.join(root, 'another-task/TASK.md') });
  await assert.rejects(refresh(run.id), /lost its task owner/);
  assert.equal(getRun(run.id)!.ticketRefreshes, undefined);
  assert.equal(await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8'), original);
});
