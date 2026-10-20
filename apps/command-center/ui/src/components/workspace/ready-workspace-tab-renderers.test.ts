import assert from 'node:assert/strict';
import test from 'node:test';

import { html, nothing } from 'lit';

import { litText } from '../../testing/lit-text.js';

import { renderReadyEvidenceTab } from './ready-workspace-tab-renderers.js';

const criteria = html`<section>AC-1 proven by gateway RPC</section>`;

test('the criteria show when the package has no evidence files', () => {
  const text = litText(
    renderReadyEvidenceTab({
      payload: {},
      artifacts: [],
      criteria,
      selectionToolbar: nothing,
      artifactGroups: nothing,
    }),
  );
  assert.match(text, /AC-1 proven by gateway RPC/);
  assert.match(text, /No evidence files/);
});

test('the criteria show while the files load or fail', () => {
  for (const state of [{ loading: true }, { error: 'HTTP 502' }]) {
    const text = litText(
      renderReadyEvidenceTab({
        payload: {},
        artifacts: [],
        criteria,
        selectionToolbar: nothing,
        artifactGroups: nothing,
        ...state,
      }),
    );
    assert.match(text, /AC-1 proven by gateway RPC/);
  }
});
