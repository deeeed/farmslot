import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { DispatchCandidate, DispatchCandidatesResult } from '@farmslot/protocol';

import type { DispatchProjectMatchResult } from './dispatch-wizard-loaders.js';

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
let candidateRequest: typeof loaders.requestDispatchWizardCandidates;
let matchRequest: typeof loaders.requestDispatchProjectMatch;
mock.module('./dispatch-wizard-loaders.js', {
  namedExports: {
    ...loaders,
    requestDispatchWizardCandidates: (...args: Parameters<typeof candidateRequest>) =>
      candidateRequest(...args),
    requestDispatchProjectMatch: (...args: Parameters<typeof matchRequest>) =>
      matchRequest(...args),
  },
});
const { DispatchWizard } = await import('./dispatch-wizard.js');

interface WizardView {
  _allCandidates: DispatchCandidate[];
  _candidates: DispatchCandidate[];
  _slotOverride: string;
  _slotOverrideExplicit: boolean;
  _candidateRefreshFailed: boolean;
  _ticketId: string;
  _matchingProject: boolean;
  _fetchCandidates(options?: { silent?: boolean; force?: boolean }): Promise<void>;
  _applyCandidateResult(result: DispatchCandidatesResult, previous: string): void;
  _refreshDispatchSnapshot(): void;
  _doMatchProject(ticket: string, generation: number): Promise<void>;
}
const row = (slotId: string): DispatchCandidate => ({
  slotId,
  project: 'farmslot',
  score: 0,
  cdpLive: false,
  branch: 'main',
  lifecycle: 'ready',
  onMain: true,
  free: true,
});
function wizard(rows: DispatchCandidate[]): WizardView {
  candidateRequest = async () => {
    throw new Error('Gateway read failed');
  };
  const view = Object.create(DispatchWizard.prototype) as WizardView;
  Object.assign(view, {
    requestUpdate: () => undefined,
    mockMode: true,
    _allCandidates: rows,
    _candidates: rows,
    _slotOverride: rows[0]?.slotId ?? '',
    _slotOverrideExplicit: false,
    _templateOptionsCache: new Map(),
    _fetchGen: 0,
    _flowType: 'dev',
    _prepareProfile: '',
    _skipPrepare: false,
    _ticketId: '',
    _normalizedTicket: '',
    _nudgeIntents: new Map(),
    _comparisonLane: false,
    _comparisonFamilyId: '',
    _matchGeneration: 1,
    _fetchTemplateOptions: async () => undefined,
    _resolveTargetBranch: () => undefined,
    _nodeCatalogModelKey: () => '',
    _resetPressureOverrideDraft: () => undefined,
    _applyVisibleCatalog: () => undefined,
    _checkActiveRunConflict: () => undefined,
    _applyVisibleCandidates(this: WizardView, previous?: string) {
      this._applyCandidateResult(
        { candidates: this._allCandidates },
        previous ?? this._slotOverride,
      );
    },
  });
  Object.defineProperties(view, {
    _runner: { value: 'claude' },
    _model: { value: '' },
    _transport: { value: 'tmux' },
  });
  return view;
}

test('Refresh keeps displayed candidates and the selection when its first forced read fails', async () => {
  const rows = [row('mini-slot')];
  const view = wizard(rows);
  view._slotOverrideExplicit = true;
  const fetch = view._fetchCandidates.bind(view);
  let pending: Promise<void> | undefined;
  view._fetchCandidates = (options) => {
    pending = fetch(options);
    return pending;
  };
  view._refreshDispatchSnapshot();
  assert.deepEqual(view._allCandidates, rows);
  assert.ok(pending);
  await pending;
  assert.deepEqual(view._allCandidates, rows);
  assert.deepEqual(view._candidates, rows);
  assert.equal(view._slotOverride, 'mini-slot');
  assert.equal(view._candidateRefreshFailed, true);
});

for (const explicit of [false, true]) {
  test(`live ranking ${explicit ? 'keeps an operator pick' : 'replaces a pick from cached paint'}`, async () => {
    const a = row('slot-a'),
      b = row('slot-b');
    const view = wizard([]);
    candidateRequest = async (_input, onCached) => {
      onCached?.({ candidates: [a, b] });
      assert.equal(view._slotOverride, a.slotId);
      if (explicit) view._slotOverrideExplicit = true;
      return { candidates: [b, a] };
    };
    await view._fetchCandidates();
    assert.equal(view._slotOverride, explicit ? a.slotId : b.slotId);
  });
}

test('clearing a ticket during its lookup clears the matching flag when that lookup settles', async () => {
  const view = wizard([]);
  view._ticketId = 'TAT-4355';
  view._matchingProject = true;
  let resolve!: (value: DispatchProjectMatchResult) => void;
  const reply = new Promise<DispatchProjectMatchResult>((done) => {
    resolve = done;
  });
  matchRequest = () => reply;
  const pending = view._doMatchProject('TAT-4355', 1);
  view._ticketId = '';
  resolve({ project: 'metamask-mobile-farm', repo: 'MetaMask/metamask-mobile' });
  await pending;
  assert.equal(view._matchingProject, false);
  assert.equal(view._ticketId, '');
});
