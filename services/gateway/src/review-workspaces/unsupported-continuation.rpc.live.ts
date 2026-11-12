// Opt-in protocol proof of an adapter declaring continuation unsupported. No model starts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { RunCreateResult, RunGetResult } from '@farmslot/protocol';

import { startGitHubFixture } from '../integrations/github-test-fixtures.js';
import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

test(
  'an unsupported continuation keeps the prior findings and delta through authenticated RPC',
  { timeout: 180000 },
  async (t) => {
    const output = process.env.FARMSLOT_UNSUPPORTED_CONTINUATION_RPC_OUT;
    assert(output, 'Set FARMSLOT_UNSUPPORTED_CONTINUATION_RPC_OUT');
    const root = await mkdtemp(path.join(os.tmpdir(), 'unsupported-continuation-rpc-'));
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
    for (const name of ['home', 'pool', 'tmux', 'projects/review/templates/worker', 'upstream'])
      await mkdir(path.join(root, name), { recursive: true });
    const upstream = path.join(root, 'upstream');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: upstream, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init');
    const commit = async (value: string) => {
      await writeFile(path.join(upstream, 'example.txt'), value);
      git('add', '.');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        'fixture',
      );
      return git('rev-parse', 'HEAD');
    };
    const base = await commit('base'),
      previousHead = await commit('previous'),
      head = await commit('current');
    await writeFile(path.join(root, 'status.json'), JSON.stringify({ slots: [] }));
    await writeFile(
      path.join(root, 'pool/local.json'),
      JSON.stringify({
        machine: 'local',
        host: 'localhost',
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
        repo_url: upstream,
        ci: { repo: 'example/app' },
        static_review: { template_id: 'review-pr/default' },
        execution_templates: {},
      }),
    );
    await writeFile(
      path.join(root, 'projects/review/templates/worker/review-pr.md'),
      '# Review\n- [ ] Inspect the frozen delta.\n',
    );
    const provider = await startGitHubFixture((request) => {
      assert(
        request.method === 'GET' ||
          (request.path === '/graphql' && !/\bmutation\b/.test(request.body)),
        'Provider writes are forbidden',
      );
      if (request.path.includes('/compare/'))
        return { body: { status: 'ahead', ahead_by: 1, behind_by: 0 } };
      if (request.path === '/user') return { body: { login: 'fixture' } };
      return {
        body: {
          number: 42,
          title: 'Continuation fixture',
          body: '',
          state: 'open',
          draft: false,
          head: { sha: head, ref: 'feature' },
          base: { sha: base, ref: 'main' },
          user: { login: 'fixture' },
          labels: [],
        },
      };
    });
    process.env.FARMSLOT_GITHUB_API_URL = provider.origin;
    t.after(() => provider.close());
    await import('../runtime/mock-pty.test-support.js');
    const fixture = await createNativeProofFixture(t, root);
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = fixture.person.id;
    const connection = await fixture.client.connect();
    t.after(() => connection.close());
    const store = await import('../runs/store.js');
    const { KNOWN_RUNNERS } = await import('../runners/registry.js');
    const capability = KNOWN_RUNNERS.codex.sessionContinuation;
    // Fault the declaration, not the launch implementation: WARM must obey the catalog.
    KNOWN_RUNNERS.codex.sessionContinuation = { ...capability, terminal: null };
    t.after(() => {
      KNOWN_RUNNERS.codex.sessionContinuation = capability;
    });
    const prior = store.createRun(
      {
        project: 'review',
        flowType: 'review-pr',
        ticketOrPr: 'example/app#42',
        runner: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'low',
        transport: 'tmux',
        reviewWorkspaceTarget: { machine: 'local' },
      },
      {
        nativeOwnerPrincipalId: fixture.person.id,
        createdByPrincipalId: fixture.person.id,
        createdByPrincipalGeneration: fixture.person.generation ?? 0,
      },
    );
    store.updateRun(prior.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      reviewWorkspace: {
        workspaceId: 'prior-workspace',
        machine: 'local',
        executionNodeId: 'local',
        checkoutPath: path.join(root, 'prior/source'),
        taskPath: path.join(root, 'prior/task'),
        artifactPath: path.join(root, 'prior/task/artifacts'),
        retainedAt: new Date().toISOString(),
        retainedUntil: new Date(Date.now() + 86400000).toISOString(),
        executionStoppedAt: new Date().toISOString(),
      },
      agentContexts: [
        {
          id: 'review',
          role: 'review',
          label: 'Review',
          status: 'complete',
          runId: prior.id,
          slotId: null,
          runner: 'codex',
          model: 'gpt-6.1-sol',
          effort: 'low',
          reviewId: 'fixture-lineage',
          runnerSessionId: 'prior-conversation',
          updatedAt: new Date().toISOString(),
        },
      ],
      reviewResult: {
        recommendation: 'REQUEST_CHANGES',
        reviewMd: 'Prior finding',
        lineComments: [{ path: 'example.txt', line: 1, body: 'Prior finding', severity: 'major' }],
        reviewSnapshot: {
          source: 'github-pr',
          baseSha: base,
          headSha: previousHead,
          capturedAt: new Date().toISOString(),
        },
      },
    });
    await store.persistRunNow(store.getRun(prior.id)!, 'historical fixture input');
    const created = await connection.call<RunCreateResult>('run.create', {
      project: 'review',
      flowType: 'review-pr',
      ticketOrPr: 'example/app#42',
      mode: 'autonomous',
      runner: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'low',
      transport: 'tmux',
      reviewWorkspaceTarget: { machine: 'local' },
      publishReview: false,
      reviewMode: 'warm',
      reviewContext: {
        reviewLineages: [{ reviewId: 'fixture-lineage', repository: 'example/app', prNumber: 42 }],
      },
    });
    process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '0';
    let replayError: unknown;
    const replay = fixture.client
      .call('run.replayStep', { runId: created.run.id, stepName: 'find-slot' })
      .catch((error) => {
        replayError = error;
      });
    let observed: RunGetResult | undefined;
    try {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        observed = await connection.call<RunGetResult>('run.get', { runId: created.run.id });
        if (observed.run.repeatReviewContext) break;
        if (replayError) throw replayError;
        assert(!['failed', 'blocked'].includes(observed.run.status), observed.run.error);
        await delay(25);
      }
      assert(observed?.run.repeatReviewContext?.session?.fallback);
      const run = observed.run;
      assert.equal(run.reviewMode, 'cold');
      assert.equal(run.repeatReviewContext?.session?.continuity, 'fresh');
      assert.equal(
        run.repeatReviewContext?.session?.fallback?.reason,
        'session-resume-unsupported',
      );
      assert.deepEqual(run.repeatReviewContext?.session?.fallback?.comparedRanges, [
        `${previousHead}..${head}`,
      ]);
      assert.equal(run.reviewWorkspaceSubject?.baseSha, previousHead);
      assert.equal(run.reviewWorkspaceSubject?.contributionBaseSha, base);
      assert.equal(run.repeatReviewContext?.unresolvedFindings[0]?.description, 'Prior finding');
      assert.equal(run.repeatReviewContext?.session?.sessionId, undefined);
      assert(
        !run.agentContexts?.some((context) => context.runnerSessionId),
        'No provider may start',
      );
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(
        output,
        JSON.stringify({ status: 'PASS', runId: run.id, priorRunId: prior.id, run }, null, 2) +
          '\n',
      );
    } finally {
      await connection.call('run.cancel', { runId: created.run.id });
      await replay;
    }
  },
);
