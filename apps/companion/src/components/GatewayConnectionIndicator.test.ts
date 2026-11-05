import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

import { gatewayOfflineLabel } from '@farmslot/protocol';

interface Element {
  type: unknown;
  props: Record<string, unknown>;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function element(value: unknown): Element {
  assert.ok(record(value) && 'type' in value && record(value.props));
  return { type: value.type, props: value.props };
}
function renderer(platform: 'ios' | 'android', modal = false) {
  const owner = Symbol('active modal');
  const state = { status: 'disconnected', signedOut: false, client: { recoveryEnabled: true } };
  const createElement = (type: unknown, props: object | null, ...children: unknown[]): Element => ({
    type,
    props: {
      ...props,
      ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}),
    },
  });
  const modules: Record<string, unknown> = {
    react: {
      createElement,
      Fragment: 'Fragment',
      useEffect: () => {},
      useRef: () => ({ current: owner }),
    },
    'react-native': {
      Platform: { OS: platform },
      View: 'View',
      Text: 'Text',
      Modal: 'Modal',
      StyleSheet: { create: (value: unknown) => value },
    },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 20 }) },
    'react-native-screens': { FullWindowOverlay: 'FullWindowOverlay' },
    '@farmslot/protocol': { gatewayOfflineLabel },
    '../lib/theme': { colors: { bgCard: '#111', statusWarn: '#ff0' }, fonts: { sizeXs: 11 } },
    '../store/connection': {
      useConnectionStore: (select: (value: typeof state) => unknown) => select(state),
    },
    '../features/quick-actions/quick-actions-context': {
      useQuickActionsField: () => (modal ? owner : null),
    },
    './quick-actions-context': {
      useOptionalQuickActions: () => ({ activeOutlet: owner, registerOutlet: () => () => {} }),
    },
    './FloatingQuickActions': { FloatingQuickActions: 'FloatingQuickActions' },
    '../../components/GatewayConnectionIndicator': {
      GatewayConnectionIndicator: 'GatewayConnectionIndicator',
    },
  };
  function load(relative: string, name: string) {
    const file = new URL(relative, import.meta.url);
    const output = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file.pathname,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    }).outputText;
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(output, {
      exports,
      Symbol,
      require: (key: string) => {
        assert.ok(key in modules, `Unexpected render dependency ${key}`);
        return modules[key];
      },
    });
    const render = exports[name];
    assert.equal(typeof render, 'function');
    if (typeof render !== 'function') throw new Error('Missing component');
    return render;
  }
  return { state, load };
}

test('iOS offline overlay leaves cached content accessible and passes touches through', () => {
  const f = renderer('ios');
  const root = element(f.load('./GatewayConnectionIndicator.tsx', 'GatewayConnectionIndicator')());
  assert.equal(root.type, 'FullWindowOverlay');
  assert.equal(root.props.unstable_accessibilityContainerViewIsModal, false);
  assert.equal(element(root.props.children).props.pointerEvents, 'none');
});

test('Android hands the one visible indicator to the active modal window', () => {
  const f = renderer('android', true);
  const render = f.load('./GatewayConnectionIndicator.tsx', 'GatewayConnectionIndicator');
  assert.equal(render(), null);
  const badge = element(render({ inModal: true }));
  assert.equal(badge.props.testID, 'gateway-offline-indicator');
  assert.equal(badge.props.pointerEvents, 'none');
});

test('connection recovery and explicit sign-out hide the indicator in either window', () => {
  const f = renderer('android');
  const render = f.load('./GatewayConnectionIndicator.tsx', 'GatewayConnectionIndicator');
  f.state.status = 'connected';
  assert.equal(render(), null);
  f.state.status = 'disconnected';
  f.state.signedOut = true;
  assert.equal(render(), null);
  f.state.signedOut = false;
  f.state.client.recoveryEnabled = false;
  assert.equal(render(), null);
});

test('the active Android native modal outlet mounts the same fixed indicator', () => {
  const f = renderer('android');
  const modal = element(
    f.load(
      '../features/quick-actions/QuickActionsModal.tsx',
      'QuickActionsModal',
    )({ visible: true, children: 'content' }),
  );
  const view = element(modal.props.children);
  assert.ok(Array.isArray(view.props.children));
  const outlet = element(view.props.children[1]);
  assert.equal(typeof outlet.type, 'function');
  if (typeof outlet.type !== 'function') throw new Error('Missing modal outlet');
  const foreground = element(outlet.type(outlet.props));
  assert.ok(Array.isArray(foreground.props.children));
  const badge = element(foreground.props.children[1]);
  assert.equal(badge.type, 'GatewayConnectionIndicator');
  assert.equal(badge.props.inModal, true);
});
