import { configuredNodeLinkEnabled } from '@farmslot/protocol/node/slot-by-repo';

import { poolDir } from '../core/config.js';

/** Routing policy survives a disconnected socket; offline pilots never silently select SSH. */
export function usesNodeLink(machine: string): boolean {
  return configuredNodeLinkEnabled(machine, poolDir);
}
