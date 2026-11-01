/**
 * The Companion AC panel, actually rendered: each row names the recording its verdict comes
 * from (the shared evidence model's `recording`). Same harness as run-gate-park-render.test.ts:
 * `react-native` primitives as DOM tags, rendered with `react-dom/server`; no layout claim.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import React from 'react';

import type { AcceptanceStatusLedger } from '@farmslot/protocol';

function primitive(tag: string) {
  return function Primitive(props: Record<string, unknown>) {
    const { children, style, testID, ...rest } = props;
    void style;
    return React.createElement(
      tag,
      {
        ...Object.fromEntries(
          Object.entries(rest).filter(([, value]) => typeof value !== 'function'),
        ),
        ...(testID ? { 'data-testid': String(testID) } : {}),
      },
      children as React.ReactNode,
    );
  };
}

mock.module('react-native', {
  namedExports: {
    View: primitive('div'),
    Text: primitive('span'),
    Pressable: primitive('button'),
    TextInput: primitive('input'),
    ActivityIndicator: primitive('span'),
    StyleSheet: { create: (sheet: unknown) => sheet, hairlineWidth: 1 },
    Alert: { alert: () => {} },
    Linking: { openURL: async () => {} },
    AccessibilityInfo: { isReduceMotionEnabled: async () => true },
    Animated: {
      Value: class {
        constructor(readonly value: number) {}
      },
      timing: () => ({ start: () => {} }),
      Text: primitive('span'),
    },
    useColorScheme: () => 'dark',
  },
});

test('each Companion AC row names the recording its verdict comes from', async () => {
  const server = await import('react-dom/server');
  const { TaskAcceptancePanel } = await import('./TaskAcceptancePanel');
  const ledger: AcceptanceStatusLedger = {
    schemaVersion: 1,
    criteria: [
      {
        id: 'AC-1',
        text: 'The panel lists every criterion',
        verdict: 'awaiting-review',
        proofMode: 'mixed',
        evidence: ['artifacts/recipe-runs/20261101072653297-84101/trace.json'],
        recipeNodes: [],
        updatedAt: '2026-11-01T07:26:53.297Z',
      },
    ],
  };
  const markup = server.renderToStaticMarkup(
    React.createElement(TaskAcceptancePanel, { acceptanceStatus: ledger, initiallyExpanded: true }),
  );
  assert.match(markup, /Recording 07:26/);
});
