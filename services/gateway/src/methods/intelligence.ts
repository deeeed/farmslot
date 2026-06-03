import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  FAILURE_CATEGORIES,
  INTELLIGENCE_ACTION_ACTORS,
  INTELLIGENCE_ACTION_FOLLOWUPS,
  INTELLIGENCE_ACTION_OUTCOME_REASONS,
  INTELLIGENCE_ACTION_OUTCOMES,
  INTELLIGENCE_ACTION_PROPOSED_TYPES,
  INTELLIGENCE_ACTION_TIERS,
  type IntelligenceAction,
  type IntelligenceActionsSummaryParams,
  type IntelligenceActionsSummaryResult,
} from '@farmslot/protocol';

import { intelligenceAuditDir } from '../auto-recovery/audit-writer.js';

const CONFIDENCE = new Set(['low', 'medium', 'high']);
const OUTCOMES = new Set(INTELLIGENCE_ACTION_OUTCOMES);
const TIERS = new Set(INTELLIGENCE_ACTION_TIERS);
const ACTORS = new Set(INTELLIGENCE_ACTION_ACTORS);
const FOLLOWUPS = new Set(INTELLIGENCE_ACTION_FOLLOWUPS);
const ACTIONS = new Set(INTELLIGENCE_ACTION_PROPOSED_TYPES);

function expectedMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function isStringOrUndefined(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function parseIntelligenceActionLine(raw: unknown): IntelligenceAction | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as any;
  if (
    typeof o.id !== 'string' ||
    typeof o.timestamp !== 'string' ||
    typeof o.decidedAt !== 'string' ||
    typeof o.runId !== 'string'
  )
    return null;
  if (
    !isStringOrUndefined(o.familyId) ||
    !isStringOrUndefined(o.project) ||
    !isStringOrUndefined(o.stepName)
  )
    return null;
  if (
    !ACTORS.has(o.actor) ||
    !o.verdict ||
    typeof o.verdict !== 'object' ||
    !CONFIDENCE.has(o.verdict.confidence)
  )
    return null;
  if (
    o.verdict.category !== undefined &&
    !(FAILURE_CATEGORIES as readonly string[]).includes(o.verdict.category)
  )
    return null;
  if (!isStringOrUndefined(o.verdict.patternId)) return null;
  if (
    !Array.isArray(o.guards) ||
    o.guards.some(
      (g: any) =>
        !g ||
        typeof g.name !== 'string' ||
        typeof g.passed !== 'boolean' ||
        !isStringOrUndefined(g.reason),
    )
  )
    return null;
  if (!OUTCOMES.has(o.outcome) || !TIERS.has(o.tier) || typeof o.costUsd !== 'number') return null;
  if (
    o.outcomeReason !== undefined &&
    !(INTELLIGENCE_ACTION_OUTCOME_REASONS as readonly string[]).includes(o.outcomeReason)
  )
    return null;
  if (o.followupOutcome !== undefined && !FOLLOWUPS.has(o.followupOutcome)) return null;
  if (o.latencyMs !== undefined && typeof o.latencyMs !== 'number') return null;
  if (o.appliedAction !== undefined) {
    if (
      !o.appliedAction ||
      typeof o.appliedAction !== 'object' ||
      Array.isArray(o.appliedAction) ||
      !ACTIONS.has(o.appliedAction.type)
    )
      return null;
    if (!isStringOrUndefined(o.appliedAction.stepName)) return null;
    if (!isStringOrUndefined(o.appliedAction.replayRunId)) return null;
    if (!isStringOrUndefined(o.appliedAction.tmuxKeys)) return null;
  }
  const verdict: IntelligenceAction['verdict'] = { confidence: o.verdict.confidence };
  if (o.verdict.category !== undefined) verdict.category = o.verdict.category;
  if (o.verdict.patternId !== undefined) verdict.patternId = o.verdict.patternId;
  const appliedAction: IntelligenceAction['appliedAction'] | undefined =
    o.appliedAction === undefined
      ? undefined
      : {
          type: o.appliedAction.type,
          ...(o.appliedAction.stepName !== undefined ? { stepName: o.appliedAction.stepName } : {}),
          ...(o.appliedAction.replayRunId !== undefined
            ? { replayRunId: o.appliedAction.replayRunId }
            : {}),
          ...(o.appliedAction.tmuxKeys !== undefined ? { tmuxKeys: o.appliedAction.tmuxKeys } : {}),
        };
  return {
    id: o.id,
    timestamp: o.timestamp,
    decidedAt: o.decidedAt,
    runId: o.runId,
    ...(o.familyId !== undefined ? { familyId: o.familyId } : {}),
    ...(o.project !== undefined ? { project: o.project } : {}),
    ...(o.stepName !== undefined ? { stepName: o.stepName } : {}),
    actor: o.actor,
    verdict,
    guards: o.guards.map((g: any) => ({
      name: g.name,
      passed: g.passed,
      ...(g.reason !== undefined ? { reason: g.reason } : {}),
    })),
    outcome: o.outcome,
    ...(o.outcomeReason !== undefined ? { outcomeReason: o.outcomeReason } : {}),
    ...(o.latencyMs !== undefined ? { latencyMs: o.latencyMs } : {}),
    ...(appliedAction ? { appliedAction } : {}),
    ...(o.followupOutcome !== undefined ? { followupOutcome: o.followupOutcome } : {}),
    tier: o.tier,
    costUsd: o.costUsd,
  };
}
async function readAuditFiles(): Promise<string[]> {
  const dir = intelligenceAuditDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if (expectedMissing(err)) return [];
    throw err;
  }
  return files
    .filter((f) => f.endsWith('.ndjson'))
    .sort()
    .map((f) => path.join(dir, f));
}
function withinDateRange(
  action: IntelligenceAction,
  params: IntelligenceActionsSummaryParams,
): boolean {
  const dateFrom =
    params.dateFrom?.length === 10 ? `${params.dateFrom}T00:00:00.000Z` : params.dateFrom;
  const dateTo = params.dateTo?.length === 10 ? `${params.dateTo}T23:59:59.999Z` : params.dateTo;
  if (dateFrom !== undefined && action.decidedAt < dateFrom) return false;
  if (dateTo !== undefined && action.decidedAt > dateTo) return false;
  return true;
}
export async function intelligenceActionsSummary(
  params: IntelligenceActionsSummaryParams = {},
): Promise<IntelligenceActionsSummaryResult> {
  const records: IntelligenceAction[] = [];
  let parseFailures = 0,
    shapeDriftFailures = 0;
  for (const file of await readAuditFiles()) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch (err) {
      if (expectedMissing(err)) continue;
      throw err;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parseFailures++;
        continue;
      }
      const action = parseIntelligenceActionLine(parsed);
      if (!action) {
        shapeDriftFailures++;
        continue;
      }
      if (!withinDateRange(action, params)) continue;
      records.push(action);
    }
  }
  records.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  const limited = records.slice(0, params.limit ?? 100);
  const byActor: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  for (const rec of records) {
    byActor[rec.actor] = (byActor[rec.actor] ?? 0) + 1;
    byOutcome[rec.outcome] = (byOutcome[rec.outcome] ?? 0) + 1;
  }
  return {
    summary: {
      total: records.length,
      byActor,
      byOutcome,
      records: limited,
      metadata: { parseFailures, shapeDriftFailures },
    },
  };
}
