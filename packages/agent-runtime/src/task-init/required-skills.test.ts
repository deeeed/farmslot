// ADR-049 Amendment 3: one required skill set, frozen at task init and read by
// the dev worker and its review. These cover selection, the fail-closed freeze
// and the read-only check `mm-harness skills required` and launch preflight use.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseRequiredSkillsConfig, type RequiredSkillsConfig } from '@farmslot/protocol';

import {
  checkRequiredSkills,
  freezeRequiredSkills,
  RequiredSkillsError,
  requiredSkillsTaskSection,
  selectRequiredSkills,
} from './required-skills.js';

const config: RequiredSkillsConfig = parseRequiredSkillsConfig({
  root: '.agents/skills',
  rules: [
    {
      id: 'mobile-testing',
      when: { flows: ['dev', 'fix-bug'] },
      skills: [{ name: 'mms-mobile-testing', files: ['SKILL.md', 'references/layers.md'] }],
    },
    {
      id: 'perps-review',
      when: { flows: ['dev', 'fix-bug'], domains: ['perps'] },
      skills: [{ name: 'mms-perps-review-pr', files: ['SKILL.md'] }],
    },
    {
      id: 'navigation',
      when: { flows: ['dev'], paths: ['app/components/Nav/**'] },
      skills: [{ name: 'mms-navigation', files: ['SKILL.md'] }],
    },
  ],
});

function checkout(files: readonly string[]): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'farmslot-required-skills-'));
  for (const file of files) {
    const target = path.join(repo, '.agents/skills', file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `# ${file}\n`);
  }
  return repo;
}

const ALL = [
  'mms-mobile-testing/SKILL.md',
  'mms-mobile-testing/references/layers.md',
  'mms-perps-review-pr/SKILL.md',
  'mms-navigation/SKILL.md',
];

test('selects the union of matching rules in pack order, without duplicates', () => {
  assert.deepEqual(
    selectRequiredSkills(config, { flow: 'dev', platform: 'ios', domain: 'perps' }),
    {
      rules: ['mobile-testing', 'perps-review'],
      skills: [
        {
          name: 'mms-mobile-testing',
          rules: ['mobile-testing'],
          files: ['SKILL.md', 'references/layers.md'],
        },
        { name: 'mms-perps-review-pr', rules: ['perps-review'], files: ['SKILL.md'] },
      ],
    },
  );
  assert.deepEqual(selectRequiredSkills(config, { flow: 'fix-bug', platform: 'android' }).rules, [
    'mobile-testing',
  ]);
  assert.deepEqual(selectRequiredSkills(config, { flow: 'ci-fix', platform: 'ios' }).rules, []);
  assert.deepEqual(
    selectRequiredSkills(config, {
      flow: 'dev',
      platform: 'ios',
      paths: ['app/components/Nav/Main.tsx'],
    }).rules,
    ['mobile-testing', 'navigation'],
  );
});

