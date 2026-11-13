/**
 * The tab layout keeps link-only screens reachable.
 *
 * Expo Router 58 turns a tab's `href: null` into a hidden tab, and its tabs navigator replaces a
 * focused hidden tab with the first visible one (`useVisibleTabsWithRedirect`). So a screen that
 * is opened only from links (Advanced > Fleet, PR links, the inbox notification) must stay
 * declared without `href: null`, or every link to it lands on Review. This calls the layout with
 * its hooks and children mocked and reads the options it gives each `Tabs.Screen`.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import React, { type ReactElement, type ReactNode } from 'react';

import type { WorkspaceAccess } from './workspace-access';

function Tabs() {
  return null;
}
function TabsScreen() {
  return null;
}
Tabs.Screen = TabsScreen;
function Stub() {
  return null;
}

let access: WorkspaceAccess = 'farm';

mock.module('expo-router', { namedExports: { Tabs, Redirect: Stub } });
mock.module('@expo/vector-icons', { namedExports: { Ionicons: Stub } });
mock.module('react-native', { namedExports: { View: Stub } });
mock.module('react-native-safe-area-context', {
  namedExports: { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
});
mock.module('../components/ConnectionBanner', { namedExports: { ConnectionBanner: Stub } });
mock.module('../components/FilterBar', { namedExports: { FilterBar: Stub } });
mock.module('./store-screenshot-mode', { namedExports: { isStoreScreenshotMode: false } });
mock.module('./theme', {
  namedExports: { colors: new Proxy({}, { get: () => '#000000' }) },
});
// The real module loads the whole protocol index for one string; the layout only redirects with it.
mock.module('./workspace-access', { namedExports: { workspaceHome: () => '/native' } });
mock.module('./use-workspace-render-access', {
  namedExports: { useWorkspaceRenderAccess: () => access },
});

type ScreenOptions = { href?: string | null; tabBarItemStyle?: { display?: string } };
type ScreenElement = ReactElement<{ name: string; options: ScreenOptions }>;
type ParentElement = ReactElement<{ children?: ReactNode }>;

/** Each declared screen's options, from the layout's element tree. */
function screens(node: ReactNode): Map<string, ScreenOptions> {
  const found = new Map<string, ScreenOptions>();
  const walk = (child: ReactNode) => {
    if (!React.isValidElement(child)) return;
    if (child.type === TabsScreen) {
      const screen = child as ScreenElement;
      found.set(screen.props.name, screen.props.options);
      return;
    }
    React.Children.forEach((child as ParentElement).props.children, walk);
  };
  walk(node);
  return found;
}

async function layoutScreens(nextAccess: WorkspaceAccess) {
  access = nextAccess;
  const { default: TabLayout } = await import('../app/(tabs)/_layout');
  return screens(TabLayout());
}

const linkOnly = ['fleet', 'prs', 'inbox', 'copilot', 'backlog', 'roadmap'];

test('with farm access, link-only screens stay reachable and out of the tab bar', async () => {
  const declared = await layoutScreens('farm');
  for (const name of linkOnly) {
    const options = declared.get(name);
    assert.ok(options, `${name} is declared`);
    // `href: null` is what Expo Router hides and redirects away from.
    assert.notEqual(options.href, null, `${name} must not be a hidden tab`);
    assert.equal(options.tabBarItemStyle?.display, 'none', `${name} has no tab-bar button`);
  }
  const tabBar = [...declared]
    .filter(([, options]) => options.href !== null && options.tabBarItemStyle?.display !== 'none')
    .map(([name]) => name);
  assert.deepEqual(tabBar, ['runs', 'workers', 'advanced', 'settings']);
});

test('without farm access, every farm screen stays hidden so the redirect applies', async () => {
  const declared = await layoutScreens('none');
  for (const name of [...linkOnly, 'runs', 'workers', 'advanced'])
    assert.equal(declared.get(name)?.href, null, `${name} is hidden`);
  assert.notEqual(declared.get('settings')?.href, null);
});
