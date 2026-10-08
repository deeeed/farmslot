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
function makeRepo(t) {
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
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: base');
  const base = git('rev-parse', 'HEAD');

  return {
    write,
    // Commit the change and run the guard on base...head, as a pull request event would.
    guard(subject) {
      git('add', '-A');
      git('commit', '-q', '-m', subject);
      const eventPath = path.join(dir, '.git', 'event.json');
      writeFileSync(
        eventPath,
        JSON.stringify({
          pull_request: { base: { sha: base }, head: { sha: git('rev-parse', 'HEAD') } },
        }),
      );
      return spawnSync('node', [guardScript, '--pr-diff'], {
        cwd: dir,
        env: { ...env, GITHUB_EVENT_PATH: eventPath },
        encoding: 'utf8',
      });
    },
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
    /apps\/docs code changed .* but apps\/docs\/CHANGELOG\.md was not updated/,
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
