import type { ArtifactRef, InteractiveOperatorPacketAction } from '@farmslot/protocol';
import { interactiveOperatorPacketArtifacts } from '@farmslot/protocol';

export type PacketActionRequest =
  | { kind: 'copy'; text: string }
  | { kind: 'open-artifact'; artifactPath: string }
  | { kind: 'terminal.send'; text: string }
  | { kind: 'decision.resolve'; decisionId: string; actionId: string };

function payloadString(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export function interactivePacketActionRequest(
  action: InteractiveOperatorPacketAction,
): PacketActionRequest | null {
  switch (action.kind) {
    case 'copy': {
      const text = payloadString(action.payload, 'text');
      return text ? { kind: 'copy', text } : null;
    }
    case 'open-artifact': {
      const artifactPath = payloadString(action.payload, 'artifactPath');
      return artifactPath ? { kind: 'open-artifact', artifactPath } : null;
    }
    case 'terminal.send': {
      const text = payloadString(action.payload, 'text');
      return text ? { kind: 'terminal.send', text } : null;
    }
    case 'decision.resolve': {
      const decisionId = payloadString(action.payload, 'decisionId');
      const actionId = payloadString(action.payload, 'actionId');
      return decisionId && actionId ? { kind: 'decision.resolve', decisionId, actionId } : null;
    }
  }
}

export function collectInteractivePacketArtifacts(
  artifacts: readonly ArtifactRef[],
): ArtifactRef[] {
  return interactiveOperatorPacketArtifacts(artifacts);
}
