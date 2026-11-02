#!/usr/bin/env node
// A pull request records its release notes in a file of its own,
// `<workspace>/.changes/<name>.md`, so parallel PRs never edit the same CHANGELOG.md lines.
// Readers see those bullets as part of the workspace's Unreleased section, and a release cut
// writes them into the changelog and deletes the files.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSection, isPlaceholderBullet } from './parse-changelog.mjs';

export const FRAGMENT_DIR = '.changes';

export function isFragmentPath(file) {
  return /(^|\/)\.changes\/[^/]+\.md$/.test(file);
}

/** Fragment files of one workspace, in name order. */
export function fragmentFiles(workspaceDir) {
  const dir = path.join(workspaceDir, FRAGMENT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** A fragment holds only bullet lines (and blank lines); anything else is an error. */
export function fragmentProblems(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return ['is empty'];
  const problems = [];
  for (const line of lines)
    if (!line.startsWith('- ') && !line.startsWith('  '))
      problems.push(`has a line that is not a '- ' bullet: ${line.slice(0, 60)}`);
  if (lines.some((line) => line.startsWith('- ') && isPlaceholderBullet(line)))
    problems.push('repeats the Unreleased placeholder bullet');
  return problems;
}

/** The changelog text with the fragments' bullets at the end of its Unreleased section. */
export function changelogWithFragments(changelog, fragmentTexts) {
  const bullets = fragmentTexts
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n');
  if (!bullets) return changelog;
  const unreleased = extractSection(changelog, (line) => /^##\s+Unreleased\b/i.test(line));
  if (!unreleased) throw new Error('Missing ## Unreleased section');
  const lines = changelog.split(/\r?\n/);
  let end = unreleased.headingIndex + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1;
  // Insert after the section's last non-blank line so the next heading keeps its spacing.
  let insert = end;
  while (insert > unreleased.headingIndex + 1 && !lines[insert - 1].trim()) insert -= 1;
  return [...lines.slice(0, insert), bullets, ...lines.slice(insert)].join('\n');
}

/** A workspace's changelog as readers should see it, and the fragment files it includes. */
export function readChangelogWithFragments(workspaceDir) {
  const changelog = readFileSync(path.join(workspaceDir, 'CHANGELOG.md'), 'utf8');
  const files = fragmentFiles(workspaceDir);
  return {
    content: changelogWithFragments(
      changelog,
      files.map((file) => readFileSync(file, 'utf8')),
    ),
    fragments: files,
  };
}

/** Writes a workspace's fragments into its CHANGELOG.md Unreleased section and deletes them. */
export function foldFragments(workspaceDir) {
  const { content, fragments } = readChangelogWithFragments(workspaceDir);
  if (fragments.length === 0) return 0;
  writeFileSync(
    path.join(workspaceDir, 'CHANGELOG.md'),
    content.endsWith('\n') ? content : `${content}\n`,
  );
  for (const fragment of fragments) rmSync(fragment);
  return fragments.length;
}

// `yarn release:fold <workspace>...`: a hand-cut release folds fragments first, then moves the
// Unreleased bullets into its version section as before. `yarn release:cut` does this itself.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspaces = process.argv.slice(2);
  if (workspaces.length === 0) {
    console.error('usage: changelog-fragments.mjs <workspace-dir>...');
    process.exit(1);
  }
  for (const workspace of workspaces)
    console.log(`${workspace}: folded ${foldFragments(path.resolve(workspace))} fragment(s)`);
}
