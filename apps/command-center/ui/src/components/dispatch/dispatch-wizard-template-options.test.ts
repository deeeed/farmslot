import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkerTemplateOption } from '@farmslot/protocol';

import {
  clearTemplateOptionsState,
  deriveTemplateOptionsState,
  templateOptionsRequestKey,
} from './dispatch-wizard-template-options.js';

const options: WorkerTemplateOption[] = [
  { fileName: 'default.md', label: 'Default', isDefault: true, flowType: 'dev' },
  { fileName: 'custom.md', label: 'Custom', isDefault: false, flowType: 'dev' },
];

test('template options helpers preserve valid selection and derive stable request key', () => {
  assert.equal(templateOptionsRequestKey('mobile', 'dev'), 'mobile:dev');
  assert.deepEqual(deriveTemplateOptionsState(options, 'custom.md'), {
    options,
    error: '',
    selectedFileName: 'custom.md',
  });
});

test('template options helpers clear invalid or empty selections', () => {
  assert.deepEqual(clearTemplateOptionsState(), {
    options: [],
    error: '',
    selectedFileName: '',
  });
  assert.equal(deriveTemplateOptionsState(options, 'missing.md').selectedFileName, 'default.md');
  assert.equal(deriveTemplateOptionsState([], 'missing.md').selectedFileName, '');
});
