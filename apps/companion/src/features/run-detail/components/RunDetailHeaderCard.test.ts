/**
 * Run Detail's header card gives every sibling a distinct key.
 *
 * Two siblings with the same key make React log "Encountered two children with the same key"
 * on every Run Detail open, which the dev LogBox shows over the tab bar. The card's own
 * components are plain functions without hooks, so this expands them by calling them and checks
 * each children list of the tree they return. `react-native` is module-mocked (same harness as
 * `RunPosturePanel.test.ts`); nothing here renders natively.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import React, { type ReactElement, type ReactNode } from 'react';

import { runListRow } from '@farmslot/protocol';

import { heldGateRun } from '../held-detail.fixtures';

function primitive(name: string) {
  return function Primitive({ children }: { children?: ReactNode }) {
    return React.createElement(name, null, children);
  };
}

mock.module('react-native', {
  namedExports: {
    View: primitive('View'),
    Text: primitive('Text'),
    TextInput: primitive('TextInput'),
    Pressable: primitive('Pressable'),
    ScrollView: primitive('ScrollView'),
    Image: primitive('Image'),
    Linking: { openURL: async () => undefined },
    Platform: { OS: 'ios', select: (options: { ios?: unknown; default?: unknown }) => options.ios },
    StyleSheet: { create: (sheet: unknown) => sheet, hairlineWidth: 1 },
  },
});

// The panels module reaches Expo modules that need the native runtime; the card only places
// CockpitTile, which this check does not expand.
mock.module('./run-detail-panels', {
  namedExports: { CockpitTile: primitive('CockpitTile') },
});

type Element = ReactElement<{ children?: ReactNode }>;

/** The card's own parts (RunDetailHeaderLines and the rest) expanded to the tree they return. */
function expand(node: ReactNode): ReactNode {
  if (!React.isValidElement(node)) return node;
  const element = node as Element;
  if (typeof element.type === 'function' && element.type.name.startsWith('RunDetail')) {
    const render = element.type as (props: unknown) => ReactNode;
    return expand(render(element.props));
  }
  return element;
}

/** Each children list in the expanded tree, as the elements in it (nulls dropped). */
function childLists(node: ReactNode): Element[][] {
  const element = expand(node);
  if (!React.isValidElement(element)) return [];
  const children = (element as Element).props.children;
  const list = (Array.isArray(children) ? children : [children]).map(expand);
  const elements = list.filter((child): child is Element => React.isValidElement(child));
  return [elements, ...elements.flatMap(childLists)];
}

/** Keys that occur more than once among one children list. */
function duplicateSiblingKeys(node: ReactNode): string[] {
  return childLists(node).flatMap((elements) => {
    const keys = elements.filter((e) => e.key !== null).map((e) => String(e.key));
    return keys.filter((key, index) => keys.indexOf(key) !== index);
  });
}

test('the header card keys no two siblings alike, with and without a title', async () => {
  const { RunDetailHeaderCard } = await import('./RunDetailHeaderCard');
  for (const summary of ['held run.get', '']) {
    const row = runListRow({ ...heldGateRun(), summary });
    const card = RunDetailHeaderCard({
      row,
      ticketsDisabled: false,
      onOpenTerminal: () => undefined,
    });
    assert.deepEqual(duplicateSiblingKeys(card), [], `summary ${JSON.stringify(summary)}`);
    // The ticket editor still resets its draft per run, as before the header moved here.
    const tickets = childLists(card)
      .flat()
      .filter((e) => typeof e.type === 'function' && e.type.name === 'RunLinkedTickets');
    assert.deepEqual(
      tickets.map((e) => e.key),
      [row.id],
    );
  }
});
