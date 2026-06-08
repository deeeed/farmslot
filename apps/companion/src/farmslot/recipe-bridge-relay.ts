import Constants from 'expo-constants';
import { useEffect } from 'react';

import type { FarmslotRecipeBridgeApi } from './RecipeBridgeProvider';

const POLL_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 1_500;

export function resolveMetroRecipeRelayBaseUrl(): string | null {
  const hostUri = Constants.expoConfig?.hostUri;
  if (typeof hostUri === 'string' && hostUri.trim()) {
    return `http://${hostUri.replace(/^https?:\/\//, '')}`;
  }

  const debuggerHost = (
    Constants as {
      manifest?: { debuggerHost?: string };
      manifest2?: { extra?: { expoClient?: { hostUri?: string } } };
    }
  ).manifest?.debuggerHost;
  if (typeof debuggerHost === 'string' && debuggerHost.trim()) {
    return `http://${debuggerHost.replace(/^https?:\/\//, '')}`;
  }

  const manifestHost = (
    Constants as { manifest2?: { extra?: { expoClient?: { hostUri?: string } } } }
  ).manifest2?.extra?.expoClient?.hostUri;
  if (typeof manifestHost === 'string' && manifestHost.trim()) {
    return `http://${manifestHost.replace(/^https?:\/\//, '')}`;
  }

  return null;
}

export function useRecipeBridgeRelay(bridge: FarmslotRecipeBridgeApi, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const loop = async () => {
      while (!cancelled) {
        const baseUrl = resolveMetroRecipeRelayBaseUrl();
        if (!baseUrl) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        try {
          const pollResponse = await fetch(
            `${baseUrl}/farmslot-recipe/poll?timeout=${POLL_TIMEOUT_MS}`,
          );
          if (pollResponse.status === 204) continue;
          if (!pollResponse.ok) {
            throw new Error(`Recipe relay poll failed with HTTP ${pollResponse.status}.`);
          }

          const job = (await pollResponse.json()) as {
            id?: string;
            command?: string;
            nodeId?: string;
            payload?: Record<string, unknown>;
          };
          if (!job.id || !job.command || !job.nodeId) {
            throw new Error('Recipe relay returned an invalid command payload.');
          }

          const result = await bridge.handleCommand({
            command: job.command,
            nodeId: job.nodeId,
            payload: job.payload ?? {},
          });

          const resultResponse = await fetch(`${baseUrl}/farmslot-recipe/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: job.id, result }),
          });
          if (!resultResponse.ok) {
            throw new Error(`Recipe relay result failed with HTTP ${resultResponse.status}.`);
          }
        } catch (error) {
          // Metro may restart or the host may time out between poll cycles; retry is expected.
          console.warn(
            '[recipe-bridge] relay cycle failed:',
            error instanceof Error ? error.message : String(error),
          );
          await sleep(RETRY_DELAY_MS);
        }
      }
    };

    void loop();
    return () => {
      cancelled = true;
    };
  }, [bridge, enabled]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
