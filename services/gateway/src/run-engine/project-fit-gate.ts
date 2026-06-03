import {
  parseGitHubRef,
  type ProjectConfig,
  type Run,
  type RunTicketData,
} from '@farmslot/protocol';

import { loadProjectConfigs } from '../fleet/state.js';
import { normalizeTicketRef } from '../methods/dispatch/ticket-ref.js';

type ProjectMismatchCandidate = {
  name: string;
  repo: string | null;
  apps: string[];
};

type ProjectFitSelection = {
  suggestedProject: string | null;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
};

type ProjectFitSelector = (
  run: Run,
  ticketData: RunTicketData | null,
  normalizedTicket: string,
  candidates: ProjectMismatchCandidate[],
) => Promise<ProjectFitSelection>;

export async function detectProjectMismatch(
  run: Run,
  ticketData: RunTicketData | null,
): Promise<{
  suggestedProject: string;
  normalizedTicket?: string;
  confidence?: string;
  rationale: string;
} | null> {
  if (!run.ticketOrPr || /^EVAL-[A-Z0-9][A-Z0-9-]{3,79}$/.test(run.ticketOrPr)) return null;

  const configs = await loadProjectConfigs();
  return detectProjectMismatchForConfigs(run, ticketData, configs, selectProjectForTicket);
}

export async function detectProjectMismatchForConfigs(
  run: Run,
  ticketData: RunTicketData | null,
  configs: ProjectConfig[],
  selectProject: ProjectFitSelector = selectProjectForTicket,
): Promise<{
  suggestedProject: string;
  normalizedTicket?: string;
  confidence?: string;
  rationale: string;
} | null> {
  if (!run.ticketOrPr || /^EVAL-[A-Z0-9][A-Z0-9-]{3,79}$/.test(run.ticketOrPr)) return null;

  const normalizedTicket = normalizeTicketRef(run.ticketOrPr);
  const candidates = findProjectMismatchCandidates(normalizedTicket, configs);
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    const [candidate] = candidates;
    if (candidate.name === run.project) return null;
    return {
      suggestedProject: candidate.name,
      normalizedTicket,
      confidence: 'high',
      rationale: 'Only one configured project matches this ticket prefix/repo.',
    };
  }

  let selection: ProjectFitSelection;
  try {
    selection = await selectProject(run, ticketData, normalizedTicket, candidates);
  } catch (err) {
    // Project-fit classification is an advisory safety gate. If the selector is
    // unavailable, fall back to deterministic metadata instead of blocking every
    // ambiguous shared-prefix ticket.
    console.warn(
      `[run-engine] project fit selector failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
    );
    selection = selectProjectForTicketByMetadata(ticketData, candidates);
  }
  if (!selection.suggestedProject || selection.suggestedProject === run.project) return null;
  if (selection.confidence === 'low') return null;
  return {
    suggestedProject: selection.suggestedProject,
    normalizedTicket,
    confidence: selection.confidence,
    rationale: selection.rationale,
  };
}

function findProjectMismatchCandidates(
  normalizedTicket: string,
  configs: ProjectConfig[],
): ProjectMismatchCandidate[] {
  const ghRef = parseGitHubRef(normalizedTicket);
  if (ghRef) {
    return configs
      .filter((config) => config.ci?.repo?.toLowerCase() === ghRef.repo.toLowerCase())
      .map(projectMismatchCandidate);
  }

  const jiraMatch = normalizedTicket.match(/^([A-Z][A-Z0-9]*)-\d+$/);
  if (!jiraMatch) return [];
  const prefix = jiraMatch[1];
  return configs.filter((config) => config.jira?.project === prefix).map(projectMismatchCandidate);
}

function projectMismatchCandidate(config: ProjectConfig): ProjectMismatchCandidate {
  return {
    name: config.name,
    repo: config.ci?.repo || null,
    apps: config.apps ?? [],
  };
}

async function selectProjectForTicket(
  run: Run,
  ticketData: RunTicketData | null,
  normalizedTicket: string,
  candidates: ProjectMismatchCandidate[],
): Promise<ProjectFitSelection> {
  try {
    const selection = await selectProjectForTicketWithLlm(
      run,
      ticketData,
      normalizedTicket,
      candidates,
    );
    if (selection) return selection;
  } catch (err) {
    // The run-engine gate must never block just because the advisory classifier is offline.
    // Fall back to deterministic metadata tokens so wrong-farm launches still get caught
    // when project names/repos are explicit in the ticket.
    console.warn(
      `[run-engine] project fit LLM validation failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
    );
  }
  return selectProjectForTicketByMetadata(ticketData, candidates);
}

