import { strict as assert } from 'node:assert';
import test from 'node:test';

import { computeSlotViewResizeValue, slotViewResizeCursor } from './slot-view-resize-model.js';

test('slotViewResizeCursor maps horizontal and vertical resize targets', () => {
  assert.equal(slotViewResizeCursor('sidebar'), 'col-resize');
  assert.equal(slotViewResizeCursor('stream'), 'col-resize');
  assert.equal(slotViewResizeCursor('review'), 'col-resize');
  assert.equal(slotViewResizeCursor('terminal'), 'row-resize');
  assert.equal(slotViewResizeCursor('pinned'), 'row-resize');
});

test('computeSlotViewResizeValue clamps sidebar width between 150 and 500', () => {
  assert.equal(
    computeSlotViewResizeValue({
      type: 'sidebar',
      startX: 100,
      startY: 0,
      clientX: 180,
      clientY: 0,
      startValue: 260,
    }),
    340,
  );
  assert.equal(
    computeSlotViewResizeValue({
      type: 'sidebar',
      startX: 100,
      startY: 0,
      clientX: -100,
      clientY: 0,
      startValue: 260,
    }),
    150,
  );
});

test('computeSlotViewResizeValue expands stream and review panels when dragging left', () => {
  assert.equal(
    computeSlotViewResizeValue({
      type: 'stream',
      startX: 400,
      startY: 0,
      clientX: 300,
      clientY: 0,
      startValue: 320,
      maxWidth: 450,
    }),
    420,
  );
  assert.equal(
    computeSlotViewResizeValue({
      type: 'review',
      startX: 400,
      startY: 0,
      clientX: 0,
      clientY: 0,
      startValue: 320,
      maxWidth: 600,
    }),
    600,
  );
});

test('computeSlotViewResizeValue clamps pinned and terminal vertical heights', () => {
  assert.equal(
    computeSlotViewResizeValue({
      type: 'pinned',
      startX: 0,
      startY: 100,
      clientX: 0,
      clientY: 180,
      startValue: 200,
    }),
    280,
  );
  assert.equal(
    computeSlotViewResizeValue({
      type: 'terminal',
      startX: 0,
      startY: 400,
      clientX: 0,
      clientY: 100,
      startValue: 250,
      maxHeight: 500,
    }),
    500,
  );
});
