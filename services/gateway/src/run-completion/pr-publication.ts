// run-completion/pr-publication.ts — PR comment, title, and ready-state mutations.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { type FlowType, modelsMatch, type Run } from '@farmslot/protocol';

import { loadProjectVars } from '../core/config.js';
import { ghRequest } from '../integrations/github-client.js';
import { formatPrTitleSuffix } from '../tasks/writer.js';

import { localPrBodyPathResidues } from './publication-artifacts.js';

// ─── PR comment ───

export function prCommentIdentityMarker(runId: string): string {
  return `<!-- farmslot-run:${runId} -->`;
}

export function prCommentBelongsToRun(body: string, runId: string): boolean {
  return (
    body.includes(prCommentIdentityMarker(runId)) ||
    body.includes(`| Run | \`${runId.slice(0, 8)}\` |`)
  );
}

export function paginatedPrCommentOutputContainsRun(output: string, runId: string): boolean {
  return output
    .split('\n')
    .filter(Boolean)
    .some((line) => prCommentBelongsToRun(JSON.parse(line) as string, runId));
}

export function shouldPostWorkerReportComment(flowType: FlowType): boolean {
  // dev/fix-bug use pr-description.md as their sole outcome artifact. It is
  // published as the PR body, so reposting it as a comment duplicates the
  // content and can expose local evidence paths before body post-processing.
  return flowType !== 'dev' && flowType !== 'fix-bug';
}

function formatDuration(ms: number | undefined): string {
  if (!ms) return '?';
  return `${Math.round(ms / 60000)}m`;
}

async function buildPRCommentHardcoded(
  run: Run,
  report: string | null,
  workflowMmd: string | null,
): Promise<string> {
  const durationMin = formatDuration(run.metrics.durationMs);

  const sections: string[] = [
    `## Automated ${run.flowType} run — ${run.ticketOrPr}`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Run | \`${run.id.slice(0, 8)}\` |`,
    `| Duration | ${durationMin} |`,
    `| Model | ${run.metrics.runner ?? ''}/${run.metrics.model ?? ''} |`,
    `| Nudges | ${run.metrics.nudgeCount} |`,
  ];

  if (run.grade) {
    sections.push(`| Difficulty | ${run.grade.difficulty} (${run.grade.score ?? '-'}/10) |`);
    sections.push(`| Grade rationale | ${run.grade.rationale} |`);
  }

  if (run.metrics.costEstimate) {
    sections.push(`| Cost estimate | $${run.metrics.costEstimate.toFixed(2)} |`);
  }
  if (run.metrics.sessionTurns) {
    const tokenParts: string[] = [];
    if (run.metrics.sessionInputTokens)
      tokenParts.push(`in=${run.metrics.sessionInputTokens.toLocaleString()}`);
    if (run.metrics.sessionOutputTokens)
      tokenParts.push(`out=${run.metrics.sessionOutputTokens.toLocaleString()}`);
    if (run.metrics.sessionCacheRead)
      tokenParts.push(`cache-read=${run.metrics.sessionCacheRead.toLocaleString()}`);
    if (run.metrics.sessionCacheCreation)
      tokenParts.push(`cache-write=${run.metrics.sessionCacheCreation.toLocaleString()}`);
    sections.push(`| Session | ${run.metrics.sessionTurns} turns · ${tokenParts.join(' · ')} |`);
  }
  if (run.metrics.actualModel && !modelsMatch(run.metrics.model, run.metrics.actualModel)) {
    sections.push(
      `| Model drift | dispatched \`${run.metrics.model ?? '?'}\`, ran \`${run.metrics.actualModel}\` |`,
    );
  }

  if (report) {
    sections.push('', '<details><summary>Worker report</summary>', '', report, '', '</details>');
  }

  if (workflowMmd) {
    sections.push(
      '',
      '<details><summary>Recipe workflow diagram</summary>',
      '',
      '```mermaid',
      workflowMmd,
      '```',
      '',
      '</details>',
    );
  }

  return sections.join('\n');
}

async function buildPRComment(
  run: Run,
  report: string | null,
  workflowMmd: string | null,
): Promise<string> {
  const { loadPromptTemplate } = await import('../core/prompt-templates.js');

  const template = await loadPromptTemplate(run.project, 'pr-comment.md', {
    RUN_ID: run.id.slice(0, 8),
    FLOW_TYPE: run.flowType,
    TICKET: run.ticketOrPr,
    DURATION: formatDuration(run.metrics.durationMs),
    MODEL: run.metrics.model ?? 'unknown',
    RUNNER: run.metrics.runner ?? 'claude',
    NUDGE_COUNT: String(run.metrics.nudgeCount ?? 0),
    GRADE_DIFFICULTY: run.grade?.difficulty ?? 'ungraded',
    GRADE_SCORE: String(run.grade?.score ?? '-'),
    GRADE_RATIONALE: run.grade?.rationale ?? '',
    COST: run.metrics.costEstimate?.toFixed(4) ?? 'unknown',
    WORKER_REPORT: report ?? 'No report available.',
    WORKFLOW_DIAGRAM: workflowMmd ?? '',
  });

  if (!template) return buildPRCommentHardcoded(run, report, workflowMmd);

  try {
    const { callLLM } = await import('../llm/index.js');
    const { getLLMConfig } = await import('../llm/config.js');
    const cfg = getLLMConfig();
    const result = await callLLM({
      systemPrompt: template,
      userPrompt: 'Generate the PR comment.',
      model: cfg.intelligenceModel,
      provider: cfg.defaultProvider,
    });
    if (result.text.length > 50 && result.text.length < 10000) {
      return result.text;
    }
    console.warn(
      `[run-completion] LLM pr-comment output out of bounds (${result.text.length} chars), using hardcoded`,
    );
  } catch (err) {
    console.warn(
      `[run-completion] LLM pr-comment failed, using hardcoded: ${(err as Error).message}`,
    );
  }

  return buildPRCommentHardcoded(run, report, workflowMmd);
}

