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
  if (baseSha) return baseSha;
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

// Unreleased bullets the PR adds, counting CHANGELOG.md and fragments alike, so editing or
// renaming another PR's fragment is not a note of its own.
function newUnreleasedBullets(mergeBase, headSha, workspace) {
  const unreleased = (notes) => [
    ...unreleasedMeaningfulBullets(notes.changelog),
    ...fragmentBullets(notes),
  ];
  const base = new Set(unreleased(notesAt(mergeBase, workspace)));
  return unreleased(notesAt(headSha, workspace)).filter((bullet) => !base.has(bullet));
}

// Every bullet a fragment held at the base must survive at the head, in CHANGELOG.md (a cut or a
// fold moved it) or in a fragment. A PR that drops, trims or loses another PR's note fails.
function checkFragmentsKept(mergeBase, headSha, changedFiles) {
  const workspaces = new Set();
  for (const file of changedFiles) {
    const workspace = workspaceForFile(file, repoRoot);
    if (workspace && isFragmentPath(file, workspace)) workspaces.add(workspace);
  }
  for (const workspace of workspaces) {
    const head = notesAt(headSha, workspace);
    const kept = new Set([...parseBullets(head.changelog), ...fragmentBullets(head)]);
    const lost = fragmentBullets(notesAt(mergeBase, workspace)).filter(
      (bullet) => !kept.has(bullet),
    );
    if (lost.length > 0)
      fail(
        `${workspace}: this PR drops a fragment's release note ("${lost[0].slice(0, 60)}"). Only a release cut or \`yarn release:fold\` moves a fragment, into CHANGELOG.md.`,
      );
  }
}

function releasedVersionCoversPr(mergeBase, headSha, workspace, changelogPath) {
  const packageJsonPath = `${workspace}/package.json`;
  const basePackage = JSON.parse(readTextAtRef(mergeBase, packageJsonPath));
  const headPackage = JSON.parse(
    headSha === 'HEAD'
      ? readFileSync(path.join(repoRoot, packageJsonPath), 'utf8')
      : readTextAtRef(headSha, packageJsonPath),
  );
  if (basePackage.version === headPackage.version) return false;

  const headContent =
    headSha === 'HEAD'
      ? readFileSync(path.join(repoRoot, changelogPath), 'utf8')
      : readTextAtRef(headSha, changelogPath);
  const section = extractSection(
    headContent,
    (line) =>
      line === `## ${headPackage.version}` || line.startsWith(`## ${headPackage.version} -`),
  );
  return section ? meaningfulBullets(section.body).length > 0 : false;
}

function checkPrDiff() {
  const mergeBase = resolveMergeBase();
  const headSha = resolveHeadSha();
  const changedFiles = gitLines(['diff', '--name-only', `${mergeBase}...${headSha}`]);
  if (changedFiles.length === 0) return;
  // Before the release exemption, so a cut that loses a note fails too.
  checkFragmentsKept(
    mergeBase,
    headSha,
    gitLines(['diff', '--name-only', '--no-renames', `${mergeBase}...${headSha}`]),
  );

  const releaseOnly = changedFiles.every(isReleaseOnlyFile);
  const commitSubjects = gitLines(['log', '--pretty=%s', `${mergeBase}..${headSha}`]);
  if (releaseOnly || commitSubjects.every((subject) => /^chore\(release\):/i.test(subject))) return;

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
    if (
      bullets.length === 0 &&
      !releasedVersionCoversPr(mergeBase, headSha, workspace, changelogPath)
    ) {
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
