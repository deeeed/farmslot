import type { ResourceKey } from '@farmslot/protocol/client-cache';
import { Methods } from '@farmslot/protocol/rpc/registry';

import { GatewayMethodError } from '../core/method-error.js';
import type { GatewayAuthRuntime } from '../security/auth.js';
import { authorizeGatewayMethod } from '../security/authorization.js';
import type { ClientState } from '../server/client-state.js';

/** Each migrated key uses its read's authorization, including owner scoping when applicable. */
export function canReadResourceKey(
  runtime: GatewayAuthRuntime,
  state: ClientState,
  key: ResourceKey,
): boolean {
  let method: string;
  switch (key.family) {
    case 'sources':
      method = Methods.SOURCES_STATUS;
      break;
    case 'gateway-update':
      method = Methods.GATEWAY_STATUS;
      break;
    case 'upstream':
      // These observations have the same farm-wide authority as their owning read.
      if (key.integration === 'providers') {
        if (key.queryId.startsWith(`${Methods.RUNNER_MODEL_CATALOG}:`))
          method = Methods.RUNNER_MODEL_CATALOG;
        else if (key.queryId.startsWith(`${Methods.PROVIDER_ACCOUNTS_SNAPSHOT}:`))
          method = Methods.PROVIDER_ACCOUNTS_SNAPSHOT;
        else return false;
        break;
      }
      if (key.integration !== 'github') return false;
      if (key.queryId === `${Methods.CONFIG_GITHUB_ACCOUNTS}:{}`)
        method = Methods.CONFIG_GITHUB_ACCOUNTS;
      else if (key.queryId.startsWith(`${Methods.PR_LIST}:`)) method = Methods.PR_LIST;
      else if (key.queryId.startsWith(`${Methods.PR_STATUS}:`)) method = Methods.PR_STATUS;
      else if (key.queryId.startsWith(`${Methods.PR_FOR_SLOT}:`)) method = Methods.PR_FOR_SLOT;
      else if (key.queryId.startsWith(`${Methods.PR_REVIEW_COMMENTS}:`))
        method = Methods.PR_REVIEW_COMMENTS;
      else return false;
      break;
    case 'runs':
      method = Methods.RUN_LIST;
      break;
    case 'slots':
    case 'slot':
      method = Methods.FLEET_STATUS;
      break;
    case 'node':
      method = 'scope' in key ? Methods.NODES_LIST : Methods.NODE_HEALTH;
      break;
    case 'workers':
      method = Methods.TMUX_WORKER_LIST;
      break;
    case 'pressure':
      method = Methods.RESOURCE_PRESSURE_SNAPSHOT;
      break;
    case 'capabilities':
    case 'capability':
      method = Methods.RUNTIME_CAPABILITY_STATUS;
      break;
    case 'progress':
      method = Methods.TASK_PROGRESS;
      break;
    case 'pr-automation':
      method = Methods.PR_WATCH_LIST;
      break;
    case 'assessment':
      // Only collection keys are emitted. Detail IDs remain private to their owning reads.
      if (key.assessmentId !== undefined) return false;
      method = Methods.ASSESSMENT_LIST;
      break;
    case 'analytics':
      method = Methods.ANALYTICS_QUERY;
      break;
    case 'copilot':
      // The existing runtime/chat API is shared by global administrators, not native owners.
      if (key.ownerId !== 'gateway-copilot') return false;
      method = key.sessionId === undefined ? Methods.COPILOT_STATUS : Methods.CHAT_SESSION_CONTEXT;
      break;
    case 'configuration':
      method = Methods.CONFIG_PROJECTS;
      break;
    case 'planning':
      switch (key.collection) {
        case 'backlog':
          method = Methods.BACKLOG_LIST;
          break;
        case 'roadmap':
          method = Methods.ROADMAP_LIST;
          break;
        case 'work-graphs':
          method = Methods.WORK_GRAPH_LIST;
          break;
        case 'dispatch-queue':
          method = Methods.DISPATCH_QUEUE_LIST;
          break;
        default:
          return false;
      }
      break;
    case 'decisions':
    case 'decision':
      method = Methods.DECISION_LIST;
      break;
    case 'family':
      method = Methods.FAMILY_OBSERVABILITY_GET;
      break;
    case 'run':
    case 'gate':
    case 'package':
    case 'review':
    case 'artifacts':
      // These projections belong to the farm run read, which requires admin access.
      method = Methods.RUN_GET;
      break;
    default:
      return false;
  }
  try {
    authorizeGatewayMethod(runtime, state, method);
    return true;
  } catch (error) {
    if (
      error instanceof GatewayMethodError &&
      ['AUTH_REQUIRED', 'AUTH_FORBIDDEN'].includes(error.code)
    )
      return false;
    throw error;
  }
}

/** runner.visibleModels.get shares the owner profile key. Only that principal receives it,
 * with or without a native reader identity. */
export function canReadVisibleModelPreferenceKey(
  runtime: GatewayAuthRuntime,
  state: ClientState,
  key: ResourceKey,
): boolean {
  if (key.family !== 'profiles' || !('scope' in key)) return false;
  try {
    return (
      authorizeGatewayMethod(runtime, state, Methods.RUNNER_VISIBLE_MODELS_GET).id === key.ownerId
    );
  } catch (error) {
    if (
      error instanceof GatewayMethodError &&
      ['AUTH_REQUIRED', 'AUTH_FORBIDDEN'].includes(error.code)
    )
      return false;
    throw error;
  }
}
