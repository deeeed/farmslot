import path from 'node:path';

import type { UiObserverRef } from '@farmslot/protocol';
import type {
  ActionExecutionContext,
  RecipeObservationResult,
  UiActionTransport,
  UiTransportResult,
} from '@farmslot/recipe-harness';

type AgentDeviceModule = typeof import('agent-device');
type AgentDeviceClient = ReturnType<AgentDeviceModule['createAgentDeviceClient']>;

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
    clientPromise ??= import('agent-device')
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
              settle: true,
              verify: true,
              responseLevel: 'digest',
              timeoutMs: positiveNumber(node.timeout_ms) ?? 10_000,
            }),
          );
        case 'ui.set_input':
          return requireSettledInteraction(
            'ui.set_input',
            await client.interactions.fill({
              ...selection,
              session: options.session,
              selector: selectorFromNode(node, 'ui.set_input'),
              text: requiredString(node.value ?? node.text, 'ui.set_input.value'),
              settle: true,
              verify: true,
              responseLevel: 'digest',
              timeoutMs: positiveNumber(node.timeout_ms) ?? 10_000,
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
          const stability = await client.command.wait({
            ...selection,
            session: options.session,
            stable: true,
            quietMs: 300,
            timeoutMs: positiveNumber(node.timeout_ms) ?? 10_000,
          });
          return { ...result, stability };
        }
        case 'ui.wait_for':
          return waitForNode(client, options.session, selection, node);
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

function requireSettledInteraction(action: string, result: unknown): unknown {
  const record = result as {
    settle?: { settled?: boolean; hint?: string };
    evidence?: { changedFromBefore?: boolean };
    targetHittable?: boolean;
  };
  if (record.settle?.settled !== true) {
    throw new Error(
      `${action} did not reach a settled native UI state${record.settle?.hint ? `: ${record.settle.hint}` : '.'}`,
    );
  }
  if (record.targetHittable === false && record.evidence?.changedFromBefore === false) {
    return {
      ...(result as Record<string, unknown>),
      warning: `${action} settled after resolving a non-hittable target with no accessibility-tree change; verify the passive observation.`,
    };
  }
  return result;
}

async function waitForNode(
  client: AgentDeviceClient,
  session: string,
  selection: { platform: 'ios' | 'android'; target: 'mobile'; device: string },
  node: Record<string, unknown>,
): Promise<unknown> {
  const timeoutMs = positiveNumber(node.timeout_ms) ?? 10_000;
  const expectedAbsent =
    node.expected === 'absent' ||
    node.expected === 'hidden' ||
    node.expected === 'not_present' ||
    node.hidden === true;
  const deadline = Date.now() + timeoutMs;
  let nodeCount = 0;
  do {
    const snapshot = await client.capture.snapshot({
      ...selection,
      session,
      interactiveOnly: false,
    });
    nodeCount = snapshot.nodes.length;
    const matched = snapshotMatches(snapshot.nodes, node);
    if (expectedAbsent ? !matched : matched) {
      return { matched: true, expected: expectedAbsent ? 'absent' : 'present' };
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
      observations[ref] = {
        provider: 'agent-device',
        items: actionable.slice(0, 20).map((node) => ({
          test_id: node.identifier,
          label: node.label,
          role: node.type,
        })),
        hidden_or_offscreen: [],
        truncated: snapshot.truncated || actionable.length > 20,
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
      ![candidate.label, candidate.value, candidate.identifier].some((value) => value === exactText)
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
