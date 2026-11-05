import type { RunnerSessionUsage } from '@farmslot/protocol';

import type {
  NativeSessionUsageIdentity,
  NativeSessionUsageRequest,
} from '../../services/gateway/src/runners/native-session-usage-command.js';
import { preferSessionUsage } from '../../services/gateway/src/runtime/reviewer-usage.js';

export const LEGACY_REVIEW_USAGE_ERROR = 'Native reviewer usage accounting is unavailable';
export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const usageKey = (runner: string, session: string) => JSON.stringify([runner, session]);

function legacyUsage(
  value: unknown,
): value is Record<string, unknown> & { runner: string; runnerSessionId: string } {
  return (
    object(value) &&
    value.source === 'unavailable' &&
    value.error === LEGACY_REVIEW_USAGE_ERROR &&
    typeof value.runner === 'string' &&
    typeof value.runnerSessionId === 'string'
  );
}

export function visitLegacyUsage(
  document: unknown,
  found: (usage: { runner: string; runnerSessionId: string }) => void,
): void {
  if (legacyUsage(document)) found(document);
  else if (Array.isArray(document)) for (const value of document) visitLegacyUsage(value, found);
  else if (object(document))
    for (const value of Object.values(document)) visitLegacyUsage(value, found);
}

function representedKeys(document: unknown): Set<string> {
  const keys = new Set<string>();
  const visit = (value: unknown): void => {
    if (
      object(value) &&
      value.source === 'runner-transcript' &&
      !value.error &&
      typeof value.runner === 'string' &&
      typeof value.runnerSessionId === 'string'
    )
      keys.add(usageKey(value.runner, value.runnerSessionId));
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (object(value)) for (const item of Object.values(value)) visit(item);
  };
  visit(document);
  return keys;
}

function identity(value: unknown): NativeSessionUsageIdentity | undefined {
  if (
    !object(value) ||
    typeof value.sessionId !== 'string' ||
    typeof value.ownerPrincipalId !== 'string' ||
    typeof value.executionNodeId !== 'string'
  )
    return;
  return {
    sessionId: value.sessionId,
    ownerPrincipalId: value.ownerPrincipalId,
    executionNodeId: value.executionNodeId,
    ...(typeof value.stateDirectory === 'string' ? { stateDirectory: value.stateDirectory } : {}),
  };
}

/** Decode only migration-owned fields; all other learning/run content stays opaque. */
export function nativeReviewerRequests(
  document: unknown,
  repo: string,
  provider: (runner: string) => string | undefined,
): NativeSessionUsageRequest[] {
  if (
    !object(document) ||
    typeof document.id !== 'string' ||
    !Array.isArray(document.agentContexts)
  )
    return [];
  const contexts = document.agentContexts;
  const represented = representedKeys(document);
  const requests = new Map<string, NativeSessionUsageRequest>();
  const candidates = new Map<string, { runner: string; runnerSessionId: string }>();
  visitLegacyUsage(document, (usage) =>
    candidates.set(usageKey(usage.runner, usage.runnerSessionId), usage),
  );
  for (const context of contexts)
    if (
      object(context) &&
      context.role === 'review' &&
      typeof context.reviewId === 'string' &&
      typeof context.runner === 'string' &&
      typeof context.runnerSessionId === 'string' &&
      !represented.has(usageKey(context.runner, context.runnerSessionId)) &&
      identity(context.nativeSession)
    )
      candidates.set(usageKey(context.runner, context.runnerSessionId), {
        runner: context.runner,
        runnerSessionId: context.runnerSessionId,
      });
  for (const usage of candidates.values()) {
    const key = usageKey(usage.runner, usage.runnerSessionId);
    const kind = provider(usage.runner);
    if (!kind || requests.has(key)) continue;
    const matches = contexts.filter(
      (value) =>
        object(value) &&
        value.role === 'review' &&
        value.runner === usage.runner &&
        value.runnerSessionId === usage.runnerSessionId,
    );
    const bindings = matches.flatMap((context) => {
      const binding = object(context) && identity(context.nativeSession);
      return binding ? [binding] : [];
    });
    const binding = bindings[0];
    const context = matches.find(
      (value) => object(value) && typeof value.runnerSessionPath === 'string',
    );
    if (
      !binding ||
      bindings.some(
        (other) =>
          other.ownerPrincipalId !== binding.ownerPrincipalId ||
          other.executionNodeId !== binding.executionNodeId,
      )
    )
      continue;
    requests.set(key, {
      key,
      runner: usage.runner,
      provider: kind,
      runnerSessionId: usage.runnerSessionId,
      cwd: repo,
      ...(object(context) && typeof context.runnerSessionPath === 'string'
        ? { sessionPath: context.runnerSessionPath }
        : {}),
      slotId: typeof document.slotId === 'string' ? document.slotId : document.id,
      nativeSession: binding,
    });
  }
  return [...requests.values()];
}

