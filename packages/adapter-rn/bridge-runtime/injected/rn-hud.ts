/**
 * Step HUD for the injected runtime: a port of MetaMask Mobile
 * `app/dev-tools/AgenticService/AgentStepHud.tsx` (main, 032bc6d0eee) built
 * from the app's own React / react-native modules (resolved through the Metro
 * registry), plus the React Refresh host swap that mounts it without any
 * in-app component.
 *
 * Helpers and styles are copied unchanged; JSX is written as createElement
 * because the injected bundle has no JSX transform bound to the app's React.
 */

import type { AgenticHudStep } from './rn-runtime';
import { walkFiberRoots, walkFiber } from './rn-runtime';

type Step = AgenticHudStep;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface HudDeps {
  React: any;
  Platform: { OS: string };
  StyleSheet: { create: <T>(styles: T) => T };
  Text: any;
  View: any;
  useSafeAreaInsets: () => {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  FullWindowOverlay: any;
}

// ─── Ported: AgentStepHud.tsx:33-81 (display helpers) ──────────────────────

function statusForStep(step: Step) {
  const id = typeof step.id === 'string' ? step.id : '';
  return String(step.status ?? id.split(/\s+/)[0] ?? '').toLowerCase();
}

function progressForStep(step: Step) {
  if (
    typeof step.progress?.current === 'number' &&
    typeof step.progress?.total === 'number'
  ) {
    return `${step.progress.current}/${step.progress.total}`;
  }
  const progressPattern = /\b\d+\s*\/\s*\d+\b/;
  const id = typeof step.id === 'string' ? step.id : '';
  const match = progressPattern.exec(id);
  return match ? match[0].replace(/\s+/g, '') : null;
}

function badgeTextForStep(step: Step) {
  const rawStatus = statusForStep(step);
  const status = rawStatus === 'running' ? 'run' : rawStatus;
  const progress = progressForStep(step);
  return [status || 'run', progress].filter(Boolean).join(' ').toUpperCase();
}

function statusToneForStep(step: Step) {
  const status = statusForStep(step);
  if (status === 'fail' || status === 'failed' || status === 'error') {
    return 'fail';
  }
  if (status === 'pass' || status === 'passed' || status === 'success') {
    return 'pass';
  }
  return 'running';
}

function displayStateForStep(step: Step) {
  const intent = step.intent.trim();
  const secondary = [
    step.error ? `error: ${step.error}` : null,
    step.detail && step.detail !== intent ? step.detail : null,
  ].filter((part): part is string => Boolean(part));
  return {
    intent,
    secondary: secondary.filter(
      (part, index) => secondary.indexOf(part) === index,
    ),
  };
}

export function createStepHud(deps: HudDeps) {
  const { React, Platform, StyleSheet, Text, View, useSafeAreaInsets } = deps;
  const { useEffect, useMemo, useState } = React;
  const FullWindowOverlay = deps.FullWindowOverlay;

  // Step bus. Same contract as AgentStepHud.tsx:23-31, plus the last step so
  // a HUD mounted by the host swap shows a step emitted before it mounted.
  let stepSink: ((step: Step | null) => void) | null = null;
  let lastStep: Step | null = null;
  let mountCount = 0;

  function emitStepHud(step: Step | null) {
    lastStep = step;
    stepSink?.(step);
  }

  function registerStepHudCallback(sink: ((step: Step | null) => void) | null) {
    stepSink = sink;
  }

  // ─── Ported: AgentStepHud.tsx:83-122 (styles) ──────────────────────────
// Debug-only overlay — intentionally uses hardcoded colors for guaranteed
// contrast on both light and dark themes. Design tokens would defeat the purpose.
/* eslint-disable react-native/no-color-literals, @metamask/design-tokens/color-no-hex */
const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 9999,
    backgroundColor: 'rgba(0, 0, 0, 0.58)',
    paddingVertical: 3,
  },
  line: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
  },
  badgeText: {
    fontFamily: 'Courier',
    fontSize: 9,
    fontWeight: '800',
  },
  badgeTextRunning: {
    color: '#00FF88',
  },
  badgeTextPass: {
    color: '#00FF88',
  },
  badgeTextFail: {
    color: '#FF4D4F',
  },
  secondary: {
    color: '#E6E6E6',
    fontSize: 10,
    fontWeight: '400',
    lineHeight: 12,
  },
});
/* eslint-enable react-native/no-color-literals, @metamask/design-tokens/color-no-hex */

  // ─── Ported: AgentStepHud.tsx:124-184 (inner component, JSX → createElement)
  const AgentStepHudInner = () => {
    const [step, setStep] = useState(lastStep);
    const insets = useSafeAreaInsets();
    const atTop = step?.placement === 'top';

    const containerStyle = useMemo(
      () => [
        styles.container,
        atTop
          ? { top: Math.max(insets.top, 0) }
          : { bottom: Math.max(insets.bottom, 0) },
        {
          paddingLeft: Math.max(insets.left, 10),
          paddingRight: Math.max(insets.right, 10),
        },
      ],
      [atTop, insets.left, insets.right, insets.top, insets.bottom],
    );

    useEffect(() => {
      mountCount += 1;
      registerStepHudCallback(setStep);
      setStep(lastStep);
      return () => {
        registerStepHudCallback(null);
      };
    }, []);

    if (!step) return null;

    const { intent, secondary } = displayStateForStep(step);
    const badge = badgeTextForStep(step);
    const tone = statusToneForStep(step);
    const badgeTextStyle =
      tone === 'fail'
        ? styles.badgeTextFail
        : tone === 'pass'
          ? styles.badgeTextPass
          : styles.badgeTextRunning;

    const content = React.createElement(
      View,
      { style: containerStyle, pointerEvents: 'none' },
      React.createElement(
        Text,
        { style: styles.line },
        React.createElement(
          Text,
          { style: [styles.badgeText, badgeTextStyle] },
          badge,
        ),
        intent ? `  ${intent}` : '',
      ),
      ...secondary.map((detail: string) =>
        React.createElement(Text, { key: detail, style: styles.secondary }, detail),
      ),
    );

    // iOS needs a UIWindow overlay to cover native-stack modals. Android keeps
    // the root-level view; FullWindowOverlay is unsupported there and warns.
    return Platform.OS === 'ios'
      ? React.createElement(FullWindowOverlay, null, content)
      : content;
  };

  return {
    AgentStepHud: AgentStepHudInner,
    emitStepHud,
    getLastStep: () => lastStep,
    getMountCount: () => mountCount,
    isSinkRegistered: () => stepSink !== null,
  };
}

