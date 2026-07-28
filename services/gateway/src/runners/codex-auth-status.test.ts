import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeJwtPayload,
  formatCodexAuthLoginMethod,
  parseCodexAuthJson,
  parseCodexLoginStatusText,
} from './codex-auth-status.js';

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('parseCodexAuthJson', () => {
  it('extracts email and plan from id_token claims without leaking tokens', () => {
    const idToken = fakeJwt({
      email: 'abreton@siteed.net',
      name: 'Arthur Breton',
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'pro',
        chatgpt_user_id: 'user-x',
      },
    });
    const raw = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: idToken,
        access_token: 'ACCESS_SECRET',
        refresh_token: 'REFRESH_SECRET',
        account_id: 'acct',
      },
    });
    const parsed = parseCodexAuthJson(raw);
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.email, 'abreton@siteed.net');
    assert.equal(parsed.planType, 'pro');
    assert.equal(parsed.authMode, 'chatgpt');
    const serialized = JSON.stringify(parsed);
    assert.equal(serialized.includes('ACCESS_SECRET'), false);
    assert.equal(serialized.includes('REFRESH_SECRET'), false);
    assert.equal(serialized.includes(idToken), false);
  });

  it('fail-opens on garbage', () => {
    assert.equal(parseCodexAuthJson('nope').error, 'unparseable');
  });
});

describe('parseCodexLoginStatusText', () => {
  it('parses ChatGPT login line', () => {
    const parsed = parseCodexLoginStatusText('Logged in using ChatGPT\n');
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.authMode, 'chatgpt');
  });
});

describe('decodeJwtPayload + formatCodexAuthLoginMethod', () => {
  it('decodes payload and formats plan · mode', () => {
    const jwt = fakeJwt({ email: 'a@b.com' });
    assert.equal(decodeJwtPayload(jwt)?.email, 'a@b.com');
    assert.equal(
      formatCodexAuthLoginMethod({
        loggedIn: true,
        email: 'a@b.com',
        planType: 'pro',
        authMode: 'chatgpt',
      }),
      'pro · chatgpt',
    );
  });
});
