import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GATEWAY_API_DOC } from './lib/release-only.mjs';

const guardScript = fileURLToPath(
  new URL('../quality/check-workspace-changelogs.mjs', import.meta.url),
);

// Run git and the guard outside any caller's repo, hooks or config.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') && key !== 'GITHUB_EVENT_PATH',
  ),
);
Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

function changelog(name, bullets = []) {
  return `# Changelog\n\nAll notable changes to \`${name}\` are tracked here.\n\n## Unreleased\n\n${bullets.map((bullet) => `- ${bullet}\n`).join('')}`;
}

// Throwaway repo with the two workspaces a protocol release touches: the
// protocol package and apps/docs, which holds the generated gateway reference.
function makeRepo(t, baseFiles = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'changelog-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
  write('package.json', JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }));
  for (const [workspace, name] of [
    ['packages/protocol', '@farmslot/protocol'],
    ['apps/docs', '@farmslot/docs'],
  ]) {
    write(`${workspace}/package.json`, JSON.stringify({ name, version: '0.1.0' }));
    write(`${workspace}/CHANGELOG.md`, changelog(name));
  }
  write('packages/protocol/src/index.ts', 'export const value = 1;\n');
  write(GATEWAY_API_DOC, 'Protocol version: `0.1.0`\n');
  for (const [file, content] of Object.entries(baseFiles)) write(file, content);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: base');
  const base = git('rev-parse', 'HEAD');

  const commit = (subject) => {
    git('add', '-A');
    git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  // Run the guard as a pull request event would, with the event's base and head.
  const check = (baseSha, headSha) => {
    const eventPath = path.join(dir, '.git', 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { base: { sha: baseSha }, head: { sha: headSha } } }),
    );
    return spawnSync('node', [guardScript, '--pr-diff'], {
      cwd: dir,
      env: { ...env, GITHUB_EVENT_PATH: eventPath },
      encoding: 'utf8',
    });
  };
  return {
    dir,
    write,
    git,
    commit,
    check,
    // Commit the change and run the guard on base...head.
    guard: (subject) => check(base, commit(subject)),
  };
}

const bumpReference = (repo) => repo.write(GATEWAY_API_DOC, 'Protocol version: `0.2.0`\n');

function addFeature(repo) {
  repo.write('packages/protocol/src/index.ts', 'export const value = 2;\n');
  repo.write('packages/protocol/CHANGELOG.md', changelog('@farmslot/protocol', ['Add `value` 2.']));
}

test('changelog guard: a version-only gateway reference change needs no apps/docs bullet', (t) => {
  const repo = makeRepo(t);
  bumpReference(repo);
  const result = repo.guard('docs(docs): regenerate the gateway API reference');
  assert.equal(result.status, 0, result.stderr);
});

test('changelog guard: a feature plus a gateway reference change needs an apps/docs bullet', (t) => {
  const repo = makeRepo(t);
  addFeature(repo);
  bumpReference(repo);
  const result = repo.guard('feat(protocol): add value 2');
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /apps\/docs code changed .* but it has no release note: add apps\/docs\/\.changes\/<branch-name>\.md \(each '\/' as '-'\)/,
  );
  assert.doesNotMatch(result.stderr, /packages\/protocol/);
});

test('changelog guard: a feature plus a gateway reference change passes with an apps/docs bullet', (t) => {
  const repo = makeRepo(t);
  addFeature(repo);
  bumpReference(repo);
  repo.write(
    'apps/docs/CHANGELOG.md',
    changelog('@farmslot/docs', ['Gateway API reference: document `value` 2.']),
  );
  const result = repo.guard('feat(protocol): add value 2');
  assert.equal(result.status, 0, result.stderr);
});

test('changelog guard: a .changes fragment is the release note, with no CHANGELOG.md edit', (t) => {
  const repo = makeRepo(t);
  repo.write('packages/protocol/src/index.ts', 'export const value = 2;\n');
  repo.write('packages/protocol/.changes/add-value-2.md', '- Add `value` 2.\n');
  const result = repo.guard('feat(protocol): add value 2');
  assert.equal(result.status, 0, result.stderr);
});

test('changelog guard: a malformed fragment fails, even beside a CHANGELOG.md bullet', (t) => {
  const repo = makeRepo(t);
  addFeature(repo);
  repo.write('packages/protocol/.changes/add-value-2.md', 'Add value 2 without a bullet\n');
  const result = repo.guard('feat(protocol): add value 2');
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /packages\/protocol\/\.changes\/add-value-2\.md has a line that is not a '- ' bullet/,
  );
});

