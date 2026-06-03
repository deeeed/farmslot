#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadEnvFiles } from '../lib/local-env.mjs';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
loadEnvFiles([join(repoRoot, '.env.sonar.local'), join(repoRoot, '.env')]);

function readOption(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(`--${prefix}`));
  if (inline) return inline.slice(`--${prefix}`.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const hostUrl = process.env.SONAR_HOST_URL;
const token = process.env.SONAR_TOKEN;
const projectKey = process.env.SONAR_PROJECT_KEY;
const output = readOption(
  'out',
  process.env.SONAR_ISSUES_OUTPUT ?? 'temp/quality/sonar-issues.json',
);
const markdownOutput = readOption(
  'markdown-out',
  process.env.SONAR_ISSUES_MARKDOWN_OUTPUT ?? 'temp/quality/sonar-issues.md',
);
const timeoutMs = Number(process.env.SONAR_REQUEST_TIMEOUT_MS ?? 30_000);
const format = readOption('format', process.env.SONAR_ISSUES_FORMAT ?? 'json');
const branch = readOption('branch', process.env.SONAR_BRANCH ?? '');
const pullRequest = readOption('pull-request', process.env.SONAR_PULL_REQUEST ?? '');
const extraComponents = readOption('components', process.env.SONAR_COMPONENT_KEYS ?? '');
const statuses = readOption(
  'statuses',
  process.env.SONAR_ISSUE_STATUSES ?? 'OPEN,CONFIRMED,REOPENED',
);
const pageSize = Number(readOption('page-size', process.env.SONAR_PAGE_SIZE ?? '500'));

if (hasFlag('help')) {
  console.log(`Usage: node scripts/quality/fetch-sonar-issues.mjs [options]

Fetch SonarQube/SonarCloud issues and optionally write a model-friendly Markdown report.

Required env:
  SONAR_HOST_URL       e.g. https://sonarcloud.io
  SONAR_TOKEN          token with Browse permission
  SONAR_PROJECT_KEY    Sonar project key

Options/env:
  --format json|markdown|both       Default: SONAR_ISSUES_FORMAT or json
  --out <path>                      Default: temp/quality/sonar-issues.json
  --markdown-out <path>             Default: temp/quality/sonar-issues.md
  --branch <name>                   Default: SONAR_BRANCH
  --pull-request <key>              Default: SONAR_PULL_REQUEST
  --components <keys>               Default: SONAR_COMPONENT_KEYS, otherwise project key
  --statuses <csv>                  Default: OPEN,CONFIRMED,REOPENED
  --page-size <n>                   Default: 500
`);
  process.exit(0);
}

if (!['json', 'markdown', 'both'].includes(format)) {
  console.error(`Invalid --format ${format}; expected json, markdown, or both.`);
  process.exit(2);
}

if (!hostUrl || !token || !projectKey) {
  console.error(
    'Missing Sonar configuration. Set SONAR_HOST_URL, SONAR_TOKEN, and SONAR_PROJECT_KEY.',
  );
  process.exit(2);
}

const issues = [];
let page = 1;
let total = 0;
let truncated = false;

function exitCodeForResponse(response) {
  if (response.status === 401 || response.status === 403) return 3;
  if (response.status >= 500) return 4;
  return 1;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const error = new Error(
      `Sonar issues request failed: ${response.status} ${response.statusText}`,
    );
    error.exitCode = exitCodeForResponse(response);
    throw error;
  }
  return response.json();
}

function sonarPath(issue) {
  const component = issue.component ?? issue.project ?? '';
  const prefix = `${projectKey}:`;
  if (component.startsWith(prefix)) return component.slice(prefix.length);
  const colonIndex = component.indexOf(':');
  if (colonIndex !== -1) return component.slice(colonIndex + 1);
  return component;
}

function normalizeIssue(issue) {
  const file = sonarPath(issue);
  const line = issue.line ?? issue.textRange?.startLine ?? null;
  const column = issue.textRange?.startOffset ?? null;
  return {
    key: issue.key,
    rule: issue.rule,
    severity: issue.severity,
    type: issue.type,
    status: issue.status,
    message: issue.message,
    file,
    line,
    column,
    effort: issue.effort ?? issue.debt,
    tags: issue.tags ?? [],
    cleanCodeAttribute: issue.cleanCodeAttribute,
    cleanCodeAttributeCategory: issue.cleanCodeAttributeCategory,
    impacts: issue.impacts ?? [],
    creationDate: issue.creationDate,
    updateDate: issue.updateDate,
  };
}

function sortIssues(a, b) {
  const fileCompare = (a.file ?? '').localeCompare(b.file ?? '');
  if (fileCompare !== 0) return fileCompare;
  return (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0);
}

