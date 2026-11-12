import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { shellQuote } from '../core/tmux.js';

import { buildLaunchCommand, wrapWorkerShellCommand } from './launch-command.js';
import { makeVars } from './test-fixtures.js';

const limitsName = 'FARMSLOT_PI_LITELLM_MODEL_LIMITS';
const limits = JSON.stringify({ 'glm-5p3-flash': { reasoning: true } });
const support = fileURLToPath(new URL('../../../../', import.meta.url));

for (const scenario of ['pool-only', 'missing-pool', 'static-collision'] as const) {
  test(`pi worker launch carries pool reasoning support: ${scenario}`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'worker-pool-env-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "worker's repo");
    const agentDir = path.join(root, 'pi-agent');
    mkdirSync(repo);
    mkdirSync(agentDir);
    // Only synthetic Pi state is ever read, even on a developer machine.
    if (scenario === 'static-collision') writeFileSync(path.join(agentDir, 'models.json'), '{}');
    const binary = path.join(root, 'pi-fixture.mjs');
    writeFileSync(
      binary,
      `
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const extension = process.argv[process.argv.indexOf('-e') + 1];
      const { resolvePiProviderCatalog, preservePiStaticModels, assertPiModelThinking } =
        await import(pathToFileURL(path.join(path.dirname(extension), 'pi-farmslot-providers.mjs')));
      const catalog = await resolvePiProviderCatalog(process.env, {
        fetchImpl: async (url) => Response.json({ data: url.endsWith('/model/info')
          ? [{ model_name: 'glm-5p3-flash', model_info: { supports_reasoning: null } }]
          : [{ id: 'glm-5p3-flash' }] }),
      });
      const [source] = await preservePiStaticModels(catalog, async () => ({
        getError: () => undefined,
        getModels: () => [{ ...catalog[0].models[0], reasoning: false }],
      }));
      const model = { ...source.models[0], provider: source.id };
      console.log(JSON.stringify({
        envNames: Object.keys(process.env).filter(name => name === '${limitsName}'),
        reasoning: model.reasoning,
      }));
      try { assertPiModelThinking(model, process.env.FARMSLOT_THINKING, source.kind); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `,
    );
    const vars = makeVars({
      remoteRepo: repo,
      piPath: `${shellQuote(process.execPath)} ${shellQuote(binary)}`,
      machineEnv: {
        FARMSLOT_PI_OLLAMA: '0',
        LITELLM_URL: 'http://litellm.invalid/v1',
        PI_CODING_AGENT_DIR: agentDir,
        ...(scenario === 'missing-pool' ? {} : { [limitsName]: limits }),
      },
    });
    const command = wrapWorkerShellCommand(
      buildLaunchCommand(vars, 'pi', 'litellm/glm-5p3-flash', 'Synthetic task', {
        effort: 'medium',
        supportDir: support,
        taskDir: path.join(repo, 'task'),
      }),
      {
        vars,
        projectJson: {
          command_env:
            scenario === 'missing-pool' ? {} : { unset: [limitsName], set: { [limitsName]: '{}' } },
        },
      },
    );
    const result = spawnSync('/bin/bash', ['-c', command], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: root },
      timeout: 4000,
    });
    assert.equal(result.error, undefined);
    const lastLine = result.stdout.trim().split('\n').at(-1);
    assert.ok(lastLine);
    const observed = JSON.parse(lastLine);
    assert.deepEqual(observed.envNames, scenario === 'missing-pool' ? [] : [limitsName]);
    if (scenario === 'missing-pool') {
      assert.equal(result.status, 1);
      assert.equal(observed.reasoning, false);
      assert.match(result.stderr, /PI_REASONING_EFFORT_MISMATCH/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(observed.reasoning, true);
    }
  });
}
