// report.ts — Family observability report generation and cache ownership

import type { FamilyObservabilitySnapshot, FamilyReport } from '@farmslot/protocol';

import { getLLMConfig } from '../llm/config.js';
import { callLLM as callLLMDefault, type LLMCallResult } from '../llm/index.js';

const reportCache = new Map<string, FamilyReport>();
interface FamilyReportDependencies {
  callLLM?: (args: Parameters<typeof callLLMDefault>[0]) => Promise<LLMCallResult>;
}
function reportCacheKey(snapshot: FamilyObservabilitySnapshot): string {
  return [
    snapshot.familyId,
    snapshot.latestRunId,
    String(snapshot.familyRunCount),
    String(snapshot.activeRunCount),
    ...snapshot.runs.map((run) => `${run.runId}:${run.updatedAt}`),
  ].join('|');
}

function buildFallbackReport(snapshot: FamilyObservabilitySnapshot, error?: string): FamilyReport {
  const strongestEvidence = snapshot.evidence
    .slice(0, 3)
    .map((artifact) => `${artifact.purpose}: ${artifact.path}`);
  return {
    generatedAt: new Date().toISOString(),
    status: 'fallback',
    provider: 'built-in',
    model: 'deterministic-summary',
    error,
    content: {
      summary: snapshot.summary,
      evidenceHighlights:
        strongestEvidence.length > 0
          ? strongestEvidence
          : ['No evidence artifacts were available.'],
      recipeAssessment: snapshot.recipeQuality.reasoning,
      learnings: snapshot.learnings.slice(0, 5).map((entry) => `${entry.title}: ${entry.summary}`),
      unresolvedGaps:
        snapshot.missingData.length > 0
          ? snapshot.missingData
          : ['No major snapshot gaps detected.'],
    },
  };
}

export async function generateFamilyReport(
  snapshot: FamilyObservabilitySnapshot,
  forceRefresh = false,
  deps: FamilyReportDependencies = {},
): Promise<FamilyReport> {
  const cacheKey = reportCacheKey(snapshot);
  if (!forceRefresh) {
    const cached = reportCache.get(cacheKey);
    if (cached) return cached;
  }

  try {
    const cfg = getLLMConfig();
    const prompt = [
      'You are generating a concise JSON report for a run family observability view.',
      'Return valid JSON only with keys: summary, evidenceHighlights, recipeAssessment, learnings, unresolvedGaps.',
      'evidenceHighlights, learnings, unresolvedGaps must be arrays of strings.',
      '',
      JSON.stringify(snapshot),
    ].join('\n');
    // 30s budget — codex/gpt-5.5 end-to-end is routinely 5-15s, the prior 4s
    // ceiling timed out every call and forced the fallback path.
    const result = await Promise.race([
      (deps.callLLM ?? callLLMDefault)({
        provider: cfg.defaultProvider,
        model: cfg.intelligenceModel,
        userPrompt: prompt,
        maxTokens: 1200,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('family report generation timed out')), 30000),
      ),
    ]);
    const parsed = JSON.parse(result.text) as {
      summary: string;
      evidenceHighlights: string[];
      recipeAssessment: string;
      learnings: string[];
      unresolvedGaps: string[];
    };
    const report: FamilyReport = {
      generatedAt: new Date().toISOString(),
      status: 'generated',
      provider: result.usage.provider,
      model: result.usage.model,
      usage: result.usage,
      content: {
        summary: parsed.summary,
        evidenceHighlights: Array.isArray(parsed.evidenceHighlights)
          ? parsed.evidenceHighlights
          : [],
        recipeAssessment: parsed.recipeAssessment,
        learnings: Array.isArray(parsed.learnings) ? parsed.learnings : [],
        unresolvedGaps: Array.isArray(parsed.unresolvedGaps) ? parsed.unresolvedGaps : [],
      },
    };
    reportCache.set(cacheKey, report);
    return report;
  } catch (error) {
    // Don't cache fallbacks — a transient LLM flake would otherwise poison the
    // cache until the snapshot identity changes (new run, new updatedAt) or
    // the gateway restarts. Returning the fallback unchanged means the next
    // call retries the LLM rather than serving the stale failure.
    return buildFallbackReport(snapshot, error instanceof Error ? error.message : String(error));
  }
}
