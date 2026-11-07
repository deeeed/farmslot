/** Real viewer and URL state, with native primitives rendered as DOM; no layout claim. */
import assert from 'node:assert/strict';
import test, { before, mock } from 'node:test';

import React from 'react';

interface ModalProps {
  visible?: boolean;
  children?: React.ReactNode;
  onRequestClose?: () => void;
}
interface Button {
  label: string;
  press: () => void;
}
let params: Record<string, string | string[] | undefined> = {};
const buttons: Button[] = [];
const modals: ModalProps[] = [];
function text(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return React.isValidElement<{ children?: React.ReactNode }>(node)
    ? text(node.props.children)
    : '';
}
function primitive(tag: string) {
  return (props: { children?: React.ReactNode }) => React.createElement(tag, null, props.children);
}
mock.module('react-native', {
  namedExports: {
    Platform: { OS: 'android' },
    StatusBar: { currentHeight: 0 },
    View: primitive('div'),
    Text: primitive('span'),
    TextInput: () => null,
    ScrollView: primitive('div'),
    Pressable: (props: { children?: React.ReactNode; onPress?: () => void }) => {
      if (props.onPress) buttons.push({ label: text(props.children), press: props.onPress });
      return React.createElement('button', null, props.children);
    },
    StyleSheet: { create: (value: unknown) => value },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  },
});
mock.module('react-native-safe-area-context', {
  namedExports: { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
});
mock.module('expo-router', {
  namedExports: {
    useIsFocused: () => true,
    useLocalSearchParams: () => params,
    useSegments: () => ['native'],
    useRouter: () => ({ push() {} }),
    useNavigation: () => ({
      setParams(patch: Record<string, string | string[] | undefined>) {
        for (const [key, value] of Object.entries(patch))
          if (value === undefined) delete params[key];
          else params[key] = value;
      },
    }),
  },
});
mock.module('./view-state-filters', { namedExports: { bindViewStateFilters: () => () => {} } });
mock.module('../lib/artifact-response', {
  namedExports: {
    readStoredArtifact: () => {
      throw Error('Unexpected network read');
    },
  },
});
mock.module('../features/quick-actions/QuickActionsModal', {
  namedExports: {
    QuickActionsModal: (props: ModalProps) => {
      modals.push(props);
      return props.visible ? React.createElement('section', null, props.children) : null;
    },
  },
});
let render: () => void;
before(async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ViewStateProvider } = await import('./view-state');
  const { MobileDiffViewer } = await import('./MobileDiffViewer');
  const props = (id: string) => ({
    fullscreenChoiceId: 'native-tool-' + id,
    title: 'Repeated filename',
    initialPath: id + '.txt',
    diffText: `--- ${id}.txt\n+++ ${id}.txt\n@@ -1 +1 @@\n-before\n+${id}\n`,
  });
  render = () => {
    buttons.length = 0;
    modals.length = 0;
    renderToStaticMarkup(
      React.createElement(
        ViewStateProvider,
        null,
        React.createElement(MobileDiffViewer, props('first')),
        React.createElement(MobileDiffViewer, props('second')),
      ),
    );
  };
});
test('each expanded diff owns its fullscreen dialog, including after a URL reload', () => {
  params = {};
  render();
  buttons.filter((button) => button.label === 'Review diff')[0].press();
  render();
  assert.equal(modals.filter((modal) => modal.visible).length, 1);
  const saved = { ...params };
  modals.find((modal) => modal.visible)!.onRequestClose?.();
  render();
  assert.equal(modals.filter((modal) => modal.visible).length, 0);
  buttons.filter((button) => button.label === 'Review diff')[1].press();
  render();
  assert.equal(modals.filter((modal) => modal.visible).length, 1);
  assert.equal(modals[0].visible, false);
  assert.equal(modals[1].visible, true);
  params = saved;
  render();
  assert.equal(modals[0].visible, true);
  assert.equal(modals[1].visible, false);
});
