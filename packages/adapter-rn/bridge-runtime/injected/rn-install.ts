/**
 * Install entry for the injected React Native runtime: builds the generic
 * members, mounts the step HUD through the React Refresh host swap, and
 * assigns the bridge to a host-chosen global with a version stamp.
 *
 * Idempotent: a second install with the same version returns the existing
 * stamp and changes nothing. A different version replaces the bridge.
 */

import {
  createModuleTable,
  createRnMembers,
  findModuleId,
  walkFiber,
  walkFiberRoots,
  type FiberNode,
  type ModuleSpec,
  type ModuleTable,
} from './rn-runtime';
import {
  createStepHud,
  swapHudIntoHost,
  type HostSwapResult,
  type RefreshRuntime,
} from './rn-hud';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Modules the generic runtime needs; the host map may add candidates. */
export const RN_CORE_MODULES: ModuleSpec[] = [
  {
    key: 'react',
    paths: ['node_modules/react/index.js'],
    shape: (m) =>
      ['createElement', 'useState', 'useEffect', 'useMemo'].every(
        (name) => typeof m[name] === 'function',
      ) && m.Fragment
        ? null
        : 'missing createElement/useState/useEffect/useMemo/Fragment',
  },
  {
    key: 'reactNative',
    paths: ['node_modules/react-native/index.js'],
    shape: (m) => {
      const platform = m.Platform as { OS?: unknown } | undefined;
      const dimensions = m.Dimensions as { get?: unknown } | undefined;
      if (typeof platform?.OS !== 'string') return 'Platform.OS is not a string';
      if (typeof dimensions?.get !== 'function') return 'Dimensions.get is not a function';
      if (!m.View || !m.Text) return 'View/Text missing';
      if (typeof (m.StyleSheet as { create?: unknown })?.create !== 'function')
        return 'StyleSheet.create missing';
      return null;
    },
  },
  {
    key: 'reactRefreshRuntime',
    paths: [
      'node_modules/react-refresh/cjs/react-refresh-runtime.development.js',
      'node_modules/react-refresh/runtime.js',
    ],
    shape: (m) =>
      ['register', 'getFamilyByType', 'performReactRefresh'].every(
        (name) => typeof m[name] === 'function',
      )
        ? null
        : 'missing register/getFamilyByType/performReactRefresh',
  },
  {
    key: 'navigationContainerRefContext',
    paths: [
      'node_modules/@react-navigation/core/lib/module/NavigationContainerRefContext.js',
      'node_modules/@react-navigation/core/lib/commonjs/NavigationContainerRefContext.js',
    ],
    shape: (m) =>
      m.NavigationContainerRefContext &&
      typeof m.NavigationContainerRefContext === 'object'
        ? null
        : 'NavigationContainerRefContext export missing',
    optional: true,
  },
];

export interface HostLeafSpec {
  key: string;
  paths: string[];
  exportKey: string;
}

export interface InstallConfig {
  globalName: string;
  version: string;
  modules: ModuleSpec[];
  /** Mount candidates for the HUD, best first (L3 host-leaf table). */
  hudHosts: HostLeafSpec[];
  /** Safe-area insets hook and the iOS overlay, resolved by the host map. */
  hudModules: { safeArea: string; screens: string };
  log?: (...args: unknown[]) => void;
  /** Host members; receives the runtime context. */
  extend: (rt: RuntimeContext) => Record<string, unknown>;
}

export interface RuntimeContext {
  modules: ModuleTable;
  hud: ReturnType<typeof createStepHud>;
  hudSwap: () => HostSwapResult;
  getHudSwap: () => HostSwapResult | null;
  readNavigationContainerRef: () => NavigationRefRead;
  walkFiber: typeof walkFiber;
  walkFiberRoots: typeof walkFiberRoots;
}

export interface NavigationRefRead {
  ref: any;
  fiberTag: number | null;
  providerFound: boolean;
  error?: string;
}

/**
 * React Navigation passes the same object to the container ref
 * (`useImperativeHandle(ref, () => navigation)`) and to
 * `<NavigationContainerRefContext.Provider value={navigation}>`
 * (@react-navigation/core BaseNavigationContainer). Read it from the
 * committed provider fiber.
 */