test('freezes the selected files with their digests', () => {
  const repo = checkout(ALL);
  try {
    const set = freezeRequiredSkills(repo, config, {
      flow: 'dev',
      platform: 'ios',
      domain: 'perps',
    });
    assert.equal(set.schemaVersion, 1);
    assert.deepEqual(set.selection, { flow: 'dev', platform: 'ios', domain: 'perps', paths: [] });
    assert.deepEqual(set.rules, ['mobile-testing', 'perps-review']);
    assert.deepEqual(set.skills[0]!.files[0], {
      path: '.agents/skills/mms-mobile-testing/SKILL.md',
      sha256: createHash('sha256').update('# mms-mobile-testing/SKILL.md\n').digest('hex'),
    });
    assert.deepEqual(set.config, config);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('refuses to freeze when a required file is not installed, naming every gap', () => {
  const repo = checkout(['mms-perps-review-pr/SKILL.md']);
  try {
    assert.throws(
      () => freezeRequiredSkills(repo, config, { flow: 'dev', platform: 'ios', domain: 'perps' }),
      (error: unknown) =>
        error instanceof RequiredSkillsError &&
        error.code === 'REQUIRED_SKILL_MISSING' &&
        error.message.includes(
          'Required skill mms-mobile-testing (rule mobile-testing) is not installed: missing .agents/skills/mms-mobile-testing/SKILL.md, .agents/skills/mms-mobile-testing/references/layers.md.',
        ) &&
        error.message.includes('Refresh the slot skills, then prepare again.'),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an empty selection freezes nothing and needs no installed skill', () => {
  const repo = checkout([]);
  try {
    const set = freezeRequiredSkills(repo, config, { flow: 'ci-fix', platform: 'ios' });
    assert.deepEqual(set.skills, []);
    assert.equal(checkRequiredSkills(repo, set).status, 'pass');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('check passes on the frozen bytes and reports removed or changed files', () => {
  const repo = checkout(ALL);
  try {
    const set = freezeRequiredSkills(repo, config, {
      flow: 'dev',
      platform: 'ios',
      domain: 'perps',
    });
    assert.deepEqual(checkRequiredSkills(repo, set), {
      status: 'pass',
      missing: [],
      scopeChanged: [],
    });
    rmSync(path.join(repo, '.agents/skills/mms-mobile-testing/references/layers.md'));
    writeFileSync(path.join(repo, '.agents/skills/mms-perps-review-pr/SKILL.md'), 'edited\n');
    assert.deepEqual(checkRequiredSkills(repo, set), {
      status: 'missing',
      missing: [
        {
          skill: 'mms-mobile-testing',
          path: '.agents/skills/mms-mobile-testing/references/layers.md',
          reason: 'missing',
        },
        {
          skill: 'mms-perps-review-pr',
          path: '.agents/skills/mms-perps-review-pr/SKILL.md',
          reason: 'changed',
        },
      ],
      scopeChanged: [],
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a diff that matches a rule outside the frozen set is a scope change', () => {
  const repo = checkout(ALL);
  try {
    const set = freezeRequiredSkills(repo, config, { flow: 'dev', platform: 'ios' });
    assert.equal(checkRequiredSkills(repo, set, ['app/util/a.ts']).status, 'pass');
    assert.deepEqual(checkRequiredSkills(repo, set, ['app/components/Nav/Main.tsx']), {
      status: 'scope-changed',
      missing: [],
      scopeChanged: [{ skill: 'mms-navigation', rules: ['navigation'] }],
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the task section lists every frozen file to load', () => {
  const repo = checkout(ALL);
  try {
    const set = freezeRequiredSkills(repo, config, { flow: 'fix-bug', platform: 'ios' });
    assert.equal(
      requiredSkillsTaskSection(set),
      [
        '## Required skills',
        '',
        'Frozen for this task in `inputs/handoff.json` (`requiredSkills`); its review checks against the same set. Load every file below before the first checklist step. Do not substitute repository docs.',
        '',
        '- `mms-mobile-testing` (rule `mobile-testing`): `.agents/skills/mms-mobile-testing/SKILL.md`, `.agents/skills/mms-mobile-testing/references/layers.md`',
        '',
      ].join('\n'),
    );
    assert.equal(
      requiredSkillsTaskSection(
        freezeRequiredSkills(repo, config, { flow: 'ci-fix', platform: 'ios' }),
      ),
      '',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('pack config validation names the offending field', () => {
  assert.throws(
    () => parseRequiredSkillsConfig({ root: '../skills', rules: [] }),
    /required_skills.root must be a checkout-relative directory/,
  );
  assert.throws(
    () =>
      parseRequiredSkillsConfig({
        root: '.agents/skills',
        rules: [{ id: 'a', when: { flow: ['dev'] }, skills: [{ name: 'x', files: ['SKILL.md'] }] }],
      }),
    /required_skills.rules\[0\].when has unsupported properties: flow/,
  );
  assert.throws(
    () =>
      parseRequiredSkillsConfig({
        root: '.agents/skills',
        rules: [{ id: 'a', skills: [{ name: 'x', files: ['../SKILL.md'] }] }],
      }),
    /must be skill-relative/,
  );
});
