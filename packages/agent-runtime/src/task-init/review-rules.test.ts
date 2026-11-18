// ADR-0073 Amendment 1 on the ADR-049 Am3 required skill set: a required review
// skill may declare its rule pack. The pack is frozen with the skill (refused
// when missing or invalid), the declaration sets the review level, and a family
// the selection leaves out becomes an optional step that the existing
// `mark N --skip` records with its reason.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseRequiredSkillsConfig,
  parseReviewRulePack,
  type RequiredSkillsConfig,
} from '@farmslot/protocol';

import {
  checkRequiredSkills,
  freezeRequiredSkills,
  RequiredSkillsError,
} from './required-skills.js';
import { markUnselectedFamilies, reviewRuleLevel } from './review-rules.js';

const require = createRequire(import.meta.url);
const checklistOrder = require('../../scripts/checklist-order.cjs') as {
  freeze: (contract: object, markdown: string, checklist: string) => object;
};
const markHelper = fileURLToPath(new URL('../../scripts/mark-checklist-step.cjs', import.meta.url));

const PACK = {
  schemaVersion: 1,
  id: 'perps',
  source: { repository: 'MetaMask/experimental-metamask-recipe-perps', revision: 'f8b9642' },
  families: [
    {
      id: 'blocking-review-checks',
      title: 'Blocking review checks',
      file: 'references/shared.md',
      areas: { always: true },
      status: 'active',
      class: 'blocking',
      rules: [],
    },
    {
      id: 'pro-mode-ui-gating',
      title: 'Pro Mode UI Gating',
      file: 'references/shared.md',
      areas: { paths: { mobile: ['app/components/UI/Perps/**'] } },
      status: 'active',
      class: 'blocking',
      rules: [{ label: 'One gate checked', why: 'pre-0073' }],
    },
  ],
};

function config(review?: Record<string, unknown>): RequiredSkillsConfig {
  return parseRequiredSkillsConfig({
    root: '.agents/skills',
    rules: [
      {
        id: 'perps-review',
        skills: [
          { name: 'mms-perps-review-pr', files: ['SKILL.md'], ...(review ? { review } : {}) },
        ],
      },
    ],
  });
}

const FULL = { pack: 'references/pack.json', client: 'core', level: 'full' };

function checkout(pack?: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'farmslot-review-rules-'));
  const skill = path.join(repo, '.agents/skills/mms-perps-review-pr');
  mkdirSync(path.join(skill, 'references'), { recursive: true });
  writeFileSync(path.join(skill, 'SKILL.md'), '# Perps static review\n');
  if (pack !== undefined) writeFileSync(path.join(skill, 'references/pack.json'), pack);
  return repo;
}

const INPUT = { flow: 'dev', platform: 'cli', domain: 'perps' };