function readNavigationRefFromFiber(context: unknown): NavigationRefRead {
  if (!context) {
    return { ref: null, fiberTag: null, providerFound: false, error: 'context module missing' };
  }
  // React 19 renders <Context> directly; React 18 renders <Context.Provider>.
  const providerTypes = new Set<unknown>([
    context,
    (context as { Provider?: unknown }).Provider,
  ]);
  let read: NavigationRefRead = {
    ref: null,
    fiberTag: null,
    providerFound: false,
    error: 'NavigationContainerRefContext provider not found in the fiber tree',
  };
  walkFiberRoots((root) =>
    walkFiber(root, (fiber: FiberNode) => {
      if (!providerTypes.has(fiber.type)) return false;
      const value = fiber.memoizedProps?.value as { getRootState?: unknown } | undefined;
      if (value && typeof value.getRootState === 'function') {
        read = { ref: value, fiberTag: fiber.tag ?? null, providerFound: true };
        return true;
      }
      return false;
    }),
  );
  return read;
}

export interface InstallStamp {
  globalName: string;
  version: string;
  installedAt: number;
  hud: HostSwapResult | null;
  moduleCount: number;
}

export function installRnRuntime(config: InstallConfig): {
  status: 'present' | 'installed' | 'replaced';
  stamp: InstallStamp;
} {
  const existing = (globalThis as Record<string, any>)[config.globalName];
  const existingStamp = existing?.__cdpRuntime?.stamp as InstallStamp | undefined;
  if (existingStamp && existingStamp.version === config.version) {
    return { status: 'present', stamp: existingStamp };
  }

  const modules = createModuleTable([...RN_CORE_MODULES, ...config.modules]);
  const RN = modules.get<Record<string, any>>('reactNative');
  const React = modules.get<Record<string, any>>('react');
  const log = config.log ?? ((...args: unknown[]) => console.log(...args));

  const safeArea = modules.get<Record<string, any>>(config.hudModules.safeArea);
  const screens = modules.get<Record<string, any>>(config.hudModules.screens);
  const hud = createStepHud({
    React,
    Platform: RN.Platform,
    StyleSheet: RN.StyleSheet,
    Text: RN.Text,
    View: RN.View,
    useSafeAreaInsets: safeArea.useSafeAreaInsets,
    FullWindowOverlay: screens.FullWindowOverlay,
  });

  let hudSwap: HostSwapResult | null = null;
  const doHudSwap = (): HostSwapResult => {
    const refresh = modules.get<RefreshRuntime>('reactRefreshRuntime');
    const hosts = config.hudHosts.flatMap((host) => {
      const found = findModuleId(host.paths);
      if (!found) return [];
      const exports = (globalThis as any).__r(found.id) as Record<string, unknown>;
      return [
        {
          key: host.key,
          moduleId: found.id,
          path: found.path,
          exportKey: host.exportKey,
          component: exports?.[host.exportKey],
        },
      ];
    });
    hudSwap = swapHudIntoHost({
      React,
      refresh,
      hosts,
      Hud: hud.AgentStepHud,
      metroPrefix: String((globalThis as any).__METRO_GLOBAL_PREFIX__ ?? ''),
    });
    return hudSwap;
  };

  let navRead: NavigationRefRead | null = null;
  const readNavigationContainerRef = (): NavigationRefRead => {
    if (navRead?.ref) {
      try {
        navRead.ref.getRootState();
        return navRead;
      } catch {
        // Stale container (remounted); read it again below.
      }
    }
    const context = modules.has('navigationContainerRefContext')
      ? (modules.get<Record<string, unknown>>('navigationContainerRefContext')
          .NavigationContainerRefContext as unknown)
      : null;
    navRead = readNavigationRefFromFiber(context);
    return navRead;
  };

  const rt: RuntimeContext = {
    modules,
    hud,
    hudSwap: doHudSwap,
    getHudSwap: () => hudSwap,
    readNavigationContainerRef,
    walkFiber,
    walkFiberRoots,
  };

  const generic = createRnMembers({ Dimensions: RN.Dimensions, Logger: { log } });
  const hostMembers = config.extend(rt);
  doHudSwap();

  const stamp: InstallStamp = {
    globalName: config.globalName,
    version: config.version,
    installedAt: Date.now(),
    hud: hudSwap,
    moduleCount: modules.snapshot().length,
  };
  const bridge = {
    ...generic,
    ...hostMembers,
    __cdpRuntime: {
      stamp,
      modules: () => modules.snapshot(),
      checkModules: () => modules.check(),
      hudSwap: doHudSwap,
      hudState: () => ({
        lastStep: hud.getLastStep(),
        mounts: hud.getMountCount(),
        sinkRegistered: hud.isSinkRegistered(),
        swap: hudSwap,
      }),
      readNavigationContainerRef,
    },
  };
  (globalThis as Record<string, unknown>)[config.globalName] = bridge;
  return { status: existingStamp ? 'replaced' : 'installed', stamp };
}
