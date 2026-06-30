import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkerTemplateOption } from '../contracts/config.js';

import {
  modeForFlow,
  resolveRunCreateMode,
  selectedTemplateMode,
} from './run-mode.js';

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
