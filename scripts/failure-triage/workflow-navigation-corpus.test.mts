import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { sealCases, type NavigationCase } from './workflow-navigation.mts';

const root = new URL('./', import.meta.url);
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
