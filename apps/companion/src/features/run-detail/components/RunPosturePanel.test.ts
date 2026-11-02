/**
 * The posture panel's loading card, actually rendered.
 *
 * Same harness as `lib/run-gate-park-render.test.ts`: `react-native` is
 * module-mocked with DOM primitives and the tree is rendered with
 * `react-dom/server`. Here the primitives keep the props the reservation
 * depends on (opacity, absolute positioning, accessibility hiding) as data
 * attributes, so the tests can tell the invisible sizing layer from the card
 * an operator reads.
 *
 * WHAT THIS PROVES: while `runtime.posture.status` is in flight, the visible
 * loading card is laid over an invisible, accessibility-hidden copy of the card
 * the read lands as, so the read fills space already held instead of pushing
 * Timeline down. WHAT IT DOES NOT PROVE: native layout. The device recording in
 * the PR shows Timeline holding its position.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import React from 'react';

import type { RunResourcePostureState } from '@farmslot/protocol';

import type { RunPosturePanel as Panel } from './RunPosturePanel';

type Style = Record<string, unknown>;

function flatten(style: unknown): Style {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object' ? (style as Style) : {};
}

function primitive(tag: string) {
  return function Primitive(props: Record<string, unknown>) {
    const { children, style, testID, importantForAccessibility, accessibilityElementsHidden } =
      props;
    const flat = flatten(style);
    return React.createElement(
      tag,
      {
        ...(testID ? { 'data-testid': String(testID) } : {}),
        ...(importantForAccessibility === 'no-hide-descendants' && accessibilityElementsHidden
          ? { 'data-a11y-hidden': 'true' }
          : {}),
        ...(flat.opacity !== undefined ? { 'data-opacity': String(flat.opacity) } : {}),
        ...(flat.position === 'absolute' ? { 'data-absolute': 'true' } : {}),
      },
      children as React.ReactNode,
    );
  };
}

mock.module('react-native', {
  namedExports: {
    View: primitive('div'),
    Text: primitive('span'),
    StyleSheet: {
      create: (sheet: unknown) => sheet,
      absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
    },
  },
});

/** A run record's persisted posture, shaped like the live Gateway's terminal runs. */
const persisted: RunResourcePostureState = {
  posture: 'terminal',
  policySource: 'framework-default',
  capabilities: [
    {
      capabilityId: 'android.physical',
      desiredDisposition: 'stopped',
      observedState: 'stopped',
      policySource: 'framework-default',
      reason: 'terminal cleanup stops every run- and family-owned provider',
      target: { platform: 'android', adb_serial: '29071JEGR20638' },
      releaseEffects: [],
    },
  ],
  workerRetained: true,
  lastTransition: {
    id: 'posture-1',
    posture: 'terminal',
    policySource: 'framework-default',
    requestedAt: '2026-11-02T04:51:58.172Z',
    completedAt: '2026-11-02T04:51:59.112Z',
    outcome: 'applied',
    effects: [],
    progress: { total: 1, completed: 1 },
    failures: [],
  },
  updatedAt: '2026-11-02T04:51:59.112Z',
};

/** Imported after the module mock is registered, which a static import would precede. */
async function render(props: React.ComponentProps<typeof Panel>): Promise<string> {
  const server = await import('react-dom/server');
  const { RunPosturePanel } = await import('./RunPosturePanel');
  return server.renderToStaticMarkup(React.createElement(RunPosturePanel, props));
}

/** The invisible layer's markup: the copy that holds the space and nothing else. */
const reservedLayer = (html: string) =>
  /<div data-a11y-hidden="true" data-opacity="0">(.*?)<\/div><div data-absolute="true">/u.exec(
    html,
  )?.[1];

test('a loading read holds the space of the card it lands as, from the run record', async () => {
  const loading = await render({ state: { status: 'loading' }, reserveFor: persisted });
  const landed = await render({ state: { status: 'ready', state: persisted } });

  // The sizing layer is the very card the read renders for the same posture.
  assert.equal(reservedLayer(loading), landed);
  // What is visible is only the loading line, laid over that space.
  const visible = loading.slice(loading.indexOf('<div data-absolute="true">'));
  assert.match(visible, /Loading posture…/u);
  assert.doesNotMatch(visible, /android\.physical|Terminal|retained ·/u);
});

test('a run record with no posture holds the smallest card a read can land as', async () => {
  const layer = reservedLayer(await render({ state: { status: 'loading' } }));
  assert.ok(layer, 'the loading card reserves space even without a persisted posture');
  for (const id of ['name', 'counts', 'policy', 'worker', 'empty']) {
    assert.match(layer, new RegExp(`data-testid="companion-run-posture-${id}"`, 'u'));
  }
});

test('a landed read renders only the live card, with nothing held behind it', async () => {
  const landed = await render({
    state: { status: 'ready', state: persisted },
    reserveFor: { ...persisted, capabilities: [] },
  });
  assert.doesNotMatch(landed, /companion-run-posture-reserved|data-opacity|data-a11y-hidden/u);
  assert.match(landed, /data-testid="companion-run-posture-row-android\.physical"/u);
});
