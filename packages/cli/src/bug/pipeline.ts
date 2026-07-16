// pipeline.ts — the LLM grade / validity / batch stages of the bug pipeline.
// Wires the `claude` and `gh` edges around the protocol decision cores
// (normalizeLlmGrade, computeFinalScore, normalizeBugValidation, filterBatchIssues).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type BugValidation,
  computeFinalScore,
  filterBatchIssues,
  type FinalScore,
  type LlmGrade,
  normalizeBugValidation,
  normalizeLlmGrade,
  parseLlmJson,
  scoreKeyForGithub,
  scoreKeyForJira,
} from '@farmslot/protocol';
import { getProjectField } from '@farmslot/slot-config';

import { collectBatchRows, renderBatchReport } from './display.js';
import { curlGet, ghJson, runClaude } from './edges.js';
import { isoTimestamp, readScoreFile, writeScoreFile } from './score-file.js';
import { loadProjectContext, type ProjectContext, runTriage, type TriageResult } from './triage.js';

// ── grade ─────────────────────────────────────────────────────────────────────

export interface GradeResult {
  skipped: boolean;
  reason?: string;
  llm?: LlmGrade;
  final?: FinalScore;
}

/** Replace `${KEY}` / `$KEY` tokens for each known variable (envsubst parity, known keys only). */
function substituteEnv(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`\${${key}}`, value).replaceAll(`$${key}`, value);
  }
  return out;
}

export async function runGrade(
  scoreFile: string,
  model: string,
  ctx: ProjectContext,
  now: Date,
): Promise<GradeResult> {
  const gradePromptRel = getProjectField(ctx.vars.projectJson, 'scoring.grade_prompt');
  if (!gradePromptRel) return { skipped: true, reason: 'no scoring.grade_prompt configured' };

  const gradePromptFile = path.join(ctx.projectDir, gradePromptRel);
  const template = await readFile(gradePromptFile, 'utf8').catch(() => {
    throw Object.assign(new Error(`grade prompt file not found: ${gradePromptFile}`), {
      code: 'GRADE_PROMPT_MISSING',
      userAction: 'Point scoring.grade_prompt at an existing template file.',
    });
  });

  const score = await readScoreFile(scoreFile);
  if (!score) {
    throw Object.assign(new Error(`score file not found: ${scoreFile}`), {
      code: 'SCORE_FILE_MISSING',
      userAction: 'Run `farmslot bug triage` first to create the score file.',
    });
  }
  if (score.llm && score.final) {
    return { skipped: true, reason: 'already graded (delete the llm key to force re-run)' };
  }
  if (!score.bug_input) {
    throw Object.assign(new Error('score file missing bug_input section'), {
      code: 'MISSING_BUG_INPUT',
      userAction: 'Re-run `farmslot bug triage` to populate bug_input.',
    });
  }

  const bi = score.bug_input;
  const h = score.heuristic as Record<string, unknown> | undefined;
  const hasHeuristic = Boolean(score.heuristic);
  const vars: Record<string, string> = {
    TITLE: bi.title ?? '',
    DESCRIPTION: (bi.description ?? '').slice(0, 3000),
    LABELS: (bi.labels ?? []).join(', '),
    COMPONENTS: (bi.components ?? []).join(', '),
    SCREENSHOT_COUNT: String((bi.screenshots ?? []).length),
    H_DIFFICULTY: hasHeuristic ? String(h?.['difficulty'] ?? '') : 'n/a',
    H_SCORE: hasHeuristic ? String(h?.['difficulty_score'] ?? 0) : 'n/a',
    H_CATEGORY: hasHeuristic ? String(h?.['category'] ?? '') : 'n/a',
    H_CAT_CONF: hasHeuristic ? String(h?.['category_confidence'] ?? '') : 'n/a',
    H_PROB: hasHeuristic ? String(h?.['one_shot_probability'] ?? 0) : 'n/a',
  };

  const prompt = substituteEnv(template, vars);
  const response = await runClaude(prompt, model);
  const llm = normalizeLlmGrade(parseLlmJson(response));
  const final = computeFinalScore(llm, score.heuristic ?? null);

  score.llm = llm;
  score.final = final;
  score.scored_at = isoTimestamp(now);
  await writeScoreFile(scoreFile, score);
  return { skipped: false, llm, final };
}

