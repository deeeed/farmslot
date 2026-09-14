import type { Run } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { ghRequest } from '../integrations/github-client.js';

const PR_TEMPLATE_CANDIDATES = [
  '.github/pull-request-template.md',
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
] as const;

export interface RepositoryPrTemplate {
  path: string;
  body: string;
}

export interface LevelTwoHeadingLine {
  heading: string;
  /** Zero-based line index in the markdown split on \r?\n. */
  line: number;
}

/**
 * Level-two headings with their line positions, ignoring headings inside
 * fenced blocks and HTML comments. Every reader of template structure
 * (validation, section extraction) goes through this one parser.
 */
export function levelTwoHeadingLines(markdown: string): LevelTwoHeadingLine[] {
  const headings: LevelTwoHeadingLine[] = [];
  let fence: { character: string; length: number } | null = null;
  let inHtmlComment = false;

  const rawLines = markdown.split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index];
    let line = rawLine;
    if (inHtmlComment) {
      const close = line.indexOf('-->');
      if (close < 0) continue;
      line = line.slice(close + 3);
      inHtmlComment = false;
    }
    while (true) {
      const open = line.indexOf('<!--');
      if (open < 0) break;
      const close = line.indexOf('-->', open + 4);
      if (close < 0) {
        line = line.slice(0, open);
        inHtmlComment = true;
        break;
      }
      line = line.slice(0, open) + line.slice(close + 3);
    }

    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;
    if (/^\s{0,3}##(?!#)\s+\S/.test(line)) headings.push({ heading: line.trim(), line: index });
  }

  return headings;
}

export function levelTwoHeadings(markdown: string): string[] {
  return levelTwoHeadingLines(markdown).map((entry) => entry.heading);
}

export function assertPrBodyMatchesTemplate(body: string, template: RepositoryPrTemplate): void {
  const required = levelTwoHeadings(template.body);
  if (required.length === 0) return;

  const actual = levelTwoHeadings(body);
  let cursor = 0;
  const missing: string[] = [];
  const outOfOrder: string[] = [];

  for (const heading of required) {
    const next = actual.indexOf(heading, cursor);
    if (next >= 0) {
      cursor = next + 1;
    } else if (actual.includes(heading)) {
      outOfOrder.push(heading);
    } else {
      missing.push(heading);
    }
  }

  if (missing.length === 0 && outOfOrder.length === 0) return;
  const details = [
    missing.length > 0 ? `missing ${missing.join(', ')}` : '',
    outOfOrder.length > 0 ? `out of order ${outOfOrder.join(', ')}` : '',
  ].filter(Boolean);
  throw new Error(
    `PR body does not match ${template.path}: ${details.join('; ')}. ` +
      'Fix artifacts/pr-description.md, then refresh and re-review the publication package.',
  );
}

export interface ConformedPrBody {
  body: string;
  /** Template sections the body lacked; appended from the template, in template order. */
  added: string[];
  /** Template sections present but not in template order; left where the author put them. */
  outOfOrder: string[];
}

/**
 * The template's own text for one level-two section, heading included: from
 * the heading line to the line before the next real heading, so a fenced or
 * commented `##` inside the boilerplate stays part of the section.
 */
function templateSection(template: string, heading: string): string {
  const lines = template.split(/\r?\n/);
  const headings = levelTwoHeadingLines(template);
  const position = headings.findIndex((entry) => entry.heading === heading);
  if (position < 0) return `${heading}\n`;
  const start = headings[position].line;
  const end = headings[position + 1]?.line ?? lines.length;
  return `${lines.slice(start, end).join('\n').trimEnd()}\n`;
}

/**
 * Make `body` carry every section the repository template requires. A missing
 * section is appended from the template itself (its heading and boilerplate),
 * so the PR is created and reviewers see what the author left out, instead of
 * the run failing on prose formatting. Order problems are reported, not fixed.
 */
export function conformPrBodyToTemplate(
  body: string,
  template: RepositoryPrTemplate,
): ConformedPrBody {
  const required = levelTwoHeadings(template.body);
  const actual = levelTwoHeadings(body);
  let cursor = 0;
  const added: string[] = [];
  const outOfOrder: string[] = [];
  for (const heading of required) {
    const next = actual.indexOf(heading, cursor);
    if (next >= 0) cursor = next + 1;
    else if (actual.includes(heading)) outOfOrder.push(heading);
    else added.push(heading);
  }
  if (added.length === 0) return { body, added, outOfOrder };
  const sections = added.map((heading) => templateSection(template.body, heading));
  return {
    body: `${body.trimEnd()}\n\n${sections.join('\n')}`,
    added,
    outOfOrder,
  };
}

export async function conformRunPrBodyToTemplate(
  run: Run,
  body: string,
  baseBranch?: string,
): Promise<ConformedPrBody> {
  const template = await readRepositoryPrTemplate(run, baseBranch);
  return template ? conformPrBodyToTemplate(body, template) : { body, added: [], outOfOrder: [] };
}

export async function readRepositoryPrTemplate(
  run: Run,
  baseBranch = 'main',
): Promise<RepositoryPrTemplate | null> {
  if (!run.slotId) {
    throw new Error('Cannot validate the repository PR template without an assigned slot');
  }
  const vars = await loadSlotVars(run.slotId);
  const baseRef = `origin/${baseBranch}`;
  const command = [
    `base_ref=${shellQuote(baseRef)}`,
    `for p in ${PR_TEMPLATE_CANDIDATES.map(shellQuote).join(' ')}; do`,
    '  if git cat-file -e "$base_ref:$p" 2>/dev/null; then',
    '    printf "%s\\n" "$p"',
    '    git show "$base_ref:$p"',
    '    exit $?',
    '  fi',
    '  if [ -f "$p" ]; then',
    '    printf "%s\\n" "$p"',
    '    cat "$p"',
    '    exit 0',
    '  fi',
    'done',
  ].join('\n');
  const result = await execOnSlot(vars, command, { timeout: 15_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `Cannot read the repository PR template: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  if (!result.stdout.trim()) return null;
  const newline = result.stdout.indexOf('\n');
  if (newline < 0) throw new Error('Repository PR template probe returned a path without content');
  return {
    path: result.stdout.slice(0, newline).trim(),
    body: result.stdout.slice(newline + 1),
  };
}

export async function readGitHubPrTemplate(
  ciRepo: string,
  baseBranch = 'main',
): Promise<RepositoryPrTemplate | null> {
  for (const templatePath of PR_TEMPLATE_CANDIDATES) {
    try {
      const result = await ghRequest([
        'api',
        `repos/${ciRepo}/contents/${templatePath}?ref=${encodeURIComponent(baseBranch)}`,
        '--jq',
        '.content',
      ]);
      const encoded = result.stdout.replace(/\s/g, '');
      if (!encoded) throw new Error(`GitHub returned an empty PR template at ${templatePath}`);
      return {
        path: templatePath,
        body: Buffer.from(encoded, 'base64').toString('utf8'),
      };
    } catch (error) {
      if (error instanceof Error && /HTTP 404\b/.test(error.message)) continue;
      throw error;
    }
  }
  return null;
}
