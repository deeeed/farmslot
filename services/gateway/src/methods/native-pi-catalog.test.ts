import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Config paths are captured at import. Every command uses this synthetic home and pool.
const home = realpathSync(await mkdtemp(path.join(tmpdir(), 'native-pi-catalog-')));
after(() => rm(home, { recursive: true, force: true }));
process.env = {
  PATH: process.env.PATH,
  TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH,
  HOME: home,
  FARMSLOT_HOME: path.join(home, 'farm'),
  FARMSLOT_ROOT: home,
  FARMSLOT_POOL_DIR: path.join(home, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(home, 'projects'),
};
for (const dir of ['scripts/runners', 'services/gateway', 'pool', 'projects/fixture'])
  await mkdir(path.join(home, dir), { recursive: true });
await writeFile(path.join(home, 'CLAUDE.md'), '# Synthetic root\n');
await writeFile(path.join(home, 'scripts/dev.sh'), '#!/bin/sh\n');
await writeFile(path.join(home, 'services/gateway/package.json'), '{}');
await writeFile(path.join(home, 'projects/fixture/project.json'), '{}');
const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
await copyFile(
  path.join(checkout, 'scripts/runners/pi-farmslot-providers.mjs'),
  path.join(home, 'scripts/runners/pi-farmslot-providers.mjs'),
);
const { piNativeAdapter } = await import('@farmslot/agent-runtime/native/pi');
const { nodeModelCatalogs } = await import('../runners/model-catalog.js');
const { NodeModelCatalogObservation } =
  await import('../runners/node-model-catalog-observation.js');
const { getRunnerDefinition } = await import('../runners/registry.js');
const { modelCatalogNodes } = await import('./runner-models.js');
const { nativeNodeModels } = await import('./native-workspace.js');

const pi = (process.env.PATH ?? '')
  .split(path.delimiter)
  .map((directory) => path.join(directory, 'pi'))
  .find((candidate) => existsSync(candidate));

test(
  'native picker selections start through the production Pi RPC adapter with its own registry',
  {
    skip: !pi && 'installed Pi unavailable',
  },
  async (t) => {
    assert.ok(pi);
    const agent = path.join(home, 'agent');
    await mkdir(agent);
    const model = 'GLM-5.3-Flash-s12';
    await writeFile(
      path.join(agent, 'models.json'),
      JSON.stringify({
        providers: {
          localsparks: {
            baseUrl: 'https://native-model.invalid/v1',
            apiKey: 'synthetic-test-key',
            api: 'openai-completions',
            models: [{ id: model }],
          },
        },
      }),
    );
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: model }, { id: 'discovered-only' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    // No inherited credentials, packages, extensions, or personal config. No prompt is sent.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: '1',
      FARMSLOT_PI_OLLAMA: '0',
      FARMSLOT_PI_ROUTER_URL: `http://127.0.0.1:${address.port}/v1`,
      FARMSLOT_PI_ROUTER_ID: 'localsparks',
    };
    const source = getRunnerDefinition('pi').modelCatalog;
    assert.ok(source && 'nodeCommand' in source);
    const repo = path.join(home, 'repo');
    await mkdir(repo);
    await promisify(execFile)(
      process.execPath,
      [
        path.join(checkout, 'scripts/install-runner-observability.mjs'),
        '--runner',
        'pi',
        '--repo',
        repo,
        '--slot-id',
        'fixture-slot',
      ],
      { env },
    );
    await writeFile(
      path.join(home, 'pool/fixture.json'),
      JSON.stringify({
        machine: 'native-pi-fixture',
        host: 'localhost',
        ssh_user: 'fixture',
        os: 'macos',
        project: 'fixture',
        pi_path: pi,
        env,
        slots: [{ id: 'fixture-slot', repo, session: 'fixture' }],
      }),
    );
    const observation = new NodeModelCatalogObservation({
      runner: 'pi',
      source,
      changed: () => undefined,
      nodes: modelCatalogNodes,
    });
    t.after(() => observation.stop());
    const worker = await observation.sample();
    assert.ok(worker.models.some((entry) => entry.id === `localsparks/discovered-only`));
    const models = nativeNodeModels(
      'pi',
      undefined,
      new Map([['fixture', 'native-pi-fixture']]),
    )?.fixture;
    assert.deepEqual(models, [`localsparks/${model}`]);
    assert.ok(worker.models.some((entry) => entry.id === `localsparks/${model}`));
    assert.ok(!models.includes('localsparks/discovered-only'));
    assert.ok(!models.includes(`router/${model}`));
    assert.deepEqual(nodeModelCatalogs.nativeListing('pi', 'native-pi-fixture'), models);
    const session = await piNativeAdapter.start(
      { executable: pi, cwd: home, env, model: models[0] },
      () => undefined,
    );
    try {
      assert.ok(session.nativeSessionId);
    } finally {
      await session.close();
    }
    assert.deepEqual(requests, ['/v1/models'], 'only synthetic discovery, no inference');
  },
);
