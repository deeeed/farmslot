import assert from 'node:assert/strict';
import test from 'node:test';

import {
  draftRestored,
  openOnSlot,
  sentThroughRunner,
  sessionRecreated,
  typedOnce,
} from './one-terminal-claims.mjs';

const slot = 'offline-proof-1';
const open = {
  focused: true,
  terminalReady: true,
  terminalStream: 'live',
  terminalTarget: { slotId: slot, bareSession: true },
};

test('typing once passes only for one command and one output line', () => {
  assert.equal(typedOnce('KT> echo ot-1\not-1\nKT> \n\n', 'ot-1'), true);
  // A replayed Return types the line twice; a dropped one never prints the output.
  assert.equal(typedOnce('KT> echo ot-1\not-1\nKT> echo ot-1\not-1\nKT> ', 'ot-1'), false);
  assert.equal(typedOnce('KT> echo ot-1', 'ot-1'), false);
});

test('opening on a slot needs a live pane on that slot', () => {
  assert.equal(openOnSlot(open, slot), true);
  assert.equal(openOnSlot({ ...open, terminalReady: false }, slot), false);
  assert.equal(openOnSlot({ ...open, terminalStream: 'connecting' }, slot), false);
  assert.equal(openOnSlot({ ...open, terminalTarget: { slotId: 'other' } }, slot), false);
});

test('a recreated session needs a finished reinit and the session back', () => {
  assert.equal(sessionRecreated({ terminalReinit: 'done' }, true), true);
  assert.equal(sessionRecreated({ terminalReinit: 'idle' }, true), false);
  assert.equal(sessionRecreated({ terminalReinit: 'done' }, false), false);
});

test('a restored draft must be the same text on a ready pane', () => {
  assert.equal(
    draftRestored({ terminalReady: true, terminalDraft: 'status please' }, 'status please'),
    true,
  );
  assert.equal(draftRestored({ terminalReady: true, terminalDraft: '' }, 'status please'), false);
  assert.equal(
    draftRestored({ terminalReady: false, terminalDraft: 'status please' }, 'status please'),
    false,
  );
});

test("a slot terminal's Send must add exactly one terminal.send", () => {
  assert.equal(sentThroughRunner({ terminalSends: ['terminal.send'] }, 0), true);
  // Typed into the pane instead, sent twice, or not sent.
  assert.equal(sentThroughRunner({ terminalSends: ['terminal.worker.input'] }, 0), false);
  assert.equal(sentThroughRunner({ terminalSends: ['terminal.send', 'terminal.send'] }, 0), false);
  assert.equal(sentThroughRunner({ terminalSends: [] }, 0), false);
});
