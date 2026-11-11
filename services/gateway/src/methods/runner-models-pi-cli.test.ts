import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const { modelCatalogNodes } = await import('./runner-models.js');
const { getRunnerDefinition } = await import('../runners/registry.js');
const { ModelCatalogFormatError, parsePiModelCatalog } =
  await import('../runners/model-catalog.js');
const { piObservabilityExtensionPath } = await import('../runners/launch-command.js');
const source = getRunnerDefinition('pi').modelCatalog;
assert.ok(source && 'nodeCommand' in source);

for (const scenario of ['healthy', 'http-500', 'timeout', 'legacy'] as const) {
  test(
    `installed pi catalog CLI: ${scenario}`,
    { skip: pi ? false : 'pi CLI is absent' },
    async (t) => {
      const provider = scenario === 'timeout' ? 'router' : 'litellm';
      let requests = 0;
      const server = createServer((req, res) => {
        if (req.url !== '/v1/models') {
          res.writeHead(200).end(JSON.stringify({ data: [] }));
          return;
        }
        requests++;
        assert.equal(req.headers.authorization, 'Bearer synthetic-key');
        if (scenario === 'timeout') return; // Abort is the condition; no fixed sleep.
        res.writeHead(scenario === 'http-500' ? 500 : 200, { 'content-type': 'application/json' });
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
      writeFileSync(
        path.join(env.PI_CODING_AGENT_DIR, 'models.json'),
        JSON.stringify({
          providers: {
            baseline: {
              baseUrl,
              api: 'openai-completions',
              apiKey: 'synthetic-key',
              models: [{ id: 'control', contextWindow: 8192, maxTokens: 1024 }],
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
      if (scenario !== 'legacy')
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
        ...(provider === 'router'
          ? { FARMSLOT_PI_ROUTER_URL: baseUrl, FARMSLOT_PI_ROUTER_KEY: 'synthetic-key' }
          : { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'synthetic-key' }),
      };
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
      const output = await node.list(source);
      assert.match(output, /baseline\s+control/);
      if (scenario === 'legacy') {
        assert.equal(requests, 0);
        assert.doesNotMatch(output, /farmslot.pi-provider-discovery/);
        assert.deepEqual(parsePiModelCatalog(output), {
          ids: ['baseline/control'],
          configuredProviders: [],
        });
        return;
      }
      const report = output
        .split('\n')
        .find((line) => line.startsWith('{"type":"farmslot.pi-provider-discovery"'));
      assert.ok(
        report,
        `No discovery report from installed extension ${piObservabilityExtensionPath(repo, runtimeDir)}`,
      );
      assert.ok(requests > 0, 'slot machine environment must reach provider discovery');
      assert.deepEqual(JSON.parse(report).sources, [
        {
          provider,
          configured: true,
          status: scenario === 'healthy' ? 'ready' : 'failed',
          modelCount: scenario === 'healthy' ? 1 : 0,
        },
      ]);
      if (scenario === 'healthy') {
        const listing = parsePiModelCatalog(output);
        assert.ok(listing.ids.includes(`${provider}/discovered-fixture`));
        assert.deepEqual(listing.configuredProviders, [provider]);
      } else {
        assert.throws(() => parsePiModelCatalog(output), ModelCatalogFormatError);
      }
    },
  );
}
