import { Methods as Rpc } from '@farmslot/protocol';

import { indirectRequest as helper, requestRecord } from './request-helper.js';
import { gateway as peer } from './transport.js';

declare const flag: boolean;
declare const extra: Record<string, unknown>;

// A registered read is forbidden even if its UI title says Refresh.
export const direct = () => peer.request(Rpc.BACKLOG_LIST, {});
export const resourceTransport = () => peer.requestResource(Rpc.CONFIG_PROJECTS, {});
const methodAlias = Rpc.COPILOT_STATUS;
export const alias = () => peer.request(methodAlias, {});
const { PR_RULES_LIST: destructuredMethod } = Rpc;
export const methodDestructure = () => peer.request(destructuredMethod, {});
const boundRequest = peer.request.bind(peer);
export const boundTransport = () => boundRequest(Rpc.PR_PUSH_LIST, {});
const partiallyBound = peer.request.bind(peer, Rpc.CONFIG_PROJECTS);
export const preboundMethod = () => partiallyBound({});
export const calledTransport = () => peer.request.call(peer, Rpc.PR_RULES_LIST, {});
export const appliedTransport = () => peer.request.apply(peer, [Rpc.PR_PUSH_LIST, {}]);
const { request: send } = peer;
export const transportDestructure = () => send(Rpc.RUN_GET, { runId: 'fixture' });
export const helperRead = () => helper(peer, Rpc.PR_LIST, {});
export const destructuredHelper = () =>
  requestRecord(peer, { method: Rpc.COPILOT_STATUS, params: {} });
const requestKey = 'request';
export const indexedTransport = () => peer[requestKey](Rpc.BACKLOG_LIST, {});
export const falseForce = () => peer.request(Rpc.PR_LIST, { force: false });
export const uncertainForce = () => peer.request(Rpc.PR_LIST, { force: flag });
export const unrelatedForce = () => peer.request(Rpc.RUN_GET, { runId: 'fixture', force: true });
export const overwrittenForce = () => peer.request(Rpc.PR_LIST, { force: true, ...extra });
export const reportRead = () => peer.request(Rpc.ASSESSMENT_REPORT, { id: 'saved-report' });
export const unionMethod = () => peer.request(flag ? Rpc.COPILOT_STATUS : Rpc.RUN_CREATE, {});

const modified = { force: true };
modified.force = false;
export const changedFlag = () => peer.request(Rpc.PR_LIST, modified);
