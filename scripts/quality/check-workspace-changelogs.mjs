#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  FRAGMENT_DIR,
  fragmentFiles,
  fragmentProblems,
  isFragmentPath,
  strayChangesEntries,
} from '../release/changelog-fragments.mjs';
import { isReleaseOnlyFile } from '../release/lib/release-only.mjs';
import { workspaceForFile } from '../release/lib/workspace-utils.mjs';
import {
  extractSection,
  meaningfulBullets,
  parseBullets,
  unreleasedMeaningfulBullets,
} from '../release/parse-changelog.mjs';

const repoRoot = process.cwd();
const failures = [];
const prDiff = process.argv.includes('--pr-diff');

function fail(message) {
  failures.push(message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function workspaceDirs() {
  const rootPackage = readJson('package.json');
  const dirs = [];
  for (const workspace of rootPackage.workspaces ?? []) {
    if (workspace.endsWith('/*')) {
      const root = workspace.slice(0, -2);
      if (!existsSync(path.join(repoRoot, root))) continue;
      for (const entry of readdirSync(path.join(repoRoot, root), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const relativeDir = `${root}/${entry.name}`;
        if (existsSync(path.join(repoRoot, relativeDir, 'package.json'))) dirs.push(relativeDir);
      }
    } else if (existsSync(path.join(repoRoot, workspace, 'package.json'))) {
      dirs.push(workspace);
    }
  }
  return [...new Set(dirs)].sort();
}

function isTestOnlyChange(relativePath) {
  return (
    relativePath.includes('/test/') ||
    relativePath.includes('/tests/') ||
    /\.test\.[cm]?[jt]sx?$/.test(relativePath) ||
    /\.spec\.[cm]?[jt]sx?$/.test(relativePath) ||
    relativePath.endsWith('.snap')
  );
}

function gitLines(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readGithubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return null;
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveMergeBase() {
  const event = readGithubEvent();
  const baseSha = event?.pull_request?.base?.sha;
  // base.sha is main's tip, which may hold notes merged after this branch left it.
  if (baseSha) {
    const mergeBase = gitLines(['merge-base', baseSha, resolveHeadSha()])[0];
    if (!mergeBase)
      throw new Error(`No merge base for ${baseSha} and ${resolveHeadSha()}: fetch full history.`);
    return mergeBase;
  }
  const originMain = gitLines(['rev-parse', '--verify', 'origin/main'])[0];
  if (originMain) {
    const mergeBase = gitLines(['merge-base', 'HEAD', originMain])[0];
    if (mergeBase) return mergeBase;
  }
  return gitLines(['rev-parse', 'HEAD~1'])[0] ?? 'HEAD~1';
}

function resolveHeadSha() {
  const event = readGithubEvent();
  const headSha = event?.pull_request?.head?.sha;
  if (headSha) return headSha;
  return 'HEAD';
}

function checkStructure() {
  for (const relativeDir of workspaceDirs()) {
    const packageJsonPath = `${relativeDir}/package.json`;
    const changelogPath = `${relativeDir}/CHANGELOG.md`;
    const pkg = readJson(packageJsonPath);
    if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@farmslot/')) {
      fail(`${packageJsonPath} must declare an @farmslot/* package name.`);
    }
    const absoluteChangelogPath = path.join(repoRoot, changelogPath);
    if (!existsSync(absoluteChangelogPath)) {
      fail(`${changelogPath} is required for workspace release notes.`);
      continue;
    }
    const content = readFileSync(absoluteChangelogPath, 'utf8');
    if (!content.startsWith('# Changelog\n')) {
      fail(`${changelogPath} must start with '# Changelog'.`);
    }
    if (!content.includes('## Unreleased')) {
      fail(`${changelogPath} must include an '## Unreleased' section.`);
    }
    for (const entry of strayChangesEntries(path.join(repoRoot, relativeDir)))
      fail(
        `${path.relative(repoRoot, entry)} is not a fragment: name it ${relativeDir}/${FRAGMENT_DIR}/<branch-name>.md, with each '/' as '-'.`,
      );
    for (const fragment of fragmentFiles(path.join(repoRoot, relativeDir))) {
      for (const problem of fragmentProblems(readFileSync(fragment, 'utf8')))
        fail(`${path.relative(repoRoot, fragment)} ${problem}.`);
    }
  }
}

function readTextAtRef(ref, relativePath) {
  const result = spawnSync('git', ['show', `${ref}:${relativePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) return '';
  return result.stdout;
}

/** A workspace's CHANGELOG.md and fragment texts at a commit (`HEAD` reads the working tree). */
function notesAt(ref, workspace) {
  if (ref === 'HEAD') {
    const changelogFile = path.join(repoRoot, workspace, 'CHANGELOG.md');
    return {
      changelog: existsSync(changelogFile) ? readFileSync(changelogFile, 'utf8') : '',
      fragments: fragmentFiles(path.join(repoRoot, workspace)).map((file) =>
        readFileSync(file, 'utf8'),
      ),
    };
  }
  return {
    changelog: readTextAtRef(ref, `${workspace}/CHANGELOG.md`),
    fragments: gitLines(['ls-tree', '--name-only', ref, `${workspace}/${FRAGMENT_DIR}/`])
      .filter((file) => isFragmentPath(file, workspace))
      .map((file) => readTextAtRef(ref, file)),
  };
}

const fragmentBullets = (notes) => notes.fragments.flatMap((text) => meaningfulBullets(text));

// Unreleased bullets the PR adds, counting CHANGELOG.md and fragments alike: renaming a
// fragment adds none, rewording one adds its new text.
function newUnreleasedBullets(mergeBase, headSha, workspace) {
  const unreleased = (notes) => [
    ...unreleasedMeaningfulBullets(notes.changelog),
    ...fragmentBullets(notes),
  ];
  const base = new Set(unreleased(notesAt(mergeBase, workspace)));
  return unreleased(notesAt(headSha, workspace)).filter((bullet) => !base.has(bullet));
}

const isWorkspaceFragment = (file) => {
  const workspace = workspaceForFile(file, repoRoot);
  return Boolean(workspace) && isFragmentPath(file, workspace);
};

const packageVersionAt = (ref, workspace) =>
  JSON.parse(
    ref === 'HEAD'
      ? readFileSync(path.join(repoRoot, workspace, 'package.json'), 'utf8')
      : readTextAtRef(ref, `${workspace}/package.json`) || '{}',
  ).version;

// A release (a chore(release) PR, or one that bumps the workspace's version) must carry every
// fragment bullet into CHANGELOG.md, or keep it as a fragment. Ordinary PRs may reword or revert
// an earlier note; they still need a new note of their own for a code change.
function checkFragmentsKept(mergeBase, headSha, changedFiles, releaseSubjects) {
  const workspaces = new Set(
    changedFiles.filter(isWorkspaceFragment).map((file) => workspaceForFile(file, repoRoot)),
  );
  for (const workspace of workspaces) {
    if (
      !releaseSubjects &&
      packageVersionAt(mergeBase, workspace) === packageVersionAt(headSha, workspace)
    )
      continue;
    const head = notesAt(headSha, workspace);
    const kept = new Set([...parseBullets(head.changelog), ...fragmentBullets(head)]);
    const lost = fragmentBullets(notesAt(mergeBase, workspace)).filter(
      (bullet) => !kept.has(bullet),
    );
    if (lost.length > 0)
      fail(
        `${workspace}: this release loses a fragment's note ("${lost[0].slice(0, 60)}") instead of writing it into CHANGELOG.md.`,
      );
  }
}

function releasedVersionCoversPr(mergeBase, headSha, workspace) {
  const version = packageVersionAt(headSha, workspace);
  if (packageVersionAt(mergeBase, workspace) === version) return false;
  const section = extractSection(
    notesAt(headSha, workspace).changelog,
    (line) => line === `## ${version}` || line.startsWith(`## ${version} -`),
  );
  return section ? meaningfulBullets(section.body).length > 0 : false;
}

function checkPrDiff() {
  const mergeBase = resolveMergeBase();
  const headSha = resolveHeadSha();
  const changedFiles = gitLines(['diff', '--name-only', `${mergeBase}...${headSha}`]);
  if (changedFiles.length === 0) return;
  const commitSubjects = gitLines(['log', '--pretty=%s', `${mergeBase}..${headSha}`]);
  const releaseSubjects = commitSubjects.every((subject) => /^chore\(release\):/i.test(subject));
  // Before the release exemption, so a cut that loses a note fails.
  checkFragmentsKept(
    mergeBase,
    headSha,
    gitLines(['diff', '--name-only', '--no-renames', `${mergeBase}...${headSha}`]),
    releaseSubjects,
  );

  // A cut deletes the fragments it writes into CHANGELOG.md.
  const releaseOnly = changedFiles.every(
    (file) => isReleaseOnlyFile(file) || isWorkspaceFragment(file),
  );
  if (releaseOnly || releaseSubjects) return;

  const touchedWorkspaces = new Map();
  const isNotes = (file, workspace) =>
    file.endsWith('/CHANGELOG.md') || isFragmentPath(file, workspace);
  for (const file of changedFiles) {
    if (isTestOnlyChange(file)) continue;
    const workspace = workspaceForFile(file, repoRoot);
    if (!workspace || isNotes(file, workspace)) continue;
    const bucket = touchedWorkspaces.get(workspace) ?? { codeChanges: [], changelogTouched: false };
    bucket.codeChanges.push(file);
    touchedWorkspaces.set(workspace, bucket);
  }

  // A PR's own `.changes/<name>.md` fragment is its entry; it never conflicts with another PR's.
  for (const file of changedFiles) {
    const workspace = workspaceForFile(file, repoRoot);
    if (!workspace || !touchedWorkspaces.has(workspace) || !isNotes(file, workspace)) continue;
    touchedWorkspaces.get(workspace).changelogTouched = true;
  }

  for (const [workspace, bucket] of touchedWorkspaces.entries()) {
    const changelogPath = `${workspace}/CHANGELOG.md`;
    if (!bucket.changelogTouched) {
      fail(
        `${workspace} code changed (${bucket.codeChanges.slice(0, 3).join(', ')}${bucket.codeChanges.length > 3 ? ', …' : ''}) but it has no release note: add ${workspace}/.changes/<branch-name>.md (each '/' as '-') with one '- ' bullet.`,
      );
      continue;
    }
    const bullets = newUnreleasedBullets(mergeBase, headSha, workspace);
    if (bullets.length === 0 && !releasedVersionCoversPr(mergeBase, headSha, workspace)) {
      fail(
        `${workspace} must add at least one new non-placeholder bullet, in ${workspace}/${FRAGMENT_DIR}/<branch-name>.md or under ${changelogPath} ## Unreleased, for this PR.`,
      );
    }
  }
}

checkStructure();
if (prDiff) checkPrDiff();

if (failures.length > 0) {
  console.error(`Workspace changelog guard failed${prDiff ? ' (PR diff)' : ''}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Workspace changelog guard passed${prDiff ? ' (PR diff)' : ''}.`);
