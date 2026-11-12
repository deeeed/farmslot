import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertPiModelThinking,
  preservePiStaticModels,
  resolvePiProviderCatalog,
} from './pi-farmslot-providers.mjs';

for (const reasoning of [true, false, undefined]) {
  test(`static models retain pool reasoning declaration: ${reasoning ?? 'absent'}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-static-models-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const agent = join(root, 'agent');
    mkdirSync(agent);
    writeFileSync(join(agent, 'models.json'), '{}');
    const env = {
      PI_CODING_AGENT_DIR: agent,
      FARMSLOT_PI_OLLAMA: '0',
      LITELLM_URL: 'http://litellm.invalid/v1',
      ...(reasoning === undefined
        ? {}
        : {
            FARMSLOT_PI_LITELLM_MODEL_LIMITS: JSON.stringify({ 'glm-5p3-flash': { reasoning } }),
          }),
    };
    const catalog = await resolvePiProviderCatalog(env, {
      fetchImpl: async (url) =>
        Response.json({
          data: url.endsWith('/model/info')
            ? [
                {
                  model_name: 'glm-5p3-flash',
                  model_info: { supports_reasoning: null, reasoning_effort_levels: ['medium'] },
                },
              ]
            : [{ id: 'glm-5p3-flash' }],
        }),
    });
    const [provider] = await preservePiStaticModels(
      catalog,
      async (file) => {
        assert.equal(file, join(agent, 'models.json'));
        return {
          getError: () => undefined,
          getModels: () => [
            {
              id: 'glm-5p3-flash',
              reasoning: reasoning !== true,
              maxTokens: 1234,
              thinkingLevelMap: { medium: null },
            },
            { id: 'static-only', reasoning: true },
          ],
        };
      },
      env,
    );
    assert.deepEqual(
      provider.models.map((model) => model.id),
      ['glm-5p3-flash', 'static-only'],
    );
    const model = { ...provider.models[0], provider: provider.id };
    assert.equal(model.maxTokens, 1234, 'unrelated static settings stay intact');
    assert.equal(model.reasoning, reasoning ?? true);
    if (reasoning === true) {
      assert.doesNotThrow(() => assertPiModelThinking(model, 'medium', provider.kind));
      assert.throws(() => assertPiModelThinking(model, 'high', provider.kind), /level unsupported/);
    } else if (reasoning === false) {
      assert.throws(() => assertPiModelThinking(model, 'medium', provider.kind), /reasoning=false/);
    } else {
      assert.equal(
        model.thinkingLevelMap.medium,
        null,
        'static model stays authoritative without a pool declaration',
      );
    }
  });
}
