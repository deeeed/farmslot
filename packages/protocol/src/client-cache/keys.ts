/** Experimental ADR-071 keys. IDs identify resources; keys never contain filesystem paths. */
export type ResourceKey =
  | { family: 'sources'; scope: 'farm' }
  | { family: 'runs'; scope: 'farm'; project?: string }
  | { family: 'run'; runId: string }
  | { family: 'family'; familyId: string }
  | { family: 'decisions'; scope: 'farm' }
  | { family: 'decision'; decisionId: string }
  | { family: 'gate' | 'package'; runId: string; decisionId?: string }
  | { family: 'slots'; scope: 'farm'; project?: string; nodeId?: string }
  | { family: 'slot'; slotId: string }
  | { family: 'node' | 'pressure' | 'workers'; nodeId: string }
  | { family: 'review'; runId: string; reviewId?: string }
  | { family: 'artifacts'; runId: string; invocationId?: string }
  | { family: 'progress'; runId: string; contextId?: string }
  | { family: 'capabilities'; nodeId?: string; slotId?: string }
  | { family: 'capability'; capabilityId: string }
  | { family: 'workspace'; slotId: string; runId?: string }
  | { family: 'workspace'; nodeId: string; ownerId: string; workspaceId: string }
  | {
      family: 'native-session';
      nodeId: string;
      ownerId: string;
      sessionId?: string;
      workerId?: string;
    }
  | { family: 'profiles'; nodeId: string; ownerId: string }
  | { family: 'configuration' | 'pr-automation' | 'analytics'; scope: 'farm'; project?: string }
  | { family: 'planning'; project?: string; itemId?: string }
  | { family: 'assessment'; scope: 'farm'; assessmentId?: string }
  | { family: 'copilot'; ownerId: string; sessionId?: string }
  | { family: 'gateway-update'; scope: 'gateway' }
  | { family: 'upstream'; integration: 'github' | 'packages' | 'providers'; queryId: string };

export type ResourceRevision = number;

export interface ResourceDependency {
  key: ResourceKey;
  revision: ResourceRevision;
}

export interface ResourceReadStamp {
  epoch: string;
  dependencies: ResourceDependency[];
}

/** Canonical JSON for query parameters and typed resource keys. Arrays retain their order. */
export function canonicalResourceJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalResourceJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalResourceJson(object[key])}`)
    .join(',')}}`;
}

export function resourceKeyId(key: ResourceKey): string {
  return canonicalResourceJson(key);
}

/** Busy observations have one gateway publication cadence, shared by all readers. */
export const RESOURCE_PUBLISH_INTERVAL_MS: Partial<Record<ResourceKey['family'], number>> = {
  workspace: 200,
  progress: 200,
  'native-session': 200,
};