// ─── React Refresh host swap ────────────────────────────────────────────────

export interface RefreshRuntime {
  register: (type: unknown, id: string) => void;
  getFamilyByType: (type: unknown) => unknown;
  performReactRefresh: () => {
    updatedFamilies: Set<unknown>;
    staleFamilies: Set<unknown>;
  } | null;
}

export interface HostLeaf {
  key: string;
  /** Metro module id of the module that defines the component. */
  moduleId: number;
  path: string;
  exportKey: string;
  component: unknown;
}

export interface HostSwapResult {
  ok: boolean;
  host?: string;
  path?: string;
  familyId?: string;
  mountedFibers?: number;
  updatedFamilies?: number;
  staleFamilies?: number;
  tried: { host: string; reason: string }[];
  error?: string;
}

function countMountedFamilyFibers(refresh: RefreshRuntime, family: unknown) {
  let mounted = 0;
  walkFiberRoots((root) =>
    walkFiber(root, (fiber) => {
      if (
        fiber.type &&
        (typeof fiber.type === 'function' || typeof fiber.type === 'object') &&
        refresh.getFamilyByType(fiber.type) === family
      ) {
        mounted += 1;
      }
      return false;
    }),
  );
  return mounted;
}

/**
 * Mount `Hud` next to the first always-mounted host leaf that is in the tree.
 * Metro registers each export as family `"<prefix> <moduleId> %exports% <key>"`
 * (metro-runtime require.js registerExportsForReactRefresh). Registering a new
 * type under that id and running react-refresh's performReactRefresh re-renders
 * every fiber of the family with the new type; DevSettings.onFastRefresh is
 * skipped on purpose (no LogBox/HMR side effects).
 */
export function swapHudIntoHost(options: {
  React: any;
  refresh: RefreshRuntime;
  hosts: HostLeaf[];
  Hud: unknown;
  metroPrefix: string;
}): HostSwapResult {
  const { React, refresh, hosts, Hud, metroPrefix } = options;
  const tried: { host: string; reason: string }[] = [];
  for (const host of hosts) {
    const original = host.component as ((props: unknown) => unknown) | undefined;
    if (typeof original !== 'function') {
      tried.push({ host: host.key, reason: 'export is not a function component' });
      continue;
    }
    const family = refresh.getFamilyByType(original);
    if (!family) {
      tried.push({ host: host.key, reason: 'export has no React Refresh family' });
      continue;
    }
    const mountedFibers = countMountedFamilyFibers(refresh, family);
    if (mountedFibers === 0) {
      tried.push({ host: host.key, reason: 'host is not mounted' });
      continue;
    }
    const familyId = `${metroPrefix} ${host.moduleId} %exports% ${host.exportKey}`;
    // Render the original host (called inline: rendering <original/> would
    // resolve back to this family) and the HUD as a sibling.
    const CdpHudHost = (props: unknown) =>
      React.createElement(
        React.Fragment,
        null,
        original(props),
        React.createElement(Hud as never),
      );
    refresh.register(CdpHudHost, familyId);
    if (refresh.getFamilyByType(CdpHudHost) !== family) {
      tried.push({
        host: host.key,
        reason: `family id ${familyId} is not the registered family of the export`,
      });
      continue;
    }
    const update = refresh.performReactRefresh();
    return {
      ok: true,
      host: host.key,
      path: host.path,
      familyId,
      mountedFibers,
      updatedFamilies: update?.updatedFamilies.size ?? 0,
      staleFamilies: update?.staleFamilies.size ?? 0,
      tried,
    };
  }
  return { ok: false, tried, error: 'No mounted host leaf accepted the HUD swap' };
}
