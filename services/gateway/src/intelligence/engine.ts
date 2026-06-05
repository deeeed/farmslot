// intelligence.ts — LLM calls for structured tasks (grading, task writing)
// Uses the multi-provider LLM wrapper (ADR-014).
// Auth cascade: farmslot store → openclaw store → env vars → CLI fallback.

import {
  RECIPE_STRATEGY_LABELS,
  type RecipeStrategyToken,
  type RunGrade,
  type RunTicketData,
  type StepLLMUsage,
} from '@farmslot/protocol';

import { loadPromptTemplate } from '../core/prompt-templates.js';
import { getLLMConfig } from '../llm/config.js';
import { callLLM, type LLMCallResult } from '../llm/index.js';

// ─── Grading ───

const GRADE_SYSTEM_FALLBACK = `You are a bug difficulty grader for a mobile app codebase. Given a bug description, assess the difficulty of fixing it.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "difficulty": "low" | "medium" | "high" | "extreme",
  "rationale": "1-2 sentence explanation",
  "modelRecommendation": "sonnet" | "opus",
  "score": 1-10
}

Guidelines:
- low (1-3): simple UI fix, typo, obvious one-liner
- medium (4-5): single-component bug, clear repro steps, moderate investigation
- high (6-8): cross-component issue, race condition, state management bug
- extreme (9-10): architecture-level issue, deep framework bug, needs extensive refactor
- Recommend "opus" only for high/extreme difficulty`;

export interface GradeResult {
  grade: RunGrade;
  usage: StepLLMUsage;
}

export async function gradeTicket(ticket: RunTicketData, project?: string): Promise<GradeResult> {
  const userPrompt = `Grade this bug:

Title: ${ticket.title}
Description: ${ticket.description.slice(0, 2000)}
${ticket.acceptanceCriteria.length > 0 ? `\nAcceptance Criteria:\n${ticket.acceptanceCriteria.join('\n')}` : ''}
${ticket.affectedArea ? `\nAffected Area: ${ticket.affectedArea}` : ''}
${ticket.stepsToReproduce.length > 0 ? `\nSteps to Reproduce:\n${ticket.stepsToReproduce.join('\n')}` : ''}`;

  const template = project ? await loadPromptTemplate(project, 'grade-ticket.md', {}) : null;
  const systemPrompt = template ?? GRADE_SYSTEM_FALLBACK;

  const cfg = getLLMConfig();
  const result: LLMCallResult = await callLLM({
    systemPrompt,
    userPrompt,
    model: cfg.intelligenceModel,
    provider: cfg.defaultProvider,
  });

  // Extract JSON from response (may have surrounding text)
  const jsonMatch = result.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn(`[intelligence] no JSON in grade response: ${result.text.slice(0, 100)}`);
    return {
      grade: {
        difficulty: 'medium',
        rationale: 'No structured response',
        modelRecommendation: 'sonnet',
      },
      usage: result.usage,
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      grade: {
        difficulty: parsed.difficulty ?? 'medium',
        rationale: parsed.rationale ?? '',
        modelRecommendation: parsed.modelRecommendation ?? 'sonnet',
        score: parsed.score,
      },
      usage: result.usage,
    };
  } catch {
    console.warn(`[intelligence] failed to parse grade response: ${result.text.slice(0, 100)}`);
    return {
      grade: {
        difficulty: 'medium',
        rationale: 'Parse error — defaulting',
        modelRecommendation: 'sonnet',
      },
      usage: result.usage,
    };
  }
}

// ─── Task Summary ───

export interface SummaryResult {
  summary: string;
  branchSlug: string; // kebab-case, 3-5 words, max 30 chars
  usage: StepLLMUsage;
}

const SUMMARY_SYSTEM = `You generate a 1-line summary and branch slug for a coding task.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "summary": "...",
  "branchSlug": "..."
}

Rules:
- summary: domain-specific 1-line description, no period, no ticket ID
- branchSlug: 3-5 lowercase kebab-case words describing the fix/feature, max 30 chars
  Examples: "fix-send-button-crash", "add-token-import-flow", "update-gas-estimation"`;

const SUMMARY_TIMEOUT_MS = 15_000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout: () => void,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  return slug || 'untitled';
}

