import assert from 'node:assert/strict';
import test from 'node:test';

import { litBindings, litText } from '../../testing/lit-text.js';
import { renderFleetSkeleton } from '../fleet-map/fleet-skeleton.js';
import { renderPrBoardSkeleton } from '../pr-dashboard/pr-board-skeleton.js';
import { renderRunListSkeleton } from '../runs/run-list-skeleton.js';
import { renderPublicationGatePanel } from '../workspace/publication-gate-panel.js';

test('gate loading, loaded and failed states preserve the registered AC count and approval guard', () => {
  const input: Parameters<typeof renderPublicationGatePanel>[0] = {
    claims: Array.from({ length: 4 }, (_, index) => ({
      id: `AC-${index + 1}`,
      text: 'Registered criterion',
      status: null,
    })),
    actions: [],
    busy: false,
    pendingConfirm: null,
    reviewDisabled: false,
    changeReason: () => undefined,
    chooseAttestation: () => undefined,
    invoke: () => undefined,
    requestReview: () => undefined,
  };
  const loadedView = renderPublicationGatePanel(input);
  const loading = litText(renderPublicationGatePanel({ ...input, loading: true }));
  const failed = litText(
    renderPublicationGatePanel({ ...input, loadError: 'Read failed', retry: () => undefined }),
  );
  const loaded = litText(loadedView);
  for (const text of [loading, loaded, failed]) assert.match(text, /--gate-row-count:4/);
  assert.match(loading, /aria-busy=true/);
  assert.match(failed, /Evidence unavailable/);
  assert.match(failed, /Retry/);
  assert.equal(litBindings(loadedView, '?disabled=')[0], true);
  assert.doesNotMatch(loading, /Loading…|spinner/);
});

test('panel-specific skeletons retain their shapes on error and wire the supplied retry', () => {
  for (const render of [
    renderRunListSkeleton,
    renderFleetSkeleton,
    (error = '', retry?: () => void) => renderPrBoardSkeleton(false, error, retry),
  ]) {
    let calls = 0;
    const retry = () => {
      calls++;
    };
    const loading = render();
    const failed = render('Read failed', retry);
    assert.equal(
      (litText(loading).match(/farm-skeleton/g) ?? []).length,
      (litText(failed).match(/farm-skeleton/g) ?? []).length,
    );
    const handler = litBindings(failed, '@retry=')[0];
    assert.equal(handler, retry);
    if (typeof handler === 'function') handler();
    assert.equal(calls, 1);
  }
});

test('pausing a cached gate disables actions without claiming a submission', () => {
  const result = renderPublicationGatePanel({
    actions: [{ id: 'approve-publish', label: 'Approve publish', style: 'primary' }],
    pausedReason: 'Run unavailable; actions paused',
    busy: false,
    pendingConfirm: null,
    reviewDisabled: false,
    changeReason: () => undefined,
    chooseAttestation: () => undefined,
    invoke: () => undefined,
    requestReview: () => undefined,
  });
  assert.match(litText(result), /Run unavailable; actions paused/);
  assert.doesNotMatch(litText(result), /Submitting|Evidence unavailable/);
  assert.equal(litBindings(result, '?disabled=')[0], true);
});
