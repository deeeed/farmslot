import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { DispatchCandidate } from '@farmslot/protocol';

Object.assign(globalThis, { location: new URL('http://localhost/') });
mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });
mock.module('../shared/source-status-panel.js', { namedExports: {} });
mock.module('./execution-template-preview-modal.js', { namedExports: {} });
mock.module('./dispatch-native-profiles.js', { namedExports: {} });
mock.module('./recipe-compatibility-panel.js', { namedExports: {} });
mock.module('./dispatch-wizard-view-renderer.js', {
  namedExports: { renderDispatchWizardView: () => undefined },
});
const loaders = await import('./dispatch-wizard-loaders.js');
mock.module('./dispatch-wizard-loaders.js', {
  namedExports: {
    ...loaders,
    requestDispatchWizardCandidates: async () => {
      throw new Error('Gateway read failed');
    },
  },
});
const { DispatchWizard } = await import('./dispatch-wizard.js');

interface RefreshView {
  _allCandidates: DispatchCandidate[];
  _candidates: DispatchCandidate[];
  _slotOverride: string;
  _candidateRefreshFailed: boolean;
  _fetchCandidates(options?: { silent?: boolean; force?: boolean }): Promise<void>;
  _refreshDispatchSnapshot(): void;
}

test('Refresh keeps displayed candidates and the selection when its first forced read fails', async () => {
  const rows: DispatchCandidate[] = [
    {
      slotId: 'mini-slot',
      project: 'farmslot',
      score: 0,
      cdpLive: false,
      branch: 'main',
      lifecycle: 'ready',
      onMain: true,
      free: true,
    },
  ];
  const view = Object.create(DispatchWizard.prototype) as RefreshView;
  Object.assign(view, {
    requestUpdate: () => undefined,
    mockMode: true,
    _allCandidates: rows,
    _candidates: rows,
    _slotOverride: 'mini-slot',
    _slotOverrideExplicit: true,
    _templateOptionsCache: new Map(),
    _fetchGen: 0,
    _flowType: 'dev',
    _prepareProfile: '',
    _skipPrepare: false,
    _ticketId: '',
    _fetchTemplateOptions: async () => undefined,
    _resolveTargetBranch: () => undefined,
    _nodeCatalogModelKey: () => '',
  });
  Object.defineProperties(view, { _runner: { value: 'claude' }, _model: { value: '' } });
  const fetch = view._fetchCandidates.bind(view);
  let pending: Promise<void> | undefined;
  view._fetchCandidates = (options) => {
    pending = fetch(options);
    return pending;
  };
  view._refreshDispatchSnapshot();
  assert.deepEqual(view._allCandidates, rows, 'the refresh must leave the held list visible');
  assert.ok(pending);
  await pending;
  assert.deepEqual(view._allCandidates, rows);
  assert.deepEqual(view._candidates, rows);
  assert.equal(view._slotOverride, 'mini-slot');
  assert.equal(view._candidateRefreshFailed, true);
});
