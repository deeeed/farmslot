import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRunner } from '@farmslot/protocol';

import {
  ModelCatalogFormatError,
  NodeModelCatalogs,
  parseAntigravityModelCatalog,
} from './model-catalog.js';
import {
  assertRunnerTransport,
  getRunnerDefinition,
  isKnownRunner,
  runnerSupportsEffort,
  runnerSupportsNativeTaskReuse,
} from './registry.js';

test('antigravity registers as a native-only ACP runner with agy alias and node model catalog', () => {
  assert.equal(normalizeRunner('agy'), 'antigravity');
  assert.equal(isKnownRunner('antigravity'), true);
  assert.equal(isKnownRunner('agy'), true);
  const definition = getRunnerDefinition('antigravity');
  assert.equal(definition.id, 'antigravity');
  assert.equal(definition.nativeTransport, 'acp');
  assert.equal(definition.nativeOnly, true);
  assert.equal(definition.sessionContinuation.native, true);
  assert.equal(definition.sessionContinuation.terminal, null);
  assert.equal(definition.observabilityScope, 'none');
  assert.deepEqual(definition.nativeChoices?.modes, ['default', 'plan']);
  assert.equal(definition.nativeChoices?.efforts, undefined);
  assert.equal(runnerSupportsEffort('antigravity', 'gemini-3.8-flash-low', 'high'), false);
  assert.equal(runnerSupportsNativeTaskReuse('antigravity'), true);
  assert.ok(definition.modelCatalog && 'nodeCommand' in definition.modelCatalog);
  assert.equal(definition.modelCatalog.nodeCommand, 'agy');
  assert.equal(definition.modelCatalog.slotPathKey, 'antigravityPath');
  assert.equal(definition.modelCatalog.flatCatalog, true);
  assert.equal(definition.modelCatalog.strictAccountCatalog, true);
  assert.doesNotThrow(() => assertRunnerTransport('antigravity', 'native'));
  assert.throws(() => assertRunnerTransport('antigravity', 'tmux'), /requires native transport/);
});

test('parseAntigravityModelCatalog preserves stable IDs and display names and rejects empty output', () => {
  const sample = [
    '\r\u001b[32m⠋ Fetching available models...\u001b[0m\rgemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'claude-opus-5-5-high   Claude Opus 5.5 (High)',
    'gemini-3.8-flash-low\tDuplicate Ignored',
  ].join('\n');

  const listing = parseAntigravityModelCatalog(sample);
  assert.deepEqual(listing.ids, [
    'gemini-4-neon-high',
    'gemini-3.8-flash-low',
    'claude-opus-5-5-high',
  ]);
  assert.deepEqual(listing.nativeIds, listing.ids);
  assert.deepEqual(listing.labels, {
    'gemini-4-neon-high': 'Gemini 4 Neon (High)',
    'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
    'claude-opus-5-5-high': 'Claude Opus 5.5 (High)',
  });
  assert.equal(listing.flatCatalog, true);
  assert.equal(listing.strictAccountCatalog, true);

  assert.throws(
    () => parseAntigravityModelCatalog('Fetching available models...\n'),
    ModelCatalogFormatError,
  );
});

test('NodeModelCatalogs preserves Antigravity display names and blocks unavailable account models', () => {
  const store = new NodeModelCatalogs();
  const listing = parseAntigravityModelCatalog(
    'gemini-4-neon-high\tGemini 4 Neon (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n',
  );
  assert.equal(store.accept('antigravity', 'macwork', listing), true);

  const result = store.result('antigravity');
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.models, [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', reasoningModes: [], listed: true },
    {
      id: 'gemini-3.8-flash-low',
      label: 'Gemini 3.8 Flash (Low)',
      reasoningModes: [],
      listed: true,
    },
  ]);
  assert.deepEqual(store.labels('antigravity'), {
    'gemini-4-neon-high': 'Gemini 4 Neon (High)',
    'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
  });

  // Available model passes
  assert.equal(store.blocker('antigravity', 'gemini-3.8-flash-low', 'macwork', 'native'), null);
  // Unavailable model on a strict account catalog is blocked even on a single-node fleet
  assert.match(
    store.blocker('antigravity', 'gemini-unavailable-99', 'macwork', 'native') ?? '',
    /not available for the macwork account/,
  );
});
