import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ProjectVars, RawProjectJson, SlotVars } from './config.js';
import { computeFixturePlan } from './fixtures.js';

function slotVars(overrides: Partial<SlotVars> = {}): SlotVars {
  return {
    slotId: 'it-1',
    machine: 'shelltest',
    platform: 'cli',
    host: 'localhost',
    sshUser: 'x',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'it1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'inc-test-farm',
    resourceVars: {},
    ...overrides,
  };
}

function projectVars(fixturesDir: string, projectJson: RawProjectJson): ProjectVars {
  return {
    projectName: 'inc-test-farm',
    projectConfig: path.join(fixturesDir, '..', 'project.json'),
    projectFixturesDir: fixturesDir,
    projectTemplatesDir: path.join(fixturesDir, '..', 'templates'),
    projectJson,
    runtimeDir: '.agent',
    artifactDir: '.task',
    recipeDir: '.agent/recipes',
  };
}

const composeTemplates: RawProjectJson['fixtures'] = {
  templates: [
    {
      dst: 'COMPOSED.md',
      compose: {
        var: 'FLOW_TYPE',
        variants: {
          'fix-bug': {
            file: 'base.md',
            includes: [
              'required.md',
              { file: 'domains/{{domain}}/domain.md', optional: true },
              { file: 'domains/{{domain}}/absent.md', optional: true },
              'missing-required.md',
            ],
          },
        },
      },
    },
    { src: 'domains/{{domain}}/review-patterns.md', dst: 'REVIEW.md', optional: true },
    { src: 'plain.md', dst: 'PLAIN.md' },
  ],
};

async function seedFixtures(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'domains', 'blue'), { recursive: true });
  await writeFile(path.join(dir, 'base.md'), 'BASE\n');
  await writeFile(path.join(dir, 'required.md'), 'REQUIRED\n');
  await writeFile(path.join(dir, 'domains', 'blue', 'domain.md'), 'DOMAIN OVERLAY\n');
  await writeFile(path.join(dir, 'domains', 'blue', 'review-patterns.md'), 'REVIEW PATTERNS\n');
  await writeFile(path.join(dir, 'plain.md'), 'PLAIN\n');
}

test('computeFixturePlan composes overlay includes in order when the domain resolves', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fixplan-'));
  const dir = path.join(root, 'fixtures');
  await mkdir(dir, { recursive: true });
  try {
    await seedFixtures(dir);
    const pv = projectVars(dir, {
      name: 'inc-test-farm',
      vars: { domain: 'blue' },
      fixtures: composeTemplates,
    } as RawProjectJson);
    const plan = await computeFixturePlan({
      slotVars: slotVars(),
      projectVars: pv,
      selectionVars: { FLOW_TYPE: 'fix-bug' },
    });

    const composed = plan.files.find((f) => f.dst === 'COMPOSED.md');
    assert.ok(composed, 'COMPOSED.md rendered');
    // base + required + domain overlay, blank-line separated (bash printf '\n' + cat).
    assert.equal(composed.content, 'BASE\n\nREQUIRED\n\nDOMAIN OVERLAY\n');

    const review = plan.files.find((f) => f.dst === 'REVIEW.md');
    assert.equal(review?.content, 'REVIEW PATTERNS\n');

    const messages = plan.logs.map((l) => `[${l.level}] ${l.message}`);
    assert.ok(messages.includes('[SKIP] optional include domains/blue/absent.md not present'));
    assert.ok(messages.includes('[WARN] include missing-required.md not found'));
    assert.ok(messages.includes('[OK] COMPOSED.md (composed: base.md)'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('computeFixturePlan skips overlay entries with the literal path when the domain is unresolved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fixplan-'));
  const dir = path.join(root, 'fixtures');
  await mkdir(dir, { recursive: true });
  try {
    await seedFixtures(dir);
    const pv = projectVars(dir, {
      name: 'inc-test-farm',
      fixtures: composeTemplates,
    } as RawProjectJson);
    const plan = await computeFixturePlan({
      slotVars: slotVars(),
      projectVars: pv,
      selectionVars: { FLOW_TYPE: 'fix-bug' },
    });

    const composed = plan.files.find((f) => f.dst === 'COMPOSED.md');
    // No domain → overlay include skips; only base + required composed.
    assert.equal(composed?.content, 'BASE\n\nREQUIRED\n');
    assert.equal(
      plan.files.find((f) => f.dst === 'REVIEW.md'),
      undefined,
      'unresolved optional src not synced',
    );

    const messages = plan.logs.map((l) => `[${l.level}] ${l.message}`);
    // Unresolved {{domain}} stays literal in the skip message — not domains//...
    assert.ok(
      messages.includes(
        '[SKIP] REVIEW.md — optional src domains/{{domain}}/review-patterns.md not present',
      ),
      `literal path expected, got: ${messages.join(' | ')}`,
    );
    assert.ok(
      messages.includes('[SKIP] optional include domains/{{domain}}/domain.md not present'),
    );
    assert.ok(
      plan.files.some((f) => f.dst === 'PLAIN.md'),
      'required plain fixture still rendered',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('computeFixturePlan skips a compose entry when its selection var is unset', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fixplan-'));
  const dir = path.join(root, 'fixtures');
  await mkdir(dir, { recursive: true });
  try {
    await seedFixtures(dir);
    const pv = projectVars(dir, {
      name: 'inc-test-farm',
      vars: { domain: 'blue' },
      fixtures: composeTemplates,
    } as RawProjectJson);
    const plan = await computeFixturePlan({ slotVars: slotVars(), projectVars: pv });
    assert.equal(
      plan.files.find((f) => f.dst === 'COMPOSED.md'),
      undefined,
    );
    const messages = plan.logs.map((l) => `[${l.level}] ${l.message}`);
    assert.ok(messages.some((m) => m.startsWith('[SKIP] COMPOSED.md — FLOW_TYPE not set')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
