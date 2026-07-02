import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listDomains } from './domain.js';

function withProjectsRoot(fn: (projectsRoot: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'farmslot-domain-ls-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeProject(projectsRoot: string, name: string, domains: string[]): void {
  const dir = join(projectsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), '{}');
  for (const domain of domains) {
    mkdirSync(join(dir, 'fixtures', 'domains', domain), { recursive: true });
  }
}

test('listDomains returns sorted, deduped domain names across projects', () => {
  withProjectsRoot((root) => {
    makeProject(root, 'app-farm', ['perps', 'swaps']);
    makeProject(root, 'other-farm', ['assets', 'perps']);
    assert.deepEqual(listDomains(root), ['assets', 'perps', 'swaps']);
  });
});

test('listDomains excludes the reserved _template starter', () => {
  withProjectsRoot((root) => {
    makeProject(root, 'app-farm', ['perps', '_template']);
    assert.deepEqual(listDomains(root), ['perps']);
  });
});

test('listDomains ignores directories without a project.json', () => {
  withProjectsRoot((root) => {
    mkdirSync(join(root, 'not-a-project', 'fixtures', 'domains', 'perps'), { recursive: true });
    assert.deepEqual(listDomains(root), []);
  });
});

test('listDomains returns an empty array when no projects or domains exist', () => {
  withProjectsRoot((root) => {
    assert.deepEqual(listDomains(root), []);
  });
  assert.deepEqual(listDomains(join(tmpdir(), 'farmslot-domain-ls-missing')), []);
});
