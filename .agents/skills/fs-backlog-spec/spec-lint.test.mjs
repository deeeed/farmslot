import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { lintSpecText, parseAcceptanceCriteria } from './spec-lint.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const lint = path.join(here, 'spec-lint.mjs');
const good = path.join(here, 'fixtures/good-spec.md');
const bad = path.join(here, 'fixtures/bad-spec.md');

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [lint, ...args], { encoding: 'utf-8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// Copied VERBATIM from extractBacklogAcceptanceCriteria in
// services/gateway/src/backlog/store.ts — keep in sync. The lint's parser must
// produce identical criteria or the filed item's AC count diverges from what
// was linted.
function gatewayExtract(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Acceptance Criteria\s*$/i.test(line));
  if (headingIndex < 0) return [];
  const body = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#{1,2}\s+\S/.test(line)) break;
    body.push(line);
  }
  return body
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
}

test('good fixture exits 0; bad fixture exits 1 reporting every seeded violation', () => {
  assert.equal(runCli([good]).status, 0);
  const result = runCli([bad]);
  assert.equal(result.status, 1);
  const lines = result.stderr.trim().split('\n');
  // 1 empty Non-goals + 9 marker-less bullets (incl. empty backticks and a
  // bare artifact: marker) + 6 forbidden patterns.
  assert.equal(lines.length, 16);
  for (const rule of [
    'empty-non-goals',
    'no-check-marker',
    'after-merge condition',
    'post-merge condition',
    'multi-day duration',
    'operator-enable condition',
    'open-ended monitoring',
    'soak-period dependence',
  ]) {
    assert.ok(
      lines.some((l) => l.includes(rule)),
      `missing violation: ${rule}`,
    );
  }
  // Diagnostics carry source line numbers.
  assert.match(lines[0], /bad-spec\.md:\d+: /);
});

test('AC parsing agrees with the gateway parser on both fixtures', () => {
  for (const fixture of [good, bad]) {
    const text = readFileSync(fixture, 'utf-8');
    const ours = parseAcceptanceCriteria(text).criteria.map((c) => c.text);
    assert.deepEqual(ours, gatewayExtract(text));
  }
});

test('--print-ac output count equals the gateway parse count', () => {
  const text = readFileSync(good, 'utf-8');
  const printed = runCli(['--print-ac', good]).stdout.trim().split('\n');
  assert.deepEqual(printed, gatewayExtract(text));
});

test('missing Acceptance Criteria heading and missing Non-goals are violations', () => {
  const violations = lintSpecText('# t\n\n## Problem\n\nx\n');
  const rules = violations.map((v) => v.rule);
  assert.ok(rules.includes('missing-acceptance-criteria'));
  assert.ok(rules.includes('missing-non-goals'));
});

test('an unreadable file fails the batch without hiding later files', () => {
  const result = runCli([path.join(here, 'fixtures/nonexistent.md'), good]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nonexistent\.md:0: unreadable:/);
  assert.match(result.stdout, /PASS .*good-spec\.md/);
});

test('both ADR-032 specs pass the lint', (t) => {
  // .backlog/ is gitignored — specs exist on operator machines, not in CI
  // checkouts. Each file is validated independently so a present-but-invalid
  // spec is never hidden by a missing peer; skip only when NONE are present.
  const repoRoot = path.resolve(here, '../../..');
  const specs = [
    '.backlog/specs/adr032-phase3-a-shadow-flag.md',
    '.backlog/specs/adr032-phase3-b-pane-regex-deletion.md',
  ].map((spec) => path.join(repoRoot, spec));
  const present = specs.filter((spec) => existsSync(spec));
  if (present.length === 0) {
    t.skip('local .backlog specs not present in this checkout');
    return;
  }
  for (const spec of present) {
    const result = runCli([spec]);
    assert.equal(result.status, 0, `${spec} failed: ${result.stderr}`);
  }
});

test('content-free references are not check markers; real ones are', () => {
  const violations = lintSpecText(
    [
      '# t',
      '',
      '## Non-goals',
      '',
      '- none',
      '',
      '## Acceptance Criteria',
      '',
      '- Looks done: ``.',
      '- Ref with space only: ` `.',
      '- Bare marker: artifact:',
      '- Punctuation marker: artifact:.',
      '- Paren marker: recipe:)',
      '- Empty span after marker: artifact: ``',
      '- Punctuation-only span: run `.` first.',
      '- Backticked punctuation ref: artifact: `.`',
      '- Backticked paren ref: recipe: `)`',
      '- Real: `yarn test` passes.',
      '- Real too: evidence (artifact: `a/b.json`).',
      '- Leading-space code is valid: ` yarn test` runs.',
      '- Plain path ref: artifact: artifacts/e.json attached.',
      '- Double-backtick span is valid: ``yarn test`` runs.',
      '',
    ].join('\n'),
  );
  const markerless = violations.filter((v) => v.rule === 'no-check-marker');
  assert.equal(markerless.length, 9);
});

test('symlinked invocation with --preserve-symlinks-main still lints', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spec-lint-'));
  const link = path.join(dir, 'lint-link.mjs');
  symlinkSync(lint, link);
  try {
    let status = 0;
    try {
      execFileSync(process.execPath, ['--preserve-symlinks-main', link, bad], {
        encoding: 'utf-8',
      });
    } catch (err) {
      status = err.status;
    }
    // A silent exit 0 here means the CLI entry check failed to recognize itself.
    assert.equal(status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
