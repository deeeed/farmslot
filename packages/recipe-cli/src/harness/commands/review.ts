import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from '@farmslot/protocol';

import { harnessContext } from '../context-state.js';
import { harnessHost } from '../host.js';
import { optionFlag, optionString, parseArgs, usageError } from '../parse-args.js';

export interface ReviewCommandOptions {
  baseRules?: string;
  runtimeIds?: readonly string[];
  parityRuntimeIds?: Readonly<Record<string, string>>;
  parity?: (input: { runtime: string; target: string; hasParityGuide: boolean }) => {
    reference?: { adapter: string; root: string; source: string };
    referenceMissing?: string;
    steps: readonly string[];
  };
}

interface KnowledgeSection {
  title: string;
  summary: string;
}
interface DomainLibrary {
  name: string;
  root: string;
  revision?: string;
}

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        out += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      const negated = glob[i + 1] === '!';
      const bodyStart = i + 1 + (negated ? 1 : 0);
      // A `]` right after the opening bracket is a literal member of the class.
      const close = glob.indexOf(']', glob[bodyStart] === ']' ? bodyStart + 1 : bodyStart);
      if (close === -1) {
        out += '\\[';
      } else {
        out += `[${negated ? '^' : ''}${glob.slice(bodyStart, close).replace(/[\\\]]/g, '\\$&')}]`;
        i = close;
      }
    } else {
      out += char.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

function matchOwnedFiles(files: readonly string[], globs: readonly string[]): string[] {
  const patterns = globs.map(globToRegExp);
  return files.filter((file) => patterns.some((pattern) => pattern.test(file)));
}

function git(target: string, args: string[]): string {
  return execFileSync('git', ['-C', target, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function defaultBaseRef(target: string): string {
  for (const candidate of ['origin/main', 'main', 'origin/develop', 'develop']) {
    try {
      git(target, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Try the next conventional base.
    }
  }
  return 'HEAD';
}

// Files touched by the change: committed since the base, plus the working tree.
function changedFiles(target: string, base?: string): { base: string; files: string[] } {
  const ref = base ?? defaultBaseRef(target);
  const lists = [
    ref === 'HEAD' ? '' : git(target, ['diff', '--name-only', `${ref}...HEAD`]),
    git(target, ['diff', '--name-only', 'HEAD']),
    git(target, ['ls-files', '--others', '--exclude-standard']),
  ];
  const files = new Set<string>();
  for (const list of lists)
    for (const line of list.split('\n')) if (line.trim()) files.add(line.trim());
  return { base: ref, files: [...files].sort() };
}

function parseSections(markdown: string): { intro: string; sections: KnowledgeSection[] } {
  const lines = markdown.split('\n');
  const introLines: string[] = [];
  const sections: KnowledgeSection[] = [];
  let current: { title: string; body: string[] } | undefined;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^## +(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(finishSection(current));
      current = { title: heading[1].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else if (!/^# /.test(line)) introLines.push(line);
  }
  if (current) sections.push(finishSection(current));
  return { intro: introLines.join('\n').trim(), sections };
}

// The summary is the first paragraph (wrapped lines joined) or, without prose, the first bullet.
function finishSection(section: { title: string; body: string[] }): KnowledgeSection {
  const lines = section.body.map((line) => line.trim());
  const firstBulletStart = lines.findIndex((line) => line.startsWith('- '));
  // Prose only counts before the first bullet; a bullet's wrapped lines are not prose.
  const proseLines = firstBulletStart === -1 ? lines : lines.slice(0, firstBulletStart);
  const proseStart = proseLines.findIndex((line) => line && !line.startsWith('#'));
  let firstProse: string | undefined;
  if (proseStart !== -1) {
    const paragraph: string[] = [];
    for (const line of proseLines.slice(proseStart)) {
      if (!line || line.startsWith('#')) break;
      paragraph.push(line);
    }
    firstProse = paragraph.join(' ');
  }
  let firstBullet: string | undefined;
  if (firstBulletStart !== -1) {
    const bullet: string[] = [lines[firstBulletStart].replace(/^- /, '')];
    for (const line of lines.slice(firstBulletStart + 1)) {
      if (!line || line.startsWith('- ') || line.startsWith('#')) break;
      bullet.push(line);
    }
    firstBullet = bullet.join(' ');
  }
  const raw = firstProse ?? firstBullet ?? '';
  return { title: section.title, summary: firstSentences(plainText(raw), SUMMARY_LIMIT) };
}

const SUMMARY_LIMIT = 220;

// Keep whole sentences while they fit the limit; a single overlong sentence is cut at a word.
function firstSentences(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // A sentence ends at terminal punctuation followed by whitespace, so `perpsConfig.ts` stays whole.
  const sentences = text.split(/(?<=[.!?])\s+/);
  let out = '';
  for (const sentence of sentences) {
    if (out && `${out} ${sentence}`.length > limit) break;
    out = out ? `${out} ${sentence}` : sentence;
  }
  if (out.length > limit) out = `${out.slice(0, limit).replace(/\s+\S*$/, '')}…`;
  return out || text.slice(0, limit);
}

function plainText(markdown: string): string {
  return markdown
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function ownedPaths(
  library: DomainLibrary,
  runtime: string,
): { domain: string; globs: string[] } | undefined {
  const file = path.join(library.root, 'owned-paths.json');
  if (!fs.existsSync(file)) return undefined;
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(value) || typeof value.domain !== 'string' || !isRecord(value.repos))
    throw usageError(`Invalid owned-paths.json: ${file}`);
  const globs: unknown = value.repos[runtime] ?? [];
  if (!Array.isArray(globs) || !globs.every((entry): entry is string => typeof entry === 'string'))
    throw usageError(`Invalid owned paths for ${runtime}: ${file}`);
  return { domain: value.domain, globs };
}

/** Review uses the host's authorized library composition without a private resolver. */
export async function handleReview(
  argv: string[],
  policy: ReviewCommandOptions = {},
): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const action = positional[0];
  if (action !== 'checklist' && action !== 'domain')
    throw usageError('Use farmslot review checklist|domain.');
  const context = harnessContext();
  const target = context?.target.value ?? path.resolve(optionString(options, 'target') ?? '.');
  const runtime = context?.adapter?.value ?? 'unscoped';
  if (policy.runtimeIds && !policy.runtimeIds.includes(runtime))
    throw usageError(`Review runtime must be one of ${policy.runtimeIds.join(', ')}.`);
  const libraries: DomainLibrary[] = context?.project?.libraries ?? [];
  const domain = optionString(options, 'domain') ?? context?.project?.domain;
  if (action === 'domain') {
    let result;
    if (domain) result = { domain, source: 'declared', adapter: runtime, target };
    else {
      const changed = changedFiles(target, optionString(options, 'base'));
      const matches = libraries
        .flatMap((library) => {
          const owned = ownedPaths(library, runtime);
          const matched = owned ? matchOwnedFiles(changed.files, owned.globs) : [];
          return owned && matched.length
            ? [{ domain: owned.domain, library: library.root, matched }]
            : [];
        })
        .sort((left, right) => right.matched.length - left.matched.length);
      result = {
        domain: matches[0]?.domain ?? null,
        source: matches.length ? 'owned-paths' : 'none',
        adapter: runtime,
        target,
        base: changed.base,
        changedFiles: changed.files.length,
        libraries,
        matches,
      };
    }
    process.stdout.write(
      optionFlag(options, 'json')
        ? `${JSON.stringify({ command: 'domain', ...result }, null, 2)}\n`
        : `${result.domain ?? 'none'}\n`,
    );
    return 0;
  }
  const library = domain ? libraries.find((entry) => entry.name === domain) : undefined;
  if (domain && !library)
    throw usageError(`No authorized recipe library found for domain "${domain}".`);
  const base = optionString(options, 'base') ?? defaultBaseRef(target);
  const since = optionString(options, 'since');
  const range = since ? `${since}..HEAD` : `${base}...HEAD`;
  const lines = [
    `# Review checklist — ${domain ? `${domain} (${runtime})` : runtime}`,
    '',
    `Scope: \`git diff ${range}\`${since ? ' (incremental re-review since the last verdict)' : ''}.`,
    '',
    '## Setup',
  ];
  let step = 0;
  const item = (text: string): void => {
    lines.push(`- [ ] ${++step}. ${text}`);
  };
  item(
    since
      ? `Re-read the previous findings, then list only the files changed in \`git diff --name-only ${range}\`; confirm each earlier finding is addressed or explicitly declined.`
      : `Read the task or PR description and the linked ticket, then list the changed files with \`git diff --name-only ${range}\`.`,
  );
  item(
    domain
      ? `Confirm the domain is ${domain} (\`farmslot review domain\`) and read the domain library.`
      : 'Run `farmslot review domain` to check whether a team library owns the changed files; if one does, re-run with --domain.',
  );
  lines.push('', '## Base review');
  for (const rule of (policy.baseRules ?? '').split('\n').filter((line) => line.trim())) item(rule);
  if (library) {
    const files = ['antipatterns.md', `antipatterns.${runtime}.md`];
    for (const name of files) {
      const file = path.join(library.root, 'review', name);
      if (fs.existsSync(file)) {
        lines.push('', `## Domain patterns (${domain})`);
        for (const section of parseSections(fs.readFileSync(file, 'utf8')).sections)
          item(`${section.title}: ${section.summary}`);
      }
    }
  }
  lines.push('', '## Parity');
  const parity = policy.parityRuntimeIds?.[runtime];
  const projectParity = policy.parity?.({
    runtime,
    target,
    hasParityGuide: Boolean(library && fs.existsSync(path.join(library.root, 'review/parity.md'))),
  });
  const reference =
    !projectParity && parity
      ? process.env[`${harnessHost().envPrefix}_REF_${parity.toUpperCase()}`]
      : undefined;
  if (projectParity) {
    for (const rule of projectParity.steps) item(rule);
  } else if (parity)
    item(
      reference
        ? `Compare touched behavior with ${parity} at ${reference}${library && fs.existsSync(path.join(library.root, 'review/parity.md')) ? ' using review/parity.md' : ''}; record every divergence under the library parity rule.`
        : `Parity with ${parity}: not checked. Record the missing reference in the verdict.`,
    );
  else item('Check consumers of each changed public contract.');
  lines.push('', '## Verdict');
  item(
    'Post APPROVE or REQUEST CHANGES, findings ordered by severity with file:line; state what was not checked and why.',
  );
  const checklist = `${lines.join('\n')}\n`;
  const out = optionString(options, 'out');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), checklist);
  }
  process.stdout.write(
    optionFlag(options, 'json')
      ? `${JSON.stringify({ command: 'review', subcommand: 'checklist', target, adapter: runtime, domain: domain ?? null, library: library ?? null, reference: projectParity ? (projectParity.reference ?? null) : (reference ?? null), referenceMissing: projectParity ? (projectParity.referenceMissing ?? null) : parity && !reference ? `no ${parity} checkout found` : null, base, since: since ?? null, out: out ? path.resolve(out) : null, checklist }, null, 2)}\n`
      : out
        ? `review checklist: ${path.resolve(out)}\n`
        : checklist,
  );
  return 0;
}