function groupByFile(normalizedIssues) {
  const groups = new Map();
  for (const issue of normalizedIssues) {
    const file = issue.file || '<project>';
    const items = groups.get(file) ?? [];
    items.push(issue);
    groups.set(file, items);
  }
  return [...groups.entries()]
    .map(([file, fileIssues]) => ({ file, issues: fileIssues.sort(sortIssues) }))
    .sort((a, b) => b.issues.length - a.issues.length || a.file.localeCompare(b.file));
}

function markdownEscape(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')
    .trim();
}

function renderImpacts(issue) {
  if (!issue.impacts?.length) return '';
  return issue.impacts
    .map((impact) => `${impact.softwareQuality ?? '?'}:${impact.severity ?? '?'}`)
    .join(', ');
}

function renderMarkdown(payload) {
  const groups = groupByFile(payload.normalizedIssues);
  const lines = [
    '# Sonar issues for model fixing',
    '',
    `- Project: \`${payload.projectKey}\``,
    `- Fetched: ${payload.fetchedAt}`,
    `- Issues fetched: ${payload.fetched}/${payload.total}${payload.truncated ? ' (truncated)' : ''}`,
  ];
  if (payload.branch) lines.push(`- Branch: \`${payload.branch}\``);
  if (payload.pullRequest) lines.push(`- Pull request: \`${payload.pullRequest}\``);
  lines.push(
    '',
    '## Fix protocol',
    '',
    '- Treat Sonar as the detector and the model as the fixer; do not invent extra churn outside the listed files.',
    '- Line numbers can drift after edits. Match by file + rule + message + nearby code, not line number alone.',
    '- Prefer mechanical fixes for simple rules first, then refactor high-complexity functions with focused tests.',
    '- After fixes, run the relevant repo quality gates and rerun this command or SonarLint/SonarQube.',
    '',
    '## Summary by file',
    '',
    '| File | Count | Rules |',
    '|---|---:|---|',
  );

  for (const group of groups) {
    const rules = [...new Set(group.issues.map((issue) => issue.rule).filter(Boolean))].join(', ');
    lines.push(
      `| ${markdownEscape(group.file)} | ${group.issues.length} | ${markdownEscape(rules)} |`,
    );
  }

  for (const group of groups) {
    lines.push(
      '',
      `## ${group.file}`,
      '',
      '| Line | Rule | Severity | Message | Impact |',
      '|---:|---|---|---|---|',
    );
    for (const issue of group.issues) {
      lines.push(
        `| ${issue.line ?? ''} | ${markdownEscape(issue.rule)} | ${markdownEscape(
          issue.severity,
        )} | ${markdownEscape(issue.message)} | ${markdownEscape(renderImpacts(issue))} |`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function writeText(path, text) {
  const outPath = join(repoRoot, path);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
}

try {
  for (;;) {
    const url = new URL('/api/issues/search', hostUrl);
    url.searchParams.set('componentKeys', extraComponents || projectKey);
    url.searchParams.set('statuses', statuses);
    url.searchParams.set('ps', String(pageSize));
    url.searchParams.set('p', String(page));
    if (branch) url.searchParams.set('branch', branch);
    if (pullRequest) url.searchParams.set('pullRequest', pullRequest);

    const body = await fetchJson(url);
    total = body.total ?? 0;
    issues.push(...(body.issues ?? []));
    if (total > 10_000) truncated = true;
    if (issues.length >= total || (body.issues ?? []).length === 0 || issues.length >= 10_000)
      break;
    page += 1;
  }

  const normalizedIssues = issues.map(normalizeIssue).sort(sortIssues);
  const byFile = groupByFile(normalizedIssues).map((group) => ({
    file: group.file,
    count: group.issues.length,
    rules: [...new Set(group.issues.map((issue) => issue.rule).filter(Boolean))].sort(),
  }));
  const payload = {
    projectKey,
    branch: branch || undefined,
    pullRequest: pullRequest || undefined,
    fetchedAt: new Date().toISOString(),
    total,
    fetched: issues.length,
    truncated,
    normalizedIssues,
    byFile,
    issues,
  };

  if (format === 'json' || format === 'both') {
    writeText(output, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`Wrote ${issues.length} Sonar issue(s) to ${output}`);
  }
  if (format === 'markdown' || format === 'both') {
    writeText(markdownOutput, renderMarkdown(payload));
    console.log(`Wrote Sonar Markdown report to ${markdownOutput}`);
  }

  if (truncated) {
    console.warn(
      `Sonar reported ${total} issue(s); fetched ${issues.length}. Narrow the query if reviewers need the full set.`,
    );
  }

  if (byFile.length > 0) {
    console.log('Top Sonar issue files:');
    for (const group of byFile.slice(0, 10)) {
      console.log(
        `  ${group.count.toString().padStart(4, ' ')}  ${relative(repoRoot, join(repoRoot, group.file)).split(sep).join('/')}  ${group.rules.join(', ')}`,
      );
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    console.error(`Sonar issues request timed out after ${timeoutMs}ms.`);
    process.exit(4);
  }
  console.error(message);
  process.exit(error?.exitCode ?? 1);
}
