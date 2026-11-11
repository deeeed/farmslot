import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { piNativeAdapter } from '@farmslot/agent-runtime/native/pi';

import { nodeModelCatalogs } from '../runners/model-catalog.js';
import { NodeModelCatalogObservation } from '../runners/node-model-catalog-observation.js';
import { getRunnerDefinition } from '../runners/registry.js';

import { nativeNodeModels } from './native-workspace.js';

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
    const home = await mkdtemp(path.join(tmpdir(), 'native-pi-catalog-'));
    const previous = process.env.FARMSLOT_HOME;
    process.env.FARMSLOT_HOME = home;
    t.after(async () => {
      if (previous === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = previous;
      await rm(home, { recursive: true, force: true });
    });
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
      response.end(JSON.stringify({ data: [{ id: model }] }));
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
      FARMSLOT_PI_ROUTER_ID: 'local-sparks',
    };
    const source = getRunnerDefinition('pi').modelCatalog;
    assert.ok(source && 'nodeCommand' in source);
    const helper = fileURLToPath(
      new URL('../../../../scripts/runners/pi-farmslot-providers.mjs', import.meta.url),
    );
    const observation = new NodeModelCatalogObservation({
      runner: 'pi',
      source,
      changed: () => undefined,
      nodes: async () => [
        {
          machine: 'native-pi-fixture',
          list: async () => {
            const { stdout } = await promisify(execFile)(
              process.execPath,
              [helper, '--list-models', pi],
              { env, cwd: home },
            );
            return stdout;
          },
        },
      ],
    });
    t.after(() => observation.stop());
    const worker = await observation.sample();
    assert.ok(worker.models.some((entry) => entry.id === `local-sparks/${model}`));
    const models = nativeNodeModels(
      'pi',
      undefined,
      new Map([['fixture', 'native-pi-fixture']]),
    )?.fixture;
    assert.deepEqual(models, [`localsparks/${model}`]);
    assert.ok(!models.includes(`local-sparks/${model}`));
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
