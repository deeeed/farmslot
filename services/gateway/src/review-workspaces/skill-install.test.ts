import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