test('changelog guard: a fragment under a branch-path subdirectory fails', (t) => {
  const repo = makeRepo(t);
  repo.write('packages/protocol/src/index.ts', 'export const value = 2;\n');
  repo.write('packages/protocol/.changes/feat/add-value-2.md', '- Add `value` 2.\n');
  const result = repo.guard('feat(protocol): add value 2');
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /packages\/protocol\/\.changes\/feat is not a fragment: name it packages\/protocol\/\.changes\/<branch-name>\.md, with each '\/' as '-'/,
  );
});

test('changelog guard: a src/.changes note is code, not a release note', (t) => {
  const repo = makeRepo(t);
  repo.write('packages/protocol/src/index.ts', 'export const value = 2;\n');
  repo.write('packages/protocol/src/.changes/add-value-2.md', '- Add `value` 2.\n');
  const result = repo.guard('feat(protocol): add value 2');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /packages\/protocol code changed .* but it has no release note/);
});

const earlier = { 'packages/protocol/.changes/earlier.md': '- Earlier note.\n' };

test("changelog guard: a follow-up PR may reword an earlier PR's fragment", (t) => {
  const repo = makeRepo(t, earlier);
  repo.write('packages/protocol/src/index.ts', 'export const value = 3;\n');
  repo.write('packages/protocol/.changes/earlier.md', '- Earlier note, kept after a restart.\n');
  const result = repo.guard('fix(protocol): keep value after a restart');
  assert.equal(result.status, 0, result.stderr);
});

test("changelog guard: a revert may delete the reverted PR's fragment, with a note of its own", (t) => {
  const repo = makeRepo(t, earlier);
  repo.write('packages/protocol/src/index.ts', 'export const value = 0;\n');
  rmSync(path.join(repo.dir, 'packages/protocol/.changes/earlier.md'));
  repo.write('packages/protocol/.changes/revert-earlier.md', '- Revert the earlier change.\n');
  const result = repo.guard('revert(protocol): the earlier change');
  assert.equal(result.status, 0, result.stderr);
});

test('changelog guard: a release cut that truncates a wrapped fragment fails', (t) => {
  const repo = makeRepo(t, {
    'packages/protocol/.changes/wrapped.md': '- Alpha feature that wraps\n  onto a second line.\n',
  });
  repo.write(
    'packages/protocol/CHANGELOG.md',
    '# Changelog\n\n## Unreleased\n\n## 0.1.1 - 2026-11-02\n\n- Alpha feature that wraps\n',
  );
  repo.write(
    'packages/protocol/package.json',
    JSON.stringify({ name: '@farmslot/protocol', version: '0.1.1' }),
  );
  rmSync(path.join(repo.dir, 'packages/protocol/.changes/wrapped.md'));
  const result = repo.guard('chore(release): cut protocol 0.1.1');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /this release loses a fragment's note \("Alpha feature that wraps/);
});

test('changelog guard: a release cut that moves fragments into the changelog passes', (t) => {
  const repo = makeRepo(t, { 'packages/protocol/.changes/add-value-2.md': '- Add `value` 2.\n' });
  repo.write(
    'packages/protocol/CHANGELOG.md',
    '# Changelog\n\n## Unreleased\n\n## 0.1.1 - 2026-11-02\n\n- Add `value` 2.\n',
  );
  repo.write(
    'packages/protocol/package.json',
    JSON.stringify({ name: '@farmslot/protocol', version: '0.1.1' }),
  );
  rmSync(path.join(repo.dir, 'packages/protocol/.changes/add-value-2.md'));
  const result = repo.guard('chore(release): cut protocol 0.1.1');
  assert.equal(result.status, 0, result.stderr);
});

test('changelog guard: a release behind main is judged from its merge base, not main', (t) => {
  // The event's base is main's tip, which gained a fragment after the release branch left it.
  const repo = makeRepo(t, { 'packages/protocol/.changes/add-value-2.md': '- Add `value` 2.\n' });
  repo.git('checkout', '-q', '-b', 'release');
  repo.write(
    'packages/protocol/CHANGELOG.md',
    '# Changelog\n\n## Unreleased\n\n## 0.1.1 - 2026-11-02\n\n- Add `value` 2.\n',
  );
  repo.write(
    'packages/protocol/package.json',
    JSON.stringify({ name: '@farmslot/protocol', version: '0.1.1' }),
  );
  rmSync(path.join(repo.dir, 'packages/protocol/.changes/add-value-2.md'));
  const head = repo.commit('chore(release): cut protocol 0.1.1');
  repo.git('checkout', '-q', 'main');
  repo.write('packages/protocol/src/index.ts', 'export const value = 3;\n');
  repo.write('packages/protocol/.changes/add-value-3.md', '- Add `value` 3.\n');
  const mainTip = repo.commit('feat(protocol): add value 3');
  const result = repo.check(mainTip, head);
  assert.equal(result.status, 0, result.stderr);
});
