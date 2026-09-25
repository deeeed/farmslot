import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  runnerModelCatalog,
  runnerVisibleModelsGet,
  runnerVisibleModelsSet,
} from '../methods/runner-models.js';
import {
  parseCodexModelCatalog,
  parseGrokModelCatalog,
  parsePiModelCatalog,
  readRunnerModelCatalog,
} from './model-catalog.js';
import { getRunnerDefinition } from './registry.js';

test('codex, grok, and pi parse structured catalogs and keep reasoning modes', () => {
  assert.deepEqual(
    parseCodexModelCatalog({
      models: [
        {
          slug: 'gpt-6-astra',
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'high' }, { effort: 'ultra' }],
        },
        { slug: 'hidden-old', visibility: 'hide', supported_reasoning_levels: [] },
      ],
    }),
    [
      { id: 'gpt-6-astra', reasoningModes: ['high', 'ultra'], listed: true },
      { id: 'hidden-old', reasoningModes: [], listed: false },
    ],
  );
  assert.deepEqual(
    parseGrokModelCatalog({
      models: {
        'grok-4.7': {
          info: { hidden: false, reasoning_efforts: [{ id: 'high' }, { id: 'xhigh' }] },
        },
        secret: { info: { hidden: true, reasoning_efforts: [] } },
      },
    }),
    [
      { id: 'grok-4.7', reasoningModes: ['high', 'xhigh'], listed: true },
      { id: 'secret', reasoningModes: [], listed: false },
    ],
  );
  assert.deepEqual(
    parsePiModelCatalog({
      anthropic: {
        models: [{ id: 'claude-fable-5', thinkingLevelMap: { off: null, high: { id: 'high' } } }],
      },
    }),
    [{ id: 'anthropic/claude-fable-5', reasoningModes: ['off', 'high'], listed: true }],
  );
});

test('a missing or unreadable structured catalog is unavailable and a runner without one is unsupported', () => {
  const home = mkdtempSync(join(tmpdir(), 'runner-catalog-'));
  const missing = readRunnerModelCatalog('pi', getRunnerDefinition('pi').modelCatalog, home);
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.source, 'structured-file');
  assert.deepEqual(missing.models, []);

  const fileHome = mkdtempSync(join(tmpdir(), 'runner-catalog-bad-'));
  mkdirSync(join(fileHome, '.codex'));
  writeFileSync(join(fileHome, '.codex', 'models_cache.json'), '{');
  const invalid = readRunnerModelCatalog(
    'codex',
    getRunnerDefinition('codex').modelCatalog,
    fileHome,
  );
  assert.equal(invalid.status, 'unavailable');
  assert.equal(invalid.models.length, 0);

  const claude = runnerModelCatalog({ runner: 'claude' });
  assert.equal(claude.status, 'unsupported');
  assert.equal(claude.source, 'unsupported');
  assert.match(claude.detail ?? '', /does not report a model catalog/);
  assert.equal(getRunnerDefinition('cursor').modelCatalog, undefined);
});

test('saved visible models keep an explicit selection and do not invent catalog entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'runner-visible-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  try {
    const saved = runnerVisibleModelsSet({ runner: 'codex', models: ['gpt-5.4', 'gpt-5.4'] });
    assert.equal(saved.ok, true);
    assert.equal(saved.runner.configured, true);
    assert.deepEqual(saved.runner.models, ['gpt-5.4']);
    const read = runnerVisibleModelsGet({ runner: 'codex', selectedModel: 'gpt-6-astra' });
    assert.equal(read.runners[0]?.retainedModel, 'gpt-6-astra');
    assert.deepEqual(read.runners[0]?.pickerModels, ['gpt-5.4', 'gpt-6-astra']);
    const seed = runnerVisibleModelsGet({ runner: 'claude' });
    assert.equal(seed.runners[0]?.configured, false);
    assert.ok(seed.runners[0]?.models.includes('opus'));
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
  }
});