export function sanitizeBranchSlug(slug: string): string {
  // Enforce git ref validity: lowercase, no double dots, no control chars, no special chars
  const clean = slug
    .toLowerCase()
    .replace(/\.{2,}/g, '.')
    .replace(/[~^:?*[\]\\@{}\x00-\x1f\x7f]/g, '')
    .replace(/\/+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 30);
  return clean || 'task';
}

export async function generateSummary(
  ticket: RunTicketData,
  flowType: string,
): Promise<SummaryResult> {
  const descTruncated = ticket.description.slice(0, 1500);
  const userPrompt = `Flow: ${flowType}
Title: ${ticket.title}
Description: ${descTruncated}
${ticket.affectedArea ? `Affected Area: ${ticket.affectedArea}` : ''}
${ticket.labels?.length ? `Labels: ${ticket.labels.join(', ')}` : ''}`;

  try {
    const cfg = getLLMConfig();
    const controller = new AbortController();
    const result: LLMCallResult = await withTimeout(
      callLLM({
        systemPrompt: SUMMARY_SYSTEM,
        userPrompt,
        model: cfg.intelligenceModel,
        provider: cfg.defaultProvider,
        signal: controller.signal,
      }),
      SUMMARY_TIMEOUT_MS,
      'summary generation',
      () => controller.abort(),
    );

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: parsed.summary ?? ticket.title,
      branchSlug: sanitizeBranchSlug(parsed.branchSlug ?? slugify(ticket.title)),
      usage: result.usage,
    };
  } catch (err) {
    console.warn(`[intelligence] summary generation failed (non-fatal): ${(err as Error).message}`);
    return {
      summary: ticket.title,
      branchSlug: slugify(ticket.title),
      usage: { provider: 'fallback', model: 'none', durationMs: 0 },
    };
  }
}

// ─── Branch helpers ───

const FLOW_DIR_MAP: Record<string, string> = {
  'fix-bug': 'fix',
  'review-pr': 'review',
  'merge-main': 'fix',
  dev: 'feat',
  'pr-complete': 'fix',
};

export function flowDir(flowType: string): string {
  return FLOW_DIR_MAP[flowType] ?? flowType;
}

