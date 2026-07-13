import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveContent, resolveFile, type ResolveRequest } from '../src/resolve/resolve-file.js';
import type { ResolutionSource } from '../src/spec/types.js';

function tierDirs(): { root: string; write: (rel: string, content: string) => string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'handoff-resolve-'));
  return {
    root,
    write: (rel, content) => {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return abs;
    },
  };
}

function request(root: string, defaultContent = 'default'): ResolveRequest {
  const defaultPath = path.join(root, 'default/template.md');
  mkdirSync(path.dirname(defaultPath), { recursive: true });
  writeFileSync(defaultPath, defaultContent);
  return {
    kind: 'task-template',
    personal: [path.join(root, 'personal/template.md')],
    domain: [path.join(root, 'domain/template.md')],
    farm: [path.join(root, 'farm/template.md')],
    defaultPath,
  };
}

test('first-match precedence across all four tiers, with full shadow recording', () => {
  const cases: {
    present: ('personal' | 'domain' | 'farm')[];
    winner: string;
    shadows: string[];
  }[] = [
    {
      present: ['personal', 'domain', 'farm'],
      winner: 'personal',
      shadows: ['domain', 'farm', 'default'],
    },
    { present: ['domain', 'farm'], winner: 'domain', shadows: ['farm', 'default'] },
    { present: ['farm'], winner: 'farm', shadows: ['default'] },
    { present: [], winner: 'default', shadows: [] },
  ];
  for (const c of cases) {
    const { root, write } = tierDirs();
    const req = request(root);
    for (const tier of c.present) write(`${tier}/template.md`, tier);
    const events: ResolutionSource[] = [];
    const result = resolveFile(req, { logger: (e) => events.push(e) });
    assert.equal(result.tier, c.winner, `winner for [${c.present.join(',')}]`);
    assert.deepEqual(
      result.shadows.map((s) => s.tier),
      c.shadows,
      `shadows for [${c.present.join(',')}]`,
    );
    // Non-silent: the event is logged as it will be recorded in provenance.json.
    assert.deepEqual(events, [result]);
  }
});

test('missing override falls through to the shipped default (always resolvable)', () => {
  const { root } = tierDirs();
  const result = resolveFile(request(root));
  assert.equal(result.tier, 'default');
  assert.deepEqual(result.shadows, []);
});

test('a broken override warns, degrades to the default, and records the fallback - never throws', () => {
  const { root, write } = tierDirs();
  const req = request(root, '{"ok":true}');
  write('personal/template.md', 'not json at all');
  const warnings: string[] = [];
  const result = resolveContent(req, (raw) => JSON.parse(raw) as { ok: boolean }, {
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(result.value, { ok: true });
  // Fallback signature in provenance: default won while a higher-tier file exists in shadows.
  assert.equal(result.resolution.tier, 'default');
  assert.ok(result.resolution.shadows.some((s) => s.tier === 'personal'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /broken/);
  assert.match(warnings[0], /Next:/);
});

test('a missing shipped default is a packaging bug and throws with escape guidance', () => {
  const { root } = tierDirs();
  assert.throws(
    () =>
      resolveFile({
        kind: 'task-template',
        defaultPath: path.join(root, 'nope/never-written.md'),
      }),
    /Next:/,
  );
});

test('a directory-as-override is a broken override: warned, skipped, chain continues', () => {
  const { root, write } = tierDirs();
  const req = request(root, 'default-content');
  // The personal candidate path EXISTS but is a directory.
  mkdirSync(path.join(root, 'personal/template.md'), { recursive: true });
  // A valid farm-tier file further down the chain must still win (the walk
  // continues tier by tier, it does not jump straight to default).
  write('farm/template.md', 'farm-content');

  const warnings: string[] = [];
  const result = resolveFile(req, { warn: (m) => warnings.push(m) });
  assert.equal(result.tier, 'farm');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /is a directory/);
  assert.match(warnings[0], /Next:/);
  // The broken candidate still shows in shadows (it exists and was passed over).
  assert.ok(result.shadows.some((s) => s.tier === 'personal'));

  // resolveContent takes the same walk.
  const contentWarnings: string[] = [];
  const resolved = resolveContent(req, (raw) => raw, { warn: (m) => contentWarnings.push(m) });
  assert.equal(resolved.value, 'farm-content');
  assert.equal(contentWarnings.length, 1);
});

test('an unreadable override is warned and skipped; default resolves', () => {
  const { root, write } = tierDirs();
  const req = request(root, 'default-content');
  const personal = write('personal/template.md', 'locked away');
  chmodSync(personal, 0o000);
  try {
    const warnings: string[] = [];
    const resolved = resolveContent(req, (raw) => raw, { warn: (m) => warnings.push(m) });
    assert.equal(resolved.resolution.tier, 'default');
    assert.equal(resolved.value, 'default-content');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /is not readable/);
  } finally {
    chmodSync(personal, 0o644);
  }
});

test('a symlinked override is treated as broken, consistent with the rest of the gate', () => {
  const { root, write } = tierDirs();
  const req = request(root, 'default-content');
  const target = write('elsewhere/real.md', 'linked content');
  mkdirSync(path.join(root, 'personal'), { recursive: true });
  symlinkSync(target, path.join(root, 'personal/template.md'));

  const warnings: string[] = [];
  const result = resolveFile(req, { warn: (m) => warnings.push(m) });
  assert.equal(result.tier, 'default');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /symlink/);
});

test('a valid override wins with zero warnings', () => {
  const { root, write } = tierDirs();
  const req = request(root);
  write('personal/template.md', 'mine');
  const warnings: string[] = [];
  const result = resolveFile(req, { warn: (m) => warnings.push(m) });
  assert.equal(result.tier, 'personal');
  assert.deepEqual(warnings, []);
});
