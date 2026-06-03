import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  extractTrailingJsonObject,
  materializeExtractedRecipe,
  PR_BODY_PROVENANCE,
  sanitizeFlowFilename,
} from './pr-body-recipe.js';

test('sanitizeFlowFilename strips paths and rejects unsafe names', () => {
  assert.equal(sanitizeFlowFilename('ac1-size-autofocus.json'), 'ac1-size-autofocus.json');
  assert.equal(sanitizeFlowFilename('ac1-size-autofocus'), 'ac1-size-autofocus.json');
  assert.equal(sanitizeFlowFilename('artifacts/recipe-flows/ac7.json'), 'ac7.json');
  assert.equal(sanitizeFlowFilename('../etc/passwd'), 'passwd.json');
  assert.equal(sanitizeFlowFilename('bad name with spaces.json'), null);
  assert.equal(sanitizeFlowFilename(''), null);
  assert.equal(sanitizeFlowFilename('   '), null);
});

test('extractTrailingJsonObject finds the last balanced object', () => {
  // Plain case
  assert.equal(extractTrailingJsonObject('{"a":1}'), '{"a":1}');
  // With prose preamble (greedy regex would have matched the whole thing — fine here)
  assert.equal(extractTrailingJsonObject('here you go: {"a":1}'), '{"a":1}');
});

test('extractTrailingJsonObject ignores braces inside strings', () => {
  // The opening brace inside the string must NOT be matched as a structural brace.
  assert.equal(
    extractTrailingJsonObject('{"label":"opens { brace","x":1}'),
    '{"label":"opens { brace","x":1}',
  );
  // Escaped quotes shouldn't toggle string state
  assert.equal(
    extractTrailingJsonObject('{"a":"he said \\"hi\\"","b":2}'),
    '{"a":"he said \\"hi\\"","b":2}',
  );
});

test('extractTrailingJsonObject avoids the multi-object greedy-match pitfall', () => {
  // The HIGH-severity case from review: a thinking preamble followed by the
  // real recipe object. The greedy `/\{[\s\S]*\}/` regex would match
  // "{...thinking...} {...real...}" as a single span and JSON.parse would
  // throw. We need to land on the LAST balanced object.
  const haystack =
    '<thinking>\n{\n  "a": 1\n}\n</thinking>\n{"found": true, "recipe": {"v": 1}, "flows": {}}';
  const got = extractTrailingJsonObject(haystack);
  assert.ok(got, 'should extract a balanced object');
  const parsed = JSON.parse(got!);
  assert.equal(parsed.found, true);
  assert.deepEqual(parsed.recipe, { v: 1 });
});

test('extractTrailingJsonObject handles nested objects', () => {
  const got = extractTrailingJsonObject('preamble {"a":{"b":{"c":1}},"d":2} trailing');
  assert.ok(got);
  assert.deepEqual(JSON.parse(got!), { a: { b: { c: 1 } }, d: 2 });
});

test('extractTrailingJsonObject returns null when there is no balanced object', () => {
  assert.equal(extractTrailingJsonObject('no braces here'), null);
  assert.equal(extractTrailingJsonObject('only one }'), null);
});

test('extractTrailingJsonObject is unaffected by JSON unicode escapes for braces and quotes', () => {
  // } decodes to `}`, { to `{`, " to `"`. In the pre-parse
  // byte stream these are 6-char sequences containing none of {, }, ".
  // The scanner must NOT mis-count them as structural braces or as quote
  // toggles. Each input below should round-trip through extract → JSON.parse.
  const inputs = [
    '{"text":"close is \\u007D"}',
    '{"text":"open is \\u007B in middle","x":1}',
    '{"text":"escaped \\u0022 quote here","y":2}',
  ];
  for (const s of inputs) {
    const got = extractTrailingJsonObject(s);
    assert.equal(got, s, `should return entire input verbatim for ${s}`);
    // Sanity: the extracted slice is parseable JSON.
    assert.doesNotThrow(() => JSON.parse(got!));
  }
});

test('materializeExtractedRecipe stages recipe + flows under inputs/inherited only — never seeds artifacts/', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'pr-body-recipe-'));
  const bundle = {
    recipe: { version: 1, steps: [{ kind: 'noop' }] },
    flows: {
      'ac1.json': { name: 'ac1', steps: [] },
      'ac2.json': { name: 'ac2', steps: [{ kind: 'click' }] },
    },
  };

  const { inheritedRecipePath, inheritedFlowFiles, provenancePath } =
    await materializeExtractedRecipe(bundle, taskDir);

  assert.equal(inheritedRecipePath, path.join(taskDir, 'inputs', 'inherited', 'recipe.json'));
  assert.equal(provenancePath, path.join(taskDir, 'inputs', 'inherited', 'recipe-source.json'));
  assert.equal(inheritedFlowFiles.length, 2);

  // Recipe + flows live under inputs/inherited only.
  assert.deepEqual(JSON.parse(await readFile(inheritedRecipePath, 'utf-8')), bundle.recipe);
  const inheritedFlows = await readdir(path.join(taskDir, 'inputs', 'inherited', 'recipe-flows'));
  assert.deepEqual(inheritedFlows.sort(), ['ac1.json', 'ac2.json']);

  // P1 contract: nothing under artifacts/. Worker's provenance gate is
  // responsible for copying after the trust check passes.
  await assert.rejects(
    () => readdir(path.join(taskDir, 'artifacts')),
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
  );

  const provenance = JSON.parse(await readFile(provenancePath, 'utf-8')) as { source?: string };
  assert.equal(provenance.source, PR_BODY_PROVENANCE);
});

test('materializeExtractedRecipe handles empty flow set', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'pr-body-recipe-empty-'));
  const result = await materializeExtractedRecipe({ recipe: { ok: true }, flows: {} }, taskDir);
  assert.equal(result.inheritedFlowFiles.length, 0);

  // Nothing under artifacts/ (P1 contract).
  await assert.rejects(
    () => readdir(path.join(taskDir, 'artifacts')),
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
  );
  const inheritedEntries = await readdir(path.join(taskDir, 'inputs', 'inherited'));
  assert.deepEqual(inheritedEntries.sort(), ['recipe-source.json', 'recipe.json']);
});
