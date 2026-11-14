// Disposable accepted-review boundaries. Failures and retries use production RPC/provider paths.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function startPublicationProof(output) {
  const source = fileURLToPath(new URL('../../../', import.meta.url));
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-publication-proof-'));
  const cdpPort = process.env.FARMSLOT_CDP_PORT;
  for (const key of Object.keys(process.env))
    if (/TOKEN|API_KEY|PASSWORD/.test(key) || /^(FARMSLOT_|GATEWAY_)/.test(key))
      delete process.env[key];
  if (cdpPort) process.env.FARMSLOT_CDP_PORT = cdpPort;
  Object.assign(process.env, {
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
  });
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const load = (relative) => import(pathToFileURL(path.join(source, relative)).href);
  for (const dir of ['home', 'runs', 'pool', 'projects/review', 'bin', 'task', 'client'])
    await mkdir(path.join(root, dir), { recursive: true });
  for (const dir of ['scripts', 'services', 'packages', 'node_modules', 'schemas'])
    await symlink(path.join(source, dir), path.join(root, dir));
  await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable publication proof\n');
  await writeFile(path.join(root, 'task/TASK.md'), '# Already completed static review\n');
  await writeFile(
    path.join(root, 'projects/review/project.json'),
    JSON.stringify({ name: 'review', ci: { repo: 'example/app' } }),
  );
  await symlink(
    path.join(source, 'scripts/runner-validation/review-provider-fixture.cjs'),
    path.join(root, 'bin/gh'),
  );
  process.env.PATH = path.join(root, 'bin') + path.delimiter + process.env.PATH;
  const stateFile = path.join(root, 'provider.json');
  process.env.PUBLICATION_FIXTURE_STATE = stateFile;
  await writeFile(
    stateFile,
    JSON.stringify({
      reviews: [],
      posts: 0,
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      author: 'author',
      files: [],
    }),
  );
  const { handleReviewProviderRequest } = createRequire(path.join(source, 'package.json'))(
    './scripts/runner-validation/review-provider-fixture.cjs',
  );
  const { startGitHubFixture } = await load(
    'services/gateway/src/integrations/github-test-fixtures.ts',
  );
  let failing = true;
  const unsupported = [];
  const provider = await startGitHubFixture((request) => {
    if (failing && request.path === '/user')
      return { status: 500, body: { message: 'Publication proof preflight failure' } };
    if (request.path === '/repos/example/app/pulls/42/commits')
      return { body: [{ sha: 'a'.repeat(40), commit: { message: 'Frozen fixture review' } }] };
    try {
      const response = handleReviewProviderRequest({
        method: request.method,
        pathname: request.path,
        payload: request.json ?? {},
      });
      const pr = response.body?.data?.repository?.pullRequest;
      if (pr) {
        pr.headRefName = 'proof';
        pr.statusCheckRollup = {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: 'StatusContext',
                        context: 'loopback-fixture',
                        state: 'SUCCESS',
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            },
          ],
        };
        pr.reviewThreads = { nodes: [], pageInfo: { hasNextPage: false } };
      }
      return response;
    } catch (error) {
      // Unsupported fixture reads must fail the proof, while still allowing owned cleanup.
      unsupported.push({ method: request.method, path: request.path, error: error.message });
      return { status: 501, body: { message: error.message } };
    }
  });
  process.env.FARMSLOT_GITHUB_API_URL = provider.origin;
  let connection, rules, monitors, wss, server;
  const pending = [];
  try {
    const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
    const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
    const person = auth.writer.createPrincipal(
      { type: 'person', displayName: 'Publication proof' },
      [{ role: 'admin', scope: { kind: 'global' } }],
    );
    process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = person.id;
    const issued = auth.writer.issueCredential(person.id, 'Disposable proof');
    const grant = await auth.writer.exchangePersonCredential(issued.secret, {
      deviceName: 'Publication proof',
      deviceKind: 'cli',
    });
    const at = new Date().toISOString();
    const account = { host: 'github.com', login: 'reviewer' };
    const teamId = 'publication-proof';
    await writeFile(
      path.join(root, '.pr-rules.json'),
      JSON.stringify({
        version: 1,
        teams: [
          {
            id: teamId,
            ownerId: person.id,
            revision: 1,
            createdAt: at,
            updatedAt: at,
            config: {
              name: 'Publication proof',
              account,
              sources: [{ kind: 'repository', repo: 'example/app' }],
              predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
              repositories: [
                {
                  repo: 'example/app',
                  project: 'review',
                  reviewProfile: 'standard',
                  excludedLabels: [],
                },
              ],
              execution: {
                workspacePolicy: { kind: 'exact', machine: 'fixture' },
                transport: 'tmux',
                models: [
                  { effort: 'high', mode: 'cold', runner: 'codex', model: 'fixture-not-launched' },
                ],
              },
              githubTeams: [],
              notificationPrincipalIds: [],
            },
          },
        ],
        rules: [],
        intents: [],
      }),
    );
    const { openRunBundleStore } = await load('packages/run-bundle/src/index.ts');
    await openRunBundleStore({
      runsDir: path.join(root, 'runs'),
      home: path.join(root, 'home'),
      create: true,
    });
    const store = await load('services/gateway/src/runs/store.ts');
    const { createWebSocketServer, broadcast, broadcastEvent } = await load(
      'services/gateway/src/server.ts',
    );
    const { resourceRevisions } = await load('services/gateway/src/resources/revisions.ts');
    resourceRevisions.setPublisher((payload) => broadcastEvent('resource.changed', payload));
    const notify = (owner, event, payload) => broadcast({ type: 'event', event, payload }, owner);
    const { initPRMonitoring } = await load('services/gateway/src/methods/pr-watch.ts');
    const { initPRRules } = await load('services/gateway/src/methods/pr-rules.ts');
    monitors = await initPRMonitoring(auth, notify, false);
    rules = await initPRRules(auth, notify, false, monitors);
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    wss = createWebSocketServer(server, auth);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `ws://127.0.0.1:${server.address().port}/ws`;
    const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
    connection = await new GatewayClient({
      url,
      credential: { token: grant.accessToken },
      timeout: 30000,
    }).connect();
    const profiles = {
      active: 'publication-proof',
      gateways: { 'publication-proof': { url, authMode: 'token', secret: issued.secret } },
    };
    await writeFile(path.join(root, 'client/gateways.json'), JSON.stringify(profiles), {
      mode: 0o600,
    });
    const { captureDirectReviewPublication } = await load(
      'services/gateway/src/review-publication/direct.ts',
    );
    const { resetGitHubTokensForTests } = await load(
      'services/gateway/src/integrations/github-transport.ts',
    );
    const runs = {};
    // Seed only the completed static-review boundary. Do not seed a publication error or receipt.
    for (const name of ['gate', 'saved']) {
      const params = {
        project: 'review',
        flowType: 'review-pr',
        mode: 'interactive',
        ticketOrPr: 'example/app#42',
        publishReview: false,
        reviewWorkspaceTarget: { machine: 'fixture' },
        runner: 'codex',
        model: 'fixture-not-launched',
        effort: 'high',
        transport: 'tmux',
      };
      const run = store.createRun(params, {
        createdByPrincipalId: person.id,
        nativeOwnerPrincipalId: person.id,
        directReviewPublication: captureDirectReviewPublication(params, undefined, person.id),
      });
      const result = {
        recommendation: 'APPROVE',
        reviewMd: `# ${name} publication proof\n\nRetained static review, no worker launched.`,
        reviewSnapshot: { source: 'github-pr', headSha: 'a'.repeat(40), capturedAt: at },
        lineComments: [],
      };
      const decision = {
        id: `accepted-${run.id}`,
        type: 'engine_review_posting',
        title: 'Accepted static review',
        description: '',
        actions: [],
        createdAt: at,
        resolvedAt: at,
        resolvedAction: 'post',
        payload: { kind: 'review', repo: 'example/app', prNumber: 42, ...result },
        selectionData: { recommendation: 'APPROVE', includedIndices: [] },
      };
      store.updateRun(run.id, {
        status: 'done',
        completedAt: at,
        taskFile: path.join(root, 'task/TASK.md'),
        reviewResult: result,
        reviewWorkspaceSubject: {
          repository: 'example/app',
          repositoryUrl: 'https://github.com/example/app.git',
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          branch: 'proof',
          title: 'Publication proof',
          body: '',
          capturedAt: at,
        },
        reviewWorkspace: {
          workspaceId: `private-${run.id}`,
          machine: 'fixture',
          executionNodeId: 'fixture',
          checkoutPath: path.join(root, 'checkout'),
          taskPath: path.join(root, 'task'),
          artifactPath: path.join(root, 'artifacts'),
          cleanedAt: at,
        },
        decisions: [decision],
        reviewPublication: {
          ...run.reviewPublication,
          gate: {
            decisionId: decision.id,
            approvedAt: at,
            publication: {
              ownerId: person.id,
              pr: { host: 'github.com', repo: 'example/app', number: 42 },
              requested: true,
              policy: { enabled: true, source: 'request', teamId, account },
            },
          },
        },
      });
      await store.persistRunNow(store.getRun(run.id), 'seed completed static review');
      resetGitHubTokensForTests();
      await assert.rejects(
        connection.call('prReview.publish', { runId: run.id }),
        /Publication proof preflight failure/,
      );
      const failed = (await connection.call('run.get', { runId: run.id, view: 'snapshot' })).run;
      assert.match(failed.reviewPublication.error, /Publication proof preflight failure/);
      runs[name] = { id: run.id, error: failed.reviewPublication.error };
    }
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).posts, 0);
    // Open a real engine gate around the retained failed result. Only fixture lifecycle changes.
    const retained = store.getRun(runs.gate.id);
    store.updateRun(runs.gate.id, {
      status: 'waiting',
      completedAt: undefined,
      reviewResult: {
        ...retained.reviewResult,
        reviewMd:
          retained.reviewResult.reviewMd + '\n\nUpdated saved report for the next explicit Post.',
      },
    });
    const { setEngineDecisionRuntime } = await load(
      'services/gateway/src/run-engine/engine-decisions.ts',
    );
    setEngineDecisionRuntime({ broadcast: broadcastEvent, stepToStatus: {} });
    const { holdWorkspaceReview } = await load('services/gateway/src/review-workspaces/gate.ts');
    const gateDone = holdWorkspaceReview(runs.gate.id).then(async (result) => {
      assert.equal(result.action, 'post');
      store.updateRun(runs.gate.id, { status: 'done', completedAt: new Date().toISOString() });
      await store.persistRunNow(store.getRun(runs.gate.id), 'fixture review step completed');
      await rules.tick();
    });
    // Retain rejection until teardown, so a failed browser proof cannot leak an unhandled promise.
    let gateError;
    pending.push(
      gateDone.catch((error) => {
        gateError = error;
      }),
    );
    failing = false;
    const config = {
      source,
      root,
      url,
      uiPort: Number(process.env.PUBLICATION_PROOF_UI_PORT ?? 5291),
      runs,
      seededBoundary: 'completed static review; errors produced by authenticated publication RPC',
      externalProviderWrites: 0,
      modelCalls: 0,
    };
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'fixture.json'), JSON.stringify(config, null, 2) + '\n');
    return {
      ...config,
      async verify() {
        assert.deepEqual(unsupported, [], 'Provider fixture must cover all browser reads');
        if (gateError) throw gateError;
        const values = {};
        for (const [name, run] of Object.entries(runs)) {
          const current = (await connection.call('run.get', { runId: run.id, view: 'snapshot' }))
            .run;
          assert.equal(current.reviewPublication.error, undefined);
          assert.equal(current.reviewPublication.receipt.state, 'published');
          values[name] = {
            runId: run.id,
            receipt: current.reviewPublication.receipt,
            errorCleared: true,
          };
        }
        await rules.tick();
        const state = JSON.parse(await readFile(stateFile, 'utf8'));
        assert.equal(state.posts, 2, 'One provider POST per review, no automatic duplicate');
        return {
          runs: values,
          providerPosts: state.posts,
          externalProviderWrites: 0,
          modelCalls: 0,
        };
      },
      async close() {
        connection.close();
        rules.stop();
        monitors.stop();
        resourceRevisions.setPublisher(() => {});
        for (const socket of wss.clients) socket.terminate();
        await new Promise((resolve) => wss.close(resolve));
        await new Promise((resolve) => server.close(resolve));
        await provider.close();
      },
    };
  } catch (error) {
    connection?.close();
    rules?.stop();
    monitors?.stop();
    for (const socket of wss?.clients ?? []) socket.terminate();
    if (wss) await new Promise((resolve) => wss.close(resolve));
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await provider.close();
    throw error;
  }
}
