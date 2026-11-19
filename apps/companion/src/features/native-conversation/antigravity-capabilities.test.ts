import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeSessionCatalogResult, NativeSessionInfo } from '@farmslot/protocol';
import {
  catalogForNativeRunners,
  nativeLaunchModel,
  nativeLaunchModelSelection,
  ReviewDispatchViewModel,
} from '@farmslot/review-dispatch';

test('Companion Copilot flow consumes server-declared Antigravity catalog, display names, and capabilities', () => {
  const catalog: NativeSessionCatalogResult = {
    runners: [
      {
        runner: 'antigravity',
        nativeOnly: true,
        models: [],
        nodeModels: {
          local: ['gemini-4-neon-high', 'gemini-3.8-flash-low'],
        },
        modelLabels: {
          'gemini-4-neon-high': 'Gemini 4 Neon (High)',
          'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
        },
        defaultModel: '',
        modes: ['default', 'plan'],
        supportsWorkers: true,
        supportsQueuedWorkers: true,
      },
    ],
    contexts: [
      {
        cwd: '/Users/operator/workspace',
        label: 'Workspace',
        executionNodeId: 'local',
        supportsProfiles: true,
      },
    ],
  };

  const runnerCatalog = catalogForNativeRunners(catalog.runners, undefined, 'local');
  const agy = runnerCatalog.runners.find((entry) => entry.id === 'antigravity');
  assert.ok(agy);
  assert.deepEqual(agy.models, [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  ]);
  // Effort is unsupported as a separate control because Antigravity encodes thinking level in model IDs
  assert.deepEqual(agy.efforts, []);
  assert.equal(nativeLaunchModelSelection(agy, 'gemini-3.8-flash-low'), 'gemini-3.8-flash-low');
  assert.equal(nativeLaunchModel(agy, 'gemini-3.8-flash-low'), 'gemini-3.8-flash-low');

  const picker = new ReviewDispatchViewModel({
    context: { allowedActions: ['chat'] },
    catalog: runnerCatalog,
    sequence: [
      { runner: 'antigravity', model: 'gemini-3.8-flash-low', effort: null, mode: 'cold' },
    ],
  });
  assert.equal(picker.selection?.runner, 'antigravity');
  assert.equal(picker.selection?.model, 'gemini-3.8-flash-low');
  assert.deepEqual(picker.effortChoices(picker.rows[0].id), [
    { value: null, label: 'Supported default' },
  ]);

  // Server-declared capabilities drive Companion screen controls (NativeConversationScreen)
  const session: Pick<
    NativeSessionInfo,
    'runner' | 'model' | 'mode' | 'approvalMode' | 'capabilities'
  > = {
    runner: 'antigravity',
    model: 'gemini-3.8-flash-low',
    mode: 'default',
    approvalMode: 'ask',
    capabilities: {
      modes: ['default', 'plan'],
      approvalModes: ['ask', 'bypass'],
      streaming: true,
      tools: true,
      approvals: true,
      questions: false,
      interrupt: true,
      resume: true,
      contextCompaction: false,
    },
  };
  // Supported controls active:
  assert.equal(session.capabilities.approvals, true);
  assert.deepEqual(session.capabilities.approvalModes, ['ask', 'bypass']);
  assert.equal(session.capabilities.interrupt, true);
  assert.equal(session.capabilities.resume, true);
  // Unsupported controls explicitly disabled/absent:
  assert.equal(session.capabilities.questions, false);
  assert.equal(session.capabilities.steer ?? false, false);
  assert.equal(session.capabilities.contextCompaction, false);
});
