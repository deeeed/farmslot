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
  | { family: 'node' | 'workers'; scope: 'farm' }
  | { family: 'node' | 'pressure' | 'workers'; nodeId: string }
  | { family: 'review'; runId: string; reviewId?: string }
  | { family: 'artifacts'; runId: string; invocationId?: string }
  | { family: 'progress'; runId: string; contextId?: string }
  | { family: 'capabilities'; nodeId?: string; slotId?: string }
  | { family: 'capability'; capabilityId: string }
  | { family: 'workspace'; slotId: string; runId?: string }
  | { family: 'workspace'; nodeId: string; ownerId: string; sessionId: string; contextId?: string }
  | { family: 'workspace'; nodeId: string; ownerId: string; workspaceId: string }
  | {
      family: 'native-session';
      nodeId: string;
      ownerId: string;
      sessionId?: string;
      workerId?: string;
    }
  | { family: 'profiles'; nodeId: string; ownerId: string }
  | { family: 'native-session' | 'profiles'; scope: 'owner'; ownerId: string }
  | { family: 'configuration' | 'pr-automation' | 'analytics'; scope: 'farm'; project?: string }
  | {
      family: 'planning';
      collection: 'backlog' | 'roadmap' | 'work-graphs' | 'dispatch-queue';
      project?: string;
      itemId?: string;
    }
  | { family: 'assessment'; scope: 'farm'; assessmentId?: string }
  | { family: 'copilot'; ownerId: string; sessionId?: string }
  | { family: 'gateway-update'; scope: 'gateway' }
  | { family: 'upstream'; integration: 'github' | 'packages' | 'providers'; queryId: string };

const RESOURCE_KEY_FAMILIES: Record<ResourceKey['family'], true> = {
  sources: true,
  runs: true,
  run: true,
  family: true,
  decisions: true,
  decision: true,
  gate: true,
  package: true,
  slots: true,
  slot: true,
  node: true,
  workers: true,
  pressure: true,
  review: true,
  artifacts: true,
  progress: true,
  capabilities: true,
  capability: true,
  workspace: true,
  'native-session': true,
  profiles: true,
  configuration: true,
  'pr-automation': true,
  analytics: true,
  planning: true,
  assessment: true,
  copilot: true,
  'gateway-update': true,
  upstream: true,
};

/** A family outside this list may come from a newer gateway, so no query can rule it out. */
export function isKnownResourceFamily(family: unknown): boolean {
  return typeof family === 'string' && Object.hasOwn(RESOURCE_KEY_FAMILIES, family);
}

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
  workers: 200,
  copilot: 200,
  progress: 200,
  'native-session': 200,
};

/**
 * An automatic reread that only changes to these keys call for waits at least this long after the
 * last read. Every slot's task phase, progress and workspace change the farm slot keys, several
 * times a second on a busy farm, and a farm-wide read returns every slot.
 */
export const RESOURCE_REREAD_INTERVAL_MS: Partial<Record<ResourceKey['family'], number>> = {
  slots: 10_000,
};

/** The longest an automatic reread waits after failed reads of the same query. */
export const RESOURCE_RETRY_MAX_WAIT_MS = 300_000;
