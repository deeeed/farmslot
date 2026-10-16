import path from 'node:path';

import { isRecord } from '@farmslot/protocol';

import {
  readContainedJsonArtifact,
  readContainedTextArtifact,
  runnerRevision,
} from '../artifact-files.js';
import { countRecipeNodes } from '../run-engine.js';

export interface TaskArtifactsMarkdownInput {
  taskDir: string;
  /** Exact package already selected by the caller; never reselect an attempt here. */
  artifactDir?: string;
  /** Invocation displayed above the retained run log. */
  command?: string;
}

interface MarkdownArtifact {
  path: string;
}

interface MarkdownRecipeArtifact extends MarkdownArtifact {
  nodes: number;
}

export interface TaskArtifactsMarkdownResult {
  body: string;
  sections: string[];
  recipe: MarkdownRecipeArtifact | null;
  run: MarkdownArtifact | null;
  workflow: MarkdownArtifact | null;
}

const RECIPE_HEADING = '## **Validation Recipe**';
const LOGS_HEADING = '## **Validation Logs**';
const WORKFLOW_HEADING = '## **Recipe Workflow**';
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

function headingKey(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const MACHINE_KEYS = new Set([RECIPE_HEADING, LOGS_HEADING, WORKFLOW_HEADING].map(headingKey));

function fenced(content: string, info = ''): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${content.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n${fence}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function optionalText(root: string, file: string): Promise<string | undefined> {
  try {
    return await readContainedTextArtifact(root, file, MAX_ARTIFACT_BYTES, file);
  } catch (error) {
    // Static tasks legitimately lack a recipe, run report or workflow diagram.
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function trimEnd(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end -= 1;
  return lines.slice(0, end);
}

/** Render authored PR prose and existing evidence without executing or publishing it. */
export async function renderTaskArtifactsMarkdown(
  input: TaskArtifactsMarkdownInput,
): Promise<TaskArtifactsMarkdownResult> {
  const artifacts = path.join(input.taskDir, 'artifacts');
  const prose = await optionalText(artifacts, 'pr-description.md');
  if (prose === undefined) {
    throw new Error('Missing artifacts/pr-description.md: write the PR description there first.');
  }
  const recipeRoot = input.artifactDir ?? artifacts;
  const reportRoot = input.artifactDir ?? path.join(artifacts, 'recipe-run');
  const recipeText = await optionalText(recipeRoot, 'recipe.json');
  const report = await optionalText(reportRoot, 'report.md');
  if (input.artifactDir && (recipeText === undefined || report === undefined))
    throw new Error('Selected artifact package must contain its captured recipe and report.');
  const provenance: string[] = [];
  if (input.artifactDir) {
    const summary = await readContainedJsonArtifact<unknown>(
      recipeRoot,
      'summary.json',
      MAX_ARTIFACT_BYTES,
      'Recipe summary',
    );
    const resolution = await readContainedJsonArtifact<unknown>(
      recipeRoot,
      'recipe-resolution.json',
      MAX_ARTIFACT_BYTES,
      'Recipe resolution',
    );
    if (isRecord(summary)) {
      if (typeof summary.recipeRunId === 'string')
        provenance.push(`Run: ${escapeHtml(summary.recipeRunId)}`);
      if (isRecord(summary.runner)) {
        const runner = summary.runner;
        const revision = runnerRevision(runner);
        if (typeof runner.name === 'string') provenance.push(`Runner: ${escapeHtml(runner.name)}`);
        if (typeof revision === 'string')
          provenance.push(`Runner revision: ${escapeHtml(revision)}`);
      }
    }
    if (
      isRecord(resolution) &&
      isRecord(resolution.root) &&
      typeof resolution.root.digest === 'string'
    )
      provenance.push(`Recipe digest: ${escapeHtml(resolution.root.digest)}`);
  }
  const workflow = await optionalText(artifacts, 'workflow.mmd');
  const machine: Array<[string, string]> = [];
  let recipe: TaskArtifactsMarkdownResult['recipe'] = null;
  if (recipeText !== undefined) {
    const document: unknown = JSON.parse(recipeText);
    const nodes = countRecipeNodes(document) ?? 0;
    const title = isRecord(document)
      ? typeof document.title === 'string'
        ? document.title
        : typeof document.description === 'string'
          ? document.description
          : ''
      : '';
    recipe = { nodes, path: path.relative(input.taskDir, path.join(recipeRoot, 'recipe.json')) };
    const summary = escapeHtml(
      `recipe.json (${nodes} nodes${title ? ` — ${title.slice(0, 120)}` : ''})`,
    );
    machine.push([
      RECIPE_HEADING,
      [
        `<details><summary>${summary}</summary>`,
        '',
        fenced(JSON.stringify(document, null, 2), 'json'),
        '</details>',
      ].join('\n'),
    ]);
  } else {
    machine.push([
      RECIPE_HEADING,
      `Not applicable: this task has no \`${path.relative(input.taskDir, path.join(recipeRoot, 'recipe.json'))}\`.`,
    ]);
  }
  if (report !== undefined) {
    const status = /^Status:\s*(\S+)/m.exec(report)?.[1];
    const nodes = /^Nodes:\s*(.+?)\s*$/m.exec(report)?.[1];
    const summary = escapeHtml(
      status || nodes
        ? `Full output (${[nodes, status].filter(Boolean).join(', ')})`
        : 'Full output',
    );
    machine.push([
      LOGS_HEADING,
      [
        ...(provenance.length ? [provenance.join('\n\n'), ''] : []),
        ...(input.command ? ['Command:', '', fenced(input.command, 'bash'), ''] : []),
        `<details><summary>${summary}</summary>`,
        '',
        fenced(report),
        '</details>',
      ].join('\n'),
    ]);
  } else {
    machine.push([
      LOGS_HEADING,
      `Not applicable: no recipe run report under \`${path.relative(input.taskDir, reportRoot)}/\`.`,
    ]);
  }
  if (workflow !== undefined) {
    machine.push([
      WORKFLOW_HEADING,
      [
        '<details><summary>workflow.mmd</summary>',
        '',
        fenced(workflow, 'mermaid'),
        '</details>',
      ].join('\n'),
    ]);
  }

  // Deliberately scan plain headings so even a broken pasted fence is replaced.
  const lines = prose.replace(/\r\n?/g, '\n').split('\n');
  const headings = lines.flatMap((line, index) =>
    /^ {0,3}##(?!#)\s+\S/.test(line) ? [index] : [],
  );
  const keep = new Array<boolean>(lines.length).fill(true);
  let insertAt = lines.length;
  headings.forEach((start, at) => {
    const end = headings[at + 1] ?? lines.length;
    const key = headingKey(lines[start]!);
    if (MACHINE_KEYS.has(key)) keep.fill(false, start, end);
    else if (insertAt === lines.length && /checklist/.test(key)) insertAt = start;
  });
  const before = lines.slice(0, insertAt).filter((_, index) => keep[index]);
  const after = lines.slice(insertAt).filter((_, index) => keep[insertAt + index]);
  const generated = machine.flatMap(([heading, body]) => [heading, '', body, '']);
  return {
    body: [...trimEnd(before), '', ...generated, ...after]
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n*$/, '\n'),
    sections: machine.map(([heading]) => heading),
    recipe,
    run:
      report === undefined
        ? null
        : { path: path.relative(input.taskDir, path.join(reportRoot, 'report.md')) },
    workflow: workflow === undefined ? null : { path: 'artifacts/workflow.mmd' },
  };
}
