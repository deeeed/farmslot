// Review rule packs (ADR-0073 Amendment 1): the pack format, the selection a
// selector returns for one diff, and the rule-change proposal. Farmslot ships
// these contracts only; every rule in a pack belongs to its project.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRequiredSkillsConfig,
  parseReviewRulePack,
  parseReviewRuleProposal,
  parseReviewRuleSelection,
  type ReviewRulePack,
} from '../../src/contracts/index.js';

function packInput(): Record<string, unknown> {
  return {
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
        id: 'missing-numeric-data-stays-undefined',
        title: 'Missing numeric data stays undefined',
        file: 'references/shared.md',
        areas: { paths: { core: ['packages/perps-controller/**'], mobile: ['app/**/Perps/**'] } },
        status: 'active',
        class: 'blocking',
        doc: 'Core packages/perps-controller/docs/formatting.md',
        rules: [
          { label: 'Missing data converted to zero', why: 'pre-0073' },
          { label: 'Unknown treated as confirmed zero', why: 'MetaMask/core#11343' },
        ],
      },
      {
        id: 'sentry-tracing',
        title: 'Sentry Tracing',
        file: 'references/shared.md',
        areas: { paths: { core: ['packages/perps-controller/src/services/**'] } },
        status: 'retired',
        class: 'advisory',
        rules: [{ label: 'Unbounded background trace volume', why: 'pre-0073' }],
      },
    ],
  };
}

const pack: ReviewRulePack = parseReviewRulePack(packInput());

function withFamily(change: Record<string, unknown>): Record<string, unknown> {
  const input = packInput();
  const families = input.families as Record<string, unknown>[];
  families[1] = { ...families[1], ...change };
  return input;
}

test('a pack generalises rule families: anchor id, reference file, areas, status, class, rule causes', () => {
  assert.equal(pack.families.length, 3);
  assert.deepEqual(pack.families[1]?.areas, {
    paths: { core: ['packages/perps-controller/**'], mobile: ['app/**/Perps/**'] },
  });
  assert.equal(pack.families[1]?.rules[0]?.why, 'pre-0073');
});

test('an invalid pack is refused with the offending field', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...packInput(), schemaVersion: 2 }, /pack\.schemaVersion must be 1/],
    [withFamily({ id: 'Not An Anchor' }), /families\[1\]\.id must be a lowercase anchor/],
    [withFamily({ file: '../shared.md' }), /families\[1\]\.file must be skill-relative/],
    [withFamily({ areas: {} }), /families\[1\]\.areas needs always: true or paths/],
    [withFamily({ areas: { paths: { core: [] } } }), /areas\.paths\.core must be a non-empty/],
    [withFamily({ status: 'deprecated' }), /families\[1\]\.status must be one of/],
    [withFamily({ class: 'nit' }), /families\[1\]\.class must be one of/],
    [withFamily({ rules: [{ label: 'No cause' }] }), /rules\[0\]\.why must be a non-empty/],
    [withFamily({ owner: 'perps' }), /families\[1\] has unsupported properties: owner/],
    [
      withFamily({ clients: [] }),
      /families\[1\]\.clients must be a non-empty array of client names/,
    ],
  ];
  for (const [input, message] of cases) assert.throws(() => parseReviewRulePack(input), message);

  const duplicate = packInput();
  (duplicate.families as unknown[]).push((duplicate.families as unknown[])[0]);
  assert.throws(
    () => parseReviewRulePack(duplicate),
    /duplicate family id "blocking-review-checks"/,
  );
});

const FROZEN = { sha256: 'a'.repeat(64), client: 'core' };

function selectionInput(families: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    pack: { id: 'perps', sha256: 'a'.repeat(64) },
    selector: { kind: 'deterministic', id: 'areas', version: '1' },
    client: 'core',
    families,
  };
}

test('a selection accounts for every family the pack still has, each with a reason', () => {
  const selection = parseReviewRuleSelection(
    selectionInput([
      { id: 'blocking-review-checks', selected: true, reason: 'always' },
      {
        id: 'missing-numeric-data-stays-undefined',
        selected: false,
        reason: 'no changed file matches its core areas',
      },
    ]),
    pack,
    FROZEN,
  );
  assert.deepEqual(
    selection.families.map((family) => [family.id, family.selected]),
    [
      ['blocking-review-checks', true],
      ['missing-numeric-data-stays-undefined', false],
    ],
  );
});

