import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Command } from 'commander';

import { resolveContext } from './context.js';

test('unmatched worker URL keeps its profile-registration hint through command context', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'gateway-context-'));
  const previousHome = process.env.FARMSLOT_HOME;
  const previousUrl = process.env.GW_URL;
  t.after(() => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    if (previousUrl === undefined) delete process.env.GW_URL;
    else process.env.GW_URL = previousUrl;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.FARMSLOT_HOME = home;
  process.env.GW_URL = 'ws://unmatched.invalid:7801';
  const command = new Command().option('--json').parse(['node', 'fixture']);
  assert.throws(
    () => resolveContext(command),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const hint = (error as Error & { userAction: string }).userAction;
      assert.match(hint, /farmslot gateway add.*farmslot login/);
      assert.ok(!hint.includes('--url'));
      return true;
    },
  );
});
