import assert from 'node:assert/strict';
import test from 'node:test';

import { RECIPE_PROTOCOL_SCHEMA_URL } from '../../src/recipe/common.js';
import { validateRecipeDocument } from '../../src/recipe/document.js';
import {
  HUD_FINISHED_FONT_SIZE,
  HUD_FINISHED_LINE_HEIGHT,
  HUD_INTENT_FONT_SIZE,
  HUD_INTENT_LINE_HEIGHT,
  HUD_INTENT_MAX_LINES,
  HUD_NATIVE_FINISHED_FONT_SIZE,
  HUD_NATIVE_FINISHED_LINE_HEIGHT,
  HUD_NATIVE_INTENT_FONT_SIZE,
  HUD_NATIVE_INTENT_LINE_HEIGHT,
  HUD_NATIVE_INTENT_MAX_LINES,
  hudFinishedLine,
  hudIntentDisplay,
  hudPlacement,
  type HudStepResult,
  nextHudFinishedStep,
  RECIPE_INTENT_MAX_LENGTH,
  RECIPE_INTENT_WARN_LENGTH,
  waitForHudPaint,
} from '../../src/recipe/hud-intent.js';

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

test('HUD acknowledgement rejects a suspended renderer within its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = assert.rejects(
    waitForHudPaint(() => {}),
    /HUD did not paint within 500ms/,
  );
  t.mock.timers.tick(500);
  await result;
});

test('HUD acknowledgement cancels pending and already-aborted paints', async () => {
  const controller = new AbortController();
  const reason = new Error('HUD provider unmounted.');
  const pending = waitForHudPaint(() => {}, controller.signal);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  let requested = false;
  await assert.rejects(
    waitForHudPaint(() => {
      requested = true;
    }, controller.signal),
    (error) => error === reason,
  );
  assert.equal(requested, false);
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

test('HUD readability constants: a larger web intent, an unchanged native panel', () => {
  assert.deepEqual(
    [HUD_INTENT_FONT_SIZE, HUD_INTENT_LINE_HEIGHT, HUD_INTENT_MAX_LINES],
    [16, 20, 3],
  );
  assert.deepEqual(
    [HUD_NATIVE_INTENT_FONT_SIZE, HUD_NATIVE_INTENT_LINE_HEIGHT, HUD_NATIVE_INTENT_MAX_LINES],
    [13, 17, 2],
  );
  assert.deepEqual([HUD_FINISHED_FONT_SIZE, HUD_FINISHED_LINE_HEIGHT], [11, 14]);
  assert.deepEqual([HUD_NATIVE_FINISHED_FONT_SIZE, HUD_NATIVE_FINISHED_LINE_HEIGHT], [10, 13]);
  assert.deepEqual([RECIPE_INTENT_WARN_LENGTH, RECIPE_INTENT_MAX_LENGTH], [80, 120]);
});

test('intent survives transport intact; web never clamps it and native keeps two lines', () => {
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
  assert.deepEqual(native.nativeStyle, { lineHeight: 17, maxHeight: 34, fontSize: 13 });
  assert.deepEqual(dom.webStyle, {
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    fontSize: '16px',
    lineHeight: '20px',
    fontWeight: '600',
  });
  for (const platform of ['card', 'bar'] as const) {
    const style: Record<string, string> = hudIntentDisplay(authored, platform).webStyle;
    for (const clip of ['WebkitLineClamp', 'textOverflow', 'maxHeight', 'overflow', 'display'])
      assert.equal(style[clip], undefined, `${platform} webStyle sets ${clip}`);
  }
  assert.deepEqual(native.panel, { maxWidth: 360, maxHeight: 88 });
  assert.deepEqual(dom.panel, { maxWidth: 500, maxHeight: 144 });
  assert.deepEqual(hudIntentDisplay(authored, 'bar').panel, { maxWidth: 960, maxHeight: 144 });
});

test('the finished line shows a result only once it left the main line', () => {
  const pass = { nodeId: 'open', intent: ' Open  the market ', status: 'pass' };
  const fail = { nodeId: 'close', intent: 'Close the position', status: 'fail' };
  assert.equal(hudFinishedLine(null, 'open'), null);
  assert.equal(hudFinishedLine(undefined), null);
  assert.equal(hudFinishedLine(pass, 'open'), null);
  assert.deepEqual(hudFinishedLine(pass, 'close'), { text: '✓ Open the market', tone: 'pass' });
  assert.deepEqual(hudFinishedLine(pass), { text: '✓ Open the market', tone: 'pass' });
  assert.equal(hudFinishedLine(fail, 'close'), null);
  assert.deepEqual(hudFinishedLine(fail, 'next'), { text: '✗ Close the position', tone: 'fail' });
  assert.equal(hudFinishedLine({ ...pass, status: 'running' }, 'other'), null);
});

test('native finished-step history resets at each new run', () => {
  const run = (updates: Array<{ status: string; intent: string; currentStep?: number } | null>) => {
    let last: HudStepResult | null = null;
    return updates.map((update) => {
      const step = nextHudFinishedStep(last, update);
      last = step.last;
      return step.finished?.intent ?? null;
    });
  };
  const first = [
    { status: 'running', intent: 'Open', currentStep: 1 },
    { status: 'pass', intent: 'Open', currentStep: 1 },
    { status: 'running', intent: 'Buy', currentStep: 2 },
    { status: 'pass', intent: 'Recipe completed', currentStep: 3 },
  ];
  assert.deepEqual(run(first), [null, null, 'Open', 'Open']);
  // The same recipe again without a reset: the first run's last result never shows.
  assert.deepEqual(run([...first, ...first]), [
    null,
    null,
    'Open',
    'Open',
    null,
    null,
    'Open',
    'Open',
  ]);
  // A one-step run repeated, a cleared HUD and an idle HUD also start clean.
  const single = [
    { status: 'running', intent: 'Only', currentStep: 1 },
    { status: 'pass', intent: 'Only', currentStep: 1 },
  ];
  assert.deepEqual(run([...single, ...single]), [null, null, null, null]);
  assert.deepEqual(run([...first.slice(0, 2), null, first[2]]), [null, null, null, null]);
  assert.deepEqual(run([...first.slice(0, 2), { status: 'idle', intent: '' }, first[2]]), [
    null,
    null,
    null,
    null,
  ]);
  // A failing step is the main line (in the fail colour); the line below keeps the last pass.
  assert.deepEqual(run([...first.slice(0, 3), { status: 'fail', intent: 'Buy', currentStep: 2 }]), [
    null,
    null,
    'Open',
    'Open',
  ]);
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
