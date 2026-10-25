import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import { digestRecipeDocument, isRecord } from '@farmslot/protocol';

/** Canonical simulated media fixture, renamed to positional task AC IDs. Not live visual evidence. */
export async function writeAcceptanceVisualPackage(
  directory: string,
  captureHead?: string,
  reviewOriginal = false,
) {
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL(
        '../../../../packages/recipe-runner/test/fixtures/visual-review-package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.ok(isRecord(fixture) && isRecord(fixture.files));
  const files = fixture.files;
  const replacements = new Map([
    ['case-1', 'AC-1'],
    ['check-1', 'AC-2'],
  ]);
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') return replacements.get(value) ?? value;
    if (Array.isArray(value)) return value.map(replace);
    if (isRecord(value)) {
      const result = Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, replace(entry)]),
      );
      if (reviewOriginal && result.id === 'AC-1') {
        result.kind = 'acceptance';
        result.proofMode = 'review';
        if ('verdict' in result) {
          result.verdict = 'awaiting-review';
          for (const field of ['recipeNodes', 'assertionIndices', 'moments', 'evidence'])
            result[field] = [];
          delete result.timing;
        }
      }
      if (reviewOriginal && result.id === 'AC-2') {
        result.kind = 'acceptance';
        delete result.parentId;
      }
      if (reviewOriginal && Array.isArray(result.proves))
        result.proves = result.proves.filter((id) => id !== 'AC-1');
      return result;
    }
    return value;
  };
  const document = (name: string): Record<string, unknown> => {
    const bytes = files[name];
    assert.equal(typeof bytes, 'string');
    const parsed: unknown = JSON.parse(String(bytes));
    assert.ok(isRecord(parsed));
    return parsed;
  };
  const recipe = document('recipe.json');
  replacements.set(digestRecipeDocument(recipe), digestRecipeDocument(replace(recipe)));
  const invocation = document('recipe-invocation.json');
  replacements.set(digestRecipeDocument(invocation), digestRecipeDocument(replace(invocation)));
  const trace = document('trace.json');
  assert.ok(Array.isArray(trace.entries));
  replacements.set(
    digestRecipeDocument(trace.entries),
    digestRecipeDocument(replace(trace.entries)),
  );
  for (const [name, value] of Object.entries(files)) {
    assert.equal(typeof value, 'string');
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    let content = name.endsWith('.json') ? replace(JSON.parse(String(value))) : String(value);
    if (captureHead && name === 'artifact-manifest.json') {
      assert.ok(isRecord(content) && Array.isArray(content.artifacts));
      const summary = document('summary.json');
      const screenshot = content.artifacts.find(
        (entry) => isRecord(entry) && entry.path === 'stills/1.png',
      );
      assert.ok(isRecord(screenshot));
      screenshot.capture = {
        ac: 'AC-2',
        role: 'after',
        recipeRunId: summary.recipeRunId,
        nodeId: 'assert-1',
        traceIndex: 1,
        sourceCommit: captureHead,
        sourceDirty: false,
      };
    }
    await writeFile(
      path.join(directory, name),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  const read = await readRecordedEvidencePackage(directory);
  const validation = validateRecordedEvidencePackage(read.input);
  assert.equal(validation.status, 'valid', JSON.stringify(validation.findings));
  assert.ok(read.input.claims);
  return { input: read.input, claims: read.input.claims };
}
