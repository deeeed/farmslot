import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';

import { runSessionUsage } from '../../packages/slot-config/src/session-usage.ts';

import install from './pi-farmslot-observability.ts';

const MODEL = 'GLM-5.3-Flash-s12';

async function withAliasExtension(check, environment = {}) {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const events = new Map();
  const configurations = new Map();
  const native = new Map();
  const records = [];
  const messages = [];
  const directory = mkdtempSync(join(tmpdir(), 'pi-router-alias-'));
  process.env = {
    PI_CODING_AGENT_DIR: join(directory, 'synthetic-agent'),
    FARMSLOT_PI_OLLAMA: '0',
    FARMSLOT_PI_ROUTER_URL: 'https://models.invalid/v1',
    FARMSLOT_PI_ROUTER_ID: 'localsparks',
    FARMSLOT_PI_ROUTER_KEY: 'synthetic-test-key',
    FARMSLOT_OBS_DIR: directory,
    ...environment,
  };
  globalThis.fetch = async (input) => {
    if (String(input) === 'https://models.invalid/v1/chat/completions')
      return new Response('synthetic response');
    assert.equal(String(input), 'https://models.invalid/v1/models', 'discovery only');
    return Response.json({ data: [{ id: MODEL }] });
  };
  console.error = () => {};
  try {
    await install({
      on: (event, handler) => events.set(event, handler),
      sendUserMessage: (text) => messages.push(text),
      appendEntry: (customType, data) => records.push({ type: 'custom', customType, data }),
      registerProvider: (id, configuration) => {
        if (typeof id === 'string') configurations.set(id, configuration);
        else native.set(id.id, id);
      },
    });
    await check({ configurations, native, events, records, directory, messages });
  } finally {
    await events.get('session_shutdown')?.({ reason: 'exit' });
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    console.error = originalError;
    rmSync(directory, { recursive: true, force: true });
  }
}

test('router aliases resolve in Pi while available models show only the configured provider', async () => {
  await withAliasExtension(async ({ configurations, native }) => {
    assert.ok(configurations.has('localsparks'));
    assert.equal(configurations.has('router'), false);
    const alias = native.get('router');
    assert.ok(alias, 'register a native provider for saved router model references');
    const models = createModels();
    models.setProvider(alias);
    const saved = models.getModel('router', MODEL);
    assert.equal(saved.provider, 'router');
    assert.equal(saved.id, MODEL);
    assert.equal(saved.baseUrl, 'https://models.invalid/v1');
    assert.equal(saved.reasoning, true);
    assert.deepEqual(
      saved.thinkingLevelMap,
      configurations.get('localsparks').models[0].thinkingLevelMap,
    );
    assert.equal((await models.getAuth(saved)).auth.apiKey, 'synthetic-test-key');
    assert.deepEqual(await models.getAvailable(), [], 'legacy aliases stay out of Pi pickers');
  });
});

test('blind workers keep registered provider keys out of the environment Pi gives tool shells', async () => {
  await withAliasExtension(async () => {
    assert.equal(process.env.FARMSLOT_PI_ROUTER_KEY, 'synthetic-test-key', 'non-blind unchanged');
  });
  const held = Symbol.for('farmslot.pi.providerCredentials');
  try {
    await withAliasExtension(
      async ({ configurations, native }) => {
        // Pi copies process.env into each bash tool spawn.
        assert.equal(process.env.FARMSLOT_PI_ROUTER_KEY, undefined);
        assert.ok(!Object.values(process.env).includes('synthetic-test-key'));
        assert.equal(configurations.get('localsparks').apiKey, 'synthetic-test-key');
        const models = createModels();
        models.setProvider(native.get('router'));
        const saved = models.getModel('router', MODEL);
        assert.equal((await models.getAuth(saved)).auth.apiKey, 'synthetic-test-key');
        // An extension reload in the same Pi process registers the held key again.
        const reloaded = new Map();
        await install({
          on: () => {},
          registerProvider: (id, configuration) => {
            if (typeof id === 'string') reloaded.set(id, configuration);
          },
        });
        assert.equal(reloaded.get('localsparks').apiKey, 'synthetic-test-key');
        assert.equal(process.env.FARMSLOT_PI_ROUTER_KEY, undefined);
      },
      { FARMSLOT_BLIND_SEATBELT: '1', FARMSLOT_MODEL: `localsparks/${MODEL}` },
    );
  } finally {
    delete globalThis[held];
  }
});

