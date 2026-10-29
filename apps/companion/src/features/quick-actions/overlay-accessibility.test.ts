/**
 * iOS full-window overlays default to accessibility-modal, which hides the whole app behind them
 * from VoiceOver and XCUITest. Both of Companion's overlays float over the app, so each must turn
 * that off. `react-native` and `react-native-screens` are module-mocked; the real components
 * render through react-dom/server, and the overlay records the props it receives.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import React from 'react';

function primitive(tag: string) {
  return function Primitive(props: Record<string, unknown>) {
    return React.createElement(tag, null, props.children as React.ReactNode);
  };
}

interface OverlayProps {
  children?: React.ReactNode;
  unstable_accessibilityContainerViewIsModal?: boolean;
}
const overlays: OverlayProps[] = [];
function FullWindowOverlay(props: OverlayProps) {
  overlays.push(props);
  return React.createElement('section', null, props.children);
}

mock.module('react-native', {
  namedExports: {
    Platform: { OS: 'ios' },
    View: primitive('div'),
    Text: primitive('span'),
    StyleSheet: { create: (sheet: unknown) => sheet, flatten: (style: unknown) => style },
  },
});
mock.module('react-native-screens', { namedExports: { FullWindowOverlay } });
mock.module('react-native-safe-area-context', {
  namedExports: {
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
    SafeAreaInsetsContext: React.createContext(null),
  },
});
mock.module('./FloatingQuickActions', {
  namedExports: { FloatingQuickActions: () => React.createElement('button', null, 'Quick') },
});
mock.module('./quick-actions-context', {
  namedExports: { useQuickActions: () => ({ activeOutlet: null }) },
});

// Loaded after the mocks; this package compiles to CJS, so no top-level await.
const load = async () => ({
  render: (await import('react-dom/server')).renderToStaticMarkup,
  QuickActionsRoot: (await import('./QuickActionsRoot')).QuickActionsRoot,
  RecipeHud: (await import('../../farmslot/RecipeHud')).RecipeHud,
});

test('the quick actions overlay leaves the app visible to iOS accessibility', async () => {
  const { render, QuickActionsRoot } = await load();
  overlays.length = 0;
  assert.match(render(React.createElement(QuickActionsRoot)), /Quick/);
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0]!.unstable_accessibilityContainerViewIsModal, false);
});

test('the recipe HUD overlay leaves the app visible to iOS accessibility', async () => {
  const { render, RecipeHud } = await load();
  overlays.length = 0;
  render(
    React.createElement(RecipeHud, {
      state: { status: 'running', intent: 'Open the gate' },
      overlay: FullWindowOverlay,
    }),
  );
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0]!.unstable_accessibilityContainerViewIsModal, false);
});
