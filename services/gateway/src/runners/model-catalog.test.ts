import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { type Principal, RUNNER_PICKER_MODELS } from '@farmslot/protocol';

import {
  runnerModelCatalog,
  runnerVisibleModelsGet,
  runnerVisibleModelsSet,
} from '../methods/runner-models.js';
import { runWithSessionOriginator } from '../security/work-originator.js';

import {
  ModelCatalogFormatError,
  parseCodexModelCatalog,
  parseCursorModelCatalog,
  parseGrokModelCatalog,
  parsePiModelCatalog,
  queryRunnerModelCatalog,
} from './model-catalog.js';
import { getRunnerDefinition } from './registry.js';
import { visibleModelsHome } from './visible-models.js';

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

test('a missing or unreadable structured catalog is unavailable and a runner without one is unsupported', async () => {
  const home = mkdtempSync(join(tmpdir(), 'runner-catalog-'));
  const missing = await queryRunnerModelCatalog('pi', getRunnerDefinition('pi').modelCatalog, home);
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.source, 'structured-file');
  assert.deepEqual(missing.models, []);

  const fileHome = mkdtempSync(join(tmpdir(), 'runner-catalog-bad-'));
  mkdirSync(join(fileHome, '.codex'));
  writeFileSync(join(fileHome, '.codex', 'models_cache.json'), '{');
  const invalid = await queryRunnerModelCatalog(
    'codex',
    getRunnerDefinition('codex').modelCatalog,
    fileHome,
  );
  assert.equal(invalid.status, 'unavailable');
  assert.equal(invalid.models.length, 0);

  const claude = await runnerModelCatalog({ runner: 'claude' });
  assert.equal(claude.status, 'unsupported');
  assert.equal(claude.source, 'unsupported');
  assert.match(claude.detail ?? '', /does not report a model catalog/);
  assert.ok(getRunnerDefinition('cursor').modelCatalog);
});

test('Cursor catalog parsing retains native ids, labels and effort variants', () => {
  const models = parseCursorModelCatalog(
    '\u001b[1mAvailable models\u001b[0m\n\nauto - Auto (default)\r\nclaude-opus-5-5-medium - Claude Opus 5.5 1M\nclaude-opus-5-5-high - Claude Opus 5.5 1M High\n\nTip: use --model\n',
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ['auto', 'claude-opus-5-5-medium', 'claude-opus-5-5-high'],
  );
  assert.equal(models[1].label, 'Claude Opus 5.5 1M');
  assert.deepEqual(models[2].reasoningModes, []);
  assert.throws(() => parseCursorModelCatalog('Please log in'), /header/);
  assert.throws(() => parseCursorModelCatalog('Available models\n'), /no models/);
});

test('catalog command execution uses the capability and fails closed when unavailable', async () => {
  const ready = await queryRunnerModelCatalog('example', {
    command: process.execPath,
    args: ['-e', 'process.stdout.write("Available models\\nmodel-one - Model One\\n")'],
    parse: parseCursorModelCatalog,
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.source, 'catalog-command');
  assert.equal(ready.models[0].id, 'model-one');
  const missing = await queryRunnerModelCatalog('example', {
    command: '/nonexistent/farmslot-catalog-runner',
    args: [],
    parse: parseCursorModelCatalog,
  });
  assert.equal(missing.status, 'unavailable');
  assert.match(missing.detail ?? '', /ENOENT/);
  assert.deepEqual(missing.models, []);
});

test('catalog failures expose exit status and parser errors without swallowing programming errors', async () => {
  const signalled = await queryRunnerModelCatalog('example', {
    command: process.execPath,
    args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
    parse: parseCursorModelCatalog,
  });
  assert.equal(signalled.status, 'unavailable');
  assert.match(signalled.detail ?? '', /signal: SIGTERM/);
  assert.match(signalled.detail ?? '', /killed: false/);
  assert.doesNotMatch(signalled.detail ?? '', /timeout:/);
  const exited = await queryRunnerModelCatalog('example', {
    command: process.execPath,
    args: ['-e', 'process.exit(7)'],
    parse: parseCursorModelCatalog,
  });
  assert.equal(exited.status, 'unavailable');
  assert.match(exited.detail ?? '', /code: 7/);
  const malformed = await queryRunnerModelCatalog('example', {
    command: process.execPath,
    args: ['-e', 'process.stdout.write("bad catalog")'],
    parse: parseCursorModelCatalog,
  });
  assert.equal(malformed.status, 'unavailable');
  assert.match(malformed.detail ?? '', /header/);
  await assert.rejects(
    queryRunnerModelCatalog('example', {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("output")'],
      parse: () => {
        throw new TypeError('unexpected parser bug');
      },
    }),
    /unexpected parser bug/,
  );
  assert.ok(new ModelCatalogFormatError('invalid') instanceof Error);
});

test('concurrent catalog requests share one command without caching later requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-catalog-concurrent-'));
  const marker = join(directory, 'calls');
  const source = {
    command: process.execPath,
    args: [
      '-e',
      "require('node:fs').appendFileSync(process.argv[1], 'called\\n'); setTimeout(() => process.stdout.write('Available models\\nexample - Example\\n'), 50)",
      marker,
    ],
    parse: parseCursorModelCatalog,
  };
  try {
    const [first, second] = await Promise.all([
      queryRunnerModelCatalog('concurrent', source),
      queryRunnerModelCatalog('concurrent', source),
    ]);
    assert.equal(first.status, 'ready');
    assert.deepEqual(first, second);
    assert.equal(readFileSync(marker, 'utf8'), 'called\n');
    await queryRunnerModelCatalog('concurrent', source);
    assert.equal(readFileSync(marker, 'utf8'), 'called\ncalled\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('visible preference GET normalizes aliases like SET and rejects invalid runner types', () => {
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = mkdtempSync(join(tmpdir(), 'runner-alias-'));
  try {
    runnerVisibleModelsSet({ runner: 'claude-code', models: ['haiku'], defaultModel: 'haiku' });
    const read = runnerVisibleModelsGet({ runner: 'claude-code' }).runners[0];
    assert.equal(read.runner, 'claude');
    assert.equal(read.defaultModel, 'haiku');
    assert.deepEqual(read.models, ['haiku']);
    assert.throws(() => runnerVisibleModelsGet({ runner: 4 }));
    assert.throws(() => runnerVisibleModelsGet({ runner: '' }));
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
  }
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
    assert.deepEqual(read.runners[0]?.pickerModels, ['gpt-5.4', 'gpt-6.1-sol', 'gpt-6-astra']);
    const seed = runnerVisibleModelsGet({ runner: 'claude' });
    assert.equal(seed.runners[0]?.configured, false);
    assert.ok(seed.runners[0]?.models.includes('opus'));
    // Until a set is saved, every runner reports the same picker defaults clients show.
    for (const runner of ['claude', 'cursor', 'grok', 'pi']) {
      const state = runnerVisibleModelsGet({ runner }).runners[0];
      assert.equal(state?.configured, false);
      assert.deepEqual(state?.models, [...(RUNNER_PICKER_MODELS[runner] ?? [])]);
    }
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
  }
});

