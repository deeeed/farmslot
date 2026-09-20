import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  attentionLabel,
  createPreferencesStore,
  DEFAULT_SHORTCUT,
  restoreBounds,
  savedRoute,
  validateAttention,
} from '../src/preferences.mjs';

test('preferences survive app replacement without storing credentials in routes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'farmslot-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createPreferencesStore(directory);
  assert.equal(store.load().shortcut, DEFAULT_SHORTCUT);
  store.save({
    shortcut: 'CommandOrControl+Shift+F',
    route: '#run/example?file=src%2Fmain.ts',
    bounds: { x: 42, y: 43, width: 1000, height: 800 },
  });
  assert.deepEqual(createPreferencesStore(directory).load(), store.load());
  assert.equal(savedRoute('#fleet?token=private'), '#fleet');
  assert.equal(savedRoute('https://example.com'), '#fleet');
});

test('a removed display restores the entire window to the remaining display', () => {
  const display = { x: 0, y: 25, width: 1440, height: 875 };
  assert.deepEqual(restoreBounds({ x: 3000, y: -500, width: 1600, height: 1000 }, [display]), {
    x: 0,
    y: 25,
    width: 1440,
    height: 875,
  });
  assert.deepEqual(restoreBounds({ x: 40, y: 50, width: 1000, height: 700 }, [display]), {
    x: 40,
    y: 50,
    width: 1000,
    height: 700,
  });
});

test('menu bar never reports a stale decision count as current after disconnect', () => {
  assert.equal(
    attentionLabel({ connected: false, ready: true, decisions: 7 }),
    'Gateway disconnected',
  );
  assert.equal(
    attentionLabel({ connected: true, ready: false, decisions: 7 }),
    'Loading pending decisions',
  );
  assert.equal(
    attentionLabel(validateAttention({ connected: true, ready: true, decisions: 2 })),
    '2 pending decisions',
  );
  assert.throws(() => validateAttention({ connected: true, ready: true, decisions: -1 }));
});