export function backfillRequests(
  document: unknown,
  repo: string,
  provider: (runner: string) => string | undefined,
): NativeSessionUsageRequest[] {
  const keys = new Set<string>();
  visitLegacyUsage(document, (usage) => keys.add(usageKey(usage.runner, usage.runnerSessionId)));
  return nativeReviewerRequests(document, repo, provider).filter((request) =>
    keys.has(request.key),
  );
}

/** Repair supporting receipts without constructing verdicts or changing unrelated run data. */
export function backfillDocument(
  document: unknown,
  usages: ReadonlyMap<string, RunnerSessionUsage>,
): { document: unknown; replacements: number; sessionKeys: string[] } {
  let replacements = 0;
  const receipts = new Map(usages);
  const retain = (value: unknown): void => {
    if (
      object(value) &&
      value.source === 'runner-transcript' &&
      !value.error &&
      typeof value.runner === 'string' &&
      typeof value.runnerSessionId === 'string' &&
      typeof value.measuredAt === 'string' &&
      typeof value.totalTokens === 'number'
    ) {
      const usage: RunnerSessionUsage = {
        ...value,
        source: 'runner-transcript',
        runner: value.runner,
        runnerSessionId: value.runnerSessionId,
        measuredAt: value.measuredAt,
        totalTokens: value.totalTokens,
      };
      const key = usageKey(value.runner, value.runnerSessionId);
      receipts.set(key, preferSessionUsage(receipts.get(key), usage));
    } else if (Array.isArray(value)) value.forEach(retain);
    else if (object(value)) Object.values(value).forEach(retain);
  };
  retain(document);
  const sessionKeys = representedKeys(document);
  const patch = (value: unknown): unknown => {
    if (legacyUsage(value)) {
      const usage = receipts.get(usageKey(value.runner, value.runnerSessionId));
      if (usage?.source === 'runner-transcript' && !usage.error) {
        replacements++;
        sessionKeys.add(usageKey(value.runner, value.runnerSessionId));
        const next = { ...value, ...usage };
        delete next.error;
        return next;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(patch);
    if (object(value))
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, patch(item)]));
    return value;
  };
  const result = patch(document);
  if (object(result) && Array.isArray(result.agentContexts)) {
    result.agentContexts = result.agentContexts.map((context: unknown) => {
      if (
        !object(context) ||
        context.role !== 'review' ||
        typeof context.reviewId !== 'string' ||
        typeof context.runner !== 'string' ||
        typeof context.runnerSessionId !== 'string' ||
        !identity(context.nativeSession)
      )
        return context;
      const key = usageKey(context.runner, context.runnerSessionId);
      const usage = receipts.get(key);
      if (!usage || usage.source !== 'runner-transcript' || usage.error) return context;
      sessionKeys.add(key);
      const merged = { ...(object(context.usage) ? context.usage : {}), ...usage };
      delete merged.error;
      if (JSON.stringify(context.usage) === JSON.stringify(merged)) return context;
      replacements++;
      return { ...context, usage: merged };
    });
  }
  return { document: result, replacements, sessionKeys: [...sessionKeys] };
}
