import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { REVIEW_SKILL_INSTALL_SCRIPT } from './skill-install.js';

test('fresh review skills are discoverable, verified, and cleaned without discarding user changes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'review-skill-install-'));
  const checkout = path.join(root, 'source'),
    source = path.join(root, 'frozen');
  mkdirSync(checkout);
  mkdirSync(source);
  writeFileSync(path.join(source, 'skill.md'), '# Frozen review');
  const input = {
    checkout,
    skills: [{ name: 'review-skill', path: path.join(source, 'skill.md') }],
  };
  const run = (extra = {}) =>
    execFileSync(
      process.execPath,
      ['-e', REVIEW_SKILL_INSTALL_SCRIPT, JSON.stringify({ ...input, ...extra })],
      { stdio: 'pipe' },
    );
  try {
    run();
    run({ verifyOnly: true });
    for (const surface of ['.agents', '.cursor', '.claude'])
      assert.equal(
        readFileSync(path.join(checkout, surface, 'skills/review-skill/SKILL.md'), 'utf8'),
        '# Frozen review',
      );
    const unexpected = path.join(checkout, '.agents/skills/review-skill/user-note');
    writeFileSync(unexpected, 'keep');
    assert.throws(() => run({ action: 'cleanup' }), /Review skill changed/);
    assert.equal(readFileSync(unexpected, 'utf8'), 'keep');
    unlinkSync(unexpected);
    run({ action: 'cleanup' });
    run({ action: 'cleanup' });
    for (const surface of ['.agents', '.cursor', '.claude'])
      assert.equal(existsSync(path.join(checkout, surface)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a skill review links its writable round folders into the read-only checkout and unlinks them on cleanup', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'review-skill-install-'));
  const checkout = path.join(root, 'source'),
    source = path.join(root, 'skill-sources/mms-perps-review-pr'),
    reviewTasks = path.join(root, 'review-tasks');
  mkdirSync(checkout);
  execFileSync('git', ['init', '-q', checkout]);
  mkdirSync(path.join(source, 'tools'), { recursive: true });
  // The repository installer, reduced to what the gateway verifies it wrote.
  writeFileSync(
    path.join(source, 'tools/install'),
    [
      'target=""; while [ $# -gt 0 ]; do [ "$1" = --target ] && target="$2"; shift; done',
      'for dir in .agents/skills .claude/skills .cursor/rules; do mkdir -p "$target/$dir/mms-perps-review-pr/scripts"; done',
      'echo "# Installed" > "$target/.agents/skills/mms-perps-review-pr/SKILL.md"',
      'echo "" > "$target/.agents/skills/mms-perps-review-pr/scripts/review-task.mjs"',
    ].join('\n'),
  );
  chmodSync(path.join(source, 'tools/install'), 0o755);
  const input = {
    checkout,
    reviewTasks,
    skills: [
      {
        name: 'mms-perps-review-pr',
        path: path.join(source, 'domains/perps/skills/perps-review-pr/skill.md'),
        install: {
          repo: 'core',
          source,
          include: 'perps/perps-review-pr',
          installedName: 'mms-perps-review-pr',
        },
      },
    ],
  };
  const run = (extra = {}) =>
    execFileSync(
      process.execPath,
      ['-e', REVIEW_SKILL_INSTALL_SCRIPT, JSON.stringify({ ...input, ...extra })],
      { stdio: 'pipe' },
    );
  try {
    assert.throws(() => run({ reviewTasks: path.join(root, 'elsewhere') }), /review task root/);
    const outside = path.join(root, 'outside');
    const cursor = path.join(checkout, '.cursor');
    mkdirSync(outside);
    symlinkSync(outside, cursor);
    assert.throws(() => run(), /destination parent is not an owned directory/);
    assert.equal(existsSync(path.join(outside, 'rules')), false);
    unlinkSync(cursor);
    const existing = path.join(checkout, '.agents/skills/mms-perps-review-pr');
    mkdirSync(existing, { recursive: true });
    writeFileSync(path.join(existing, 'original.txt'), 'preserve this file');
    assert.throws(() => run(), /destination already exists without an owner/);
    run({ action: 'cleanup' });
    assert.equal(readFileSync(path.join(existing, 'original.txt'), 'utf8'), 'preserve this file');
    rmSync(existing, { recursive: true });
    run();
    run();
    run({ verifyOnly: true });
    const link = path.join(checkout, 'temp/tasks');
    assert(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), '../../review-tasks');
    assert(lstatSync(reviewTasks).isDirectory());
    const exclude = readFileSync(path.join(checkout, '.git/info/exclude'), 'utf8');
    assert.equal(exclude.split('\n').filter((line) => line === '/temp/tasks').length, 1);
    // A round the skill writes through the link lands in the writable sibling.
    mkdirSync(path.join(link, 'review/pr-1/r1'), { recursive: true });
    assert(existsSync(path.join(reviewTasks, 'review/pr-1/r1')));
    run({ action: 'cleanup' });
    assert.equal(existsSync(path.join(checkout, 'temp')), false);
    assert.equal(existsSync(path.join(checkout, '.agents/skills/mms-perps-review-pr')), false);
    assert.equal(existsSync(path.join(checkout, '.cursor/rules')), false);
    assert(existsSync(path.join(reviewTasks, 'review/pr-1/r1')));
    assert.throws(() => run({ verifyOnly: true }), /installation missing|link missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
