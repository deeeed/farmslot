// Authenticated completion policy proof. Canonical media and review records are
// controlled setup fixtures, not product visual judgments or real model reviews.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildRunResolveDecisionParams, type NativeWorkerSessionBinding } from '@farmslot/protocol';

const source = new URL('../../../', import.meta.url).pathname;
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'completion-policy-')));
const output = path.resolve(process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/completion-policy');
const repo = path.join(root, 'projects/policy');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
});
const exec = promisify(execFile);
const load = (file: string) => import(new URL(file, new URL('../../../', import.meta.url)).href);
for (const dir of [path.join(root, 'pool'), path.dirname(repo), output])
  await mkdir(dir, { recursive: true });
await exec('git', ['clone', '--quiet', '--shared', '--no-checkout', source, repo]);
await writeFile(
  path.join(repo, 'project.json'),
  JSON.stringify({ name: 'policy', task_dir: 'tasks', ci: { repo: 'deeeed/farmslot' }, hooks: {} }),
);
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'policy',
    platform: 'cli',
    slots: [{ id: 'completion-policy', repo, session: 'completion-policy' }],
  }),
);
await load('services/gateway/src/runtime/mock-pty.test-support.ts');
const store = await load('services/gateway/src/runs/store.ts');
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: root });
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Policy fixture reviewer' },
  [{ role: 'admin', scope: { kind: 'global' } }],
);
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = person.id;
const issued = auth.writer.issueCredential(person.id, 'Disposable policy fixture');
const grant = auth.writer.exchangePersonCredential(issued.secret, {
  deviceName: 'Policy fixture',
  deviceKind: 'cli',
});
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
const { NativeSessionClient } = await import('@farmslot/agent-runtime/native');
const native = new NativeSessionClient(path.join(root, 'native'));
const { matchesProcess } = await load('packages/agent-runtime/src/native/storage.ts');
const { writeAcceptanceVisualPackage } = await load(
  'services/gateway/src/run-engine/acceptance-package.test-support.ts',
);
const { initializeAcceptanceRegistration, acceptAcceptanceDerivation } = await load(
  'services/gateway/src/tasks/acceptance-registration.ts',
);
const { syncAcceptanceExecutionContract } = await load(
  'services/gateway/src/tasks/acceptance-execution-contract.ts',
);
const { ORCHESTRATOR_LOCALITY } = await load('services/gateway/src/core/slot-io.ts');
const { resolveWorkerTerminalContract } = await load(
  'services/gateway/src/tasks/worker-terminal-contract.ts',
);
const { captureRunOutput } = await load('services/gateway/src/run-completion/output.ts');
const { readGateAcceptance } = await load('services/gateway/src/run-engine/gate-prerequisites.ts');
const { visualReviewSnapshotIdentity } = await load(
  'services/gateway/src/run-engine/recorded-evidence-sources.ts',
);
const { readReviewedInputs } = await load('services/gateway/src/review/reviewed-inputs.ts');
const { readPRCompletionHead, reviewAcceptanceCriteria } = await load(
  'services/gateway/src/review/acceptance-coverage.ts',
);
const server = createServer(),
  wss = createWebSocketServer(server, auth);
