// Opt-in request-policy proof. Uses a disposable gateway and never starts a reviewer.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  isRecord,
  type ReviewGatePayload,
  type RunCreateParams,
  type RunCreateResult,
  type RunGetResult,
} from '@farmslot/protocol';

import { testGatewayProfile } from '../../../../scripts/lib/test-gateway-identity-source.mjs';
import { startGitHubFixture } from '../integrations/github-test-fixtures.js';
import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

test(
  'a fresh chain survives authenticated run creation without inheriting its predecessor',
  { timeout: 180_000 },
  async (t) => {
    const output = process.env.FARMSLOT_FRESH_CHAIN_RPC_OUT;
    assert(output, 'Set FARMSLOT_FRESH_CHAIN_RPC_OUT');
    await mkdir(path.dirname(output), { recursive: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'fresh-review-chain-rpc-'));
    const source = fileURLToPath(new URL('../../../../', import.meta.url));
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(root, 'home'),
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
      TMUX_TMPDIR: path.join(root, 'tmux'),
      GH_TOKEN: 'fixture-token',
      GITHUB_TOKEN: 'fixture-token',
    });
    for (const name of [
      'scripts',
      'packages',
      'services',
      'node_modules',
      'schemas',
      'package.json',
      'CLAUDE.md',
    ])
      await symlink(path.join(source, name), path.join(root, name));
    for (const name of ['home', 'pool', 'tmux', 'projects/review/templates/worker'])
      await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, 'status.json'), JSON.stringify({ slots: [] }));
    await writeFile(
      path.join(root, 'pool/local.json'),
      JSON.stringify({
        machine: 'local',
        host: 'localhost',
        ssh_user: os.userInfo().username,
        project: 'review',
        platform: 'cli',
        slots: [],
        review_workspaces: { max_concurrent: 2 },
      }),
    );
    await writeFile(
      path.join(root, 'projects/review/project.json'),
      JSON.stringify({
        name: 'review',
        repo_url: 'https://github.com/example/app.git',
        ci: { repo: 'example/app' },
        static_review: { template_id: 'review-pr/default' },
        execution_templates: {},
        workflow_defaults: { 'review-pr': { review: { mode: 'warm' } } },
      }),
    );
    await writeFile(
      path.join(root, 'projects/review/templates/worker/review-pr.md'),
      '# Review\n- [ ] Inspect the frozen contribution.\n',
    );
    const provider = await startGitHubFixture((request) => {
      if (request.method !== 'GET')
        return { status: 405, body: { message: 'Fixture refuses provider writes' } };
      if (request.path === '/user') return { body: { login: 'fixture' } };
      return {
        body: {
          number: 42,
          title: 'Fresh review fixture',
          body: '',
          state: 'open',
          draft: false,
          head: { sha: 'c'.repeat(40), ref: 'feature' },
          base: { sha: 'b'.repeat(40), ref: 'main' },
          user: { login: 'fixture' },
          labels: [],
        },
      };
    });
    process.env.FARMSLOT_GITHUB_API_URL = provider.origin;
    t.after(() => provider.close());
    await import('../runtime/mock-pty.test-support.js');
    const fixture = await createNativeProofFixture(t, root);
    const store = await import('../runs/store.js');
    const { findLatestPriorReviewRun } = await import('../run-engine/engine-decisions.js');
    const prior = store.createRun({
      project: 'review',
      flowType: 'review-pr',
      ticketOrPr: 'example/app#42',
    });
    const priorResult: ReviewGatePayload = {
      kind: 'review',
      prNumber: 42,
      repo: 'example/app',
      recommendation: 'REQUEST_CHANGES',
      reviewMd: 'artifacts/review.md',
      lineComments: [{ path: 'src/example.ts', line: 1, body: 'Prior finding', severity: 'major' }],
      reviewSnapshot: {
        source: 'github-pr',
        headSha: 'a'.repeat(40),
        capturedAt: new Date().toISOString(),
      },
    };
    const savedPrior = store.updateRun(prior.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      reviewResult: priorResult,
      agentContexts: [
        {
          id: 'review',
          role: 'review',
          label: 'Reference',
          status: 'complete',
          runId: prior.id,
          slotId: null,
          reviewId: 'reference-lineage',
        },
      ],
    });
    await store.persistRunNow(savedPrior, 'historical fixture setup');
    const before = structuredClone(savedPrior);
    const request: RunCreateParams = {
      project: 'review',
      flowType: 'review-pr',
      ticketOrPr: 'example/app#42',
      mode: 'autonomous',
      runner: 'codex',
      model: 'gpt-6.1-sol',
      transport: 'tmux',
      reviewWorkspaceTarget: { machine: 'local' },
      publishReview: false,
      reviewMode: 'cold',
      reviewContext: { freshChain: true, reviewLineages: [null] },
    };
    const { createGatewayAuthRuntime } = await import('../security/auth.js');
    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'auth') });
    const grant = await auth.writer.exchangePersonCredential(fixture.browserCredential, {
      deviceName: 'Fresh chain CLI proof',
      deviceKind: 'cli',
    });
    testGatewayProfile(path.join(root, 'home'), fixture.url, grant.accessToken, 'fresh-proof');
    const exec = promisify(execFile);
    let runId: string | undefined;
    try {
      const projectPath = path.join(root, 'projects/review/project.json');
      const validProject = await readFile(projectPath, 'utf8');
      const projectConfig: unknown = JSON.parse(validProject);
      assert(isRecord(projectConfig));
      try {
        await writeFile(
          projectPath,
          JSON.stringify({
            ...projectConfig,
            workflow_defaults: {
              'review-pr': {
                review: {
                  mode: 'cold',
                  reviewContext: { freshChain: true, reviewLineages: [null] },
                },
              },
            },
          }),
        );
        // Invalid file-backed defaults make the project unavailable to admission.
        // Direct policy tests additionally assert the detailed one-off-only error.
        await assert.rejects(fixture.client.call('run.create', request), {
          code: 'REVIEW_WORKSPACE_NEEDS_CONFIGURATION',
        });
      } finally {
        await writeFile(projectPath, validProject);
      }
      const cli = await exec(
        'yarn',
        [
          'farmslot',
          '--gateway',
          'fresh-proof',
          '--json',
          '--timeout',
          '120000',
          'run',
          'create',
          '--project',
          'review',
          '--flow-type',
          'review-pr',
          '--ticket',
          'example/app#42',
          '--mode',
          'autonomous',
          '--runner',
          'codex',
          '--model',
          'gpt-6.1-sol',
          '--transport',
          'tmux',
          '--review-machine',
          'local',
          '--no-publish-review',
          '--fresh-review-chain',
        ],
        {
          cwd: path.join(source, 'apps/command-center'),
          env: { ...process.env, GW_URL: fixture.url },
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const envelope: unknown = JSON.parse(cli.stdout);
      assert(
        isRecord(envelope) &&
          envelope.status === 'ok' &&
          isRecord(envelope.data) &&
          isRecord(envelope.data.run),
      );
      const createdId = envelope.data.run.id;
      assert(typeof createdId === 'string');
      runId = createdId;
      const observed = await fixture.client.call<RunGetResult>('run.get', { runId });
      assert.deepEqual(observed.run.reviewContext, request.reviewContext);
      assert.equal(observed.run.repeatReviewContext, undefined);
      assert.equal(findLatestPriorReviewRun(observed.run, [before]), null);
      assert.deepEqual(store.getRun(prior.id), before);
      await store.persistRunNow(store.getRun(runId)!, 'fresh request observed over RPC');
      const stored = JSON.parse(await readFile(path.join(root, 'runs', runId + '.json'), 'utf8'));
      assert.deepEqual(stored.reviewContext, request.reviewContext);
      const cliRunId = runId;
      await fixture.client.call('run.cancel', { runId: cliRunId });
      await fixture.client.call('run.archive', { runId: cliRunId });
      runId = undefined;
      const omittedMode = await fixture.client.call<RunCreateResult>('run.create', {
        ...request,
        reviewMode: undefined,
      });
      try {
        assert.equal(omittedMode.run.reviewMode, 'cold');
        assert.deepEqual(omittedMode.run.reviewContext, request.reviewContext);
      } finally {
        await fixture.client.call('run.cancel', { runId: omittedMode.run.id });
        await fixture.client.call('run.archive', { runId: omittedMode.run.id });
      }

      const comparisonRequest: RunCreateParams = {
        ...request,
        lane: 'comparison',
        variant: 'candidate',
        familyId: prior.id,
        reviewMode: undefined,
        reviewContext: undefined,
      };
      const comparison = await fixture.client.call<RunCreateResult>(
        'run.create',
        comparisonRequest,
      );
      try {
        const observed = await fixture.client.call<RunGetResult>('run.get', {
          runId: comparison.run.id,
        });
        assert.equal(observed.run.reviewMode, 'cold');
        assert.deepEqual(observed.run.reviewContext, { freshChain: true, reviewLineages: [null] });
        assert.equal(findLatestPriorReviewRun(observed.run, [before]), null);
        assert.equal(observed.run.repeatReviewContext, undefined);
      } finally {
        await fixture.client.call('run.cancel', { runId: comparison.run.id });
        await fixture.client.call('run.archive', { runId: comparison.run.id });
      }
      const retainedContext = {
        reviewLineages: [
          {
            reviewId: 'reference-lineage',
            repository: 'example/app',
            prNumber: 42,
          },
        ],
      };
      const retained = await fixture.client.call<RunCreateResult>('run.create', {
        ...comparisonRequest,
        reviewMode: 'cold',
        reviewContext: retainedContext,
      });
      try {
        assert.deepEqual(retained.run.reviewContext, retainedContext);
        assert.equal(findLatestPriorReviewRun(retained.run, [before])?.id, prior.id);
      } finally {
        await fixture.client.call('run.cancel', { runId: retained.run.id });
        await fixture.client.call('run.archive', { runId: retained.run.id });
      }
      assert.deepEqual(store.getRun(prior.id), before);

      await assert.rejects(
        fixture.client.call('run.create', { ...request, reviewMode: 'warm' }),
        /requires COLD/,
      );
      await assert.rejects(
        fixture.client.call('run.create', { ...request, flowType: 'dev' }),
        /new review-pr request/,
      );
      await assert.rejects(
        fixture.client.call('run.create', {
          ...request,
          reviewContext: undefined,
          reviewSequence: [{ runner: 'codex', model: null, effort: null, mode: 'cold' }],
          reviewSequenceContext: { freshChain: true, reviewLineages: [null] },
        }),
        /new review-pr request/,
      );
      await writeFile(
        output,
        JSON.stringify(
          {
            pass: true,
            runId: cliRunId,
            omittedModeRunId: omittedMode.run.id,
            root,
            modelCalls: 0,
            reviewerStarted: false,
            persistentFarmPolicyRejected: true,
            checkoutLocalCliFlag: true,
            freshSelectionPersisted: true,
            omittedModeOverridesWarmDefault: true,
            comparisonDefaultRunId: comparison.run.id,
            comparisonDefaultFresh: true,
            comparisonModeOverridesWarmDefault: true,
            explicitComparisonLineageRunId: retained.run.id,
            explicitComparisonLineagePreserved: true,
            predecessorSelected: false,
            priorRunUnchanged: true,
            conflictingWarmRejected: true,
            otherFlowRejected: true,
            scope:
              'Authenticated request persistence and production predecessor selection; engine deliberately disabled. Task materialization is proved separately.',
          },
          null,
          2,
        ) + '\n',
      );
    } finally {
      if (runId) {
        await fixture.client.call('run.cancel', { runId });
        await fixture.client.call('run.archive', { runId });
      }
    }
  },
);
