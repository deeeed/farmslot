import assert from 'node:assert/strict';
import test from 'node:test';

import { litBindings, litText } from '../../testing/lit-text.js';
import { renderFleetSkeleton } from '../fleet-map/fleet-skeleton.js';
import { renderPrBoardSkeleton } from '../pr-dashboard/pr-board-skeleton.js';
import { renderRunListSkeleton } from '../runs/run-list-skeleton.js';
import {
  renderPublicationGatePanel,
  renderPublicationGateSkeleton,
} from '../workspace/publication-gate-panel.js';

test('gate loading, loaded and failed states preserve the registered AC count and approval guard', () => {
  const loading = litText(renderPublicationGateSkeleton(4));
  const failed = litText(renderPublicationGateSkeleton(4, 'Read failed', () => undefined));
  const loadedView = renderPublicationGatePanel({
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
  });
  const loaded = litText(loadedView);
  for (const text of [loading, loaded, failed]) assert.match(text, /--gate-row-count:4/);
  assert.match(loading, /aria-busy=true/);
  assert.match(failed, /role=alert/);
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