test('a selection computed for another pack revision or client is refused', () => {
  const families = [
    { id: 'blocking-review-checks', selected: true, reason: 'always' },
    { id: 'missing-numeric-data-stays-undefined', selected: false, reason: 'no core match' },
  ];
  assert.throws(
    () =>
      parseReviewRuleSelection(selectionInput(families), pack, {
        ...FROZEN,
        sha256: 'c'.repeat(64),
      }),
    /selection was computed for pack digest a{64}, not the frozen c{64}/,
  );
  assert.throws(
    () => parseReviewRuleSelection({ ...selectionInput(families), client: 'mobile' }, pack, FROZEN),
    /selection was computed for client mobile, not the declared core/,
  );
});

test('a selection covers exactly the families its client review carries', () => {
  const scoped = parseReviewRulePack(withFamily({ clients: ['mobile'] }));
  const always = { id: 'blocking-review-checks', selected: true, reason: 'always' };
  assert.equal(
    parseReviewRuleSelection(selectionInput([always]), scoped, FROZEN).families.length,
    1,
  );
  assert.throws(
    () =>
      parseReviewRuleSelection(
        selectionInput([
          always,
          { id: 'missing-numeric-data-stays-undefined', selected: false, reason: 'not core' },
        ]),
        scoped,
        FROZEN,
      ),
    /names family "missing-numeric-data-stays-undefined", which the core review does not carry/,
  );
});

test('a family missing from the selection is refused, so no rule leaves a review silently', () => {
  assert.throws(
    () =>
      parseReviewRuleSelection(
        selectionInput([{ id: 'blocking-review-checks', selected: true, reason: 'always' }]),
        pack,
        FROZEN,
      ),
    /selection omits family "missing-numeric-data-stays-undefined"/,
  );
});

test('a selection is refused when it skips an always family, names an unknown one or gives no reason', () => {
  const cases: [unknown[], RegExp][] = [
    [
      [
        { id: 'blocking-review-checks', selected: false, reason: 'small diff' },
        { id: 'missing-numeric-data-stays-undefined', selected: true, reason: 'core areas' },
      ],
      /family "blocking-review-checks" is always selected/,
    ],
    [
      [
        { id: 'blocking-review-checks', selected: true, reason: 'always' },
        { id: 'missing-numeric-data-stays-undefined', selected: true, reason: 'core areas' },
        { id: 'invented-family', selected: false, reason: 'n/a' },
      ],
      /selection names family "invented-family", which the pack does not have/,
    ],
    [
      [
        { id: 'blocking-review-checks', selected: true, reason: 'always' },
        { id: 'missing-numeric-data-stays-undefined', selected: false, reason: ' ' },
      ],
      /families\[1\]\.reason must be one non-empty line/,
    ],
    [
      [
        { id: 'blocking-review-checks', selected: true, reason: 'always' },
        { id: 'missing-numeric-data-stays-undefined', selected: false, reason: 'see [notes]' },
      ],
      /families\[1\]\.reason must be one non-empty line without square brackets/,
    ],
    [
      [
        { id: 'blocking-review-checks', selected: true, reason: 'always' },
        { id: 'sentry-tracing', selected: true, reason: 'services changed' },
        { id: 'missing-numeric-data-stays-undefined', selected: true, reason: 'core areas' },
      ],
      /selection names family "sentry-tracing", which the pack retired/,
    ],
  ];
  for (const [families, message] of cases)
    assert.throws(() => parseReviewRuleSelection(selectionInput(families), pack, FROZEN), message);
});

