import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { PNG } from 'pngjs';

import type { UiObserverRef } from '@farmslot/protocol';
import {
  type ActionExecutionContext,
  type GestureAction,
  gestureDurationMs,
  gesturePhase,
  gesturePoints,
  gestureSegmentDuration,
  gestureTarget,
  type RecipeActionPhase,
  type RecipeObservationResult,
  type UiActionTransport,
  type UiPoint,
  type UiTransportResult,
} from '@farmslot/recipe-harness';

const execFileAsync = promisify(execFile);

// Structural view of the used agent-device client surface. Keeping this local
// (instead of `typeof import('agent-device')`) keeps the optional peer out of
// emitted declarations, so consumers without agent-device still typecheck.
export interface AgentDeviceSnapshotNode {
  identifier?: string;
  label?: string;
  value?: unknown;
  type?: string;
  hittable?: boolean;
  visibleToUser?: boolean;
  interactionBlocked?: 'covered';
  hiddenContentAbove?: boolean;
  hiddenContentBelow?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface AgentDeviceSnapshot {
  nodes: AgentDeviceSnapshotNode[];
  truncated: boolean;
  appName?: string;
  appBundleId?: string;
}

export interface AgentDeviceClientLike {
  apps: { open(options: Record<string, unknown>): Promise<unknown> };
  interactions: {
    press(options: Record<string, unknown>): Promise<unknown>;
    fill(options: Record<string, unknown>): Promise<unknown>;
    scroll(options: Record<string, unknown>): Promise<unknown>;
    swipe(options: Record<string, unknown>): Promise<unknown>;
  };
  command: {
    wait(options: Record<string, unknown>): Promise<unknown>;
    keyboard(options: Record<string, unknown>): Promise<unknown>;
  };
  capture: {
    snapshot(options: Record<string, unknown>): Promise<AgentDeviceSnapshot>;
    screenshot(options: Record<string, unknown>): Promise<{
      width?: number;
      height?: number;
      logicalWidth?: number;
      logicalHeight?: number;
      pixelDensity?: number;
    }>;
  };
  sessions: { close(options: Record<string, unknown>): Promise<unknown> };
}

type AgentDeviceClient = AgentDeviceClientLike;

export const NATIVE_UI_ACTIONS = [
  'ui.press',
  'ui.key_press',
  'ui.set_input',
  'ui.scroll',
  'ui.swipe',
  'ui.pan',
  'ui.drag',
  'ui.long_press',
  'ui.wait_for',
  'ui.screenshot',
  'ui.capture_surface',
] as const;

export interface AgentDeviceUiTransportOptions {
  platform: 'ios' | 'android';
  device: string;
  app: string;
  session: string;
  stateDir?: string;
  client?: AgentDeviceClient;
  gestureCommandRunner?: NativeGestureCommandRunner;
  idbPath?: string;
  adbPath?: string;
}

export interface NativeGestureCommandRunner {
  execFile(
    file: string,
    args: string[],
    options?: { timeoutMs?: number },
  ): Promise<{ stdout?: string; stderr?: string }>;
}

export interface AgentDeviceUiTransport extends UiActionTransport {
  close(): Promise<void>;
}

type AgentDeviceSelection = {
  platform: 'ios' | 'android';
  target: 'mobile';
  device?: string;
  serial?: string;
  udid?: string;
};

export function createAgentDeviceUiTransport(
  options: AgentDeviceUiTransportOptions,
): AgentDeviceUiTransport {
  let clientPromise = options.client ? Promise.resolve(options.client) : undefined;
  const selection = agentDeviceSelection(options.platform, options.device);
  let opened = false;
  const gestureCommandRunner = options.gestureCommandRunner ?? defaultGestureCommandRunner();
  let gestureToolPromise: Promise<string> | undefined;
  let gestureDevicePromise: Promise<string> | undefined;

  function gestureTool(): Promise<string> {
    gestureToolPromise ??= resolveGestureTool(
      options.platform === 'ios' ? 'idb' : 'adb',
      options.platform === 'ios' ? options.idbPath : options.adbPath,
      gestureCommandRunner,
    ).catch((error: unknown) => {
      gestureToolPromise = undefined;
      throw error;
    });
    return gestureToolPromise;
  }

  function gestureDevice(): Promise<string> {
    gestureDevicePromise ??= (
      options.platform === 'ios'
        ? gestureTool().then((tool) =>
            resolveIosGestureDevice(options.device, tool, gestureCommandRunner),
          )
        : Promise.resolve(options.device)
    ).catch((error: unknown) => {
      gestureDevicePromise = undefined;
      throw error;
    });
    return gestureDevicePromise;
  }

  async function resolveClient(): Promise<AgentDeviceClient> {
    if (!clientPromise) {
      assertAgentDeviceNodeVersion(process.versions.node);
      clientPromise = import('agent-device')
        .then(({ createAgentDeviceClient }) =>
          createAgentDeviceClient({
            session: options.session,
            stateDir: options.stateDir,
            lockPolicy: 'reject',
            lockPlatform: options.platform,
          }),
        )
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Native recipe actions require the optional agent-device provider: ${message}`,
          );
        });
    }
    return clientPromise;
  }

  async function ensureOpen(): Promise<AgentDeviceClient> {
    const client = await resolveClient();
    if (opened) return client;
    await client.apps.open({
      ...selection,
      app: options.app,
      session: options.session,
      relaunch: false,
      noRecord: true,
    });
    opened = true;
    return client;
  }

  return {
    async execute(action, node, context) {
      const client = await ensureOpen();
      switch (action) {
        case 'ui.press':
          return requireSettledInteraction(
            'ui.press',
            await client.interactions.press({
              ...selection,
              session: options.session,
              selector: selectorFromNode(node, 'ui.press'),
              settle: node.settle !== false,
              verify: true,
              responseLevel: 'digest',
              timeoutMs: positiveNumber(node.timeout_ms) ?? 10_000,
            }),
            node.settle !== false,
          );
        case 'ui.key_press': {
          const result = await client.command.keyboard({
            ...selection,
            session: options.session,
            action: nativeKeyboardAction(node.key),
            responseLevel: 'digest',
          });
          if (node.settle === false) return result;
          return {
            ...(result as Record<string, unknown>),
            ...(await awaitNativeStability(
              client,
              options.session,
              selection,
              'ui.key_press',
              10_000,
            )),
          };
        }
        case 'ui.set_input':
          return sanitizeFillResult(
            await replaceNativeInput({
              client,
              selection,
              session: options.session,
              node,
              platform: options.platform,
              commandRunner: gestureCommandRunner,
              tool: gestureTool,
              device: gestureDevice,
            }),
          );
        case 'ui.scroll': {
          const result = await client.interactions.scroll({
            ...selection,
            session: options.session,
            direction: scrollDirection(node),
            amount: positiveNumber(node.amount),
            pixels: positiveNumber(node.pixels),
            durationMs: positiveNumber(node.duration_ms),
            responseLevel: 'digest',
          });
          if (node.settle === false) return result;
          return {
            ...(result as Record<string, unknown>),
            ...(await awaitNativeStability(
              client,
              options.session,
              selection,
              'ui.scroll',
              positiveNumber(node.timeout_ms) ?? 10_000,
            )),
          };
        }
        case 'ui.swipe':
        case 'ui.pan':
        case 'ui.drag':
        case 'ui.long_press':
          return executeNativeGesture(
            client,
            options.session,
            selection,
            action,
            node,
            gestureCommandRunner,
            await gestureTool(),
            await gestureDevice(),
          );
        case 'ui.wait_for': {
          const startedAt = Date.now();
          const result = await waitForNode(client, options.session, selection, node);
          if (node.settle === false) return result;
          // timeout_ms budgets the whole node: stability only gets what the wait left over.
          return {
            ...(result as Record<string, unknown>),
            ...(await awaitNativeStability(
              client,
              options.session,
              selection,
              'ui.wait_for',
              Math.max(1, (positiveNumber(node.timeout_ms) ?? 10_000) - (Date.now() - startedAt)),
            )),
          };
        }
        case 'ui.screenshot':
          return captureScreenshot(client, options.session, node, context);
        case 'ui.capture_surface':
          return captureSurface(client, options.session, selection, node, context);
        default:
          throw new Error(`${action} is not supported by the Agent Device UI transport.`);
      }
    },
    async observe(refs): Promise<RecipeObservationResult> {
      const client = await ensureOpen();
      const snapshot = await client.capture.snapshot({
        ...selection,
        session: options.session,
        interactiveOnly: true,
        forceFull: true,
      });
      return observationsFromSnapshot(refs, snapshot);
    },
    async close() {
      if (!opened) return;
      const client = await resolveClient();
      await client.sessions.close({ session: options.session, shutdown: false });
      opened = false;
    },
  };
}

function nativeKeyboardAction(value: unknown): 'dismiss' | 'enter' {
  const key = requiredString(value, 'ui.key_press.key').toLowerCase();
  if (key === 'back' || key === 'escape') return 'dismiss';
  if (key === 'enter' || key === 'return') return 'enter';
  throw new Error(
    `ui.key_press key ${JSON.stringify(value)} is not supported by the native device transport. Next: use Back, Escape, Enter, or Return`,
  );
}

async function replaceNativeInput({
  client,
  selection,
  session,
  node,
  platform,
  commandRunner,
  tool,
  device,
}: {
  client: AgentDeviceClient;
  selection: AgentDeviceSelection;
  session: string;
  node: Record<string, unknown>;
  platform: 'ios' | 'android';
  commandRunner: NativeGestureCommandRunner;
  tool: () => Promise<string>;
  device: () => Promise<string>;
}): Promise<unknown> {
  const text = requiredString(node.value ?? node.text, 'ui.set_input.value');
  const selector = selectorFromNode(node, 'ui.set_input');
  const fill = () =>
    client.interactions.fill({
      ...selection,
      session,
      selector,
      text,
      settle: node.settle !== false,
      verify: true,
      responseLevel: 'digest',
      timeoutMs: positiveNumber(node.timeout_ms) ?? 10_000,
    });
  const testId = optionalString(node.test_id ?? node.testID);
  const before =
    platform === 'android' && testId
      ? await nativeInputValue(client, selection, session, testId)
      : undefined;
  let result = await fill();
  if (platform !== 'android' || !testId) {
    return requireSettledInteraction('ui.set_input', result, node.settle !== false);
  }
  let observed = await nativeInputValue(client, selection, session, testId);
  if (
    !observed.verifiable ||
    observed.value === text ||
    (observed.masked &&
      before?.verifiable &&
      before.value.length === 0 &&
      observed.value.length === text.length)
  ) {
    return requireSettledInteraction('ui.set_input', result, node.settle !== false);
  }
  await client.interactions.press({
    ...selection,
    session,
    selector,
    settle: false,
    verify: false,
    responseLevel: 'digest',
    timeoutMs: positiveNumber(node.timeout_ms) ?? 10_000,
  });
  const adb = await tool();
  const serial = await device();
  await commandRunner.execFile(adb, ['-s', serial, 'shell', 'input', 'keyevent', '123'], {
    timeoutMs: 10_000,
  });
  if (observed.value.length > 0) {
    await commandRunner.execFile(
      adb,
      ['-s', serial, 'shell', 'input', 'keyevent', ...Array.from(observed.value, () => '67')],
      { timeoutMs: 10_000 },
    );
  }
  const cleared = await nativeInputValue(client, selection, session, testId);
  if (cleared.verifiable && cleared.value.length !== 0) {
    throw new Error('ui.set_input could not clear the Android field before replacement.');
  }
  result = await fill();
  observed = await nativeInputValue(client, selection, session, testId);
  if (
    observed.verifiable &&
    (observed.masked ? observed.value.length !== text.length : observed.value !== text)
  ) {
    throw new Error(
      `ui.set_input could not replace the Android field; expected ${Array.from(text).length} characters and observed ${Array.from(observed.value).length}.`,
    );
  }
  return requireSettledInteraction('ui.set_input', result, node.settle !== false);
}

async function nativeInputValue(
  client: AgentDeviceClient,
  selection: AgentDeviceSelection,
  session: string,
  testId: string,
): Promise<{ value: string; verifiable: boolean; masked: boolean }> {
  const snapshot = await client.capture.snapshot({
    ...selection,
    session,
    interactiveOnly: false,
    forceFull: true,
  });
  const target = snapshot.nodes.find((candidate) => candidate.identifier === testId);
  const value = target?.value;
  if (typeof value !== 'string') {
    return { value: '', verifiable: false, masked: false };
  }
  return {
    value,
    verifiable: true,
    masked:
      value.length > 0 &&
      Array.from(value).every(
        (character) => character === '\u2022' || character === '*' || character === '\u25cf',
      ),
  };
}

async function executeNativeGesture(
  client: AgentDeviceClient,
  session: string,
  selection: AgentDeviceSelection,
  action: GestureAction,
  node: Record<string, unknown>,
  commandRunner: NativeGestureCommandRunner,
  gestureTool: string,
  gestureDevice: string,
): Promise<UiTransportResult> {
  const start = await resolveNativeGesturePoint(
    client,
    session,
    selection,
    gestureTarget(node, action),
  );
  const durationMs = gestureDurationMs(node, action);
  const points = gesturePoints(action, node, start).map(roundPoint);
  if ((action === 'ui.pan' || action === 'ui.drag') && points.length > 2) {
    throw new Error(
      `${selection.platform} ${action} cannot stream a multi-point path. Next: use one path point or delta.`,
    );
  }
  const segmentDurationMs = gestureSegmentDuration(durationMs, points);
  const phases: RecipeActionPhase[] = [];
  const gestureSelection = { platform: selection.platform, device: gestureDevice };
  let segments = 0;
  const startedAtMs = Date.now();
  phases.push(gesturePhase('start', start, startedAtMs));

  if (action === 'ui.long_press') {
    await runNativeLongPress(commandRunner, gestureTool, gestureSelection, start, durationMs);
    segments = 1;
    phases.push(gesturePhase('move', start, startedAtMs));
  } else {
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]!;
      const to = points[index]!;
      await runNativeSwipe(
        commandRunner,
        gestureTool,
        gestureSelection,
        from,
        to,
        segmentDurationMs,
      );
      segments += 1;
      phases.push(gesturePhase('move', to, startedAtMs));
    }
  }

  const end = points.at(-1)!;
  phases.push(gesturePhase('end', end, startedAtMs));
  const stability =
    node.settle === false
      ? undefined
      : await awaitNativeStability(
          client,
          session,
          selection,
          action,
          positiveNumber(node.timeout_ms) ?? 10_000,
        );
  return {
    kind: 'ui-transport-result',
    output: {
      action,
      resolvedStart: start,
      resolvedEnd: end,
      backend: selection.platform === 'ios' ? 'idb-ui' : 'adb-input-swipe',
      segments,
      ...stability,
    },
    phases,
  };
}

async function resolveNativeGesturePoint(
  client: AgentDeviceClient,
  session: string,
  selection: AgentDeviceSelection,
  target: string | UiPoint,
): Promise<UiPoint> {
  if (typeof target !== 'string') return roundPoint(target);
  const snapshot = await client.capture.snapshot({
    ...selection,
    session,
    interactiveOnly: false,
    forceFull: true,
  });
  const match = snapshot.nodes.find((node) => node.identifier === target);
  if (!match?.rect) throw new Error(`Gesture target not found or has no coordinates: ${target}`);
  return roundPoint({
    x: match.rect.x + match.rect.width / 2,
    y: match.rect.y + match.rect.height / 2,
  });
}

async function runNativeSwipe(
  runner: NativeGestureCommandRunner,
  tool: string,
  selection: { platform: 'ios' | 'android'; device: string },
  from: UiPoint,
  to: UiPoint,
  durationMs: number,
): Promise<void> {
  if (selection.platform === 'ios') {
    await runner.execFile(
      tool,
      [
        'ui',
        'swipe',
        String(from.x),
        String(from.y),
        String(to.x),
        String(to.y),
        '--duration',
        String(durationMs / 1000),
        '--udid',
        selection.device,
      ],
      { timeoutMs: durationMs + 10_000 },
    );
    return;
  }
  await runner.execFile(
    tool,
    [
      '-s',
      selection.device,
      'shell',
      'input',
      'swipe',
      String(from.x),
      String(from.y),
      String(to.x),
      String(to.y),
      String(durationMs),
    ],
    { timeoutMs: durationMs + 10_000 },
  );
}

async function runNativeLongPress(
  runner: NativeGestureCommandRunner,
  tool: string,
  selection: { platform: 'ios' | 'android'; device: string },
  point: UiPoint,
  durationMs: number,
): Promise<void> {
  if (selection.platform === 'ios') {
    await runner.execFile(
      tool,
      [
        'ui',
        'tap',
        String(point.x),
        String(point.y),
        '--duration',
        String(durationMs / 1000),
        '--udid',
        selection.device,
      ],
      { timeoutMs: durationMs + 10_000 },
    );
    return;
  }
  await runNativeSwipe(runner, tool, selection, point, point, durationMs);
}

async function resolveGestureTool(
  command: 'idb' | 'adb',
  configuredPath: string | undefined,
  runner: NativeGestureCommandRunner,
): Promise<string> {
  const candidate = configuredPath?.trim() || command;
  if (path.isAbsolute(candidate)) return candidate;
  const result = await runner.execFile('/usr/bin/which', [candidate], { timeoutMs: 5_000 });
  const resolved = result.stdout?.trim();
  if (!resolved || !path.isAbsolute(resolved)) {
    throw new Error(
      `Native gesture execution requires ${command}. Next: install ${command} and ensure it is on PATH.`,
    );
  }
  return resolved;
}

async function resolveIosGestureDevice(
  device: string,
  idbPath: string,
  runner: NativeGestureCommandRunner,
): Promise<string> {
  if (isIosUdid(device)) return device;
  const result = await runner.execFile(idbPath, ['list-targets', '--json'], { timeoutMs: 10_000 });
  const matches = (result.stdout ?? '')
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const target = JSON.parse(line) as { name?: unknown; udid?: unknown; state?: unknown };
        return target.name === device && typeof target.udid === 'string' ? [target] : [];
      } catch {
        // idb may mix diagnostic lines into its newline-delimited JSON output.
        return [];
      }
    });
  const match = matches.find(({ state }) => state === 'Booted') ?? matches[0];
  if (!match || typeof match.udid !== 'string') {
    throw new Error(
      `Native iOS gestures could not resolve simulator ${device}. Next: run idb list-targets and use a listed simulator name or UDID.`,
    );
  }
  return match.udid;
}

function agentDeviceSelection(platform: 'ios' | 'android', device: string): AgentDeviceSelection {
  if (platform === 'android') return { platform, target: 'mobile', serial: device };
  if (isIosUdid(device)) return { platform, target: 'mobile', udid: device };
  return { platform, target: 'mobile', device };
}

function isIosUdid(value: string): boolean {
  return /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/iu.test(value);
}

function defaultGestureCommandRunner(): NativeGestureCommandRunner {
  return {
    async execFile(file, args, options) {
      try {
        return await execFileAsync(file, args, {
          encoding: 'utf8',
          timeout: options?.timeoutMs,
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const output = error as Error & { stdout?: string; stderr?: string };
        const detail = [output.message, output.stderr, output.stdout].filter(Boolean).join('\n');
        throw new Error(`${file} ${args.join(' ')} failed: ${detail}`);
      }
    },
  };
}

function roundPoint(point: UiPoint): UiPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

export function assertAgentDeviceNodeVersion(version: string): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 12)) return;
  throw new Error(
    `Native Agent Device recipe actions require Node >=22.12; current runtime is ${version}. Non-native @farmslot/expo-recipe usage supports Node >=20.10.`,
  );
}

async function awaitNativeStability(
  client: AgentDeviceClient,
  session: string,
  selection: AgentDeviceSelection,
  action: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  try {
    const stability = await client.command.wait({
      ...selection,
      session,
      stable: true,
      quietMs: 300,
      timeoutMs,
    });
    return { stability };
  } catch (error) {
    // The action itself already succeeded; unconfirmed settlement surfaces as a
    // visible warning instead of failing the node, matching the CDP transport.
    return {
      settlementWarning: `${action} did not reach a settled native UI state: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function requireSettledInteraction(
  action: string,
  result: unknown,
  settleRequired: boolean,
): unknown {
  const record = result as {
    settle?: { settled?: boolean; hint?: string };
    evidence?: { changedFromBefore?: boolean };
    targetHittable?: boolean;
  };
  let outcome = result as Record<string, unknown>;
  if (settleRequired && record.settle?.settled !== true) {
    // Match the CDP transport contract: a successful action with unconfirmed
    // settlement passes and surfaces a visible settlement warning instead of failing.
    outcome = {
      ...outcome,
      settlementWarning: `${action} did not reach a settled native UI state${record.settle?.hint ? `: ${record.settle.hint}` : '.'}`,
    };
  }
  if (record.targetHittable === false && record.evidence?.changedFromBefore === false) {
    outcome = {
      ...outcome,
      warning: `${action} settled after resolving a non-hittable target with no accessibility-tree change; verify the passive observation.`,
    };
  }
  return outcome;
}

function sanitizeFillResult(result: unknown): Record<string, unknown> {
  const record = result as {
    targetKind?: unknown;
    selector?: unknown;
    targetHittable?: unknown;
    evidence?: unknown;
    settle?: {
      settled?: unknown;
      waitedMs?: unknown;
      captures?: unknown;
      quietMs?: unknown;
      timeoutMs?: unknown;
      diff?: { summary?: unknown; truncated?: unknown };
    };
    warning?: unknown;
    settlementWarning?: unknown;
  };
  return {
    redacted: true,
    message: 'Filled input',
    targetKind: record.targetKind,
    selector: record.selector,
    targetHittable: record.targetHittable,
    evidence: record.evidence,
    settle: record.settle
      ? {
          settled: record.settle.settled,
          waitedMs: record.settle.waitedMs,
          captures: record.settle.captures,
          quietMs: record.settle.quietMs,
          timeoutMs: record.settle.timeoutMs,
          diff: record.settle.diff
            ? {
                summary: record.settle.diff.summary,
                truncated: record.settle.diff.truncated,
              }
            : undefined,
        }
      : undefined,
    warning: record.warning,
    settlementWarning: record.settlementWarning,
  };
}

async function waitForNode(
  client: AgentDeviceClient,
  session: string,
  selection: AgentDeviceSelection,
  node: Record<string, unknown>,
): Promise<unknown> {
  const timeoutMs = positiveNumber(node.timeout_ms) ?? 10_000;
  const expected = node.hidden === true ? 'hidden' : (optionalString(node.expected) ?? 'present');
  const deadline = Date.now() + timeoutMs;
  let nodeCount = 0;
  do {
    const snapshot = await client.capture.snapshot({
      ...selection,
      session,
      interactiveOnly: false,
      forceFull: true,
    });
    nodeCount = snapshot.nodes.length;
    const present = snapshotMatches(snapshot.nodes, node);
    const visible = snapshotMatches(snapshot.nodes.filter(isVisibleNode), node);
    const matched =
      expected === 'absent' || expected === 'not_present'
        ? !present
        : expected === 'hidden'
          ? !visible
          : expected === 'visible'
            ? visible
            : present;
    if (matched) {
      return { matched: true, expected };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  throw new Error(`ui.wait_for timed out after ${timeoutMs}ms (${nodeCount} nodes observed).`);
}

async function captureScreenshot(
  client: AgentDeviceClient,
  session: string,
  node: Record<string, unknown>,
  context: ActionExecutionContext,
): Promise<UiTransportResult> {
  const relativePath = optionalString(node.path) ?? `screenshots/${context.nodeId}.png`;
  const normalizedPath = relativePath.split(path.sep).join('/');
  const outputPath = context.resolveArtifactPath(normalizedPath);
  const result = await client.capture.screenshot({ session, path: outputPath, stabilize: true });
  const artifact = {
    path: normalizedPath,
    type: 'screenshot' as const,
    nodeId: context.nodeId,
    mimeType: 'image/png',
    label: optionalString(node.label) ?? 'UI screenshot',
  };
  context.registerArtifact(artifact);
  return {
    kind: 'ui-transport-result',
    output: { captured: true, path: normalizedPath, width: result.width, height: result.height },
    control: { artifacts: [artifact] },
  };
}

async function captureSurface(
  client: AgentDeviceClient,
  session: string,
  selection: AgentDeviceSelection,
  node: Record<string, unknown>,
  context: ActionExecutionContext,
): Promise<UiTransportResult> {
  const relativePath = optionalString(node.path) ?? `screenshots/${context.nodeId}.png`;
  const normalizedPath = relativePath.split(path.sep).join('/');
  const outputPath = context.resolveArtifactPath(normalizedPath);
  const surfaceTestId = optionalString(node.surface_test_id ?? node.surfaceTestId);
  const untilTestId = optionalString(node.until_test_id ?? node.untilTestId);
  const maxScrolls = boundedPositiveInteger(node.max_scrolls ?? node.maxScrolls, 12, 60);
  const restorePosition = node.restore_position !== false && node.restorePosition !== false;
  const temporaryDir = context.resolveArtifactPath(
    `.capture-surface/${context.nodeId.replaceAll(/[^a-zA-Z0-9._-]/gu, '-')}`,
  );
  const pages: Array<{ path: string; surface: PixelRect; revealedRows?: number }> = [];
  let reachedEnd = false;
  let surfaceRect: SurfaceRect | undefined;
  let surfaceResolved = false;
  let failure: { error: unknown } | undefined;
  let captureResult: UiTransportResult | undefined;
  let captureArtifact: Parameters<ActionExecutionContext['registerArtifact']>[0] | undefined;

  await mkdir(temporaryDir, { recursive: true });
  try {
    surfaceRect = await resolveSurfaceRect(client, session, selection, surfaceTestId);
    surfaceResolved = true;
    await resetSurfaceToTop(client, session, selection, surfaceRect, maxScrolls);

    const firstPath = path.join(temporaryDir, 'page-00.png');
    const firstScreenshot = await client.capture.screenshot({
      session,
      path: firstPath,
      stabilize: true,
    });
    const firstImage = PNG.sync.read(await readFile(firstPath));
    pages.push({
      path: firstPath,
      surface: physicalRectForSurface(surfaceRect, firstScreenshot, firstImage, selection.platform),
    });
    reachedEnd = await surfaceEndIsVisible(client, session, selection, surfaceTestId, untilTestId);

    let captureAttempt = 0;
    let movedScrolls = 0;
    let consecutiveDroppedMoves = 0;
    while (movedScrolls < maxScrolls && !reachedEnd) {
      captureAttempt += 1;
      const requestedPoints = await moveSurface(
        client,
        session,
        selection,
        surfaceRect,
        'toward-bottom',
      );
      const pagePath = path.join(
        temporaryDir,
        `page-${String(captureAttempt).padStart(2, '0')}.png`,
      );
      const screenshot = await client.capture.screenshot({
        session,
        path: pagePath,
        stabilize: true,
      });
      const previous = PNG.sync.read(await readFile(pages.at(-1)!.path));
      const current = PNG.sync.read(await readFile(pagePath));
      const currentSurface = physicalRectForSurface(
        surfaceRect,
        screenshot,
        current,
        selection.platform,
      );
      const requestedRows = Math.round(
        requestedPoints * (currentSurface.height / surfaceRect.height),
      );
      const revealedRows = measureRevealedRows(
        previous,
        current,
        pages.at(-1)!.surface,
        currentSurface,
        requestedRows,
      );
      if (revealedRows === 0) {
        reachedEnd =
          untilTestId === undefined ||
          (await surfaceEndIsVisible(client, session, selection, surfaceTestId, untilTestId, true));
        if (!reachedEnd) {
          consecutiveDroppedMoves += 1;
          if (consecutiveDroppedMoves <= 2) continue;
          throw new Error(
            `ui.capture_surface stopped moving before reaching until_test_id=${untilTestId}.`,
          );
        }
        break;
      }
      movedScrolls += 1;
      consecutiveDroppedMoves = 0;
      pages.push({
        path: pagePath,
        surface: currentSurface,
        revealedRows,
      });
      reachedEnd = await surfaceEndIsVisible(
        client,
        session,
        selection,
        surfaceTestId,
        untilTestId,
      );
    }

    if (!reachedEnd) {
      throw new Error(
        `ui.capture_surface did not reach the end within ${maxScrolls} scrolls. Increase max_scrolls or provide an earlier until_test_id.`,
      );
    }

    const stitched = await stitchSurfacePages(pages);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, PNG.sync.write(stitched));
    const artifact = {
      path: normalizedPath,
      type: 'screenshot' as const,
      nodeId: context.nodeId,
      mimeType: 'image/png',
      label: optionalString(node.label) ?? 'Full UI surface',
    };
    captureArtifact = artifact;
    captureResult = {
      kind: 'ui-transport-result',
      output: {
        captured: true,
        extent: 'full',
        path: normalizedPath,
        width: stitched.width,
        height: stitched.height,
        viewports: pages.length,
      },
      control: { artifacts: [artifact] },
    };
  } catch (error) {
    failure = { error };
  } finally {
    try {
      if (restorePosition && surfaceResolved) {
        await resetSurfaceToTop(client, session, selection, surfaceRect!, maxScrolls);
      }
    } catch (restoreError) {
      failure ??= { error: restoreError };
    } finally {
      await rm(temporaryDir, { recursive: true, force: true });
    }
  }
  if (failure) throw failure.error;
  if (!captureResult || !captureArtifact) {
    throw new Error('ui.capture_surface produced no result.');
  }
  context.registerArtifact(captureArtifact);
  return captureResult;
}

type SurfaceRect = { x: number; y: number; width: number; height: number };
type PixelRect = { x: number; y: number; width: number; height: number };

async function resolveSurfaceRect(
  client: AgentDeviceClient,
  session: string,
  selection: AgentDeviceSelection,
  surfaceTestId: string | undefined,
): Promise<SurfaceRect> {
  const snapshot = await client.capture.snapshot({
    ...selection,
    session,
    interactiveOnly: false,
    forceFull: true,
  });
  const requestedSurface = surfaceTestId
    ? snapshot.nodes.find((candidate) => candidate.identifier === surfaceTestId)
    : undefined;
  if (surfaceTestId && !requestedSurface?.rect) {
    throw new Error(`ui.capture_surface could not resolve surface_test_id=${surfaceTestId}.`);
  }
  const scrollSurface =
    requestedSurface?.type === 'ScrollView'
      ? requestedSurface
      : snapshot.nodes
          .filter(
            (candidate) =>
              candidate.type === 'ScrollView' &&
              candidate.rect !== undefined &&
              (!requestedSurface?.rect || rectsIntersect(candidate.rect, requestedSurface.rect)),
          )
          .sort(
            (left, right) =>
              right.rect!.width * right.rect!.height - left.rect!.width * left.rect!.height,
          )[0];
  const surface =
    scrollSurface ??
    requestedSurface ??
    snapshot.nodes
      .filter((candidate) => /Application|Window/u.test(candidate.type ?? '') && candidate.rect)
      .sort(
        (left, right) =>
          right.rect!.width * right.rect!.height - left.rect!.width * left.rect!.height,
      )[0];
  if (!surface?.rect || surface.rect.width <= 0 || surface.rect.height <= 0) {
    throw new Error(
      surfaceTestId
        ? `ui.capture_surface could not resolve surface_test_id=${surfaceTestId}.`
        : 'ui.capture_surface could not resolve the native viewport.',
    );
  }
  return surface.rect;
}

async function resetSurfaceToTop(
  client: AgentDeviceClient,
  session: string,
  selection: AgentDeviceSelection,
  surfaceRect: SurfaceRect,
  maxScrolls: number,
): Promise<void> {
  for (let index = 0; index <= maxScrolls; index += 1) {
    const snapshot = await client.capture.snapshot({
      ...selection,
      session,
      interactiveOnly: false,
      forceFull: true,
    });
    const hasHiddenContentAbove = snapshot.nodes.some(
      (candidate) =>
        candidate.hiddenContentAbove === true &&
        candidate.rect !== undefined &&
        rectsIntersect(candidate.rect, surfaceRect),
    );
    if (!hasHiddenContentAbove) return;
    if (index === maxScrolls) {
      throw new Error(
        `ui.capture_surface could not reset to the top within ${maxScrolls} scrolls.`,
      );
    }
    await moveSurface(client, session, selection, surfaceRect, 'toward-top');
    await awaitNativeStability(client, session, selection, 'ui.capture_surface', 10_000);
  }
}

async function moveSurface(
  client: AgentDeviceClient,
  session: string,
  selection: AgentDeviceSelection,
  surfaceRect: SurfaceRect,
  direction: 'toward-top' | 'toward-bottom',
): Promise<number> {
  const upperY = surfaceRect.y + surfaceRect.height * 0.2;
  const lowerY = surfaceRect.y + surfaceRect.height * 0.8;
  const pixels = Math.max(1, Math.round(lowerY - upperY));
  // Stay near the edge to avoid nested scroll views, but outside iOS's
  // system back-gesture zone where a vertical swipe can be dropped.
  const x = surfaceRect.x + Math.min(32, surfaceRect.width * 0.1);
  if (direction === 'toward-bottom') {
    await client.interactions.swipe({
      ...selection,
      session,
      from: { x, y: lowerY },
      to: { x, y: upperY },
      durationMs: 250,
      responseLevel: 'digest',
    });
    return pixels;
  }
  await client.interactions.swipe({
    ...selection,
    session,
    from: { x, y: upperY },
    to: { x, y: lowerY },
    durationMs: 250,
    responseLevel: 'digest',
  });
  return pixels;
}

async function surfaceEndIsVisible(
  client: AgentDeviceClient,
  session: string,
  selection: AgentDeviceSelection,
  surfaceTestId: string | undefined,
  untilTestId: string | undefined,
  stoppedMoving = false,
): Promise<boolean> {
  if (!untilTestId) return false;
  const snapshot = await client.capture.snapshot({
    ...selection,
    session,
    interactiveOnly: false,
    forceFull: true,
  });
  const viewport = snapshot.nodes
    .filter((candidate) => /Application|Window/u.test(candidate.type ?? '') && candidate.rect)
    .map((candidate) => candidate.rect!)
    .sort((left, right) => right.width * right.height - left.width * left.height)[0];
  const surface = surfaceTestId
    ? snapshot.nodes.find((candidate) => candidate.identifier === surfaceTestId)
    : undefined;
  const hasHiddenContentBelow = surface
    ? surface.hiddenContentBelow === true
    : snapshot.nodes.some(
        (candidate) =>
          candidate.hiddenContentBelow === true &&
          (!viewport || !candidate.rect || rectsIntersect(candidate.rect, viewport)),
      );
  if (hasHiddenContentBelow && !stoppedMoving) return false;
  return snapshot.nodes.some((candidate) => {
    if (candidate.identifier !== untilTestId || !candidate.rect || !isVisibleNode(candidate)) {
      return false;
    }
    return viewport ? rectsIntersect(candidate.rect, viewport) : true;
  });
}

function physicalRectForSurface(
  surface: SurfaceRect,
  screenshot: {
    logicalWidth?: number;
    logicalHeight?: number;
    pixelDensity?: number;
  },
  image: PNG,
  platform: 'ios' | 'android',
): PixelRect {
  const logicalWidth = positiveNumber(screenshot.logicalWidth);
  const logicalHeight = positiveNumber(screenshot.logicalHeight);
  const density = positiveNumber(screenshot.pixelDensity);
  const scaleX = logicalWidth
    ? image.width / logicalWidth
    : (density ??
      (logicalHeight ? image.height / logicalHeight : platform === 'android' ? 1 : undefined));
  const scaleY = logicalHeight
    ? image.height / logicalHeight
    : (density ??
      (logicalWidth ? image.width / logicalWidth : platform === 'android' ? 1 : undefined));
  if (!scaleX || !scaleY) {
    throw new Error(
      'ui.capture_surface requires screenshot logical dimensions or pixel density to map the native surface.',
    );
  }
  const x = Math.max(0, Math.round(surface.x * scaleX));
  const y = Math.max(0, Math.round(surface.y * scaleY));
  const right = Math.min(image.width, Math.round((surface.x + surface.width) * scaleX));
  const bottom = Math.min(image.height, Math.round((surface.y + surface.height) * scaleY));
  if (right <= x || bottom <= y) {
    throw new Error('ui.capture_surface resolved outside the captured screenshot.');
  }
  return { x, y, width: right - x, height: bottom - y };
}

function rectsIntersect(left: SurfaceRect, right: SurfaceRect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

async function stitchSurfacePages(
  pages: Array<{ path: string; surface: PixelRect; revealedRows?: number }>,
): Promise<PNG> {
  const firstPage = pages[0];
  if (!firstPage) throw new Error('ui.capture_surface did not capture a viewport.');
  const first = PNG.sync.read(await readFile(firstPage.path));
  if (
    pages.some(
      (page) =>
        page.surface.width !== firstPage.surface.width ||
        page.surface.height !== firstPage.surface.height,
    )
  ) {
    throw new Error('ui.capture_surface viewport or surface dimensions changed during capture.');
  }
  const revealed = pages.slice(1).map((page) => page.revealedRows!);
  const firstSurface = firstPage.surface;
  const lastSurface = pages.at(-1)!.surface;
  const isFullWidth = pages.every(
    (page) => page.surface.x === 0 && page.surface.width === first.width,
  );
  const leadingRows = isFullWidth ? firstSurface.y : 0;
  const trailingRows = isFullWidth ? first.height - (lastSurface.y + lastSurface.height) : 0;
  const output = new PNG({
    width: isFullWidth ? first.width : firstSurface.width,
    height:
      leadingRows +
      revealed.reduce((sum, pixels) => sum + pixels, 0) +
      lastSurface.height +
      trailingRows,
  });
  if (leadingRows > 0) copyImageRows(first, output, 0, 0, leadingRows, 0);
  let outputY = leadingRows;
  let sourceStart = 0;
  let image = first;
  for (let index = 0; index < pages.length; index += 1) {
    const surface = pages[index].surface;
    const nextPage = pages[index + 1];
    const nextImage = nextPage ? PNG.sync.read(await readFile(nextPage.path)) : undefined;
    if (nextImage && (nextImage.width !== first.width || nextImage.height !== first.height)) {
      throw new Error('ui.capture_surface viewport or surface dimensions changed during capture.');
    }
    const sourceEnd =
      nextImage && nextPage
        ? chooseSurfaceSeam(image, nextImage, surface, nextPage.surface, revealed[index])
        : surface.height;
    const rows = sourceEnd - sourceStart;
    copyImageRows(
      image,
      output,
      isFullWidth ? 0 : surface.x,
      surface.y + sourceStart,
      rows,
      outputY,
    );
    outputY += rows;
    if (nextImage) {
      sourceStart = sourceEnd - revealed[index];
      image = nextImage;
    }
  }
  if (trailingRows > 0) {
    copyImageRows(image, output, 0, lastSurface.y + lastSurface.height, trailingRows, outputY);
  }
  return output;
}

function chooseSurfaceSeam(
  current: PNG,
  next: PNG,
  currentSurface: PixelRect,
  nextSurface: PixelRect,
  revealedRows: number,
): number {
  const minimum = Math.min(currentSurface.height - 2, revealedRows + 2);
  const maximum = currentSurface.height - 2;
  let bestRow = revealedRows;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let currentRow = minimum; currentRow <= maximum; currentRow += 1) {
    const nextRow = currentRow - revealedRows;
    const score = sampledSeamDifference(
      current,
      next,
      currentSurface,
      nextSurface,
      currentRow,
      nextRow,
    );
    if (score < bestScore) {
      bestScore = score;
      bestRow = currentRow;
    }
  }
  return bestRow;
}

function sampledSeamDifference(
  current: PNG,
  next: PNG,
  currentSurface: PixelRect,
  nextSurface: PixelRect,
  currentRow: number,
  nextRow: number,
): number {
  const sampleLeft = Math.max(1, Math.floor(currentSurface.width * 0.05));
  const sampleRight = Math.max(sampleLeft + 1, Math.floor(currentSurface.width * 0.8));
  let difference = 0;
  let samples = 0;
  for (let x = sampleLeft; x < sampleRight; x += 3) {
    for (const channel of [0, 1, 2]) {
      const currentOffset =
        ((currentSurface.y + currentRow) * current.width + currentSurface.x + x) * 4 + channel;
      const nextOffset = ((nextSurface.y + nextRow) * next.width + nextSurface.x + x) * 4 + channel;
      const currentAbove = currentOffset - current.width * 4;
      const currentBelow = currentOffset + current.width * 4;
      const nextAbove = nextOffset - next.width * 4;
      const nextBelow = nextOffset + next.width * 4;
      difference += Math.abs(current.data[currentOffset] - next.data[nextOffset]) * 2;
      difference += Math.abs(current.data[currentAbove] - current.data[currentBelow]);
      difference += Math.abs(next.data[nextAbove] - next.data[nextBelow]);
      samples += 4;
    }
  }
  return samples > 0 ? difference / samples : Number.POSITIVE_INFINITY;
}

function copyImageRows(
  source: PNG,
  destination: PNG,
  sourceX: number,
  sourceY: number,
  rows: number,
  destinationY: number,
): void {
  for (let row = 0; row < rows; row += 1) {
    const sourceStart = ((sourceY + row) * source.width + sourceX) * 4;
    const sourceEnd = sourceStart + destination.width * 4;
    source.data.copy(
      destination.data,
      (destinationY + row) * destination.width * 4,
      sourceStart,
      sourceEnd,
    );
  }
}

function measureRevealedRows(
  previous: PNG,
  current: PNG,
  previousSurface: PixelRect,
  currentSurface: PixelRect,
  requestedRows: number,
): number {
  const height = previousSurface.height;
  const minimumOverlap = Math.max(4, Math.floor(height * 0.12));
  const stationaryDifference = sampledSurfaceDifference(
    previous,
    current,
    previousSurface,
    currentSurface,
    0,
    false,
  );
  if (stationaryDifference < 10) return 0;
  let bestDelta = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestDifference = Number.POSITIVE_INFINITY;
  for (let delta = 1; delta <= height - minimumOverlap; delta += 1) {
    const meanDifference = sampledSurfaceDifference(
      previous,
      current,
      previousSurface,
      currentSurface,
      delta,
    );
    const distancePenalty =
      requestedRows > 0 ? (Math.abs(delta - requestedRows) / requestedRows) * 8 : 0;
    const score = meanDifference + distancePenalty;
    if (score < bestScore) {
      bestScore = score;
      bestDifference = meanDifference;
      bestDelta = delta;
    }
  }
  if (bestDelta === 0 || bestDifference > 24) {
    throw new Error(
      `ui.capture_surface could not prove screenshot overlap (best mean difference ${bestDifference.toFixed(1)}).`,
    );
  }
  return bestDelta;
}

function sampledSurfaceDifference(
  previous: PNG,
  current: PNG,
  previousSurface: PixelRect,
  currentSurface: PixelRect,
  delta: number,
  trimOutliers = true,
): number {
  const overlap = previousSurface.height - delta;
  const differences: number[] = [];
  const sampleLeft = Math.max(1, Math.floor(previousSurface.width * 0.05));
  const sampleRight = Math.max(sampleLeft + 1, Math.floor(previousSurface.width * 0.8));
  for (let y = Math.floor(overlap * 0.08); y < overlap; y += 4) {
    for (let x = sampleLeft; x < sampleRight; x += 4) {
      const previousOffset =
        ((previousSurface.y + y + delta) * previous.width + previousSurface.x + x) * 4;
      const currentOffset = ((currentSurface.y + y) * current.width + currentSurface.x + x) * 4;
      differences.push(
        (Math.abs(previous.data[previousOffset] - current.data[currentOffset]) +
          Math.abs(previous.data[previousOffset + 1] - current.data[currentOffset + 1]) +
          Math.abs(previous.data[previousOffset + 2] - current.data[currentOffset + 2])) /
          3,
      );
    }
  }
  if (differences.length === 0) return Number.POSITIVE_INFINITY;
  differences.sort((left, right) => left - right);
  const retained = trimOutliers
    ? differences.slice(0, Math.max(1, Math.ceil(differences.length * 0.8)))
    : differences;
  return retained.reduce((sum, value) => sum + value, 0) / retained.length;
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(
      `Expected a positive integer no greater than ${maximum}; got ${String(value)}.`,
    );
  }
  return parsed;
}

function observationsFromSnapshot(
  refs: readonly UiObserverRef[],
  snapshot: Awaited<ReturnType<AgentDeviceClient['capture']['snapshot']>>,
): RecipeObservationResult {
  const observations: RecipeObservationResult['observations'] = {};
  const warnings: RecipeObservationResult['warnings'] = [];
  for (const ref of refs) {
    if (ref === 'ui.screen') {
      observations[ref] = {
        provider: 'agent-device',
        name: snapshot.appName,
        app_id: snapshot.appBundleId,
      };
    } else if (ref === 'ui.visible') {
      const actionable = snapshot.nodes.filter(isActionableNode);
      const visible = actionable.filter(isVisibleNode);
      const hidden = actionable.filter((node) => !isVisibleNode(node));
      observations[ref] = {
        provider: 'agent-device',
        items: visible.slice(0, 20).map((node) => ({
          test_id: node.identifier,
          label: node.label,
          role: node.type,
        })),
        hidden_or_offscreen: hidden.slice(0, 10).map((node) => ({
          test_id: node.identifier,
          role: node.type,
          reason: node.interactionBlocked === 'covered' ? 'covered' : 'hidden_or_offscreen',
        })),
        truncated: snapshot.truncated || visible.length > 20 || hidden.length > 10,
      };
    } else {
      warnings.push({ ref, message: `Agent Device does not support UI observer ${ref}.` });
    }
  }
  return {
    ...(Object.keys(observations).length ? { observations } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

function isActionableNode(node: { type?: string; hittable?: boolean }): boolean {
  if (node.hittable) return true;
  const type = node.type?.toLowerCase() ?? '';
  return ['button', 'cell', 'link', 'switch', 'textfield', 'text-field'].some((role) =>
    type.includes(role),
  );
}

function isVisibleNode(node: { visibleToUser?: boolean; interactionBlocked?: 'covered' }): boolean {
  return node.visibleToUser !== false && node.interactionBlocked !== 'covered';
}

function snapshotMatches(
  nodes: ReadonlyArray<{ identifier?: string; label?: string; value?: unknown; type?: string }>,
  node: Record<string, unknown>,
): boolean {
  const testId = optionalString(node.test_id ?? node.testID);
  const exactText = optionalString(node.text ?? node.label);
  const contains = Array.isArray(node.text_contains)
    ? node.text_contains.filter((value): value is string => typeof value === 'string')
    : [];
  if (!testId && !exactText && contains.length === 0) {
    throw new Error('ui.wait_for requires test_id, text, label, or text_contains.');
  }
  const matchesIdentity = nodes.some((candidate) => {
    if (testId && candidate.identifier !== testId) return false;
    if (
      exactText &&
      ![candidate.label, candidate.value, candidate.identifier].some(
        (value) => typeof value === 'string' && value.includes(exactText),
      )
    ) {
      return false;
    }
    return true;
  });
  if ((testId || exactText) && !matchesIdentity) return false;
  return contains.every((text) =>
    nodes.some((candidate) =>
      [candidate.label, candidate.value, candidate.identifier]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.includes(text)),
    ),
  );
}

function selectorFromNode(node: Record<string, unknown>, action: string): string {
  const selector = optionalString(node.selector);
  if (selector) return selector;
  const testId = optionalString(node.test_id ?? node.testID);
  if (testId) return `id=${JSON.stringify(testId)}`;
  const label = optionalString(node.text ?? node.label);
  if (label) return `label=${JSON.stringify(label)}`;
  throw new Error(`${action} requires selector, test_id, text, or label.`);
}

function scrollDirection(node: Record<string, unknown>): 'up' | 'down' | 'left' | 'right' {
  const direction = optionalString(node.direction) ?? 'down';
  if (direction === 'up' || direction === 'down' || direction === 'left' || direction === 'right') {
    return direction;
  }
  throw new Error(`ui.scroll.direction must be up, down, left, or right; got ${direction}.`);
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${field} requires a non-empty string.`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
