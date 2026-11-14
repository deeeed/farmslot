// Opt-in real Claude review proof. No production runs, sessions or provider writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { RunCreateResult, RunGetResult } from '../../../packages/protocol/src/index.js';
import { startGitHubFixture } from '../../../services/gateway/src/integrations/github-test-fixtures.js';
import { createNativeProofFixture } from '../../../services/gateway/src/runtime/native-proof-fixture.live-support.js';

const source = fileURLToPath(new URL('../../../', import.meta.url));

test(
  'controlled terminal WARM delta reuses coverage and compacts the same provider session before rebinding',
  { timeout: 900000 },
  async (t) => {
    const evidence = process.env.FARMSLOT_WARM_DELTA_PROOF_OUT;
    assert(evidence, 'Set FARMSLOT_WARM_DELTA_PROOF_OUT');
    await mkdir(evidence, { recursive: true });
    await writeFile(
      path.join(evidence, 'CREATE-ONCE.json'),
      JSON.stringify({ at: new Date().toISOString(), source }),
      { flag: 'wx' },
    );
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'warm-delta-proof-')));
    const save = (name: string, value: unknown) =>
      writeFile(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n');
    const upstream = path.join(root, 'upstream');
    const accountOverride = process.env.CLAUDE_CONFIG_DIR;
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(root, 'home'),
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
      TMUX_TMPDIR: path.join(root, 'tmux'),
      CLAUDE_CODE_TMPDIR: path.join(root, 'provider-tmp'),
      DISABLE_OMC: '1',
      DISABLE_OMX: '1',
      GH_TOKEN: 'fixture-token',
      GITHUB_TOKEN: 'fixture-token',
    });
    for (const key of [
      'TMUX',
      'TMUX_PANE',
      'CLAUDECODE',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'LITELLM_API_KEY',
    ])
      delete process.env[key];
    const auth = JSON.parse(execFileSync('claude', ['auth', 'status'], { encoding: 'utf8' }));
    assert(
      auth.loggedIn === true &&
        auth.authMethod === 'claude.ai' &&
        auth.apiProvider === 'firstParty',
      'This proof requires an existing subscription login',
    );
    await save('AUTH.json', {
      loggedIn: auth.loggedIn,
      authMethod: auth.authMethod,
      apiProvider: auth.apiProvider,
      subscriptionType: auth.subscriptionType,
    });
    for (const name of [
      'scripts',
      'packages',
      'services',
      'node_modules',
      'schemas',
      'package.json',
    ])
      await symlink(path.join(source, name), path.join(root, name));
    for (const name of [
      'home',
      'pool',
      'tmux',
      'upstream',
      'provider-tmp',
      'projects/review/templates/worker',
    ])
      await mkdir(path.join(root, name), { recursive: true });
    await writeFile(
      path.join(root, 'CLAUDE.md'),
      '# Controlled review fixture\nFollow only the current frozen task.\n',
    );
    await writeFile(path.join(root, 'status.json'), JSON.stringify({ slots: [] }));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: upstream, encoding: 'utf8', stdio: 'pipe' }).trim();
    const commit = (message: string) => {
      git('add', '-A');
      git(
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        message,
      );
      return git('rev-parse', 'HEAD');
    };
    git('init', '-b', 'main');
    await writeFile(path.join(upstream, 'sum.js'), 'export const sum = (a, b) => a + b;\n');
    const base = commit('test: base');
    git('checkout', '-b', 'feature');
    await writeFile(
      path.join(upstream, 'sum.js'),
      'export const sum = (a, b) => Number(a) + Number(b);\n',
    );
    for (let i = 1; i <= 12; i++)
      await writeFile(
        path.join(upstream, `guide-${i}.md`),
        `# Sum guide ${i}\n\nAdd two numeric values.\n`,
      );
    let currentHead = commit('test: document numeric sum');
    const baselineHead = currentHead;
    await writeFile(
      path.join(root, 'pool/local.json'),
      JSON.stringify({
        machine: 'local',
        host: 'localhost',
        ssh_user: os.userInfo().username,
        project: 'review',
        platform: 'cli',
        slots: [],
        claude_path: execFileSync('which', ['claude'], { encoding: 'utf8' }).trim(),
        review_workspaces: { max_concurrent: 2 },
      }),
    );
    await writeFile(
      path.join(root, 'projects/review/project.json'),
      JSON.stringify({
        name: 'review',
        repo_url: upstream,
        ci: { repo: 'example/warm-delta' },
        execution_templates: {},
        static_review: { template_id: 'review-pr/default' },
        command_env: {
          unset: [
            'ANTHROPIC_API_KEY',
            'ANTHROPIC_BASE_URL',
            'ANTHROPIC_AUTH_TOKEN',
            'LITELLM_API_KEY',
          ],
          set: {
            ...(accountOverride ? { CLAUDE_CONFIG_DIR: accountOverride } : {}),
            CLAUDE_CODE_TMPDIR: path.join(root, 'provider-tmp'),
            DISABLE_OMC: '1',
            DISABLE_OMX: '1',
          },
        },
      }),
    );
    await writeFile(
      path.join(root, 'projects/review/templates/worker/review-pr.md'),
      `# Numeric sum review

- [ ] Inspect frozen instructions and the exact diff. Start the task.
- [ ] Check that sum adds two numeric inputs. The API intentionally coerces numeric strings; do not request input rejection.
- [ ] Check that every changed guide accurately describes numeric addition and contains no incompatible API promise.
- [ ] Recheck prior findings and each rule's applicability against the current delta. Reuse only validated rows.
- [ ] Write a current-head verdict and typed result, with complete coverage. Preserve concrete gaps and findings.
- [ ] Write artifacts/learnings.md and finish through the shared mark complete command.

Use the root checklist without child units. Scope is numeric addition and these guides only. Use compact current updates and the shared composer; do not rewrite validated tables. Aim for 8-12 provider calls and under 10000 output tokens, without skipping required inspection. Fewer calls are fine. Batch independent reads and writes when practical.
`,
    );
    let providerWrites = 0;
    const provider = await startGitHubFixture((request) => {
      if (
        request.method !== 'GET' &&
        !(request.path === '/graphql' && !/\bmutation\b/.test(request.body))
      ) {
        providerWrites++;
        return { status: 405, body: { message: 'No provider writes in this proof' } };
      }
      if (request.path === '/user') return { body: { login: 'fixture' } };
      if (request.path.includes('/compare/'))
        return { body: { status: 'ahead', ahead_by: 2, behind_by: 0 } };
      return {
        body: {
          number: 42,
          title: 'Document numeric sum',
          body: 'Allow numeric strings and document the numeric sum. All guides are required examples.',
          html_url: 'https://github.com/example/warm-delta/pull/42',
          state: 'open',
          draft: false,
          head: { sha: currentHead, ref: 'feature' },
          base: { sha: base, ref: 'main' },
          user: { login: 'fixture' },
          labels: [],
        },
      };
    });
    process.env.FARMSLOT_GITHUB_API_URL = provider.origin;
    t.after(() => provider.close());
    const fixture = await createNativeProofFixture(t, root);
    const { initServerGlobals, resetServerGlobalsForTests } =
      await import('../../../services/gateway/src/server.js');
    initServerGlobals();
    t.after(resetServerGlobalsForTests);
    delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    const connection = await fixture.client.connect();
    t.after(() => connection.close());
    const runs: string[] = [];
    const read = async (runId: string) =>
      (await connection.call<RunGetResult>('run.get', { runId })).run;
    const parameters = {
      project: 'review',
      flowType: 'review-pr',
      ticketOrPr: 'example/warm-delta#42',
      mode: 'autonomous',
      runner: 'claude',
      model: 'claude-opus-5-5',
      transport: 'tmux',
      safetyTier: 'dangerous',
      reviewWorkspaceTarget: { machine: 'local' },
      publishReview: false,
      reviewAutoFinish: true,
    };
    const awaitDone = async (id: string, label: string) => {
      const deadline = Date.now() + 360000;
      let lastStatus = '';
      while (Date.now() < deadline) {
        if (existsSync(path.join(evidence, 'STOP.json')))
          throw new Error('Operator stopped the owned proof');
        const run = await read(id);
        await save(label + '-RUN.json', run);
        if (run.status !== lastStatus) {
          process.stdout.write(`${label} ${run.status}\n`);
          lastStatus = run.status;
        }
        if (run.status === 'done') return run;
        if (['failed', 'blocked', 'cancelled'].includes(run.status))
          throw new Error(`${label}: ${run.error ?? run.status}`);
        await delay(250);
      }
      throw new Error(label + ' timed out');
    };
    try {
      const first = (
        await connection.call<RunCreateResult>('run.create', {
          ...parameters,
          reviewMode: 'cold',
          reviewContext: { freshChain: true, reviewLineages: [null] },
        })
      ).run;
      runs.push(first.id);
      const prior = await awaitDone(first.id, 'COLD');
      assert(
        prior.reviewResult?.artifactManifest?.some(
          (entry) => entry.path === 'artifacts/review-coverage.json',
        ),
      );
      const context = prior.agentContexts?.find((entry) => entry.id === 'review');
      assert(context?.reviewId && context.runnerSessionId);
      await writeFile(
        path.join(upstream, 'guide-1.md'),
        '# Sum guide 1\n\nAdd two numeric values, including numeric strings.\n',
      );
      commit('test: clarify guide one');
      await writeFile(
        path.join(upstream, 'guide-2.md'),
        '# Sum guide 2\n\nExample: sum("2", "3") returns 5.\n',
      );
      currentHead = commit('test: add numeric string example');
      const second = (
        await connection.call<RunCreateResult>('run.create', {
          ...parameters,
          reviewMode: 'warm',
          reviewContext: {
            reviewLineages: [
              { repository: 'example/warm-delta', prNumber: 42, reviewId: context.reviewId },
            ],
          },
        })
      ).run;
      runs.push(second.id);
      const warm = await awaitDone(second.id, 'WARM');
      const trace = warm.repeatReviewContext?.session;
      assert(trace);
      assert.equal(trace.continuity, 'resumed');
      assert.equal(trace.priorSessionId, context.runnerSessionId);
      assert.equal(trace.compaction?.status, 'confirmed');
      assert.equal(trace.compaction.nativeSessionId, context.runnerSessionId);
      const view = path.join(root, 'runs/review-workspace-tasks', warm.id, 'view');
      const packet = JSON.parse(await readFile(path.join(view, 'inputs/warm-delta.json'), 'utf8'));
      assert.equal(packet.baselineHeadSha, baselineHead);
      assert.equal(packet.currentHeadSha, currentHead);
      assert(packet.reusableKeys.length > 0);
      const index = JSON.parse(
        await readFile(path.join(view, 'artifacts/review-coverage.json'), 'utf8'),
      );
      await save('PACKET.json', packet);
      await save('COVERAGE.json', index);
      for (const file of ['review.md', 'review-result.json', 'review-ledger.md'])
        await cp(path.join(view, 'artifacts', file), path.join(evidence, 'WARM-' + file));
      assert(
        index.rows.some(
          (row: { provenance: { runId: string } }) => row.provenance.runId === prior.id,
        ),
      );
      const sessionPath = warm.agentContexts?.find(
        (entry) => entry.id === 'review',
      )?.runnerSessionPath;
      assert(sessionPath && path.basename(sessionPath) === context.runnerSessionId + '.jsonl');
      const records: Record<string, unknown>[] = (await readFile(sessionPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      await save('SESSION.json', records);
      let boundary = -1;
      for (let index = records.length - 1; index >= 0; index--) {
        if (records[index].type === 'system' && records[index].subtype === 'compact_boundary') {
          boundary = index;
          break;
        }
      }
      assert(boundary >= 0);
      const delta = records.slice(boundary + 1);
      const responses = new Map<string, Record<string, unknown>>();
      for (const row of delta) {
        const message = row.message;
        if (
          row.type === 'assistant' &&
          message &&
          typeof message === 'object' &&
          'id' in message &&
          typeof message.id === 'string'
        )
          responses.set(message.id, message);
      }
      let outputTokens = 0,
        cacheReadTokens = 0,
        inputTokens = 0;
      for (const message of responses.values()) {
        const usage = message.usage;
        if (usage && typeof usage === 'object') {
          if ('output_tokens' in usage && typeof usage.output_tokens === 'number')
            outputTokens += usage.output_tokens;
          if (
            'cache_read_input_tokens' in usage &&
            typeof usage.cache_read_input_tokens === 'number'
          )
            cacheReadTokens += usage.cache_read_input_tokens;
          if ('input_tokens' in usage && typeof usage.input_tokens === 'number')
            inputTokens += usage.input_tokens;
        }
      }
      const result = {
        status: 'PASS',
        coldRunId: prior.id,
        warmRunId: warm.id,
        sessionId: context.runnerSessionId,
        compaction: trace.compaction,
        deltaCalls: responses.size,
        outputTokens,
        cacheReadTokens,
        inputTokens,
        reusedRows: index.rows.filter(
          (row: { provenance: { runId: string } }) => row.provenance.runId === prior.id,
        ).length,
        totalRows: index.rows.length,
        packetBytes: Buffer.byteLength(JSON.stringify(packet)),
        providerWrites,
      };
      await save('RESULT.json', result);
      assert.equal(providerWrites, 0);
      assert(
        responses.size > 0 && responses.size <= 12,
        'Controlled delta exceeded 12 provider calls',
      );
      assert(outputTokens > 0 && outputTokens < 10000, 'Controlled delta exceeded output budget');
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (error) {
      await save('FAILURE.json', {
        root,
        runs,
        error: error instanceof Error ? error.stack : String(error),
      });
      for (const runId of runs) {
        const run = await read(runId);
        await save(runId + '-FAILED-RUN.json', run);
        const snapshot = path.join(root, 'runs/review-workspace-tasks', runId);
        if (existsSync(snapshot))
          await cp(snapshot, path.join(evidence, runId + '-snapshot'), { recursive: true });
      }
      throw error;
    } finally {
      for (const runId of runs) {
        const run = await read(runId);
        if (!['done', 'failed', 'cancelled'].includes(run.status))
          await connection.call('run.cancel', { runId });
        const deadline = Date.now() + 60000;
        while (true) {
          const settled = await read(runId);
          if (
            !settled.reviewWorkspace ||
            settled.reviewWorkspace.executionStoppedAt ||
            settled.reviewWorkspace.cleanedAt
          )
            break;
          assert(Date.now() < deadline, 'Owned review teardown did not settle');
          await delay(100);
        }
        await connection.call('run.archive', { runId });
      }
    }
  },
);
