import type { ActionExecutionContext, UiActionTransport } from '@farmslot/recipe-harness';
import {
  createReactNativeBridgeUiTransport,
  type ReactNativeBridge,
  type ReactNativeBridgeCommand,
} from '@farmslot/recipe-harness/runtime/react-native-bridge';

export interface MetroRecipeBridgeTransportOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function resolveMetroRecipeBridgePort(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.FARMSLOT_RECIPE_METRO_PORT ?? env.METRO_PORT;
  if (!raw) {
    throw new Error(
      'Metro recipe bridge port is missing; load the checkout-local .env.ports configuration.',
    );
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid Metro port for recipe bridge transport: ${raw}`);
  }
  return port;
}

export function createMetroRecipeBridge(
  options: MetroRecipeBridgeTransportOptions = {},
): ReactNativeBridge {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? resolveMetroRecipeBridgePort();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = `http://${host}:${port}`;

  return {
    async send(
      command: ReactNativeBridgeCommand,
      context: ActionExecutionContext,
    ): Promise<unknown> {
      const nodeTimeoutMs = readPositiveTimeoutMs(command.payload.timeout_ms);
      const effectiveTimeoutMs = Math.max(timeoutMs, nodeTimeoutMs ?? 0);
      const response = await fetchImpl(`${baseUrl}/farmslot-recipe/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: command.command,
          nodeId: command.nodeId,
          payload: {
            ...command.payload,
            artifacts_dir: context.artifactsDir,
          },
          timeout_ms: effectiveTimeoutMs,
        }),
      });

      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const message =
          typeof body.error === 'string'
            ? body.error
            : `Metro recipe bridge command failed with HTTP ${response.status}.`;
        throw new Error(message);
      }
      if (body.ok === false) {
        throw new Error(
          typeof body.error === 'string'
            ? body.error
            : 'Companion recipe bridge returned ok:false.',
        );
      }
      return body;
    },
  };
}

export function createMetroRecipeBridgeUiTransport(
  options: MetroRecipeBridgeTransportOptions = {},
): UiActionTransport {
  return createReactNativeBridgeUiTransport({
    bridge: createMetroRecipeBridge(options),
  });
}

function readPositiveTimeoutMs(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return undefined;
}
