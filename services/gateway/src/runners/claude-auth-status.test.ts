import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatClaudeAuthLoginMethod, parseClaudeAuthStatusJson } from './claude-auth-status.js';

describe('parseClaudeAuthStatusJson', () => {
  it('extracts email and subscription from claude auth status json', () => {
    const raw = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'deeeed@gmail.com',
      orgId: '68dbc4aa-d442-40e9-82bd-2a3fff330aa7',
      orgName: "deeeed@gmail.com's Organization",
      subscriptionType: 'max',
    });
    const parsed = parseClaudeAuthStatusJson(raw);
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.email, 'deeeed@gmail.com');
    assert.equal(parsed.subscriptionType, 'max');
    assert.equal(parsed.authMethod, 'claude.ai');
    assert.equal(parsed.orgName, "deeeed@gmail.com's Organization");
    assert.equal(parsed.error, undefined);
  });

  it('fail-opens on garbage', () => {
    const parsed = parseClaudeAuthStatusJson('not json');
    assert.equal(parsed.loggedIn, false);
    assert.equal(parsed.email, null);
    assert.equal(parsed.error, 'unparseable');
  });

  it('handles logged-out payload', () => {
    const parsed = parseClaudeAuthStatusJson(JSON.stringify({ loggedIn: false }));
    assert.equal(parsed.loggedIn, false);
    assert.equal(parsed.email, null);
  });
});

describe('formatClaudeAuthLoginMethod', () => {
  it('joins plan and auth method', () => {
    assert.equal(
      formatClaudeAuthLoginMethod({
        loggedIn: true,
        email: 'a@b.com',
        subscriptionType: 'max',
        authMethod: 'claude.ai',
        orgName: null,
      }),
      'max · claude.ai',
    );
  });
});