test('a required review skill without a pack runs the generic review (level 1)', () => {
  const repo = checkout();
  try {
    assert.deepEqual(reviewRuleLevel(freezeRequiredSkills(repo, config(), INPUT)), {
      level: 'generic',
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a declared pack is frozen with its skill and sets the review level', () => {
  const repo = checkout(`${JSON.stringify(PACK)}\n`);
  try {
    const set = freezeRequiredSkills(repo, config(FULL), INPUT);
    assert.deepEqual(reviewRuleLevel(set), {
      level: 'full',
      skill: 'mms-perps-review-pr',
      client: 'core',
      pack: '.agents/skills/mms-perps-review-pr/references/pack.json',
    });
    assert.equal(checkRequiredSkills(repo, set).status, 'pass');
    writeFileSync(
      path.join(repo, '.agents/skills/mms-perps-review-pr/references/pack.json'),
      `${JSON.stringify({ ...PACK, families: PACK.families.slice(0, 1) })}\n`,
    );
    assert.deepEqual(checkRequiredSkills(repo, set).missing, [
      {
        skill: 'mms-perps-review-pr',
        path: '.agents/skills/mms-perps-review-pr/references/pack.json',
        reason: 'changed',
      },
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a declared pack that is missing or invalid refuses prepare instead of falling back', () => {
  for (const [pack, message] of [
    [undefined, /missing \.agents\/skills\/mms-perps-review-pr\/references\/pack\.json/],
    // The decoder's own diagnostic is kept, so a maintainer sees where the JSON breaks.
    ['{not json', /review pack .*references\/pack\.json is not valid JSON: .*JSON/],
    [
      JSON.stringify({ ...PACK, schemaVersion: 2 }),
      /review pack .*references\/pack\.json is invalid: pack\.schemaVersion must be 1/,
    ],
  ] as const) {
    const repo = checkout(pack);
    try {
      assert.throws(
        () => freezeRequiredSkills(repo, config(FULL), INPUT),
        (error: unknown) =>
          error instanceof RequiredSkillsError &&
          message.test(error.message) &&
          error.message.includes('Refresh the slot skills, then prepare again.'),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('one review runs one pack: two pack-declaring skills, or two packs on one skill, refuse prepare', () => {
  const repo = checkout(`${JSON.stringify(PACK)}\n`);
  try {
    const other = path.join(repo, '.agents/skills/mms-core-review/references');
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(repo, '.agents/skills/mms-core-review/SKILL.md'), '# Core review\n');
    writeFileSync(path.join(other, 'pack.json'), `${JSON.stringify({ ...PACK, id: 'core' })}\n`);
    const competing = parseRequiredSkillsConfig({
      root: '.agents/skills',
      rules: [
        { id: 'project', skills: [{ name: 'mms-core-review', files: ['SKILL.md'], review: FULL }] },
        {
          id: 'perps-review',
          when: { domains: ['perps'] },
          skills: [{ name: 'mms-perps-review-pr', files: ['SKILL.md'], review: FULL }],
        },
      ],
    });
    assert.throws(
      () => freezeRequiredSkills(repo, competing, INPUT),
      (error: unknown) =>
        error instanceof RequiredSkillsError &&
        /Required skills mms-core-review, mms-perps-review-pr each declare a review pack, and one review runs one pack/.test(
          error.message,
        ),
    );
    const twice = parseRequiredSkillsConfig({
      root: '.agents/skills',
      rules: [
        { id: 'a', skills: [{ name: 'mms-perps-review-pr', files: ['SKILL.md'], review: FULL }] },
        {
          id: 'b',
          skills: [
            {
              name: 'mms-perps-review-pr',
              files: ['SKILL.md'],
              review: { ...FULL, level: 'static' },
            },
          ],
        },
      ],
    });
    assert.throws(
      () => freezeRequiredSkills(repo, twice, INPUT),
      (error: unknown) =>
        error instanceof RequiredSkillsError &&
        /mms-perps-review-pr declares two different review packs/.test(error.message),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

const CHECKLIST = [
  '# Perps static review',
  '',
  '- [ ] 1. Record the review context',
  '- [ ] 2. Blocking review checks',
  '  Every confirmed violation is blocking. See references/shared.md#blocking-review-checks',
  '- [ ] 3. Pro Mode UI Gating',
  '  Both gates must be active. See references/shared.md#pro-mode-ui-gating',
  '- [ ] 4. Write the verdict',
  '',
].join('\n');

const pack = parseReviewRulePack(PACK);
const REASON = 'no changed file matches its mobile areas';
const REVIEW = {
  pack: { path: '.agents/skills/mms-perps-review-pr/references/pack.json', sha256: 'b'.repeat(64) },
  client: 'mobile',
  level: 'full',
} as const;

function selectionFor(families: unknown[], change: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    pack: { id: 'perps', sha256: 'b'.repeat(64) },
    selector: { kind: 'deterministic', id: 'areas', version: '1' },
    client: 'mobile',
    families,
    ...change,
  };
}

const SELECTION = selectionFor([
  { id: 'blocking-review-checks', selected: true, reason: 'always' },
  { id: 'pro-mode-ui-gating', selected: false, reason: REASON },
]);

test('a family the selection leaves out becomes an optional step carrying the reason', () => {
  const marked = markUnselectedFamilies(CHECKLIST, pack, REVIEW, SELECTION);
  assert.match(marked, /^- \[ \] 2\. Blocking review checks$/m);
  assert.match(
    marked,
    /^- \[ \] 3\. Pro Mode UI Gating \[OPTIONAL: not selected: no changed file matches its mobile areas\]$/m,
  );
  assert.equal(
    marked.split('\n').length,
    CHECKLIST.split('\n').length,
    'only the family row changes',
  );
});

test('a selection for another pack revision or client grants no skip', () => {
  assert.throws(
    () =>
      markUnselectedFamilies(
        CHECKLIST,
        pack,
        { ...REVIEW, pack: { ...REVIEW.pack, sha256: 'd'.repeat(64) } },
        SELECTION,
      ),
    /selection was computed for pack digest b{64}, not the frozen d{64}/,
  );
  assert.throws(
    () => markUnselectedFamilies(CHECKLIST, pack, { ...REVIEW, client: 'core' }, SELECTION),
    /selection was computed for client mobile, not the declared core/,
  );
});

test('a skip can never cover another family: one family per step, one step per family', () => {
  // A selected row that cross-links the unselected family would otherwise become skippable.
  const seeAlso = CHECKLIST.replace(
    'Every confirmed violation is blocking.',
    'Every confirmed violation is blocking; see also references/shared.md#pro-mode-ui-gating.',
  );
  assert.throws(
    () => markUnselectedFamilies(seeAlso, pack, REVIEW, SELECTION),
    /Checklist step 2 links families blocking-review-checks, pro-mode-ui-gating; a step covers one family/,
  );
  const twice = CHECKLIST.replace(
    '- [ ] 4. Write the verdict',
    '- [ ] 4. Write the verdict\n  Recheck references/shared.md#pro-mode-ui-gating.',
  );
  assert.throws(
    () => markUnselectedFamilies(twice, pack, REVIEW, SELECTION),
    /Family pro-mode-ui-gating is linked by checklist steps 3 and 4; one step covers a family/,
  );
});

test('a selected family must have its step; a skipped one the checklist lacks gets a visible step', () => {
  const withoutPro = CHECKLIST.replace('#pro-mode-ui-gating', '#elsewhere');
  // On a core review the mobile-only family lives in the mobile overlay. It is
  // not dropped: it gets an optional step carrying the reason, and later steps
  // are renumbered so mark targets stay positional.
  const core = { ...REVIEW, client: 'core' } as const;
  const coreSelection = selectionFor(
    [
      { id: 'blocking-review-checks', selected: true, reason: 'always' },
      { id: 'pro-mode-ui-gating', selected: false, reason: 'no core areas' },
    ],
    { client: 'core' },
  );
  const marked = markUnselectedFamilies(withoutPro, pack, core, coreSelection);
  assert.match(
    marked,
    /^- \[ \] 2\. Blocking review checks\n {2}Every confirmed violation is blocking\. See references\/shared\.md#blocking-review-checks\n- \[ \] 3\. Pro Mode UI Gating \[OPTIONAL: not selected: no core areas\]\n {2}Not in the core checklist\. See references\/shared\.md#pro-mode-ui-gating\n- \[ \] 4\. Pro Mode UI Gating\n/m,
  );
  assert.match(marked, /^- \[ \] 5\. Write the verdict$/m);
  assert.throws(
    () =>
      markUnselectedFamilies(
        CHECKLIST.replace('#blocking-review-checks', '#elsewhere'),
        pack,
        core,
        coreSelection,
      ),
    /no step linking references\/shared\.md#blocking-review-checks, which this core review selected/,
  );
});

function markRun(checklist: string, skipStep: number, reason: string, steps: number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-review-rules-mark-'));
  try {
    mkdirSync(path.join(dir, 'inputs'), { recursive: true });
    writeFileSync(path.join(dir, 'CHECKLIST.md'), checklist);
    writeFileSync(
      path.join(dir, 'checklist-target.json'),
      `${JSON.stringify({ checklist: 'CHECKLIST.md' })}\n`,
    );
    writeFileSync(
      path.join(dir, 'inputs', 'worker-terminal-contract.json'),
      `${JSON.stringify(checklistOrder.freeze({ schemaVersion: 1, flowType: 'review-pr', requireSignal: true }, checklist, 'CHECKLIST.md'))}\n`,
    );
    const mark = (...args: string[]) =>
      spawnSync(process.execPath, [markHelper, dir, ...args], { encoding: 'utf8' });
    assert.equal(mark('1').status, 0);
    const refused = mark('2', '--skip', 'small diff');
    assert.notEqual(refused.status, 0, 'a selected family is not optional');
    assert.match(refused.stderr, /step 2 is not declared optional, so it cannot be skipped/);
    for (let step = 2; step <= steps; step += 1) {
      const result = step === skipStep ? mark(String(step), '--skip', reason) : mark(String(step));
      assert.equal(result.status, 0, result.stderr);
    }
    const events = JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8')).checklistTiming
      .events as { stepNumber: number; skipped?: boolean; reason?: string }[];
    return events
      .filter((event) => event.skipped === true)
      .map(({ stepNumber, reason: recorded }) => ({ stepNumber, reason: recorded }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the existing mark --skip records the selector reason beside the skipped family', () => {
  assert.deepEqual(
    markRun(
      markUnselectedFamilies(CHECKLIST, pack, REVIEW, SELECTION),
      3,
      `selector: ${REASON}`,
      4,
    ),
    [{ stepNumber: 3, reason: `selector: ${REASON}` }],
  );
  // The core case: the step added for the mobile overlay's family is skipped the same way.
  const core = { ...REVIEW, client: 'core' } as const;
  const checklist = markUnselectedFamilies(
    CHECKLIST.replace('#pro-mode-ui-gating', '#elsewhere'),
    pack,
    core,
    selectionFor(
      [
        { id: 'blocking-review-checks', selected: true, reason: 'always' },
        { id: 'pro-mode-ui-gating', selected: false, reason: 'no core areas' },
      ],
      { client: 'core' },
    ),
  );
  assert.deepEqual(markRun(checklist, 3, 'selector: no core areas', 5), [
    { stepNumber: 3, reason: 'selector: no core areas' },
  ]);
});
