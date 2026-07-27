#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

// A scope is one or more comma-separated tokens. Conventional Commits v1.0.0
// only requires "a noun describing a section of the codebase surrounded by
// parenthesis" and does not forbid commas; comma-separated multi-scope is
// common practice and commitlint supports it. Rejecting it blocked
// `feat(gateway,node): ...`, a legitimate subject, on a change that spanned both.
// Each token keeps the original strict shape, so junk scopes still fail.
const SCOPE_TOKEN = '[a-z0-9][a-z0-9._/-]*';
const CONVENTIONAL_SUBJECT = new RegExp(
  `^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)` +
    `(\\(${SCOPE_TOKEN}(?: *, *${SCOPE_TOKEN})*\\))?!?: \\S.+$`,
);

const args = process.argv.slice(2);
const failures = [];

function fail(message) {
  failures.push(message);
}

function usage() {
  return `Usage:
  node scripts/quality/check-conventional-commits.mjs --github-event
  node scripts/quality/check-conventional-commits.mjs --message "docs(repo): update docs"
  node scripts/quality/check-conventional-commits.mjs --message-file .git/COMMIT_EDITMSG
  node scripts/quality/check-conventional-commits.mjs --range origin/main..HEAD
`;
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.allowError ? 'pipe' : 'inherit'],
  }).trim();
}

function firstCommitLine(message) {
  return message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
}

function validateSubject(subject, label) {
  if (!subject) {
    fail(`${label}: missing commit subject.`);
    return;
  }
  if (!CONVENTIONAL_SUBJECT.test(subject)) {
    fail(
      `${label}: '${subject}' is not a Conventional Commit subject. Expected '<type>(optional-scope): <subject>' where type is one of build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test.`,
    );
  }
}

function commitSubjectsForRange(range) {
  // Skip merge commits: GitHub's "Update branch" button and local `git merge`
  // create commits like `Merge branch 'main' into <branch>` with >1 parent,
  // whose subjects are not (and by convention need not be) Conventional
  // Commits. Enforcing them would fail any PR that gets branch-updated.
  const output = git(['log', '--no-merges', '--format=%s', range]);
  return output ? output.split('\n').filter(Boolean) : [];
}

function isMergeCommit(ref) {
  // A merge commit has more than one parent (%P lists parent hashes).
  const parents = git(['log', '-1', '--format=%P', ref]);
  return parents.split(/\s+/).filter(Boolean).length > 1;
}

function validateRange(range) {
  const subjects = commitSubjectsForRange(range);
  if (subjects.length === 0) {
    console.log(`No commits found in ${range}; skipping commit subject check.`);
    return;
  }
  subjects.forEach((subject, index) => validateSubject(subject, `commit ${index + 1} in ${range}`));
}

function validatePullRequestEvent(event) {
  const pr = event.pull_request;
  if (!pr) {
    fail('GitHub pull_request event is missing pull_request payload.');
    return;
  }

  validateSubject(pr.title ?? '', 'pull request title');

  const headSha = pr.head?.sha;
  const baseRef = pr.base?.ref;
  if (!headSha || !baseRef) {
    fail('GitHub pull_request event is missing head SHA or base ref for commit range validation.');
    return;
  }

  let base = '';
  try {
    base = git(['merge-base', `origin/${baseRef}`, headSha]);
  } catch {
    base = pr.base?.sha ?? '';
  }
  if (!base) {
    fail(`Unable to determine merge base for origin/${baseRef}..${headSha}.`);
    return;
  }

  validateRange(`${base}..${headSha}`);
}

function validatePushEvent(event) {
  const after = event.after || 'HEAD';
  let ref = after;
  let subject = '';
  try {
    subject = git(['log', '-1', '--format=%s', after]);
  } catch {
    ref = 'HEAD';
    subject = git(['log', '-1', '--format=%s', 'HEAD']);
  }
  if (isMergeCommit(ref)) {
    console.log(`Skipping conventional commit check for merge commit ${ref}.`);
    return;
  }
  validateSubject(subject, `pushed commit ${after}`);
}

function validateGitHubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventPath || !existsSync(eventPath)) {
    fail('GITHUB_EVENT_PATH is not available; cannot validate GitHub event metadata.');
    return;
  }
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    validatePullRequestEvent(event);
    return;
  }
  if (eventName === 'push') {
    validatePushEvent(event);
    return;
  }
  console.log(`Skipping conventional commit check for unsupported GitHub event: ${eventName}`);
}

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--help' || arg === '-h') {
    console.log(usage());
    process.exit(0);
  }
  if (arg === '--github-event') {
    validateGitHubEvent();
  } else if (arg === '--message') {
    const message = args[++index];
    validateSubject(firstCommitLine(message ?? '') ?? '', 'commit message');
  } else if (arg === '--message-file') {
    const file = args[++index];
    if (!file) fail('--message-file requires a path.');
    else validateSubject(firstCommitLine(readFileSync(file, 'utf8')) ?? '', 'commit message');
  } else if (arg === '--range') {
    const range = args[++index];
    if (!range) fail('--range requires a git revision range.');
    else validateRange(range);
  } else {
    fail(`Unknown argument: ${arg}\n${usage()}`);
  }
}

if (args.length === 0) fail(`No mode provided.\n${usage()}`);

if (failures.length > 0) {
  console.error('Conventional commit guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Conventional commit guard passed.');