test('alias request pricing joins its saved provider and cannot report unknown cost as zero', async () => {
  await withAliasExtension(async ({ configurations, native, events, records, directory }) => {
    const alias = native.get('router').getModels()[0];
    const context = {
      model: alias,
      hasUI: false,
      abort: () => assert.fail('unexpected abort'),
      shutdown: () => assert.fail('unexpected shutdown'),
    };
    await events.get('session_start')({}, context);
    const request = async () =>
      (
        await globalThis.fetch('https://models.invalid/v1/chat/completions', {
          body: JSON.stringify({ model: MODEL, reasoning_effort: 'medium' }),
        })
      ).text();
    await request();
    const session = join(directory, 'session.jsonl');
    writeFileSync(
      session,
      [
        records[0],
        {
          type: 'message',
          message: {
            role: 'assistant',
            provider: 'router',
            model: MODEL,
            usage: {
              input: 100,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { total: 0, totalFromProvider: false },
            },
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const usage = await runSessionUsage({
      repo: '',
      slotId: 'synthetic-alias',
      action: 'total',
      forcedPath: session,
      forcedRunner: 'pi',
    });
    assert.doesNotMatch(usage, /cost_usd=/);
    assert.equal(records[0].data.provider, 'router');
    assert.equal(records[0].data.cost, null);

    const canonical = { ...configurations.get('localsparks').models[0], provider: 'localsparks' };
    await events.get('model_select')({ model: canonical }, context);
    await request();
    assert.equal(records[1].data.provider, 'localsparks');
    await events.get('model_select')({ model: { ...alias, provider: 'litellm' } }, context);
    await request();
    assert.equal(
      records[2].data.provider,
      'localsparks',
      'another source kind cannot rename the record',
    );
    await events.get('model_select')({ model: { ...alias, id: 'different-model' } }, context);
    await request();
    assert.equal(records[3].data.provider, 'localsparks', 'another model cannot rename the record');
  });
});

const piBinary = (process.env.PATH ?? '')
  .split(delimiter)
  .map((directory) => join(directory, 'pi'))
  .find((candidate) => existsSync(candidate));
const piRoot = piBinary && resolve(dirname(realpathSync(piBinary)), '../..');
const runtimeFile = piRoot && join(piRoot, 'dist/core/model-runtime.js');

test(
  'installed Pi resolves CLI aliases and restores a saved router model without fallback',
  {
    skip: !runtimeFile || !existsSync(runtimeFile) ? 'installed Pi SDK unavailable' : false,
  },
  async () => {
    await withAliasExtension(async ({ configurations, native }) => {
      const { ModelRuntime } = await import(pathToFileURL(runtimeFile).href);
      const { resolveCliModel, restoreModelFromSession } = await import(
        pathToFileURL(join(piRoot, 'dist/core/model-resolver.js')).href
      );
      const runtime = await ModelRuntime.create({
        modelsPath: null,
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        refreshOnCreate: false,
      });
      runtime.registerProvider('localsparks', configurations.get('localsparks'));
      assert.ok(native.has('router'), 'saved run keeps the router provider reference');
      runtime.registerNativeProvider(native.get('router'));
      await runtime.refresh({ allowNetwork: false });
      const cli = resolveCliModel({ cliModel: `router/${MODEL}`, modelRuntime: runtime });
      assert.equal(cli.error, undefined);
      assert.equal(cli.warning, undefined);
      assert.equal(cli.model.provider, 'router');
      assert.equal(cli.model.id, MODEL);
      const restored = await restoreModelFromSession('router', MODEL, undefined, false, runtime);
      assert.equal(restored.fallbackMessage, undefined);
      assert.equal(restored.model.provider, 'router');
      assert.equal(restored.model.id, MODEL);
      assert.deepEqual(
        (await runtime.getAvailable())
          .filter((model) => ['router', 'localsparks'].includes(model.provider))
          .map((model) => `${model.provider}/${model.id}`),
        [`localsparks/${MODEL}`],
      );
      assert.equal(
        runtime.getAvailableSnapshot().some((model) => model.provider === 'router'),
        false,
        'terminal picker snapshot hides legacy aliases too',
      );
    });
  },
);

test('read-only terminal review registers providers but leaves trust and argv delivery to Pi', async () => {
  await withAliasExtension(
    async ({ native, events, directory, messages }) => {
      assert.equal(events.has('project_trust'), false);
      process.env.FARMSLOT_TASK_FILE = join(directory, 'TASK.md');
      writeFileSync(process.env.FARMSLOT_TASK_FILE, 'Review task body');
      await events.get('session_start')(
        {},
        {
          model: native.get('router').getModels()[0],
          hasUI: true,
          cwd: directory,
          abort: () => assert.fail('unexpected abort'),
          shutdown: () => assert.fail('unexpected shutdown'),
        },
      );
      assert.deepEqual(messages, [], 'the argv prompt must be the only initial message');
    },
    { FARMSLOT_PI_WORKSPACE_TRUST: 'untrusted', FARMSLOT_THINKING: 'max' },
  );
});
