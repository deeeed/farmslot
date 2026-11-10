import { Events, type MonitorViolation } from '@farmslot/protocol';

import { broadcast } from '../server.js';

/** Raw operator feed only: observer/recovery audit failures must never mutate this run. */
export function notifyPublicationGateStall(violation: MonitorViolation): void {
  broadcast({ type: 'event', event: Events.MONITOR_VIOLATION, payload: { violation } });
}