test('a rule proposal carries its evidence, confirmation, net rule count and a reasoned decision', () => {
  const proposal = parseReviewRuleProposal({
    schemaVersion: 1,
    pack: 'perps',
    kind: 'edit',
    family: 'missing-numeric-data-stays-undefined',
    source: 'miss',
    evidence: [
      { ref: 'MetaMask/metamask-mobile#123', location: 'app/components/UI/Perps/x.ts:42' },
    ],
    confirmation: 'fix',
    bar: { recurrence: 'blocker', examined: ['missing-numeric-data-stays-undefined'] },
    change: 'Name `Number(value) || 0` in the first rule.',
    netRuleDelta: 0,
    decision: { status: 'pending' },
  });
  assert.equal(proposal.kind, 'edit');

  const base = { ...proposal } as Record<string, unknown>;
  assert.deepEqual(
    parseReviewRuleProposal({
      ...base,
      evidence: [{ ref: 'MetaMask/metamask-mobile#123', location: 'app/main.ts:42-48' }],
    }).evidence,
    [{ ref: 'MetaMask/metamask-mobile#123', location: 'app/main.ts:42-48' }],
  );
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...base, kind: 'append' }, /proposal\.kind must be one of/],
    [{ ...base, family: undefined }, /proposal\.family is required for an edit/],
    [{ ...base, evidence: [] }, /proposal\.evidence must be a non-empty array/],
    [
      { ...base, evidence: [{ ref: 'MetaMask/metamask-mobile#123' }] },
      /proposal\.evidence\[0\]\.location \(file:line\) is required for a miss/,
    ],
    [{ ...base, bar: undefined }, /proposal\.bar is required for an edit/],
    [
      { ...base, bar: { recurrence: 'once', examined: ['missing-numeric-data-stays-undefined'] } },
      /proposal\.bar\.recurrence must be one of recurring, blocker/,
    ],
    [
      { ...base, bar: { recurrence: 'recurring', examined: [] } },
      /proposal\.bar\.examined must list the family ids checked for coverage/,
    ],
    ...['x.ts', 'app/main.ts:0', 'app/main.ts:42-2'].map(
      (location): [Record<string, unknown>, RegExp] => [
        { ...base, evidence: [{ ref: 'MetaMask/metamask-mobile#123', location }] },
        /proposal\.evidence\[0\]\.location must be file:line or file:start-end/,
      ],
    ),
    [{ ...base, netRuleDelta: 0.5 }, /proposal\.netRuleDelta must be an integer/],
    [
      { ...base, decision: { status: 'approved', reason: 'kept\nand more' } },
      /proposal\.decision\.reason must be one non-empty line/,
    ],
    [
      { ...base, decision: { status: 'rejected' } },
      /proposal\.decision\.reason is required once decided/,
    ],
  ];
  for (const [input, message] of cases)
    assert.throws(() => parseReviewRuleProposal(input), message);

  assert.equal(
    parseReviewRuleProposal({
      ...base,
      kind: 'stale',
      bar: undefined,
      source: 'stale-check',
      confirmation: 'stale-check',
      evidence: [{ ref: 'areas match no file at core@abc1234' }],
      decision: { status: 'rejected', reason: 'the guard still applies to new providers' },
    }).decision.status,
    'rejected',
  );
});

test('a required skill can declare its review pack, client and level', () => {
  const config = parseRequiredSkillsConfig({
    root: '.agents/skills',
    rules: [
      {
        id: 'perps-review',
        skills: [
          {
            name: 'mms-perps-review-pr',
            files: ['SKILL.md'],
            review: { pack: 'references/pack.json', client: 'core', level: 'full' },
          },
        ],
      },
    ],
  });
  assert.deepEqual(config.rules[0]?.skills[0]?.review, {
    pack: 'references/pack.json',
    client: 'core',
    level: 'full',
  });
  for (const [review, message] of [
    [
      { pack: '/abs/pack.json', client: 'core', level: 'full' },
      /review\.pack must be skill-relative/,
    ],
    [{ pack: 'references/pack.json', client: 'core', level: 'living' }, /review\.level must be/],
    [{ pack: 'references/pack.json', level: 'static' }, /review\.client must be a simple name/],
  ] as const)
    assert.throws(
      () =>
        parseRequiredSkillsConfig({
          root: '.agents/skills',
          rules: [{ id: 'r', skills: [{ name: 's', files: ['SKILL.md'], review }] }],
        }),
      message,
    );
});
