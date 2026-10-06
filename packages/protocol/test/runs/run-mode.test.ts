import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkerTemplateOption } from '../../src/contracts/config.js';
import type { ExecutionTemplateDefault } from '../../src/contracts/execution-templates.js';
import {
  catalogDefaultRunMode,
  modeForFlow,
  resolveRunCreateMode,
  selectedTemplateMode,
} from '../../src/runs/run-mode.js';

const devOptions: WorkerTemplateOption[] = [
  { fileName: 'dev.md', label: 'dev (default)', isDefault: true, flowType: 'dev', variant: null },
  {
    fileName: 'dev-interactive.md',
    label: 'dev · interactive',
    isDefault: false,
    flowType: 'dev',
    variant: 'interactive',
  },
];

test('modeForFlow matches dispatch wizard baselines', () => {
  assert.equal(modeForFlow('fix-bug'), 'autonomous');
  assert.equal(modeForFlow('pr-complete'), 'autonomous');
  assert.equal(modeForFlow('dev'), 'interactive');
  assert.equal(modeForFlow('review-pr'), 'interactive');
});

test('selectedTemplateMode treats default dev.md as autonomous when interactive sibling exists', () => {
  assert.equal(selectedTemplateMode('dev', devOptions, 'dev-interactive.md'), 'interactive');
  assert.equal(selectedTemplateMode('dev', devOptions, 'dev.md'), 'autonomous');
});

test('resolveRunCreateMode preserves explicit mode and defaults omitted mode from templates', () => {
  assert.equal(resolveRunCreateMode({ flowType: 'dev', mode: 'interactive' }), 'interactive');
  assert.equal(
    resolveRunCreateMode({
      flowType: 'dev',
      templateOptions: devOptions,
    }),
    'autonomous',
  );
  assert.equal(
    resolveRunCreateMode({
      flowType: 'dev',
      taskTemplateFileName: 'dev-interactive.md',
      templateOptions: devOptions,
    }),
    'interactive',
  );
  assert.equal(resolveRunCreateMode({ flowType: 'fix-bug' }), 'autonomous');
});

test('catalogDefaultRunMode derives the omitted mode from execution-template defaults', () => {
  // The rule shape every MetaMask farm ships: an interactive rule before the general one.
  const defaults: ExecutionTemplateDefault[] = [
    { when: { flow: 'dev', runMode: 'interactive' }, templateId: 'dev/interactive' },
    {
      when: { flow: 'pr-complete', runMode: 'interactive' },
      templateId: 'pr-complete/interactive',
    },
    { when: { flow: 'fix-bug', runMode: 'interactive' }, templateId: 'fix-bug/default' },
    { when: { flow: 'fix-bug', runMode: 'validation' }, templateId: 'fix-bug/default' },
    { when: { flow: 'dev' }, templateId: 'dev/mobile' },
    { when: { flow: 'fix-bug' }, templateId: 'fix-bug/mobile' },
    { when: { flow: 'pr-complete' }, templateId: 'pr-complete/default' },
    { when: { flow: 'review-pr' }, templateId: 'review-pr/default' },
  ];
  // Same answers the template folder gave: dev.md + dev-interactive.md => autonomous.
  assert.equal(catalogDefaultRunMode('dev', defaults), 'autonomous');
  assert.equal(catalogDefaultRunMode('pr-complete', defaults), 'autonomous');
  assert.equal(catalogDefaultRunMode('fix-bug', defaults), 'autonomous');
  assert.equal(catalogDefaultRunMode('review-pr', defaults), 'interactive');
  // A flow the catalog does not cover falls back to the template folder.
  assert.equal(catalogDefaultRunMode('update-branch', defaults), null);
  // Without an interactive rule, the flow baseline applies.
  assert.equal(
    catalogDefaultRunMode('dev', [{ when: { flow: 'dev' }, templateId: 'dev/core' }]),
    'interactive',
  );
  // Only interactive rules: nothing general to run autonomously.
  assert.equal(
    catalogDefaultRunMode('dev', [
      { when: { flow: 'dev', runMode: 'interactive' }, templateId: 'dev/interactive' },
    ]),
    'interactive',
  );
});