export function ticketSlug(ticketOrPr: string): string {
  // GitHub: owner/repo#123 or #123 → just the number
  const ghMatch = ticketOrPr.match(/#(\d+)$/);
  if (ghMatch) return ghMatch[1];
  // Jira: PROJ-2636 → proj-2636 (unchanged)
  return ticketOrPr.replace(/[#\/]/g, '-').toLowerCase();
}

export function buildSmartBranch(
  flowType: string,
  ticketOrPr: string,
  branchSlug?: string,
  namespace?: string,
  variant?: string | null,
  branchFormat?: string,
): string {
  const dir = flowDir(flowType);
  const tSlug = ticketSlug(ticketOrPr);
  const variantSuffix = variant ? `-${ticketSlug(variant)}` : '';

  if (branchFormat) {
    const ticketRaw = ticketOrPr.replace(/[~^:?*[\]\\@{}\x00-\x1f\x7f]/g, '').replace(/\//g, '-');
    const slug = branchSlug ? sanitizeBranchSlug(branchSlug) : '';
    return branchFormat
      .replace('{{ticket}}', ticketRaw)
      .replace('{{type}}', dir)
      .replace('{{slug}}', slug)
      .replace('{{namespace}}', namespace ?? '')
      .replace('{{variant_suffix}}', variantSuffix)
      .replace(/\/\/+/g, '/')
      .replace(/^\/|\/$/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  }

  const withSlug = branchSlug ? `${tSlug}-${branchSlug}` : tSlug;
  const base = variantSuffix
    ? `${withSlug.slice(0, Math.max(1, 50 - variantSuffix.length))}${variantSuffix}`.slice(0, 50)
    : withSlug.slice(0, 50);
  return namespace ? `${dir}/${namespace}/${base}` : `${dir}/${base}`;
}

// ─── Recipe Strategy Selection (Phase 1 Pre-Filter) ───

const NON_UI_EXTENSIONS = /\.(md|test\.tsx?|spec\.tsx?|config\.[^.]+|json|ya?ml|lock)$/i;
const UI_PATCH_PATTERNS = /\b(jsx|tsx|css|scss|style|className|render|component|<[A-Z])/;

function isNonUIFile(filename: string, patch?: string): boolean {
  if (NON_UI_EXTENSIONS.test(filename)) return true;
  if (/\.tsx$/.test(filename)) return false; // .tsx is always UI
  if (/\.ts$/.test(filename) && patch && !UI_PATCH_PATTERNS.test(patch)) return true;
  return false;
}

export interface RecipeStrategyResult {
  strategy: import('@farmslot/protocol').RecipeStrategyDecision;
  usage: StepLLMUsage;
}

const RECIPE_STRATEGY_SYSTEM = `You are a code review evidence strategist. Given a PR diff summary, decide what evidence strategy to use.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "strategy": "full-qa" | "smoke" | "targeted",
  "reasoning": "1-2 sentence explanation",
  "uiImpact": true/false,
  "diffSummary": "brief summary of what changed"
}

Guidelines:
- "full-qa": PR touches UI components, styles, layouts, or user-visible behavior. Run the full QA session — screenshots plus opt-in video when motion proof helps.
- "smoke": PR is purely backend, config, tests, or non-visual. Run the backend smoke regression only; no UI evidence.
- "targeted": PR has mixed changes — smoke regression plus targeted screenshots for the UI-impacting parts only.
- When in doubt, prefer "full-qa" (safer).`;

const RECIPE_STRATEGY_TOKENS = Object.keys(RECIPE_STRATEGY_LABELS) as RecipeStrategyToken[];

/** Validate the strategy token returned by the LLM. Falls back to `full-qa`
 * (the safe default for an ambiguous diff) and warns when a non-empty value
 * was rejected so stale/legacy tokens surface in logs instead of being
 * silently absorbed. */
export function coerceStrategyToken(value: unknown): RecipeStrategyToken {
  if (typeof value === 'string' && (RECIPE_STRATEGY_TOKENS as readonly string[]).includes(value)) {
    return value as RecipeStrategyToken;
  }
  if (typeof value === 'string' && value.length > 0) {
    console.warn(
      `[intelligence] unrecognised recipe-strategy token "${value}" — defaulting to full-qa`,
    );
  }
  return 'full-qa';
}

export async function selectRecipeStrategy(
  diffFiles: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>,
  tier: string,
  ticketData?: RunTicketData | null,
): Promise<RecipeStrategyResult> {
  // Tier ceiling: light tier always gets smoke
  if (tier === 'light') {
    return {
      strategy: {
        strategy: 'smoke',
        reasoning: 'Light tier — no evidence required',
        diffSummary: `${diffFiles.length} files`,
        uiImpact: false,
        mode: 'suggest',
      },
      usage: { provider: 'heuristic', model: 'none', durationMs: 0 },
    };
  }

  // Heuristic fast path: all files are non-UI → smoke
  const allNonUI = diffFiles.every((f) => isNonUIFile(f.filename, f.patch));
  if (allNonUI && diffFiles.length > 0) {
    return {
      strategy: {
        strategy: 'smoke',
        reasoning: 'All changed files are non-UI (tests, config, docs, pure logic)',
        diffSummary: `${diffFiles.length} non-UI files`,
        uiImpact: false,
        mode: 'suggest',
      },
      usage: { provider: 'heuristic', model: 'none', durationMs: 0 },
    };
  }

  // LLM path for ambiguous diffs
  const fileSummary = diffFiles
    .map((f) => `${f.filename} (+${f.additions}/-${f.deletions})`)
    .join('\n');
  const userPrompt = `PR diff files:\n${fileSummary}\n\n${ticketData ? `Title: ${ticketData.title}\nDescription: ${ticketData.description.slice(0, 500)}` : ''}`;

  try {
    const cfg = getLLMConfig();
    const result = await callLLM({
      systemPrompt: RECIPE_STRATEGY_SYSTEM,
      userPrompt,
      model: 'fast',
      provider: cfg.defaultProvider,
    });

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in recipe strategy response');

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      strategy: {
        strategy: coerceStrategyToken(parsed.strategy),
        reasoning: parsed.reasoning ?? '',
        diffSummary: parsed.diffSummary ?? fileSummary.slice(0, 200),
        uiImpact: parsed.uiImpact ?? true,
        mode: 'suggest',
      },
      usage: result.usage,
    };
  } catch (err) {
    console.warn(
      `[intelligence] recipe strategy failed (defaulting to full-qa): ${(err as Error).message}`,
    );
    return {
      strategy: {
        strategy: 'full-qa',
        reasoning: 'LLM classification failed — defaulting to full QA',
        diffSummary: `${diffFiles.length} files`,
        uiImpact: true,
        mode: 'suggest',
      },
      usage: { provider: 'fallback', model: 'none', durationMs: 0 },
    };
  }
}

// ─── Evidence Quality Audit (Phase 2 Pre-Filter) ───

const EVIDENCE_AUDIT_SYSTEM = `You audit the quality of evidence captured for a PR review. For each acceptance criterion, evaluate whether the captured evidence (screenshots, videos) is relevant to the code change and of sufficient quality.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "acVerdicts": [
    { "ac": "acceptance criterion text", "verdict": "RELEVANT_HIGH" | "RELEVANT_LOW" | "IRRELEVANT" | "MISSING", "reasoning": "brief explanation", "evidenceRef": "filename if applicable" }
  ],
  "overallScore": 0-100
}

Verdict definitions:
- RELEVANT_HIGH: Evidence clearly shows the AC is met. Correct screen, readable, demonstrates the claim.
- RELEVANT_LOW: Evidence exists but is poor quality (wrong screen, unreadable, partial, doesn't fully demonstrate).
- IRRELEVANT: Evidence exists but doesn't relate to this AC at all.
- MISSING: No evidence found for this AC.`;

export async function auditEvidenceQuality(
  manifest: {
    summary?: string;
    before_after_pairs?: Array<{ label: string }>;
    standalone?: Array<{ label: string; file: string }>;
  },
  diffFiles: Array<{ filename: string; status: string; additions: number; deletions: number }>,
  acceptanceCriteria: string[],
): Promise<{
  report: import('@farmslot/protocol').EvidenceQualityReport | null;
  usage: StepLLMUsage;
}> {
  if (acceptanceCriteria.length === 0) {
    return {
      report: { acVerdicts: [], overallScore: 100, overrides: [] },
      usage: { provider: 'skip', model: 'none', durationMs: 0 },
    };
  }

  const evidenceList =
    [
      ...(manifest.before_after_pairs ?? []).map((p) => `pair: ${p.label}`),
      ...(manifest.standalone ?? []).map((s) => `standalone: ${s.label} (${s.file})`),
    ].join('\n') || 'No evidence files found';

  const fileSummary = diffFiles.map((f) => f.filename).join('\n');
  const acList = acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n');

  const userPrompt = `Evidence captured:\n${evidenceList}\n\nChanged files:\n${fileSummary}\n\nAcceptance criteria:\n${acList}`;

  try {
    const cfg = getLLMConfig();
    const result = await callLLM({
      systemPrompt: EVIDENCE_AUDIT_SYSTEM,
      userPrompt,
      model: 'standard',
      provider: cfg.defaultProvider,
    });

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in audit response');

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      report: {
        acVerdicts: (parsed.acVerdicts ?? []).map((v: Record<string, string>) => ({
          ac: v.ac ?? '',
          verdict: v.verdict ?? 'MISSING',
          reasoning: v.reasoning ?? '',
          evidenceRef: v.evidenceRef,
        })),
        overallScore: parsed.overallScore ?? 0,
        overrides: [],
      },
      usage: result.usage,
    };
  } catch (err) {
    console.warn(`[intelligence] evidence audit failed (non-fatal): ${(err as Error).message}`);
    return {
      report: null,
      usage: { provider: 'fallback', model: 'none', durationMs: 0 },
    };
  }
}

// ─── Override Rate (Progressive Trust) ───

export function computeOverrideRate(
  runs: Array<{ evidenceQualityReport?: { overrides: unknown[] } | null }>,
): { rate: number; totalRuns: number; overriddenRuns: number } {
  const qualifying = runs.filter(
    (r) => r.evidenceQualityReport && r.evidenceQualityReport.overrides,
  );
  if (qualifying.length === 0) return { rate: 0, totalRuns: 0, overriddenRuns: 0 };

  const overridden = qualifying.filter((r) => r.evidenceQualityReport!.overrides.length > 0).length;
  return {
    rate: overridden / qualifying.length,
    totalRuns: qualifying.length,
    overriddenRuns: overridden,
  };
}

// ─── Task writing ───

export async function generateTaskContent(
  template: string,
  vars: Record<string, string>,
): Promise<string> {
  // Simple variable expansion — no LLM needed
  let content = template;
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}
