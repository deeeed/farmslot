import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const found = spawnSync('which', ['pi'], { encoding: 'utf8' });
const pi = found.status === 0 ? found.stdout.trim() : undefined;
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'catalog-pi-cli-')));
after(() => rmSync(root, { recursive: true, force: true }));
const checkout = path.resolve(import.meta.dirname, '../../../..');
const home = path.join(root, 'home');
const poolDir = path.join(root, 'pool');
const projectsDir = path.join(root, 'projects');
// Neither the installer nor pi may inherit personal credentials or agent settings.
const env = {
  PATH: process.env.PATH,
  HOME: home,
  GROK_HOME: path.join(home, '.grok'),
  PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
  NO_COLOR: '1',
  FARMSLOT_PI_OLLAMA: '0',
};
process.env = {
  ...env,
  TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH,
  FARMSLOT_HOME: path.join(root, 'farm'),
  FARMSLOT_ROOT: root,
  FARMSLOT_POOL_DIR: poolDir,
  FARMSLOT_PROJECTS_DIR: projectsDir,
};
for (const dir of [
  home,
  env.PI_CODING_AGENT_DIR,
  poolDir,
  path.join(root, 'scripts'),
  path.join(root, 'services/gateway'),
])
  mkdirSync(dir, { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Synthetic root\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
mkdirSync(path.join(root, 'scripts/runners'));
copyFileSync(
  path.join(checkout, 'scripts/runners/pi-farmslot-providers.mjs'),
  path.join(root, 'scripts/runners/pi-farmslot-providers.mjs'),
);
const { modelCatalogNodes } = await import('./runner-models.js');
const { getRunnerDefinition } = await import('../runners/registry.js');
const { ModelCatalogFormatError, parsePiModelCatalog } =
  await import('../runners/model-catalog.js');
const { RUNNER_OBSERVABILITY_COPY_PATHS } = await import('../runners/runner-observability.js');
for (const relative of RUNNER_OBSERVABILITY_COPY_PATHS) {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  copyFileSync(path.join(checkout, relative), path.join(root, relative));
}
const { piObservabilityExtensionPath } = await import('../runners/launch-command.js');
const source = getRunnerDefinition('pi').modelCatalog;
assert.ok(source && 'nodeCommand' in source);

for (const scenario of [
  'healthy',
  'support-only',
  'static-overrides',
  'http-500',
  'timeout',
  'legacy',
  'worker-static',
  'renamed-router',
  'renamed-router-empty-native',
  'renamed-router-failed',
] as const) {
  test(
    `installed pi catalog CLI: ${scenario}`,
    { skip: pi ? false : 'pi CLI is absent' },
    async (t) => {
      assert.ok(pi);
      const emptyNative = scenario === 'renamed-router-empty-native';
      const renamed =
        scenario === 'renamed-router' || emptyNative || scenario === 'renamed-router-failed';
      const provider = renamed ? 'localsparks' : scenario === 'timeout' ? 'router' : 'litellm';
      const healthy =
        scenario === 'healthy' ||
        scenario === 'support-only' ||
        scenario === 'static-overrides' ||
        scenario === 'renamed-router' ||
        emptyNative;
      let requests = 0;
      const inferenceModels: string[] = [];
      const server = createServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            inferenceModels.push(JSON.parse(body).model);
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(
              `data: ${JSON.stringify({
                id: 'synthetic-completion',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'static-only',
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'fixture-ok' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              })}\n\ndata: [DONE]\n\n`,
            );
          });
          return;
        }
        if (req.url !== '/v1/models') {
          res.writeHead(200).end(JSON.stringify({ data: [] }));
          return;
        }
        requests++;
        assert.equal(req.headers.authorization, 'Bearer synthetic-key');
        if (scenario === 'timeout') return; // Abort is the condition; no fixed sleep.
        res.writeHead(scenario === 'http-500' || scenario === 'renamed-router-failed' ? 500 : 200, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ data: [{ id: 'discovered-fixture' }] }));
      });
      t.after(() => {
        server.closeAllConnections();
        return new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      if (emptyNative) rmSync(path.join(env.PI_CODING_AGENT_DIR, 'models.json'), { force: true });
      else
        writeFileSync(
          path.join(env.PI_CODING_AGENT_DIR, 'models.json'),
          '// Synthetic pi JSONC configuration\n' +
            JSON.stringify({
              providers: {
                baseline: {
                  baseUrl,
                  api: 'openai-completions',
                  apiKey: 'synthetic-key',
                  models: [{ id: 'control', contextWindow: 8192, maxTokens: 1024 }],
                },
                [provider]: {
                  baseUrl,
                  api: 'openai-completions',
                  apiKey: 'synthetic-key',
                  models: [
                    { id: 'static-only', contextWindow: 16384, maxTokens: 2048 },
                    ...(scenario === 'static-overrides'
                      ? [{ id: 'discovered-fixture', contextWindow: 32768, maxTokens: 2048 }]
                      : []),
                  ],
                  ...(scenario === 'static-overrides'
                    ? { modelOverrides: { 'discovered-fixture': { maxTokens: 1024 } } }
                    : {}),
                },
              },
            }),
        );
      // An apostrophe and spaces exercise shell quoting. A custom runtime proves
      // catalog lookup uses the listing slot's project path rather than a default.
      const repo = path.join(root, `slot's ${scenario}`);
      const runtimeDir = 'custom runtime';
      mkdirSync(repo, { recursive: true });
      const project = path.join(projectsDir, scenario);
      mkdirSync(project, { recursive: true });
      writeFileSync(
        path.join(project, 'project.json'),
        JSON.stringify({ paths: { runtime_dir: runtimeDir } }),
      );
      if (scenario !== 'legacy' && scenario !== 'support-only')
        await run(
          process.execPath,
          [
            path.join(checkout, 'scripts/install-runner-observability.mjs'),
            '--runner',
            'pi',
            '--repo',
            repo,
            '--runtime-dir',
            runtimeDir,
            '--slot-id',
            'fixture-slot',
          ],
          { env },
        );
      const machineEnv = {
        ...env,
        ...(provider === 'router' || renamed
          ? {
              FARMSLOT_PI_ROUTER_URL: baseUrl,
              FARMSLOT_PI_ROUTER_KEY: 'synthetic-key',
              ...(renamed ? { FARMSLOT_PI_ROUTER_ID: provider } : {}),
            }
          : { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'synthetic-key' }),
      };
      if (scenario === 'worker-static') {
        const probe = path.join(repo, 'catalog-probe.ts');
        writeFileSync(
          probe,
          `import { writeSync } from 'node:fs';
          export default function(pi) {
            pi.on('session_start', (_event, ctx) => writeSync(1, JSON.stringify({
              type: 'fixture_model_catalog',
              ids: ctx.modelRegistry.getAll().filter(model => model.provider === 'litellm')
                .map(model => model.provider + '/' + model.id),
            }) + '\\n'));
          }`,
        );
        const worker = run(
          pi,
          [
            '--mode',
            'json',
            '--print',
            '--no-session',
            '--no-tools',
            '--thinking',
            'off',
            '-e',
            piObservabilityExtensionPath(repo, runtimeDir),
            '-e',
            probe,
            '--model',
            'litellm/static-only',
            'Synthetic fixture prompt',
          ],
          { cwd: repo, env: machineEnv, timeout: 4000 },
        );
        worker.child.stdin?.end();
        const { stdout, stderr } = await worker;
        assert.deepEqual(inferenceModels, ['static-only']);
        const messages = stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const catalog = messages.find((event) => event.type === 'fixture_model_catalog');
        assert.ok(catalog, stderr);
        assert.ok(catalog.ids.includes('litellm/static-only'));
        assert.ok(catalog.ids.includes('litellm/discovered-fixture'));
        assert.ok(
          messages.some(
            (event) =>
              event.type === 'message_end' &&
              event.message.role === 'assistant' &&
              event.message.content.some((part: { text?: string }) => part.text === 'fixture-ok'),
          ),
        );
        return;
      }
      writeFileSync(
        path.join(poolDir, 'fixture.json'),
        JSON.stringify({
          machine: 'fixture',
          host: 'localhost',
          ssh_user: 'fixture',
          os: 'macos',
          project: scenario,
          pi_path: pi,
          env: machineEnv,
          slots: [{ id: 'fixture-slot', repo, session: 'fixture' }],
        }),
      );
      const nodes = await modelCatalogNodes();
      assert.equal(nodes.length, 1);
      const [node] = nodes;
      assert.ok(node);
      if (scenario !== 'legacy' && !healthy) {
        // Static rows survive discovery failure, but cannot certify the node catalog.
        await assert.rejects(node.list(source), /exit code/);
        const { stdout } = await run(
          pi,
          ['--list-models', '-e', piObservabilityExtensionPath(repo, runtimeDir)],
          { cwd: repo, env: machineEnv },
        );
        assert.match(stdout, new RegExp(`${provider}\\s+static-only`));
        const report = stdout
          .split('\n')
          .find((line) => line.startsWith('{"type":"farmslot.pi-provider-discovery"'));
        assert.ok(report);
        assert.deepEqual(JSON.parse(report).sources, [
          { provider, configured: true, status: 'failed', modelCount: 0 },
        ]);
        assert.throws(() => parsePiModelCatalog(stdout), ModelCatalogFormatError);
        return;
      }
      if (scenario === 'legacy') {
        const helper = path.join(root, 'scripts/runners/pi-farmslot-providers.mjs');
        rmSync(helper);
        t.after(() =>
          copyFileSync(path.join(checkout, 'scripts/runners/pi-farmslot-providers.mjs'), helper),
        );
      }
      const output = await node.list(source);
      const listing = parsePiModelCatalog(output);
      if (emptyNative) {
        assert.equal(requests, 1, 'installed extension must discover worker models');
        assert.deepEqual(listing.ids, ['localsparks/discovered-fixture']);
        assert.deepEqual(listing.nativeIds, []);
        assert.deepEqual(listing.configuredProviders, ['localsparks']);
        assert.deepEqual(listing.aliases, {
          'router/discovered-fixture': 'localsparks/discovered-fixture',
        });
        return;
      }
      if (scenario === 'legacy') {
        assert.equal(requests, 0);
        assert.deepEqual(listing.ids, ['baseline/control', 'litellm/static-only']);
        assert.deepEqual(listing.configuredProviders, []);
        return;
      }
      assert.ok(listing.nativeIds?.includes('baseline/control'));
      assert.ok(listing.nativeIds?.includes(`${provider}/static-only`));
      assert.ok(requests > 0, 'slot machine environment must reach provider discovery');
      assert.equal(
        requests,
        1,
        'installed extension discovers once; helper preserves its static union',
      );
      assert.equal(
        listing.nativeIds?.includes(`${provider}/discovered-fixture`),
        scenario === 'static-overrides',
        'discovery alone cannot certify native registry membership',
      );
      assert.ok(listing.ids.includes(`${provider}/discovered-fixture`));
      assert.ok(listing.ids.includes(`${provider}/static-only`));
      assert.deepEqual(listing.configuredProviders, [provider]);
      assert.equal(listing.ids.filter((id) => id === `${provider}/discovered-fixture`).length, 1);
      if (renamed) {
        assert.deepEqual(listing.aliases, {
          'router/discovered-fixture': 'localsparks/discovered-fixture',
          'router/static-only': 'localsparks/static-only',
        });
        assert.equal(
          listing.ids.some((id) => id.startsWith('router/')),
          false,
        );
        assert.equal(
          listing.nativeIds?.some((id) => id.startsWith('router/')),
          false,
        );
      }
      if (scenario === 'static-overrides') {
        const { stdout } = await run(
          pi,
          ['--list-models', '-e', piObservabilityExtensionPath(repo, runtimeDir)],
          { cwd: repo, env: machineEnv },
        );
        assert.match(stdout, /litellm\s+discovered-fixture\s+32\.8K\s+1\.0K\s+no\s+no/);
      }
    },
  );
}