let client: InstanceType<typeof GatewayClient> | undefined;
const bindings: NativeWorkerSessionBinding[] = [];
const checks: unknown[] = [];
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const wait = async (read: () => Promise<boolean>, label: string) => {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (await read()) return;
    await pause();
  }
  throw new Error(`Timed out: ${label}`);
};
let failure: unknown;
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  client = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 60_000,
  }).connect();
  try {
    await native.list(person.id);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Native host unavailable;'))
      throw error;
    await wait(async () => {
      try {
        const r = JSON.parse(await readFile(path.join(root, 'native/ready.json'), 'utf8'));
        return matchesProcess(r.pid, path.join(root, 'native'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw e;
      }
    }, 'private native host');
  }
  const kinds = [
    'fresh',
    'old-head',
    'changed-evidence',
    'minimum-two-one',
    'minimum-two-two',
    'interactive-second-feedback',
    'interactive-both-feedback',
  ] as const;
  const requestedCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7);
  assert(!requestedCase || kinds.some((kind) => kind === requestedCase), 'Unknown policy case');
  for (const kind of kinds.filter((kind) => !requestedCase || kind === requestedCase)) {
    const run = store.createRun(
      {
        project: 'policy',
        flowType: 'pr-complete',
        mode: kind.startsWith('interactive-') ? 'interactive' : 'autonomous',
        ticketOrPr: 'deeeed/farmslot#1483',
        slotId: 'completion-policy',
        transport: 'native',
        runner: 'claude',
        model: 'haiku',
      },
      { nativeOwnerPrincipalId: person.id, createdByPrincipalId: person.id },
    );
    const head = await readPRCompletionHead(run);
    await exec('git', ['update-ref', 'HEAD', head], { cwd: repo });
    const oldHead = (await exec('git', ['rev-parse', `${head}^`], { cwd: repo })).stdout.trim();
    const taskDir = path.join(repo, 'tasks/pr-complete', run.id),
      directory = path.join(taskDir, 'artifacts/recipe-runs/qa-attempt');
    await mkdir(directory, { recursive: true });
    await mkdir(path.join(taskDir, 'inputs'));
    const { claims } = await writeAcceptanceVisualPackage(
      directory,
      kind === 'old-head' ? oldHead : head,
      true,
    );
    const original = claims.criteria[0],
      visual = claims.criteria[1];
    const registration = initializeAcceptanceRegistration(
      run.id,
      [{ id: original.id, text: original.text }],
      [{ id: 'visual-source', kind: 'instruction', version: 'v1', body: visual.text }],
      {
        provider: 'github',
        repository: 'deeeed/farmslot',
        prNumber: 1483,
        headSha: head,
        capturedAt: new Date().toISOString(),
      },
    );
    const accepted = acceptAcceptanceDerivation(
      registration,
      {
        schemaVersion: 1,
        runId: run.id,
        generation: 0,
        registrationRevision: registration.revision,
        unitId: 'derive-acceptance',
        classifications: [
          {
            sourceId: 'visual-source',
            sourceVersion: 'v1',
            obligations: [{ text: visual.text, proofMode: 'visual' }],
          },
        ],
      },
      0,
    );
    await writeFile(path.join(taskDir, 'TASK.md'), '# Canonical simulated policy fixture\n');
    await writeFile(path.join(taskDir, 'CHECKLIST.md'), '# Work\n- [x] **1. Done**\n');
    await writeFile(
      path.join(taskDir, 'inputs/handoff.json'),
      JSON.stringify({
        attemptId: run.id,
        project: 'policy',
        flow: 'pr-complete',
        task: { acceptanceCriteria: [original.text] },
      }),
    );
    const base = {
      ...resolveWorkerTerminalContract(null, 'pr-complete', { mode: run.mode }),
      recordedEvidenceContractVersion: run.recordedEvidenceContractVersion,
      acceptanceContractVersion: 1,
      claimReviewSupported: true,
    };
    await writeFile(
      path.join(taskDir, 'inputs/worker-terminal-contract.json'),
      JSON.stringify(base),
    );
    await writeFile(
      path.join(taskDir, 'inputs/acceptance-registration.json'),
      JSON.stringify({ schemaVersion: 1, generation: 0, registration: accepted }),
    );
    await writeFile(path.join(taskDir, 'artifacts/acceptance-status.json'), JSON.stringify(claims));
    await writeFile(
      path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
      JSON.stringify({ version: 1, relativeArtifactRoot: 'recipe-runs/qa-attempt' }),
    );
    await writeFile(path.join(taskDir, 'artifacts/report.md'), '# Simulated policy fixture\n');
    await writeFile(
      path.join(directory, 'evidence-manifest.json'),
      JSON.stringify({
        version: 1,
        standalone: [{ label: 'Simulated policy fixture', file: 'stills/1.png' }],
      }),
    );
    const extra = path.join(taskDir, 'artifacts/reviewed-extra.png');
    await writeFile(extra, 'fixture-reviewed-before');
    const leaseId = randomUUID(),
      session = await native.ensureWorker(
        person.id,
        { sessionId: randomUUID(), runner: 'claude', model: 'haiku', cwd: repo },
        { leaseId, safetyTier: 'full-auto', environment: { set: {}, unset: [] } },
      );
    const binding: NativeWorkerSessionBinding = {
      sessionId: session.id,
      executionNodeId: 'local',
      ownerPrincipalId: person.id,
      generation: session.generation,
      leaseId,
      commandId: randomUUID(),
    };
    bindings.push(binding);
    await native.closeWorker(person.id, {
      sessionId: binding.sessionId,
      generation: binding.generation!,
      leaseId,
    });
    store.updateRun(run.id, {
      status: 'paused',
      lane: 'production',
      taskFile: path.join(taskDir, 'TASK.md'),
      acceptanceRegistration: accepted,
      ticketData: {
        source: 'manual',
        title: 'Simulated policy fixture',
        description: 'Fixture-only metadata; no product visual judgment',
        acceptanceCriteria: [original.text],
        affectedArea: '',
        screenshots: [],
        stepsToReproduce: [],
        labels: [],
      },
      agentContexts: [
        {
          id: 'primary',
          role: 'primary',
          label: 'Stopped fixture process',
          status: 'complete',
          runId: run.id,
          slotId: 'completion-policy',
          runner: 'claude',
          model: 'haiku',
          nativeSession: { ...binding, closedAt: new Date().toISOString() },
        },
      ],
      steps: [
        { name: 'dispatch', status: 'done' },
        { name: 'monitor', status: 'done' },
        { name: 'review', status: 'done' },
        { name: 'complete', status: 'pending' },
      ],
    });
    await writeFile(
      path.join(root, 'status.json'),
      JSON.stringify({
        slots: [
          {
            slot: 'completion-policy',
            current_run_id: run.id,
            lifecycle: 'held',
            phase: 'operator-wait',
          },
        ],
      }),
    );
    await syncAcceptanceExecutionContract(
      store.getRun(run.id)!,
      ORCHESTRATOR_LOCALITY,
      taskDir,
      taskDir,
      async () => true,
    );
    const fingerprint = await readReviewedInputs(store.getRun(run.id)!);
    assert(fingerprint);
    if (kind.startsWith('interactive-')) {
      const { executeReviewStep } = await load(
        'services/gateway/src/run-engine/post-dispatch-steps.ts',
      );
      const { createEngineDecision } = await load(
        'services/gateway/src/run-engine/engine-decisions.ts',
      );
      const { codeReviewCertifiesPRCompletion } = await load(
        'services/gateway/src/review/acceptance-coverage.ts',
      );
      const calls: import('../../../services/gateway/src/review/orchestrator.js').ReviewOptions[] =
        [];
      const decisions: string[] = [];
      const issueCalls = new Set(kind === 'interactive-both-feedback' ? [1, 3] : [2]);
      store.updateRun(run.id, {
        status: 'reviewing',
        steps: [{ name: 'review', status: 'running' }],
        engineState: {
          publishGate: {
            reviews: [],
            reviewPolicy: { minimumReviews: 2, requestedBy: 'dispatch' },
            reviewSequence: [
              { runner: 'claude', model: 'opus', effort: null, mode: 'cold' },
              { runner: 'codex', model: 'gpt-6.1-sol', effort: null, mode: 'cold' },
            ],
          },
        },
      });
      const unexpected = (): never => {
        throw new Error('Unexpected fixture engine path');
      };
      const unexpectedAsync = async (): Promise<never> => unexpected();
      const context: import('../../../services/gateway/src/run-engine/post-dispatch-steps.js').PostDispatchStepContext =
        {
          activeMonitors: new Map(),
          blockedRunError: unexpected,
          broadcastFn: () => undefined,
          createEngineDecision: (id, reason, description, actions, payload, options) =>
            createEngineDecision(id, reason, description, actions, payload, {
              ...options,
              readProgress: async () => ({ kind: 'idle' }),
            }),
          executeNoChangeGate: unexpectedAsync,
          executePublishGateReviewPlan: unexpectedAsync,
          executeReadyGate: unexpectedAsync,
          executeReviewGate: unexpectedAsync,
          getDiffStat: unexpectedAsync,
          interactiveLightweightSkipOutputs: unexpected,
          isHumanGateEnabled: unexpectedAsync,
          monitorTerminalError: unexpected,
          refreshRunLinks: unexpectedAsync,
          stepPartialIO: new Map(),
          deferTerminalSlotRelease: unexpected,
          executeReviewForRun: async (id, _slot, options) => {
            assert(options?.reviewId);
            calls.push(options);
            const current = store.getRun(id)!;
            const verdict = issueCalls.has(calls.length) ? 'issues' : 'pass';
            const row: import('@farmslot/protocol').ReviewStatus = {
              id: options.reviewId,
              source: 'pipeline',
              mode: options.mode ?? 'cold',
              loopNumber: calls.length,
              verdict,
              unresolvedCount: verdict === 'issues' ? 1 : 0,
              reviewerSessionId: `simulated-${options.reviewId}`,
              reviewedHeadSha: head,
              acceptanceReviewCoverage: reviewAcceptanceCriteria(current),
              reviewedInputsFingerprint: fingerprint.fingerprint,
            };
            store.updateRun(id, {
              engineState: {
                ...current.engineState,
                publishGate: {
                  ...current.engineState?.publishGate,
                  reviews: [
                    ...(current.engineState?.publishGate?.reviews ?? []).filter(
                      (review: import('@farmslot/protocol').ReviewStatus) => review.id !== row.id,
                    ),
                    row,
                  ],
                },
              },
            });
            return {
              verdict,
              retryCount: 0,
              reviewId: row.id,
              mode: row.mode,
              acceptanceReviewCoverage: row.acceptanceReviewCoverage,
              reviewedInputsFingerprint: row.reviewedInputsFingerprint,
              reviewSnapshot: {
                headSha: head,
                capturedAt: new Date().toISOString(),
                source: 'local-git',
              },
              ...(verdict === 'issues'
                ? {
                    issues: [
                      { file: 'source.ts', line: 1, description: 'Simulated review finding' },
                    ],
                  }
                : {}),
            };
          },
        };
      let settled = false;
      let reviewFailure: unknown;
      const review = executeReviewStep(run.id, context);
      void review.then(
        () => {
          settled = true;
        },
        (error) => {
          reviewFailure = error;
          settled = true;
        },
      );
      for (let index = 0; index < issueCalls.size; index++) {
        await wait(async () => {
          if (reviewFailure) throw reviewFailure;
          assert(!settled, 'Reviewer findings returned without an operator decision');
          const current = (await client!.call('run.get', { runId: run.id })).run;
          const decision = current.decisions.find(
            (entry: import('@farmslot/protocol').RunDecision) =>
              !entry.resolvedAt && entry.type === 'engine_review_complete',
          );
          if (!decision) return false;
          assert(!decisions.includes(decision.id));
          decisions.push(decision.id);
          await client!.call(
            'run.resolveDecision',
            buildRunResolveDecisionParams({ runId: run.id, decision, actionId: 'send_feedback' }),
          );
          return true;
        }, 'interactive reviewer feedback decision');
      }
      const result = await review;
      assert.equal(result.outputs?.verdict, 'pass');
      assert.equal(result.outputs?.interactiveRetry, true);
      assert.equal(calls.length, issueCalls.size + 2);
      assert.equal(decisions.length, issueCalls.size);
      for (const [index, call] of calls.entries()) {
        if (!call.resumeFromResult) continue;
        assert.equal(call.reviewId, calls[index - 1].reviewId);
        assert.equal(call.reviewRunner, calls[index - 1].reviewRunner);
        assert.equal(call.model, calls[index - 1].model);
        assert.equal(call.mode, 'warm');
        assert.equal(call.publicationReview, true);
      }
      assert(codeReviewCertifiesPRCompletion(store.getRun(run.id)!, head, fingerprint.fingerprint));
      checks.push({
        kind,
        head,
        reviewCalls: calls.length,
        distinctFeedbackDecisions: decisions.length,
        allowed: true,
      });
      continue;
    }
    const minimum = kind.startsWith('minimum-two') ? 2 : 1,
      count = kind === 'minimum-two-two' ? 2 : 1;
    const reviews = Array.from({ length: count }, (_, index) => ({
      id: `pipeline-review-policy-${index}`,
      source: 'pipeline',
      mode: 'cold',
      loopNumber: 1,
      verdict: 'pass',
      unresolvedCount: 0,
      reviewerSessionId: `fixture-independent-${index}`,
      reviewedHeadSha: head,
      acceptanceReviewCoverage: reviewAcceptanceCriteria(store.getRun(run.id)!),
      reviewedInputsFingerprint: fingerprint.fingerprint,
    }));
    const contract = store.getRun(run.id)!.acceptanceExecutionContract!;
    store.updateRun(run.id, {
      metrics: { ...run.metrics, outcome: 'partial' },
      engineState: {
        publishGate: {
          reviews,
          reviewPolicy: { minimumReviews: minimum, requestedBy: 'dispatch' },
        },
      },
      acceptanceProofHold: {
        state: 'held',
        registrationRevision: accepted.revision,
        contractRevision: contract.revision,
        headSha: head,
      },
    });
    await captureRunOutput(run.id, false, true);
    const acceptance = await readGateAcceptance(store.getRun(run.id)!);
    assert.equal(acceptance.error, undefined, acceptance.error);
    const captured = store.getRun(run.id)!;
    const decision = captured.decisions.find(
      ({ payload }: { payload?: { kind?: string } }) => payload?.kind === 'output-review',
    )!;
    store.updateRun(run.id, {
      acceptanceProofHold: { ...captured.acceptanceProofHold!, decisionId: decision.id },
    });
    const judgment = {
      runId: run.id,
      decisionId: decision.id,
      claimId: visual.id,
      recipeRunId: claims.recipeRunId,
      snapshotIdentity: visualReviewSnapshotIdentity(store.getRun(run.id)!, decision.id),
      verdict: 'confirmed',
      reason: 'Simulated framework policy fixture only.',
    };
    if (kind === 'old-head')
      await assert.rejects(
        client.call('run.reviewVisualClaim', judgment),
        /comparison-source-mismatch/,
      );
    else await client.call('run.reviewVisualClaim', judgment);
    if (kind === 'changed-evidence') {
      await writeFile(extra, 'fixture-reviewed-after');
      await wait(
        async () =>
          (await readReviewedInputs(store.getRun(run.id)!))?.fingerprint !==
          fingerprint.fingerprint,
        'changed reviewed evidence fingerprint',
      );
    }
    const advance = async () => {
      const current = (await client!.call('run.get', { runId: run.id })).run;
      const shown = current.decisions.find((entry: { id: string }) => entry.id === decision.id)!;
      return client!.call(
        'run.resolveDecision',
        buildRunResolveDecisionParams({
          runId: run.id,
          decision: shown,
          actionId: 'mark-reviewed',
        }),
      );
    };
    const allowed = kind === 'fresh' || kind === 'minimum-two-two';
    if (allowed) {
      await advance();
      const read = (await client.call('run.get', { runId: run.id })).run;
      assert.equal(read.status, 'completing');
      assert.equal(read.acceptanceProofHold.state, 'reviewed');
    } else {
      await assert.rejects(advance());
      const read = (await client.call('run.get', { runId: run.id })).run;
      assert.equal(read.status, 'paused');
      assert.equal(
        read.decisions.find((d: { id: string }) => d.id === decision.id).resolvedAt,
        undefined,
      );
    }
    checks.push({
      kind,
      allowed,
      head,
      captureHead: kind === 'old-head' ? oldHead : head,
      minimumReviews: minimum,
      reviewCount: count,
    });
  }
} catch (error) {
  failure = error;
} finally {
  const errors: unknown[] = [];
  client?.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const run of store.getAllRuns()) {
    try {
      store.updateRun(run.id, { status: 'done' });
      await store.persistRunNow(store.getRun(run.id)!, 'policy fixture teardown');
      await store.deleteRun(run.id);
    } catch (e) {
      errors.push(e);
    }
  }
  try {
    const h = JSON.parse(await readFile(path.join(root, 'native/host.json'), 'utf8'));
    if (matchesProcess(h.pid, path.join(root, 'native'))) {
      process.kill(h.pid, 'SIGTERM');
      await wait(
        async () => !matchesProcess(h.pid, path.join(root, 'native')),
        'owned policy host stops',
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(e);
  }
  const result = {
    pass: !failure && !errors.length,
    checks,
    error: failure instanceof Error ? failure.message : failure,
    cleanupErrors: errors.map(String),
    scope:
      'Actual authenticated run.reviewVisualClaim/run.resolveDecision/run.get, current engineering PR head read-only, real Git evidence fingerprints. Canonical media/review records are setup fixtures. Native processes receive no command; zero model turns. Engine continuation disabled; no PR writes or product operation.',
    retainedFixture: failure || errors.length ? root : undefined,
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  if (!failure && !errors.length) await rm(root, { recursive: true, force: true });
  if (failure || errors.length) process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
