import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  navigationReferenceHash,
  sealCases,
  type NavigationCase,
  type NavigationReference,
} from './workflow-navigation.mts';

const root = new URL('./', import.meta.url);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
test('draft synthetic navigation cases and hidden reference require at most two reads per case', async () => {
  const cases: NavigationCase[] = JSON.parse(
    await readFile(new URL('navigation-cases.v1.json', root), 'utf8'),
  );
  const labels = JSON.parse(await readFile(new URL('navigation-reference.v1.json', root), 'utf8'));
  assert.equal(sealCases(cases).cases.length, 8);
  assert.equal(labels.status, 'frozen');
  assert.equal(
    new Set(labels.references.map((row: { caseId: string }) => row.caseId)).size,
    cases.length,
  );
  for (const reference of labels.references) {
    const item = cases.find((entry) => entry.id === reference.caseId);
    assert(item);
    assert(reference.requiredReadIds.length > 0 && reference.requiredReadIds.length <= 2);
    assert(
      reference.requiredReadIds.every((id: string) =>
        item.sources.some((source) => source.id === id),
      ),
    );
    assert(
      reference.rationale?.length > 10 ||
        !['quote-timeout', 'proof-missing', 'mixed-timeout', 'local-resolver'].includes(item.id),
    );
    assert(!Object.keys(item).includes('reference'));
  }
});

test('v2 draft has compatible references, independent families, and variable evidence paths', async () => {
  const caseSource = await readFile(new URL('navigation-cases.v2.json', root), 'utf8');
  const referenceSource = await readFile(new URL('navigation-reference.v2.json', root), 'utf8');
  const cases: NavigationCase[] = JSON.parse(caseSource);
  const reference: NavigationReference = JSON.parse(referenceSource);
  const v1: NavigationReference = JSON.parse(
    await readFile(new URL('navigation-reference.v1.json', root), 'utf8'),
  );
  assert.equal(sealCases(cases).cases.length, 8);
  assert.match(navigationReferenceHash(reference), /^[a-f0-9]{64}$/);
  assert.equal(reference.version, 1); // Corpus revision 2 uses the existing reference schema.
  assert.equal(reference.status, 'draft-unsealed');
  assert.equal(
    sha256(caseSource),
    'b939ff5109c7a789196921d5f34113f14945f7413546ea1529c26f136903ab3a',
  );
  assert.equal(
    sha256(referenceSource),
    '962190287629e2348f9bb94162b8bad0040ed75ee52c5846f262049055522f7f',
  );
  assert.equal(reference.references.length, cases.length);
  const oldFamilies = new Set(v1.references.map((row) => row.family));
  const families = reference.references.map((row) => row.family);
  assert.equal(new Set(families).size, cases.length);
  assert(families.every((family) => !oldFamilies.has(family)));

  const references = new Map(reference.references.map((row) => [row.caseId, row]));
  const oneReadPositions = new Set<number>();
  let twoReadCases = 0;
  let firstReadIsInsufficient = 0;
  const requiredTitleCounts = new Map<string, number>();
  for (const item of cases) {
    const row = references.get(item.id);
    assert(row);
    assert(row.requiredReadIds.length > 0 && row.requiredReadIds.length <= 2);
    assert(row.requiredReadIds.every((id) => item.sources.some((source) => source.id === id)));
    assert(row.rationale && row.rationale.length > 10);
    if (row.requiredReadIds.length === 1) {
      oneReadPositions.add(
        item.sources.findIndex((source) => source.id === row.requiredReadIds[0]),
      );
    } else {
      twoReadCases += 1;
    }
    if (!row.requiredReadIds.includes(item.sources[0].id)) firstReadIsInsufficient += 1;
    for (const id of row.requiredReadIds) {
      const title = item.sources.find((source) => source.id === id)!.title;
      requiredTitleCounts.set(title, (requiredTitleCounts.get(title) ?? 0) + 1);
    }
    assert.deepEqual(
      item.sources.map((source) => source.id),
      ['e1', 'e2', 'e3', 'e4'],
    );
    const titles = new Set(item.sources.map((source) => source.title));
    assert.equal(titles.size, 4);
    assert(
      [...titles].every((title) =>
        [
          'Runtime output',
          'Run events',
          'Application output',
          'Environment snapshot',
          'Application state',
          'Request trace',
          'Configuration snapshot',
        ].includes(title),
      ),
    );
    assert(!Object.keys(item).includes('reference'));
  }
  assert.equal(twoReadCases, 3);
  assert.equal(oneReadPositions.size, 4);
  assert.equal(firstReadIsInsufficient, 7);
  assert(requiredTitleCounts.has('Runtime output'));
  assert(requiredTitleCounts.has('Application output'));
  assert(requiredTitleCounts.has('Application state'));
  assert([...requiredTitleCounts.values()].every((count) => count <= 3));
});
