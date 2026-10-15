'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  REVIEW_DIFF_SCOPE_RULE,
  diffScopeCandidates,
  buildDiffScopePacket,
  gitDiffScopeFiles,
} = require('../scripts/review-diff-scope.cjs');

test('sensitive paths are candidates, while product hooks and required tests stay unclassified', () => {
  const paths = [
    '.github/workflows/check.yml',
    'AGENTS.md',
    'web/CLAUDE.local.md',
    '.claude/hooks/check.sh',
    '.cursor/rules/scope.mdc',
    'package.json',
    'yarn.lock',
    'web/tsconfig.json',
    'vite.config.ts',
  ];
  assert.deepEqual(new Set(diffScopeCandidates(paths).map(({ file }) => file)), new Set(paths));
  assert.deepEqual(
    diffScopeCandidates(['src/hooks/useOrders.ts', 'src/order.test.ts', 'README.md']),
    [],
  );
});

test('scope packet lists every file without granting an exception or treating an unreadable diff as clean', () => {
  const packet = buildDiffScopePacket(['src/order.ts', 'AGENTS.md', 'AGENTS.md']);
  assert.ok(packet.startsWith(REVIEW_DIFF_SCOPE_RULE));
  assert.ok(packet.includes('["AGENTS.md","src/order.ts"]'));
  assert.ok(packet.includes('"category":"agent/editor configuration"'));
  assert.ok(packet.includes('Any scope BLOCKER requires REQUEST_CHANGES, never APPROVE'));
  assert.ok(packet.includes('Warm reviews keep correctness checks on their saved delta'));
  assert.ok(buildDiffScopePacket([], 'missing base').includes('UNVERIFIED: missing base'));
});

test('whole-contribution inventory uses the publication merge base and includes deleted rename paths', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'diff-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(root, 'AGENTS.md'), 'Original instructions');
  git('add', '.');
  git('commit', '-qm', 'fixture base');
  const base = git('rev-parse', 'HEAD');
  git('mv', 'AGENTS.md', 'notes.md');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'order.ts'), 'export const order = 1;');
  git('add', '.');
  git('commit', '-qm', 'fixture change');
  const files = gitDiffScopeFiles(root, base, 'HEAD');
  assert.deepEqual(files, ['AGENTS.md', 'notes.md', 'src/order.ts']);
  assert.equal(diffScopeCandidates(files)[0].file, 'AGENTS.md');
  assert.throws(() => gitDiffScopeFiles(root, 'missing-base', 'HEAD'));
});
