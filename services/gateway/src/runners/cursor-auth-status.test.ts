import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatCursorAuthLoginMethod,
  parseCursorAuthStatusJson,
  parseCursorAuthStatusText,
} from './cursor-auth-status.js';

describe('parseCursorAuthStatusJson', () => {
  it('extracts email from status --format json', () => {
    const raw = JSON.stringify({
      status: 'authenticated',
      isAuthenticated: true,
      hasAccessToken: true,
      hasRefreshToken: true,
      userInfo: {
        email: 'arthur.breton@consensys.net',
        userId: 78775097,
        firstName: 'Arthur',
        lastName: 'Breton',
        teamId: 1196733,
      },
    });
    const parsed = parseCursorAuthStatusJson(raw);
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.email, 'arthur.breton@consensys.net');
    assert.equal(parsed.displayName, 'Arthur Breton');
    assert.equal(JSON.stringify(parsed).includes('hasAccessToken'), false);
  });

  it('falls back to text when not json', () => {
    const parsed = parseCursorAuthStatusJson('✓ Logged in as arthur.breton@consensys.net\n');
    assert.equal(parsed.email, 'arthur.breton@consensys.net');
  });
});

describe('parseCursorAuthStatusText', () => {
  it('parses logged-in line', () => {
    const parsed = parseCursorAuthStatusText('✓ Logged in as arthur.breton@consensys.net');
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.email, 'arthur.breton@consensys.net');
  });
});

describe('formatCursorAuthLoginMethod', () => {
  it('returns cursor when logged in', () => {
    assert.equal(
      formatCursorAuthLoginMethod({
        loggedIn: true,
        email: 'a@b.com',
        displayName: null,
      }),
      'cursor',
    );
  });
});
