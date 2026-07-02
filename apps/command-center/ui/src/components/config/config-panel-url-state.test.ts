import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  type ConfigPanelFlowsState,
  formatConfigPanelRoute,
  parseConfigPanelRoute,
} from './config-panel-url-state.js';

const flowsState: ConfigPanelFlowsState = {
  flowType: 'fix-bug',
  mode: 'interactive',
  laneMode: 'phase',
  project: 'mobile',
};

test('parseConfigPanelRoute preserves pool/project/llm and bare pool routes', () => {
  assert.deepEqual(parseConfigPanelRoute('project/mobile'), {
    selection: { kind: 'project', name: 'mobile' },
  });
  assert.deepEqual(parseConfigPanelRoute('pool/runner-a'), {
    selection: { kind: 'pool', machine: 'runner-a' },
  });
  assert.deepEqual(parseConfigPanelRoute('llm'), { selection: { kind: 'llm' } });
  assert.deepEqual(parseConfigPanelRoute('settings'), { selection: { kind: 'settings' } });
  assert.deepEqual(parseConfigPanelRoute('runner-a'), {
    selection: { kind: 'pool', machine: 'runner-a' },
  });
  assert.equal(parseConfigPanelRoute(''), null);
});

test('parseConfigPanelRoute preserves flow route defaults', () => {
  assert.deepEqual(parseConfigPanelRoute('flows'), {
    selection: { kind: 'flows' },
    flowsState: undefined,
  });
  assert.deepEqual(parseConfigPanelRoute('flows/review/visual'), {
    selection: { kind: 'flows' },
    flowsState: {
      flowType: 'review',
      mode: 'visual',
      laneMode: 'phase',
      project: '',
    },
  });
});

test('formatConfigPanelRoute mirrors component hash subpaths', () => {
  assert.equal(
    formatConfigPanelRoute({ kind: 'flows' }, flowsState),
    'flows/fix-bug/interactive/phase/mobile',
  );
  assert.equal(
    formatConfigPanelRoute({ kind: 'flows' }, { ...flowsState, project: '' }),
    'flows/fix-bug/interactive/phase',
  );
  assert.equal(
    formatConfigPanelRoute({ kind: 'pool', machine: 'runner-a' }, flowsState),
    'pool/runner-a',
  );
  assert.equal(
    formatConfigPanelRoute({ kind: 'project', name: 'mobile' }, flowsState),
    'project/mobile',
  );
  assert.equal(formatConfigPanelRoute({ kind: 'llm' }, flowsState), 'llm');
  assert.equal(formatConfigPanelRoute({ kind: 'settings' }, flowsState), 'settings');
});
