import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCodexBarUsageJson } from './codexbar-usage.js';

describe('parseCodexBarUsageJson', () => {
  it('extracts email and used percent from codexbar usage array', () => {
    const raw = JSON.stringify([
      {
        provider: 'codex',
        source: 'oauth',
        usage: {
          accountEmail: 'abreton@siteed.net',
          loginMethod: 'pro',
          identity: { accountEmail: 'abreton@siteed.net', loginMethod: 'pro' },
          primary: null,
          secondary: {
            usedPercent: 48,
            resetsAt: '2026-08-02T05:43:19Z',
          },
        },
      },
    ]);
    const parsed = parseCodexBarUsageJson(raw, 'codex');
    assert.equal(parsed.accountEmail, 'abreton@siteed.net');
    assert.equal(parsed.usedPercent, 48);
    assert.equal(parsed.remainingPercent, 52);
    assert.equal(parsed.resetsAt, '2026-08-02T05:43:19Z');
    assert.equal(parsed.loginMethod, 'pro');
    assert.equal(parsed.source, 'oauth');
  });

  it('fail-opens on garbage output', () => {
    const parsed = parseCodexBarUsageJson('not json at all', 'claude');
    assert.equal(parsed.accountEmail, null);
    assert.equal(parsed.error, 'unparseable');
  });
});
