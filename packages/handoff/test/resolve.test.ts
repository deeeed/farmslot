import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
