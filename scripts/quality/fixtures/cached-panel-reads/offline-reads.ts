import { Methods } from '@farmslot/protocol';

import { gateway } from './transport.js';

declare function gatewayFetch(url: string): Promise<Response>;

// ADR-071 Amendment 2: commands and listed exceptions may reach the gateway; reads may not.
export const command = () => gateway.request(Methods.RUN_CANCEL, { runId: 'fixture' });
export const stream = () => gateway.request(Methods.TERMINAL_SUBSCRIBE, { slotId: 'fixture' });
export const connection = () => gateway.request(Methods.GATEWAY_PING);
export const uncachedRead = () => gateway.request(Methods.BACKLOG_SPEC_GET, { itemId: 'fixture' });
export const artifactText = () => gatewayFetch('/api/run-artifact?path=report.md');
export const plainFetch = () => fetch('/api/run-artifact?path=report.md');
