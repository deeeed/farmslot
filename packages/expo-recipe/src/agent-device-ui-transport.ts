import path from 'node:path';

import type { UiObserverRef } from '@farmslot/protocol';
import type {
  ActionExecutionContext,
  RecipeObservationResult,
  UiActionTransport,
  UiTransportResult,
} from '@farmslot/recipe-harness';

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
  };
  command: { wait(options: Record<string, unknown>): Promise<unknown> };
  capture: {
    snapshot(options: Record<string, unknown>): Promise<AgentDeviceSnapshot>;
    screenshot(options: Record<string, unknown>): Promise<{ width?: number; height?: number }>;
  };
  sessions: { close(options: Record<string, unknown>): Promise<unknown> };
}

type AgentDeviceClient = AgentDeviceClientLike;

export const NATIVE_UI_ACTIONS = [
  'ui.press',
  'ui.set_input',
  'ui.scroll',
  'ui.wait_for',
  'ui.screenshot',
] as const;

export interface AgentDeviceUiTransportOptions {
  platform: 'ios' | 'android';
  device: string;
  app: string;
  session: string;
  stateDir?: string;
  client?: AgentDeviceClient;
}

export interface AgentDeviceUiTransport extends UiActionTransport {
  close(): Promise<void>;
}

export function createAgentDeviceUiTransport(
  options: AgentDeviceUiTransportOptions,
): AgentDeviceUiTransport {
  let clientPromise = options.client ? Promise.resolve(options.client) : undefined;
  const selection = {
    platform: options.platform,
    target: 'mobile' as const,
    device: options.device,
  };
  let opened = false;

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
        case 'ui.set_input':
          return sanitizeFillResult(
            requireSettledInteraction(
              'ui.set_input',
              await client.interactions.fill({
                ...selection,
                session: options.session,
                selector: selectorFromNode(node, 'ui.set_input'),
                text: requiredString(node.value ?? node.text, 'ui.set_input.value'),
                settle: node.settle !== false,
                verify: true,
                responseLevel: 'digest',
                timeoutMs: positiveNumber(node.timeout_ms) ?? 10_000,
              }),
              node.settle !== false,
            ),
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
  selection: { platform: 'ios' | 'android'; target: 'mobile'; device: string },
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
  selection: { platform: 'ios' | 'android'; target: 'mobile'; device: string },
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
    output: { captured: true, path: normalizedPath, width: result.width, height: result.height },
    control: { artifacts: [artifact] },
  };
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
