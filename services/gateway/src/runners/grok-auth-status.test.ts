import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatGrokAuthLoginMethod, parseGrokAuthJson } from './grok-auth-status.js';

describe('parseGrokAuthJson', () => {
  it('extracts email from OIDC profile entry without requiring token fields', () => {
    const raw = JSON.stringify({
      'https://auth.x.ai::client-id': {
        auth_mode: 'oidc',
        email: 'danettechan@gmail.com',
        first_name: 'Dnet Breton',
        user_id: '5f985ed8-7a27-45d9-9fcb-ee434ce4afcf',
        refresh_token: 'SECRET_MUST_NOT_LEAK',
        access_token: 'ALSO_SECRET',
      },
    });
    const parsed = parseGrokAuthJson(raw);
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.email, 'danettechan@gmail.com');
    assert.equal(parsed.displayName, 'Dnet Breton');
    assert.equal(parsed.authMode, 'oidc');
    assert.equal(parsed.error, undefined);
    // Ensure parse path never returns secret material on the result object.
    assert.equal(JSON.stringify(parsed).includes('SECRET'), false);
    assert.equal(JSON.stringify(parsed).includes('ALSO_SECRET'), false);
  });

  it('fail-opens on missing file-shaped empty input', () => {
    const parsed = parseGrokAuthJson('');
    assert.equal(parsed.email, null);
    assert.equal(parsed.error, 'empty-output');
  });

  it('fail-opens on garbage', () => {
    const parsed = parseGrokAuthJson('not-json');
    assert.equal(parsed.error, 'unparseable');
  });
});

describe('formatGrokAuthLoginMethod', () => {
  it('labels grok.com seats', () => {
    assert.equal(
      formatGrokAuthLoginMethod({
        loggedIn: true,
        email: 'a@b.com',
        displayName: null,
        authMode: 'oidc',
      }),
      'grok.com · oidc',
    );
  });
});