export async function postPRComment(
  run: Run,
  report: string | null,
  ciRepo: string,
  prNumber: number,
  options: { failOnError?: boolean } = {},
): Promise<boolean> {
  // Defensive short-circuit — callers already gate on a non-empty report,
  // but this catches any future caller that forgets so we never post a
  // comment whose Worker report section is literally "No report available.".
  if (!report || report.trim().length === 0) {
    console.log(
      `[run-completion] postPRComment refused for ${run.id.slice(0, 8)}: report=${report ? 'empty' : 'null'}`,
    );
    return false;
  }
  try {
    // Read workflow diagram if present
    let workflowMmd: string | null = null;
    if (run.taskFile) {
      const mmdPath = path.join(path.dirname(run.taskFile), 'artifacts', 'workflow.mmd');
      if (existsSync(mmdPath)) {
        try {
          workflowMmd = (await readFile(mmdPath, 'utf-8')).trim();
        } catch (err) {
          if (options.failOnError) throw err;
          console.warn(
            `[run-completion] workflow diagram read failed: ${(err as Error).message.slice(0, 200)}`,
          );
        }
      }
    }

    const generatedComment = await buildPRComment(run, report, workflowMmd);
    const identityMarker = prCommentIdentityMarker(run.id);
    const comment = generatedComment.includes(identityMarker)
      ? generatedComment
      : `${identityMarker}\n${generatedComment}`;
    const localResidues = localPrBodyPathResidues(comment);
    if (localResidues.length > 0) {
      const message = `PR comment still contains local artifact path(s): ${localResidues.join(', ')}`;
      if (options.failOnError) throw new Error(message);
      console.warn(`[run-completion] skipping PR comment: ${message}`);
      return false;
    }

    const tmpFile = `/tmp/farmslot-pr-comment-${run.id.slice(0, 8)}.md`;
    await writeFile(tmpFile, comment, 'utf-8');

    // A replay after posting must be idempotent for this run, while a distinct
    // run on the same PR may still publish its own report.
    try {
      const existing = await ghRequest([
        'api',
        '--paginate',
        `repos/${ciRepo}/issues/${prNumber}/comments`,
        '--jq',
        '.[].body | @json',
      ]);
      const alreadyPosted = paginatedPrCommentOutputContainsRun(existing.stdout, run.id);
      if (alreadyPosted) {
        console.log(`[run-completion] comment already posted for run ${run.id.slice(0, 8)}`);
        return true;
      }
    } catch (err) {
      if (options.failOnError) throw err;
      console.warn(`[run-completion] bot comment dedup check failed: ${(err as Error).message}`);
    }

    await ghRequest(['pr', 'comment', String(prNumber), '--repo', ciRepo, '--body-file', tmpFile], {
      force: true,
    });
    console.log(`[run-completion] posted comment on PR #${prNumber}`);
    return true;
  } catch (err) {
    if (options.failOnError) throw err;
    console.warn(`[run-completion] PR comment failed: ${(err as Error).message}`);
    return false;
  }
}

// ─── PR title ───

export async function updatePRTitle(run: Run, ciRepo: string, prNumber: number): Promise<void> {
  if (!run.ticketData?.title) return;

  const pv = await loadProjectVars(run.project).catch(() => null);

  // Build conventional commit title: fix(scope): description, preserving any
  // configured human-gate suffix without breaking Conventional Commit title linters.
  const commitType = run.flowType === 'fix-bug' ? 'fix' : run.flowType === 'dev' ? 'feat' : 'chore';
  const scope = pv?.projectJson.ci?.default_scope || '';
  const scopePart = scope ? `(${scope})` : '';
  const titleSuffix = formatPrTitleSuffix(pv?.projectJson.ci?.pr_title_suffix);
  // Use ticket title, lowercased first char, strip trailing period
  let desc = run.ticketData.title;
  desc = desc.charAt(0).toLowerCase() + desc.slice(1);
  desc = desc.replace(/\.$/, '');
  const newTitle = `${commitType}${scopePart}: ${desc}${titleSuffix}`;

  try {
    // Check current title — only update if it looks like a ticket ID
    const prResult = await ghRequest([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      ciRepo,
      '--json',
      'title',
    ]);
    const current = JSON.parse(prResult.stdout || '{}').title ?? '';
    // Update if current title contains just the ticket ID (e.g. "fix(perps): PROJ-2418")
    const ticketId = run.ticketOrPr.toUpperCase();
    if (current.includes(ticketId) && !current.includes(run.ticketData.title.slice(0, 20))) {
      await ghRequest(['pr', 'edit', String(prNumber), '--repo', ciRepo, '--title', newTitle], {
        force: true,
      });
      console.log(`[run-completion] updated PR #${prNumber} title: ${newTitle}`);
    }
  } catch (err) {
    console.warn(`[run-completion] PR title update failed: ${(err as Error).message}`);
  }
}

// ─── Mark PR ready for review ───

export async function markPRReady(ciRepo: string, prNumber: number): Promise<void> {
  await ghRequest(['pr', 'ready', String(prNumber), '--repo', ciRepo], { force: true });
  console.log(`[run-completion] marked PR #${prNumber} as ready for review`);
}
