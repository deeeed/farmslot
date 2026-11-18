// The Farmslot farm's review rule pack (ADR-0073 Amendment 1): generated from the canonical
// FSR rules, kept in sync with them and valid under the protocol contract.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseReviewRulePack } from '@farmslot/protocol';

const root = fileURLToPath(new URL('../..', import.meta.url));
const runtime = path.join(root, 'projects/farmslot-farm/fixtures/runtime');
const generator = path.join(root, 'projects/farmslot-farm/scripts/review-pack.mjs');
const generate = (...args) =>
  spawnSync(process.execPath, [generator, ...args], { encoding: 'utf8' });

test('the committed pack is the one generated from review-quality.md', () => {
  const result = generate('--check');
  assert.equal(result.status, 0, result.stderr);
});

test('the pack is valid and carries every FSR rule with its recorded failure', () => {
  const rules = readFileSync(path.join(runtime, 'review-quality.md'), 'utf8');
  const pack = parseReviewRulePack(
    JSON.parse(readFileSync(path.join(runtime, 'review-pack.json'), 'utf8')),
  );
  const ids = [...rules.matchAll(/^### (FSR-\d+)\. /gm)].map(([, id]) => id.toLowerCase());
  assert.ok(ids.length >= 11);
  assert.deepEqual(
    pack.families.map((family) => family.id),
    ids,
  );
  for (const family of pack.families) {
    assert.ok(rules.includes(`<a id="${family.id}"></a>`), `${family.id} has an anchor`);
    assert.equal(family.file, 'review-quality.md');
    assert.deepEqual(family.areas, { paths: { farmslot: ['**'] } });
    assert.equal(family.class, 'blocking');
    assert.equal(family.rules.length, 1);
    assert.notEqual(family.rules[0].why, 'pre-0073', `${family.id} keeps its recorded failure`);
    assert.ok(rules.includes(`- Failure: ${family.rules[0].why}`));
  }
});

test('the generator refuses a rule with no anchor or no recorded failure', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'farmslot-review-pack-'));
  try {
    const rule = (id, failure = true) =>
      `<a id="${id.toLowerCase()}"></a>\n\n### ${id}. A rule\n\n- Applies to x.\n${failure ? '- Failure: it broke in #1.\n' : ''}`;
    for (const [source, message] of [
      [
        `# Rules\n\n## Rules\n\n${rule('FSR-01')}\n### FSR-02. Unanchored\n\n- Failure: y.\n`,
        /FSR-02 has no <a id="fsr-02"><\/a> anchor/,
      ],
      [`# Rules\n\n## Rules\n\n${rule('FSR-01', false)}`, /FSR-01 has no "- Failure:" line/],
      ['# Rules\n\nNo rules here.\n', /no FSR rules/],
      [null, /--source needs a value/],
    ]) {
      const file = path.join(temp, 'rules.md');
      if (source !== null) writeFileSync(file, source);
      const result =
        source === null
          ? generate('--source')
          : generate('--source', file, '--out', path.join(temp, 'pack.json'));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
