import { Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { indirectRequest } from './request-helper.js';
import { cache, gateway } from './transport.js';

declare const selectors: Record<string, unknown>;

export const read = () => cache.observe(resourceQuery(Methods.BACKLOG_LIST, {}), () => {});
export const command = () => gateway.request(Methods.RUN_CREATE, { project: 'fixture' });
export const indirectCommand = () => indirectRequest(gateway, Methods.RUN_CREATE, {});
export const explicitForce = () => gateway.request(Methods.PR_LIST, { force: true });
export const finalForce = () => gateway.request(Methods.PR_LIST, { ...selectors, force: true });
export const createReport = () =>
  gateway.request(Methods.ASSESSMENT_REPORT, { assessmentId: 'completed-fixture' });
export const omittedReportSelector = () => gateway.request(Methods.ASSESSMENT_REPORT);

// Text is not an RPC call: gateway.request(Methods.BACKLOG_LIST).
export const example = 'gateway.request("backlog.list")';