test('visible preferences are isolated by authenticated principal', () => {
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = mkdtempSync(join(tmpdir(), 'runner-owner-'));
  const first = { id: 'first' } as Principal;
  const second = { id: 'second' } as Principal;
  try {
    runWithSessionOriginator(first, () =>
      runnerVisibleModelsSet({ runner: 'cursor', models: ['auto'], defaultModel: 'auto' }),
    );
    const own = runWithSessionOriginator(first, () => runnerVisibleModelsGet({ runner: 'cursor' }));
    const other = runWithSessionOriginator(second, () =>
      runnerVisibleModelsGet({ runner: 'cursor' }),
    );
    assert.deepEqual(own.runners[0].models, ['auto']);
    assert.equal(other.runners[0].configured, false);
    assert.equal(own.runners[0].defaultModel, 'auto');
    assert.equal(other.runners[0].defaultModel, 'claude-opus-5-5-high');
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
  }
});

test('default model can be saved and reset independently of visibility', () => {
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = mkdtempSync(join(tmpdir(), 'runner-default-'));
  try {
    runnerVisibleModelsSet({ runner: 'cursor', models: ['composer-2.5'] });
    const saved = runnerVisibleModelsSet({
      runner: 'cursor',
      defaultModel: 'claude-opus-5-5-medium',
    });
    assert.equal(saved.runner.defaultModel, 'claude-opus-5-5-medium');
    assert.equal(saved.runner.defaultConfigured, true);
    assert.deepEqual(saved.runner.models, ['composer-2.5']);
    assert.ok(saved.runner.pickerModels.includes('claude-opus-5-5-medium'));
    runnerVisibleModelsSet({ runner: 'cursor', models: [] });
    assert.equal(
      runnerVisibleModelsGet({ runner: 'cursor' }).runners[0].defaultModel,
      'claude-opus-5-5-medium',
    );
    const reset = runnerVisibleModelsSet({ runner: 'cursor', defaultModel: null });
    assert.equal(reset.runner.defaultModel, 'claude-opus-5-5-high');
    assert.equal(reset.runner.defaultConfigured, false);
    assert.deepEqual(reset.runner.models, []);
    assert.throws(() => runnerVisibleModelsSet({ runner: 'cursor', defaultModel: '--unsafe' }));
    assert.throws(() => runnerVisibleModelsSet({ runner: 'cursor', defaultModel: '' }));
    assert.throws(() => runnerVisibleModelsSet({ runner: 'cursor' }));
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
  }
});

test('visible preferences expand the configured home directory', () => {
  const previous = process.env.FARMSLOT_HOME;
  try {
    process.env.FARMSLOT_HOME = '~/.farmslot-dev';
    assert.equal(visibleModelsHome(), join(homedir(), '.farmslot-dev'));
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
  }
});