async function selectProjectForTicketWithLlm(
  run: Run,
  ticketData: RunTicketData | null,
  normalizedTicket: string,
  candidates: ProjectMismatchCandidate[],
): Promise<ProjectFitSelection | null> {
  // Dynamic imports keep the gateway startup path independent from optional LLM-provider
  // packages; any provider/auth failure is caught by the caller and downgraded to the
  // deterministic metadata gate.
  const [{ getLLMConfig }, { callLLM }] = await Promise.all([
    import('../llm/config.js'),
    import('../llm/index.js'),
  ]);
  const cfg = getLLMConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_500);
  try {
    const result = await callLLM({
      provider: cfg.defaultProvider,
      model: cfg.intelligenceModel,
      allowCliFallback: false,
      maxTokens: 320,
      signal: controller.signal,
      systemPrompt:
        'You are a dispatch safety classifier. Choose the configured project whose repo/app surface best matches the ticket. Return only compact JSON.',
      userPrompt: buildProjectFitPrompt(run, ticketData, normalizedTicket, candidates),
    });
    return normalizeProjectFitSelection(result.text, candidates);
  } finally {
    clearTimeout(timeout);
  }
}

function buildProjectFitPrompt(
  run: Run,
  ticketData: RunTicketData | null,
  normalizedTicket: string,
  candidates: ProjectMismatchCandidate[],
): string {
  return JSON.stringify(
    {
      instruction:
        'Pick the best project for this ticket. If the ticket does not clearly identify one candidate, use null/low. Respond as {"suggestedProject":string|null,"confidence":"low|medium|high","rationale":"short"}.',
      currentProject: run.project,
      flowType: run.flowType,
      ticket: {
        ref: normalizedTicket,
        source: ticketData?.source ?? null,
        issueType: ticketData?.issueType ?? null,
        title: ticketData?.title ?? '',
        affectedArea: ticketData?.affectedArea ?? '',
        labels: ticketData?.labels ?? [],
        acceptanceCriteria: ticketData?.acceptanceCriteria ?? [],
        description: truncateForPrompt(ticketData?.description ?? '', 1_200),
      },
      candidates,
    },
    null,
    2,
  );
}

function normalizeProjectFitSelection(
  text: string,
  candidates: ProjectMismatchCandidate[],
): ProjectFitSelection | null {
  const jsonText = extractJsonObjectText(text);
  if (!jsonText) return null;
  const parsed = JSON.parse(jsonText) as {
    suggestedProject?: unknown;
    confidence?: unknown;
    rationale?: unknown;
  };
  const suggestedProject =
    typeof parsed.suggestedProject === 'string' &&
    candidates.some((candidate) => candidate.name === parsed.suggestedProject)
      ? parsed.suggestedProject
      : null;
  const confidence =
    parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
      ? parsed.confidence
      : 'low';
  const rationale =
    typeof parsed.rationale === 'string' && parsed.rationale.trim()
      ? parsed.rationale.trim()
      : 'Ticket metadata did not clearly identify a project.';
  return { suggestedProject, confidence, rationale };
}

function extractJsonObjectText(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : null;
}

function selectProjectForTicketByMetadata(
  ticketData: RunTicketData | null,
  candidates: ProjectMismatchCandidate[],
): ProjectFitSelection {
  const haystack = tokenizeProjectFitText([
    ticketData?.title,
    ticketData?.affectedArea,
    ...(ticketData?.labels ?? []),
    ...(ticketData?.acceptanceCriteria ?? []),
    ticketData?.description,
  ]);
  const scored = candidates.map((candidate) => ({
    candidate,
    score: candidateTokens(candidate).filter((token) => haystack.has(token)).length,
  }));
  const [best, second] = scored.sort((a, b) => b.score - a.score);
  if (!best || best.score === 0 || (second && second.score === best.score)) {
    return {
      suggestedProject: null,
      confidence: 'low',
      rationale: 'Ticket metadata does not uniquely match a configured project.',
    };
  }
  return {
    suggestedProject: best.candidate.name,
    confidence: best.score >= 2 ? 'high' : 'medium',
    rationale: `Ticket metadata mentions ${best.candidate.name.replace(/-farm$/, '')}.`,
  };
}

function candidateTokens(candidate: ProjectMismatchCandidate): string[] {
  return [
    ...tokenizeProjectFitText([
      candidate.name.replace(/-farm$/, ''),
      candidate.repo,
      ...candidate.apps,
    ]),
  ].filter((token) => !PROJECT_FIT_STOP_WORDS.has(token));
}

function tokenizeProjectFitText(values: Array<string | null | undefined>): Set<string> {
  const joined = values.filter((value): value is string => typeof value === 'string').join(' ');
  return new Set(
    joined
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !PROJECT_FIT_STOP_WORDS.has(token)),
  );
}

function truncateForPrompt(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

const PROJECT_FIT_STOP_WORDS = new Set([
  'app',
  'apps',
  'farm',
  'example-app',
  'repo',
  'project',
  'task',
  'ticket',
]);
