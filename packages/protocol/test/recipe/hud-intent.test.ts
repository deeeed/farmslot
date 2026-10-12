import assert from 'node:assert/strict';
import test from 'node:test';

import { RECIPE_PROTOCOL_SCHEMA_URL } from '../../src/recipe/common.js';
import { validateRecipeDocument } from '../../src/recipe/document.js';
import { hudIntentDisplay, hudPlacement, waitForHudPaint } from '../../src/recipe/hud-intent.js';

test('HUD acknowledgement waits for a paint without a fixed timer', async () => {
  const frames: (() => void)[] = [];
  let completed = false;
  const pending = waitForHudPaint((callback) => frames.push(callback)).then(() => {
    completed = true;
  });
  assert.equal(completed, false);
  frames.shift()!();
  assert.equal(completed, false);
  frames.shift()!();
  await pending;
  assert.equal(completed, true);
});

test('HUD placement retains the vertical edge of supported display positions', () => {
  for (const position of ['top', 'top-left', 'top-right'])
    assert.equal(hudPlacement({ position }), 'top');
  for (const position of ['bottom', 'bottom-left', 'bottom-right'])
    assert.equal(hudPlacement({ position }), 'bottom');
  for (const display of [undefined, null, {}, { position: 'side' }])
    assert.equal(hudPlacement(display), undefined);
});

function recipe(intent: string) {
  return {
    $schema: RECIPE_PROTOCOL_SCHEMA_URL,
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'demo.read', intent, next: 'done' },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
}

test('intent survives transport intact, with wrapping and trailing ellipsis deferred to layout', () => {
  const authored = `Show ${'the full measured proof 🧪 '.repeat(15)}without cutting the end.`;
  const native = hudIntentDisplay(authored, 'native');
  const dom = hudIntentDisplay(authored);
  assert.equal(native.text, authored);
  assert.equal(dom.text, authored);
  assert.deepEqual(native.nativeProps, {
    numberOfLines: 2,
    ellipsizeMode: 'tail',
    allowFontScaling: false,
  });
  assert.equal(dom.webStyle.WebkitLineClamp, '2');
  assert.equal(dom.webStyle.whiteSpace, 'normal');
  assert.equal(dom.webStyle.overflowWrap, 'anywhere');
  assert.equal(dom.webStyle.textOverflow, 'ellipsis');
  assert.equal(dom.webStyle.maxHeight, '32px');
  assert.deepEqual(native.panel, { maxWidth: 360, maxHeight: 88 });
  assert.deepEqual(dom.panel, { maxWidth: 360, maxHeight: 144 });
  assert.deepEqual(hudIntentDisplay(authored, 'bar').panel, { maxWidth: 960, maxHeight: 144 });
});

test('display normalizes whitespace without a character cut or broken Unicode', () => {
  assert.equal(hudIntentDisplay('  Confirm\n the\t 🧪 result. ').text, 'Confirm the 🧪 result.');
  assert.equal(hudIntentDisplay(null).text, '');
  assert.equal(hudIntentDisplay('🧪'.repeat(121)).text, '🧪'.repeat(121));
});

for (const [length, severity] of [
  [80, undefined],
  [81, 'warning'],
  [120, 'warning'],
  [121, 'error'],
] as const) {
  test(`authoring lint boundary ${length} characters`, () => {
    const result = validateRecipeDocument(recipe('x'.repeat(length)), { lintIntent: true });
    const findings = result.findings.filter(
      (finding) => finding.code === 'workflow.intent_too_long',
    );
    assert.equal(findings.length, severity ? 1 : 0);
    if (severity) assert.equal(findings[0].severity, severity);
    assert.equal(result.summary.errors, severity === 'error' ? 1 : 0);
  });
}

test('authoring counts Unicode code points after trimming; old graph/evidence validation is unchanged', () => {
  const document = recipe(`  ${'🧪'.repeat(81)}  `);
  assert.equal(validateRecipeDocument(document).summary.warnings, 0);
  assert.equal(validateRecipeDocument(document, { lintIntent: true }).summary.warnings, 1);
  assert.equal(validateRecipeDocument(recipe('x'.repeat(121))).summary.errors, 0);
});
