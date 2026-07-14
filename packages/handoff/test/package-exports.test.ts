import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

test('package exports expose the stable public handoff surface', async () => {
  const root = await dynamicImport('@farmslot/handoff');
  assert.equal(typeof root.validateLearningPackage, 'function');
  assert.equal(typeof root.assembleLearningPackage, 'function');
  assert.equal(typeof root.scrubFiles, 'function');
  assert.equal(typeof root.scanForFloorSecrets, 'function');
  assert.equal(typeof root.loadSchema, 'function');
  assert.equal(typeof root.isValidRunSlug, 'function');
  assert.equal(root.SCHEMA_VERSION, 1);

  assert.equal(typeof root.writeLearningPackage, 'function');
  assert.equal(typeof root.deriveTaskKey, 'function');
  assert.equal(typeof root.resolveFile, 'function');
  assert.equal(typeof root.resolveContent, 'function');
  assert.equal(typeof root.extractTaskDocument, 'function');
  assert.equal(typeof root.renderTaskMarkdown, 'function');
  assert.equal(typeof root.buildPrPackage, 'function');
  assert.equal(typeof root.publishPrEvidence, 'function');

  const validate = await dynamicImport('@farmslot/handoff/validate');
  const scrub = await dynamicImport('@farmslot/handoff/scrub');
  const learning = await dynamicImport('@farmslot/handoff/learning-package');
  const spec = await dynamicImport('@farmslot/handoff/spec');
  const resolve = await dynamicImport('@farmslot/handoff/resolve');
  const taskIo = await dynamicImport('@farmslot/handoff/task-io');
  const prPublish = await dynamicImport('@farmslot/handoff/pr-publish');
  assert.equal(typeof validate.validateLearningPackage, 'function');
  assert.equal(typeof scrub.scrubFiles, 'function');
  assert.equal(typeof learning.assembleLearningPackage, 'function');
  assert.equal(typeof learning.writeLearningPackage, 'function');
  assert.equal(typeof spec.loadSchema, 'function');
  assert.equal(typeof spec.deriveTaskKey, 'function');
  assert.equal(typeof resolve.resolveFile, 'function');
  assert.equal(typeof taskIo.extractTaskDocument, 'function');
  assert.equal(typeof prPublish.buildPrPackage, 'function');
});

test('the shipped schema assets are reachable as package subpaths', () => {
  const require = createRequire(import.meta.url);
  const resolved = require.resolve('@farmslot/handoff/schemas/manifest.schema.json');
  const schema = JSON.parse(readFileSync(resolved, 'utf8')) as { $id: string };
  assert.ok(schema.$id.endsWith('manifest.schema.json'));
});

test('package exports are explicit and extensionless (except schema assets)', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, unknown> };
  const subpaths = Object.keys(packageJson.exports).filter((s) => !s.startsWith('./schemas'));
  assert.equal(
    subpaths.some((s) => s.endsWith('.js')),
    false,
  );
  assert.equal(
    subpaths.some((s) => s.includes('*')),
    false,
  );
});
