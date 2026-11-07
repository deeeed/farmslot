import { MINIMUM_RUNTIME_VERSION, RUNTIME_VERSION } from '@farmslot/agent-runtime/version';
import {
  MINIMUM_PROTOCOL_VERSION,
  type PeerVersionDeclaration,
  PROTOCOL_VERSION,
} from '@farmslot/protocol';

/** Facts from the gateway's own selected protocol and runtime installations. */
export const gatewayPeerVersions: PeerVersionDeclaration = {
  protocolVersion: PROTOCOL_VERSION,
  minimumProtocolVersion: MINIMUM_PROTOCOL_VERSION,
  runtimeVersion: RUNTIME_VERSION,
  minimumRuntimeVersion: MINIMUM_RUNTIME_VERSION,
};
