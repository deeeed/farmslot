import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs, { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';

import { Methods } from '@farmslot/protocol';

import { createGatewayAuthRuntime, type GatewayAuthSession } from './auth.js';
import { authorizeGatewayMethod } from './authorization.js';
import { generateCredentialSecret, hashSecret } from './credential-secret.js';
import {
  type CredentialStore,
  CredentialStoreRuntime,
  loadCredentialStore,
  readCredentialStoreSnapshot,
} from './credential-store.js';
import { withCredentialStoreLock } from './credential-store-lock.js';

function fixture(t: TestContext) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const home = mkdtempSync(join(tmpdir(), 'credential-freshness-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { FARMSLOT_HOME: home, GATEWAY_HOST: '127.0.0.1' };
  const runtime = createGatewayAuthRuntime(env);
  const principal = runtime.writer.createPrincipal({ type: 'service', displayName: 'reader' }, [
    { role: 'operator', scope: { kind: 'global' } },
  ]);
  const issued = runtime.writer.issueCredential(principal.id, 'reader');
  const session: GatewayAuthSession = {
    authenticated: true,
    authentication: { kind: 'credential', credentialId: issued.record.id },
  };
  const path = runtime.store.path;
  const authorize = () => authorizeGatewayMethod(runtime, session, Methods.NODES_LIST);
  const external = (mutate: (store: CredentialStore) => void) => {
    const next = loadCredentialStore(path);
    mutate(next);
    writeFileSync(path + '.external', JSON.stringify(next));
    renameSync(path + '.external', path);
  };
  return {
    home,
    env,
    path,
    runtime,
    issued,
    principal,
    session,
    authorize,
    external,
    setNow: (value: number) => {
      now = value;
    },
  };
}
function countStats(
  t: TestContext,
  path: string,
  respond?: (...args: Parameters<typeof fs.statSync>) => ReturnType<typeof fs.statSync>,
) {
  const stat = fs.statSync;
  let calls = 0;
  const spy = t.mock.method(fs, 'statSync', (...args: Parameters<typeof stat>) => {
    if (String(args[0]) === path) {
      calls++;
      if (respond) return respond(...args);
    }
    return stat(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    spy.mock.restore();
    syncBuiltinESMExports();
  });
  return () => calls;
}
function revoke(store: CredentialStore, id: string) {
  const record = store.credentials.find((c) => c.id === id);
  assert(record);
  record.revokedAt = new Date().toISOString();
}

test('authorization and frozen snapshot reads share at most one stat per 100 ms', (t) => {
  const f = fixture(t);
  const stats = countStats(t, f.path);
  f.setNow(100);
  for (let n = 0; n < 100; n++) {
    assert.equal(f.authorize().id, f.principal.id);
    readCredentialStoreSnapshot(f.path);
  }
  assert.equal(stats(), 1);
  f.setNow(199);
  f.authorize();
  assert.equal(stats(), 1);
  f.setNow(200);
  f.authorize();
  assert.equal(stats(), 2);
});
test('local writer revocation reaches other runtimes and path aliases immediately', (t) => {
  const f = fixture(t);
  const other = new CredentialStoreRuntime(f.env);
  const alias = f.home + '/./credentials.json';
  const before = readCredentialStoreSnapshot(alias);
  f.authorize();
  other.snapshot();
  f.runtime.writer.revokeCredential(f.issued.record.id);
  assert.throws(f.authorize, { code: 'AUTH_REQUIRED' });
  assert.notEqual(other.findCredential(f.issued.record.id)?.revokedAt, null);
  const after = readCredentialStoreSnapshot(alias);
  assert.notEqual(after, before);
  assert.notEqual(after.credentials.find((c) => c.id === f.issued.record.id)?.revokedAt, null);
});
test('external revocation is refused at the 100 ms boundary, with no sliding deadline', (t) => {
  const f = fixture(t);
  f.authorize();
  f.external((store) => revoke(store, f.issued.record.id));
  for (let now = 1; now < 100; now++) {
    f.setNow(now);
    assert.equal(f.authorize().id, f.principal.id);
  }
  f.setNow(100);
  assert.throws(f.authorize, { code: 'AUTH_REQUIRED' });
  assert.notEqual(
    readCredentialStoreSnapshot(f.path).credentials.find((c) => c.id === f.issued.record.id)
      ?.revokedAt,
    null,
  );
});
test('external role removal does not retain the old grant after 100 ms', (t) => {
  const f = fixture(t);
  f.authorize();
  f.external((store) => {
    const p = store.principals.find((p) => p.id === f.principal.id);
    assert(p);
    p.roles = [];
  });
  f.setNow(100);
  assert.throws(f.authorize, { code: 'AUTH_FORBIDDEN' });
});
test('a racy unchanged stamp cannot hide a revocation after the recheck boundary', (t) => {
  const f = fixture(t);
  f.authorize();
  readCredentialStoreSnapshot(f.path);
  const stamp = fs.statSync(f.path);
  countStats(t, f.path, () => stamp);
  f.external((store) => revoke(store, f.issued.record.id));
  f.setNow(100);
  assert.throws(f.authorize, { code: 'AUTH_REQUIRED' });
  assert.notEqual(
    readCredentialStoreSnapshot(f.path).credentials.find((c) => c.id === f.issued.record.id)
      ?.revokedAt,
    null,
  );
});
test('malformed store at the deadline never falls back to last known good authority', (t) => {
  const f = fixture(t);
  f.authorize();
  readCredentialStoreSnapshot(f.path);
  writeFileSync(f.path, '{');
  f.setNow(100);
  for (let n = 0; n < 2; n++) {
    assert.throws(f.authorize, /not valid JSON/);
    assert.throws(() => readCredentialStoreSnapshot(f.path), /not valid JSON/);
  }
});
test('stat failure at the deadline is retried and fails closed', (t) => {
  const f = fixture(t);
  f.authorize();
  readCredentialStoreSnapshot(f.path);
  countStats(t, f.path, () => {
    throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' });
  });
  f.setNow(100);
  for (let n = 0; n < 2; n++) {
    assert.throws(f.authorize, { code: 'EACCES' });
    assert.throws(() => readCredentialStoreSnapshot(f.path), { code: 'EACCES' });
  }
});
test('a removed external store cannot authorize the bound credential after 100 ms', (t) => {
  const f = fixture(t);
  f.authorize();
  rmSync(f.path);
  f.setNow(100);
  assert.throws(f.authorize, { code: 'AUTH_REQUIRED' });
});

test('a secret changed externally during async verification cannot create a session', async (t) => {
  const f = fixture(t);
  const derive = crypto.scrypt;
  let finish: (() => void) | undefined;
  let notify!: () => void;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const spy = t.mock.method(crypto, 'scrypt', (...args: Parameters<typeof derive>) => {
    const [password, salt, length, options, callback] = args;
    return derive(password, salt, length, options, (error, key) => {
      finish = () => callback(error, key);
      notify();
    });
  });
  syncBuiltinESMExports();
  const authentication = f.runtime.resolver.resolveSecret(f.issued.secret, 'token');
  try {
    await Promise.race([
      entered,
      authentication.then(() => {
        throw new Error('verification did not enter the gate');
      }),
    ]);
    f.external((store) => {
      const record = store.credentials.find((c) => c.id === f.issued.record.id);
      assert(record);
      record.secret = hashSecret(generateCredentialSecret());
    });
  } finally {
    finish?.();
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  const result = await authentication;
  assert.equal(
    result.ok,
    false,
    'the post-derivation freshness fence must bypass the 100 ms cache',
  );
});

test('a local grant is visible on the next authorization without waiting for the interval', (t) => {
  const f = fixture(t);
  assert.throws(() => authorizeGatewayMethod(f.runtime, f.session, 'principal.create'), {
    code: 'AUTH_FORBIDDEN',
  });
  f.runtime.writer.grantRole(f.principal.id, 'admin', { kind: 'global' });
  const principal = authorizeGatewayMethod(f.runtime, f.session, 'principal.create');
  assert.equal(
    principal.roles.some((binding) => binding.role === 'admin'),
    true,
  );
});
test('shared freshness observations never share authority between different homes', (t) => {
  const first = fixture(t);
  const second = fixture(t);
  first.runtime.writer.grantRole(first.principal.id, 'admin', { kind: 'global' });
  assert.throws(() => authorizeGatewayMethod(second.runtime, first.session, Methods.NODES_LIST), {
    code: 'AUTH_REQUIRED',
  });
  assert.throws(() => authorizeGatewayMethod(second.runtime, second.session, 'principal.create'), {
    code: 'AUTH_FORBIDDEN',
  });
  assert.equal(
    readCredentialStoreSnapshot(first.path)
      .principals.find((p) => p.id === first.principal.id)
      ?.roles.some((r) => r.role === 'admin'),
    true,
  );
  assert.equal(
    readCredentialStoreSnapshot(second.path)
      .principals.find((p) => p.id === second.principal.id)
      ?.roles.some((r) => r.role === 'admin'),
    false,
  );
});

test('a direct locked save invalidates cached authority before any runtime reload', (t) => {
  const f = fixture(t);
  f.authorize();
  const alias = f.home + '/./credentials.json';
  readCredentialStoreSnapshot(alias);
  withCredentialStoreLock(
    (store) => {
      const next = structuredClone(store);
      revoke(next, f.issued.record.id);
      return { next, result: undefined };
    },
    { env: f.env },
  );
  assert.throws(f.authorize, { code: 'AUTH_REQUIRED' });
  assert.notEqual(
    readCredentialStoreSnapshot(alias).credentials.find((c) => c.id === f.issued.record.id)
      ?.revokedAt,
    null,
  );
});

test('a settled runtime projection is reused across a stat recheck', (t) => {
  const f = fixture(t);
  const settledAt = Date.now() + 10_000;
  t.mock.method(Date, 'now', () => settledAt);
  const stats = countStats(t, f.path);
  f.setNow(100);
  const first = f.runtime.store.snapshot();
  assert.equal(stats(), 1);
  f.setNow(200);
  assert.equal(f.runtime.store.snapshot(), first);
  assert.equal(stats(), 2);
});
