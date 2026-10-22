import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

// The renderers module reaches the browser gateway client at import time.
mock.module('../../gateway-client.js', {
  namedExports: { gateway: { request: async () => ({}), subscribe: () => () => {} } },
});
// The evidence renderer does not exercise the browser-only history panel and its CSS.
mock.module('./review-history-panel.js', { namedExports: {} });
const memory = new Map<string, string>();
Object.assign(globalThis, {
  location: new URL('http://localhost/#'),
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
});

const { renderRunEvidence } = await import('./run-detail-renderers.js');
const { runResultsSummary } = await import('@farmslot/review-dispatch');
const { litBinding, litText } = await import('../../testing/lit-text.js');

// An active run with no output yet: the "View operation log" case on TAT-3991.
const run = {
  id: 'ba646bae-62a2-490b-86bb-0d5c3edcb9de',
  familyId: 'ba646bae-62a2-490b-86bb-0d5c3edcb9de',
  lane: 'production',
  flowType: 'fix-bug',
  mode: 'autonomous',
  status: 'monitoring',
  project: 'metamask-mobile-farm',
  ticketOrPr: 'TAT-3991',
  slotId: 'macpro-mm-4',
  branch: null,
  taskFile: null,
  steps: [],
  decisions: [],
  metrics: { nudgeCount: 0, runner: 'claude', model: 'opus' },
  createdAt: '2026-10-04T06:39:49.645Z',
  updatedAt: '2026-10-04T07:00:00.000Z',
} as unknown as Run;

const ctx = {
  evidenceLightboxItems: [
    {
      url: '/api/run-artifact?path=artifacts%2Foperations%2Fbac623d2.log',
      path: 'artifacts/operations/bac623d2.log',
      purpose: 'other',
    },
  ],
  evidenceLightboxOpen: true,
  evidenceLightboxIndex: 0,
  artifactUrl: () => '',
  onEvidenceArtifactClick: () => {},
  closeEvidenceLightbox: () => {},
  navigateEvidenceLightbox: () => {},
  replaceEvidenceLightbox: () => {},
};

test('a run with no results card still mounts the evidence lightbox', () => {
  assert.equal(runResultsSummary(run, 0).shouldRender, false, 'no results card for this run');
  const rendered = renderRunEvidence(run, ctx);
  assert.match(litText(rendered), /<media-lightbox/);
  assert.equal(litBinding(rendered, '.open='), true, 'the opened log is on the page');
});

test('an artifact link that cannot open renders its reason', () => {
  const text = litText(
    renderRunEvidence(run, {
      ...ctx,
      evidenceLightboxOpen: false,
      evidenceArtifactUnavailable: {
        path: 'artifacts/operations/gone.log',
        reason: "it is not among this run's evidence files or worker command logs.",
      },
    }),
  );
  assert.match(text, /evidence-artifact-unavailable/);
  assert.match(text, /Cannot open[\s\S]*artifacts\/operations\/gone\.log[\s\S]*not among/);
});

test('the lightbox names its scope: the run output, or the criterion whose evidence it steps through', () => {
  assert.equal(litBinding(renderRunEvidence(run, ctx), 'scopeLabel='), 'Run output');
  assert.equal(
    litBinding(
      renderRunEvidence(run, { ...ctx, evidenceLightboxScope: 'AC-1 evidence' }),
      'scopeLabel=',
    ),
    'AC-1 evidence',
  );
});

test("a held run's results card leaves its stop reason to the decision", () => {
  const stopped = {
    ...run,
    completionPolicy: 'artifact-only' as const,
    error: 'Review found 2 issue(s) after 1/2 fix attempts.',
  };
  const card = (status: Run['status']) =>
    litText(renderRunEvidence({ ...stopped, status }, { ...ctx, evidenceLightboxOpen: false }));
  assert.doesNotMatch(card('needs-decision'), /Review found 2 issue/);
  assert.match(card('failed'), /Review found 2 issue/);
});
