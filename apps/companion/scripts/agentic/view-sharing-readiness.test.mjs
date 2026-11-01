import assert from 'node:assert/strict';
import test from 'node:test';

import {
  viewSharingArtifactReady,
  viewSharingProfileReady,
  viewSharingRectFits,
  viewSharingScreenReady,
} from './view-sharing-readiness.mjs';

test('Preview requires the actual focused file, not the prior terminal or another file', () => {
  const artifactPath = 'artifacts/videos/recipe-run.mp4';
  const nodes = [
    { label: 'Focus: ' + artifactPath },
    { label: artifactPath },
    { label: 'Preview', enabled: true, hittable: true },
  ];
  assert.equal(viewSharingArtifactReady({ nodes }, artifactPath), true);
  for (let index = 0; index < nodes.length; index += 1)
    assert.equal(
      viewSharingArtifactReady({ nodes: nodes.filter((_, i) => i !== index) }, artifactPath),
      false,
    );
  assert.equal(viewSharingArtifactReady({ nodes }, 'artifacts/foreign.mp4'), false);
  assert.equal(
    viewSharingArtifactReady(
      { nodes: [{ label: 'Run terminal' }, { label: 'Recipe files' }, { label: 'Tail 50' }] },
      artifactPath,
    ),
    false,
  );
  assert.equal(
    viewSharingArtifactReady(
      { nodes: [...nodes.slice(0, 2), { ...nodes[2], enabled: false }] },
      artifactPath,
    ),
    false,
  );
  assert.equal(
    viewSharingArtifactReady(
      { nodes: [...nodes, { identifier: 'companion-artifact-media-viewer' }] },
      artifactPath,
    ),
    false,
  );
});

const expected = { gatewayUrl: 'ws://gateway.test:18678', webBase: 'https://cc.example.test/' };
const profile = {
  nodes: [
    { identifier: 'companion-screen-settings' },
    { label: 'ACTIVE · CONNECTED' },
    { label: 'Active & connected: Configured Gateway · Custom · Healthy' },
    { label: expected.gatewayUrl },
    { identifier: 'companion-command-center-url-configured-gateway', value: expected.webBase },
  ],
};

test('a visible floating button on disconnected Review is not a restored profile', () => {
  const screen = {
    nodes: [
      { identifier: 'companion-quick-actions' },
      { identifier: 'companion-screen-review' },
      { label: 'Gateway offline' },
    ],
  };
  assert.equal(viewSharingProfileReady(screen, expected), false);
  assert.equal(viewSharingScreenReady(screen, 'slot', 'saved-slot'), false);
});

test('readiness requires the active connected profile and its exact web URL', () => {
  assert.equal(viewSharingProfileReady(profile, expected), true);
  for (let index = 0; index < profile.nodes.length; index += 1) {
    assert.equal(
      viewSharingProfileReady({ nodes: profile.nodes.filter((_, i) => i !== index) }, expected),
      false,
    );
  }
  assert.equal(
    viewSharingProfileReady(profile, { ...expected, webBase: 'https://other.test/' }),
    false,
  );
  assert.equal(
    viewSharingProfileReady(profile, { ...expected, gatewayUrl: 'ws://other.test' }),
    false,
  );
  assert.equal(
    viewSharingProfileReady(
      { nodes: profile.nodes.map((node) => ({ ...node, visibleToUser: false })) },
      expected,
    ),
    false,
  );
});

test('a mounted slot is observed through its real content without the absent wrapper ID', () => {
  const screen = {
    nodes: [
      { identifier: 'companion-slot-tab-slot' },
      { identifier: 'companion-workspace-shortcut-run' },
      { label: 'saved-slot' },
    ],
  };
  assert.equal(viewSharingScreenReady(screen, 'slot', 'saved-slot'), true);
  assert.equal(viewSharingScreenReady(screen, 'slot', 'foreign-slot'), false);
  assert.equal(
    viewSharingScreenReady({ nodes: screen.nodes.slice(0, 1) }, 'slot', 'saved-slot'),
    false,
  );
});

test('each terminal needs its visible terminal content and exact destination', () => {
  const screen = { nodes: [{ label: 'saved-slot' }, { label: 'Tail 400' }] };
  assert.equal(viewSharingScreenReady(screen, 'terminal', 'saved-slot'), true);
  assert.equal(viewSharingScreenReady(screen, 'run-terminal', 'saved-slot'), false);
  assert.equal(
    viewSharingScreenReady(
      { nodes: [{ label: 'Run terminal' }, { label: 'Tail 400' }] },
      'run-terminal',
      'saved-slot',
    ),
    true,
  );
  assert.equal(
    viewSharingScreenReady(
      { nodes: [...screen.nodes, { identifier: 'companion-screen-review' }] },
      'terminal',
      'saved-slot',
    ),
    false,
  );
});

test('timeline points must use finite controls inside the observed clipping viewport', () => {
  const viewport = { x: 32, y: 1919, width: 1017, height: 192 };
  const control = { x: 32, y: 1919, width: 844, height: 96 };
  assert.equal(viewSharingRectFits(viewport, control), true);
  assert.equal(viewSharingRectFits(viewport, { ...control, x: 20 }), false);
  assert.equal(viewSharingRectFits(viewport, { ...control, x: 900 }), false);
  assert.equal(viewSharingRectFits(viewport, { ...control, y: 2100 }), false);
  assert.equal(viewSharingRectFits(viewport, { ...control, width: NaN }), false);
  assert.equal(viewSharingRectFits(viewport, { ...control, height: 0 }), false);
});