// ── validate ────────────────────────────────────────────────────────────────

/** Resolve the GitHub `owner/repo` from ci.repo, falling back to repo_url. */
export function resolveRepo(ctx: ProjectContext): string {
  const ci = getProjectField(ctx.vars.projectJson, 'ci.repo');
  if (ci) return ci;
  const url = getProjectField(ctx.vars.projectJson, 'repo_url');
  return url
    ? url
        .split(':')
        .pop()!
        .replace(/\.git$/, '')
    : '';
}

interface GhComment {
  createdAt?: string;
  author?: { login?: string };
  body?: string;
}
interface GhMergedPr {
  title?: string;
  number?: number;
  mergedAt?: string;
}

async function gatherGithubContext(repo: string, issueNum: string): Promise<string> {
  if (!issueNum) return 'No linked PRs or recent commits found referencing this issue.';
  const parts: string[] = [];

  const mergedPrs = JSON.parse(
    await ghJson([
      'search',
      'prs',
      '--repo',
      repo,
      '--state',
      'merged',
      '--limit',
      '5',
      '--json',
      'title,number,mergedAt',
      `fixes #${issueNum}`,
    ]),
  ) as GhMergedPr[];
  if (mergedPrs.length) {
    parts.push(
      `Merged PRs referencing this issue:\n${mergedPrs
        .map(
          (pr) => `  - PR #${pr.number}: ${pr.title} (merged ${(pr.mergedAt ?? '?').slice(0, 10)})`,
        )
        .join('\n')}`,
    );
  }

  const comments = JSON.parse(
    await ghJson([
      'issue',
      'view',
      issueNum,
      '--repo',
      repo,
      '--json',
      'comments',
      '--jq',
      '.comments[-3:]',
    ]),
  ) as GhComment[];
  if (comments.length) {
    parts.push(
      `Recent comments:\n${comments
        .map(
          (c) =>
            `  ${(c.createdAt ?? '').slice(0, 10)} ${c.author?.login ?? '?'}: ${(c.body ?? '')
              .slice(0, 150)
              .replace(/\n/g, ' ')}`,
        )
        .join('\n')}`,
    );
  }

  return parts.length
    ? parts.join('\n')
    : 'No linked PRs or recent commits found referencing this issue.';
}

export async function runValidate(
  scoreFile: string,
  ctx: ProjectContext,
  now: Date,
): Promise<BugValidation & { validated_at: string }> {
  const repo = resolveRepo(ctx);
  const score = await readScoreFile(scoreFile);
  if (!score) {
    throw Object.assign(new Error(`score file not found: ${scoreFile}`), {
      code: 'SCORE_FILE_MISSING',
      userAction: 'Run `farmslot bug triage` first to create the score file.',
    });
  }
  const bi = score.bug_input;
  const issueRef = score.issue_ref ?? '';
  const issueNum = issueRef.includes('#') ? issueRef.split('#').pop()! : '';
  const githubContext = await gatherGithubContext(repo, issueNum);

  const prompt = `Assess whether this bug is likely still valid (unfixed) or already resolved.

ISSUE: ${issueRef}
TITLE: ${bi?.title ?? ''}
STATE: ${bi?.state ?? 'open'}
LABELS: ${(bi?.labels ?? []).join(', ')}

DESCRIPTION (truncated):
${(bi?.description ?? '').slice(0, 3000)}

GITHUB ACTIVITY:
${githubContext}

Based on the above, determine:
1. Is this bug likely STILL VALID (present in codebase) or LIKELY FIXED/EXPIRED?
2. Your confidence level (0.0 = no idea, 1.0 = certain)
3. Brief reason (1-2 sentences)

Consider:
- If merged PRs explicitly fix this issue, it's likely fixed
- If no activity and the issue is old (>6 months), it may be stale but not necessarily fixed
- If the description references specific code/UI that still exists, it's likely still valid
- Issues about missing features vs bugs in existing features age differently

Respond ONLY with valid JSON, no markdown:
{"still_valid": true, "confidence": 0.8, "reason": "No merged PRs reference this issue and the described UI component still exists."}`;

  const response = await runClaude(prompt, 'haiku');
  let parsed: unknown;
  try {
    parsed = parseLlmJson(response);
  } catch {
    // Match validate-bug.sh: an unparseable validity response degrades to a
    // conservative "still valid, unknown confidence" record rather than failing.
    parsed = { still_valid: true, confidence: 0, reason: 'LLM response unparseable' };
  }
  const validation = { ...normalizeBugValidation(parsed), validated_at: isoTimestamp(now) };
  score.validation = validation;
  await writeScoreFile(scoreFile, score);
  return validation;
}

// ── batch ─────────────────────────────────────────────────────────────────────

export interface BatchOptions {
  source: 'github' | 'jira';
  label: string[];
  team?: string;
  jql?: string;
  limit: number;
  since?: string;
  maxAge?: number;
  excludeAssigned: boolean;
  parallel: number;
  rescore: boolean;
  validate: boolean;
  downloadImages?: string;
  now: Date;
}

export interface BatchResult {
  scoresDir: string;
  repo: string;
  displayLabels: string;
  total: number;
  scored: number;
  skipped: number;
  failed: number;
  /** Per-issue failures — surfaced to the operator, never silently dropped. */
  failures: Array<{ ref: string; error: string; code?: string; userAction?: string }>;
  report: string;
  keys: string[];
  /** Keys whose score file reflects THIS run (newly scored or skipped-with-existing).
   * Failed issues are excluded — with --rescore a failure can leave a STALE score
   * file on disk, and downstream consumers (the enqueue bridge) must not act on it. */
  scoredKeys: string[];
}

/**
 * Canonical score-key form of a failure identifier, so dedup compares like with
 * like: the triage stage records a human ref (`owner/repo#N` or `JIRA-KEY`) while
 * the display stage reports the score-file key (`gh-N` / lowercased jira). Both
 * collapse to the same key here.
 */
function canonicalFailureKey(ref: string): string {
  const gh = ref.match(/#(\d+)$/) ?? ref.match(/\/issues\/(\d+)/);
  return gh ? scoreKeyForGithub(gh[1]) : scoreKeyForJira(ref);
}

/** Build a per-item failure record, carrying the error's structured code/userAction when present. */
function toFailure(ref: string, err: unknown): BatchResult['failures'][number] {
  const e = err as { code?: unknown; userAction?: unknown };
  return {
    ref,
    error: err instanceof Error ? err.message : String(err),
    code: typeof e.code === 'string' ? e.code : undefined,
    userAction: typeof e.userAction === 'string' ? e.userAction : undefined,
  };
}

interface NormalizedIssue {
  ref: string; // triage ref (owner/repo#N or JIRA-KEY)
  key: string; // score-file key (gh-N or jira-key lowercased)
  updatedAt?: string;
  assigned?: boolean;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function fetchGithubIssues(
  repo: string,
  labels: string[],
  team: string | undefined,
  limit: number,
  filter: { since?: string; excludeAssigned: boolean },
): Promise<NormalizedIssue[]> {
  if (team) {
    const teamLabel = `team-${team}`;
    const existing = (
      await ghJson([
        'label',
        'list',
        '--repo',
        repo,
        '--search',
        teamLabel,
        '--limit',
        '10',
        '--json',
        'name',
        '--jq',
        '.[].name',
      ])
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!existing.includes(teamLabel)) {
      throw Object.assign(new Error(`label '${teamLabel}' not found in ${repo}`), {
        code: 'TEAM_LABEL_NOT_FOUND',
        userAction: `Pick an existing team label; candidates: ${existing.join(', ') || '(none)'}.`,
      });
    }
  }

  const args = [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    String(limit),
    '--json',
    'number,title,labels,assignees,updatedAt',
  ];
  for (const label of labels) args.push('--label', label);
  const raw = JSON.parse(await ghJson(args)) as Array<{
    number: number;
    assignees?: unknown[];
    updatedAt?: string;
  }>;
  const normalized = raw.map((i) => ({
    ref: `${repo}#${i.number}`,
    key: scoreKeyForGithub(String(i.number)),
    updatedAt: i.updatedAt,
    assigned: Array.isArray(i.assignees) && i.assignees.length > 0,
  }));
  return filterBatchIssues(normalized, {
    since: filter.since,
    excludeAssigned: filter.excludeAssigned,
  });
}

async function fetchJiraIssues(
  ctx: ProjectContext,
  opts: BatchOptions,
): Promise<NormalizedIssue[]> {
  const jiraProject = getProjectField(ctx.vars.projectJson, 'jira.project');
  const baseUrl = getProjectField(ctx.vars.projectJson, 'jira.base_url');
  if (!jiraProject || !baseUrl) {
    throw Object.assign(new Error('jira.project and jira.base_url must be set in project.json'), {
      code: 'JIRA_CONFIG_MISSING',
      userAction: 'Add jira.project and jira.base_url to the project.json.',
    });
  }
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;
  if (!email || !token) {
    throw Object.assign(new Error('JIRA_EMAIL and JIRA_TOKEN environment variables are required'), {
      code: 'JIRA_ENV_MISSING',
      userAction: 'Export JIRA_EMAIL and JIRA_TOKEN, then re-run.',
    });
  }

  let jql = `project = ${jiraProject} AND type = Bug AND status != Done`;
  if (opts.team) jql += ` AND labels = "team-${opts.team}"`;
  if (opts.since) jql += ` AND updated >= "${opts.since}"`;
  if (opts.excludeAssigned) jql += ' AND assignee is EMPTY';
  if (opts.jql) jql += ` AND ${opts.jql}`;
  jql += ' ORDER BY updated DESC';

  const url = `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${opts.limit}&fields=key,summary,labels,assignee,updated,description,status`;
  const raw = JSON.parse(
    await curlGet(url, {
      basicAuth: `${email}:${token}`,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as {
    errorMessages?: string[];
    issues?: Array<{ key: string; fields?: { updated?: string; assignee?: unknown } }>;
  };
  if (raw.errorMessages) {
    throw Object.assign(new Error(`Jira API error: ${JSON.stringify(raw.errorMessages)}`), {
      code: 'JIRA_API_ERROR',
      userAction: 'Check JIRA_EMAIL/JIRA_TOKEN and the JQL/base URL.',
    });
  }
  return (raw.issues ?? []).map((i) => ({
    ref: i.key,
    key: scoreKeyForJira(i.key),
    updatedAt: i.fields?.updated,
    assigned: i.fields?.assignee != null,
  }));
}

export async function runBatch(project: string, opts: BatchOptions): Promise<BatchResult> {
  const ctx = await loadProjectContext(project);
  const repo = resolveRepo(ctx);

  const labels = [...opts.label];
  if (opts.team) labels.push(`team-${opts.team}`);
  if (opts.source === 'github' && labels.length === 0) labels.push('type-bug');

  const scoresDir = opts.team
    ? path.join(ctx.projectDir, 'scores', `team-${opts.team}`)
    : path.join(ctx.projectDir, 'scores');

  let since = opts.since;
  if (opts.maxAge != null) {
    if (since) {
      throw Object.assign(new Error('--since and --max-age are mutually exclusive'), {
        code: 'USAGE_ERROR',
        userAction: 'Pass only one of --since or --max-age.',
      });
    }
    since = new Date(opts.now.getTime() - opts.maxAge * 86400000).toISOString().slice(0, 10);
  }

  let issues: NormalizedIssue[];
  if (opts.source === 'github') {
    if (!repo) {
      throw Object.assign(new Error('cannot resolve GitHub repo from project.json'), {
        code: 'REPO_MISSING',
        userAction: 'Set ci.repo (or repo_url) in the project.json.',
      });
    }
    issues = await fetchGithubIssues(repo, labels, opts.team, opts.limit, {
      since,
      excludeAssigned: opts.excludeAssigned,
    });
  } else {
    issues = await fetchJiraIssues(ctx, { ...opts, since });
  }

  const displayLabels = labels.join(', ');
  const total = issues.length;
  let scored = 0;
  let skipped = 0;
  const failures: BatchResult['failures'] = [];
  // Record a per-item failure once per issue, deduped at append time on the
  // canonical score key. The same corrupt score file can surface in more than one
  // stage — the triage skip-check, the validation re-read, and the display
  // re-read all read scores/<key>.json — and each stage identifies it differently
  // (triage by owner/repo#N, the later stages by gh-N); this keeps failed=1.
  const seenFailures = new Set<string>();
  const addFailure = (ref: string, err: unknown): void => {
    const canonical = canonicalFailureKey(ref);
    if (seenFailures.has(canonical)) return;
    seenFailures.add(canonical);
    failures.push(toFailure(ref, err));
  };

  const scoredKeys: string[] = [];
  if (total > 0) {
    const results = await mapPool(issues, opts.parallel, async (issue) => {
      // One malformed issue must not abort the batch, but its failure is
      // captured and reported — not swallowed. The error is surfaced in
      // BatchResult.failures and printed by the command layer.
      try {
        const result: TriageResult = await runTriage(
          {
            ...(opts.source === 'github' ? { github: issue.ref } : { jira: issue.ref }),
            project,
            scoresDir,
            skipExisting: !opts.rescore,
            downloadImages: opts.downloadImages,
            now: opts.now,
          },
          ctx,
        );
        return {
          status: result.skipped ? ('skip' as const) : ('ok' as const),
          ref: issue.ref,
          key: issue.key,
        };
      } catch (err) {
        return { status: 'fail' as const, ref: issue.ref, key: issue.key, err };
      }
    });
    for (const r of results) {
      if (r.status === 'fail') addFailure(r.ref, r.err);
      else if (r.status === 'skip') {
        skipped++;
        scoredKeys.push(r.key);
      } else {
        scored++;
        scoredKeys.push(r.key);
      }
    }
  }

  if (opts.validate) {
    const files = await listScoreFiles(scoresDir);
    for (const file of files) {
      const scoreFile = path.join(scoresDir, file);
      // One issue's failure — including an unreadable/corrupt score file — must
      // not abort the rest. The read+parse is inside the try so those files are
      // captured as per-item failures, matching batch-triage.sh which validated
      // every issue and reported failures at the end.
      try {
        if (!opts.rescore) {
          const existing = await readScoreFile(scoreFile);
          if (existing?.validation) continue;
        }
        await runValidate(scoreFile, ctx, opts.now);
      } catch (err) {
        addFailure(file.replace(/\.json$/, ''), err);
      }
    }
  }

  // A corrupt score file re-read at the display stage must also be reported
  // per-item, not abort runBatch and discard the failures gathered above.
  const rows = await collectBatchRows(
    scoresDir,
    issues.map((i) => i.key),
    (key, err) => addFailure(key, err),
  );
  const report = renderBatchReport(rows, { repo, displayLabels });

  return {
    scoresDir,
    repo,
    displayLabels,
    total,
    scored,
    skipped,
    failed: failures.length,
    failures,
    report,
    keys: issues.map((i) => i.key),
    scoredKeys,
  };
}

/** List `*.json` score files in a directory; a missing directory yields none. */
async function listScoreFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
