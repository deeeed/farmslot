import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { claudeAccountState, observeClaudeAccount } from './account-claude.js';
import { codexAccountState, observeCodexAccount } from './account-codex.js';
import { accountProtocolProbe, observeNativeAccount } from './account-common.js';
import { cursorAccountState, observeCursorAccount } from './account-cursor.js';
import { grokAccountState, observeGrokAccount } from './account-grok.js';

const secret = 'DO_NOT_EXPOSE_NATIVE_SECRET';
test('native status parsers allowlist identity fields and preserve differing identity quality', () => {
  const claude = claudeAccountState({
    loggedIn: true,
    authMethod: 'claude.ai',
    email: 'one@example.test',
    orgId: 'org-a',
    accountId: 'unsupported',
    accessToken: secret,
    configDirectory: secret,
  });
  assert.deepEqual(claude, {
    login: 'authenticated',
    mode: 'subscription',
    identity: { email: 'one@example.test', organizationId: 'org-a' },
    identityQuality: 'display-only',
  });
  const cursor = cursorAccountState({
    isAuthenticated: true,
    hasAccessToken: true,
    token: secret,
    userInfo: { userId: 7, teamId: 19, email: 'two@example.test', token: secret },
  });
  assert.deepEqual(cursor, {
    login: 'authenticated',
    mode: 'unknown',
    identity: { subjectId: '7', organizationId: '19', email: 'two@example.test' },
    identityQuality: 'stable-subject',
  });
  const codex = codexAccountState({
    account: {
      type: 'chatgpt',
      email: 'three@example.test',
      planType: 'pro',
      accountId: 'unsupported',
      accessToken: secret,
    },
    requiresOpenaiAuth: true,
  });
  assert.equal(codex.identityQuality, 'display-only');
  assert.deepEqual(codex.identity, { email: 'three@example.test' });
  const grok = grokAccountState({
    _meta: {
      auth_mode: 'Oidc',
      email: 'four@example.test',
      team_id: 'org-b',
      subscription_tier: 'tier',
      access_token: secret,
      user_id: 'unsupported',
    },
  });
  assert.equal(grok.identityQuality, 'display-only');
  assert.deepEqual(grok.identity, { email: 'four@example.test', organizationId: 'org-b' });
  assert.ok(!JSON.stringify([claude, cursor, codex, grok]).includes(secret));
});

test('signed-out, malformed, API and missing identity cannot become stable subscription identity', () => {
  assert.equal(
    claudeAccountState({ loggedIn: false, email: 'stale', orgId: 'stale' }).identity,
    undefined,
  );
  assert.equal(
    cursorAccountState({ isAuthenticated: false, userInfo: { userId: 7 } }).login,
    'signed-out',
  );
  assert.equal(cursorAccountState({ hasAccessToken: true }).login, 'unavailable');
  assert.equal(codexAccountState({ account: null, requiresOpenaiAuth: true }).login, 'signed-out');
  assert.equal(
    codexAccountState({ account: null, requiresOpenaiAuth: false }).login,
    'unavailable',
  );
  assert.deepEqual(codexAccountState({ account: { type: 'apiKey' } }), {
    login: 'authenticated',
    mode: 'api',
    identityQuality: 'unavailable',
  });
  assert.equal(claudeAccountState({ loggedIn: true, authMethod: 'api_key' }).mode, 'api');
  assert.equal(
    cursorAccountState({
      isAuthenticated: true,
      userInfo: { userId: Number.MAX_SAFE_INTEGER + 1, email: 'bad\nlabel' },
    }).identityQuality,
    'unavailable',
  );
  assert.equal(
    codexAccountState({ account: { type: 'chatgpt', email: null } }).identityQuality,
    'unavailable',
  );
  assert.equal(
    grokAccountState({ _meta: { auth_mode: 'Oidc', team_id: 'org-only' } }).identityQuality,
    'unavailable',
  );
});

const fixture = `#!/usr/bin/env node
const fs=require('node:fs');
const mode=process.env.PROBE_MODE;
const record=value=>fs.appendFileSync('calls.jsonl',JSON.stringify(value)+'\\n');
record({argv:process.argv.slice(2),profile:process.env.CURSOR_CONFIG_DIR??process.env.CLAUDE_CONFIG_DIR,claudeContext:process.env.CLAUDECODE??null});
if(process.argv.includes('--version')){if(mode==='bad-version'){process.stderr.write(process.env.PROBE_SECRET);process.exit(2)}console.log('probe-fixture 1.0');process.exit(0)}
if(process.argv.includes('status')){
 if(mode==='malformed'){process.stdout.write('not-json '+process.env.PROBE_SECRET);process.stderr.write(process.env.PROBE_SECRET);process.exit(1)}
 if(mode==='failure'){process.stdout.write(JSON.stringify({loggedIn:true,isAuthenticated:true}));process.stderr.write(process.env.PROBE_SECRET);process.exit(2)}
 console.log(JSON.stringify(mode==='signed-out'?{loggedIn:false,isAuthenticated:false,token:process.env.PROBE_SECRET}:{loggedIn:true,isAuthenticated:true,authMethod:'claude.ai',email:process.env.CLAUDE_CONFIG_DIR+'@example.test',userInfo:{userId:process.env.PROBE_SUBJECT,teamId:3},token:process.env.PROBE_SECRET}));process.exit(mode==='signed-out'?1:0)
}
const acp=process.argv.includes('stdio');
const send=m=>process.stdout.write(JSON.stringify({...acp?{jsonrpc:'2.0'}:{},...m})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);record({method:m.method,params:m.params});
 if(m.method==='initialize')return send({id:m.id,result:acp?{protocolVersion:1,authMethods:[{id:mode==='no-cached'?'grok.com':'cached_token'}]}:{}});
 if(m.method==='initialized')return;
 if(m.method==='account/read')return send({id:m.id,result:{account:{type:'chatgpt',email:'account@example.test',refreshToken:process.env.PROBE_SECRET},requiresOpenaiAuth:true}});
 if(m.method==='authenticate'){
  if(mode==='auth-failure')return send({id:m.id,error:{code:-32000,message:process.env.PROBE_SECRET}});
  return send({id:m.id,result:{_meta:{auth_mode:'Oidc',email:'grok@example.test',team_id:'team',access_token:process.env.PROBE_SECRET}}})
 }
 send({id:m.id,error:{code:-32601,message:'Unexpected method'}})
});`;
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'native-account-proof-'));
  const executable = join(cwd, 'runner');
  writeFileSync(executable, fixture);
  chmodSync(executable, 0o700);
  return {
    cwd,
    executable,
    env: { ...process.env, PROBE_SECRET: secret },
    close: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

test('native command probes distinguish install/version/status failure without exposing output', async () => {
  const f = setup();
  try {
    const missing = await observeCursorAccount({ ...f, executable: join(f.cwd, 'missing') });
    assert.equal(missing.installed, false);
    assert.equal(missing.reason, 'not-installed');
    const version = await observeClaudeAccount({
      ...f,
      env: { ...f.env, PROBE_MODE: 'bad-version' },
    });
    assert.equal(version.installed, true);
    assert.equal(version.reason, 'version-unavailable');
    const invalid = await observeClaudeAccount({
      ...f,
      env: { ...f.env, PROBE_MODE: 'malformed' },
    });
    assert.equal(invalid.login, 'unavailable');
    assert.equal(invalid.reason, 'malformed-status');
    const failure = await observeCursorAccount({ ...f, env: { ...f.env, PROBE_MODE: 'failure' } });
    assert.equal(failure.login, 'unavailable');
    const signedOut = await observeClaudeAccount({
      ...f,
      env: { ...f.env, PROBE_MODE: 'signed-out' },
    });
    assert.equal(signedOut.login, 'signed-out');
    assert.equal(signedOut.installed, true);
    assert.ok(!JSON.stringify([missing, version, invalid, failure, signedOut]).includes(secret));
  } finally {
    f.close();
  }
});

test('two explicit profile environments remain separate under one OS user', async () => {
  const f = setup();
  try {
    const a = await observeCursorAccount({
      ...f,
      env: {
        ...f.env,
        CURSOR_CONFIG_DIR: 'profile-a',
        PROBE_SUBJECT: 'user-a',
        CLAUDECODE: 'parent-context',
      },
    });
    const b = await observeCursorAccount({
      ...f,
      env: { ...f.env, CURSOR_CONFIG_DIR: 'profile-b', PROBE_SUBJECT: 'user-b' },
    });
    assert.equal(a.identity?.subjectId, 'user-a');
    assert.equal(b.identity?.subjectId, 'user-b');
    const calls = readFileSync(join(f.cwd, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      calls.filter((c) => c.argv?.includes('status')).map((c) => c.profile),
      ['profile-a', 'profile-b'],
    );
    assert.ok(calls.every((c) => c.claudeContext === null));
  } finally {
    f.close();
  }
});

test('Codex and Grok probes authenticate/read only, never create sessions or prompts', async () => {
  const f = setup();
  try {
    const codex = await observeCodexAccount(f);
    assert.equal(codex.login, 'authenticated');
    assert.equal(codex.identityQuality, 'display-only');
    const grok = await observeGrokAccount(f);
    assert.equal(grok.login, 'authenticated');
    assert.equal(grok.identityQuality, 'display-only');
    const calls = readFileSync(join(f.cwd, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      calls.filter((c) => c.method).map((c) => c.method),
      ['initialize', 'initialized', 'account/read', 'initialize', 'authenticate'],
    );
    assert.deepEqual(calls.find((c) => c.method === 'account/read').params, {
      refreshToken: false,
    });
    assert.deepEqual(calls.find((c) => c.method === 'authenticate').params, {
      methodId: 'cached_token',
      _meta: { headless: true },
    });
    assert.ok(calls.find((c) => c.argv?.includes('stdio')).argv.includes('--no-leader'));
    assert.ok(!JSON.stringify([codex, grok]).includes(secret));
  } finally {
    f.close();
  }
});

test('Grok absent cached auth and rejected auth remain unavailable without an API fallback', async () => {
  const f = setup();
  try {
    const missing = await observeGrokAccount({ ...f, env: { ...f.env, PROBE_MODE: 'no-cached' } });
    assert.equal(missing.login, 'unavailable');
    assert.equal(missing.reason, 'native-auth-unavailable');
    const failed = await observeGrokAccount({
      ...f,
      env: { ...f.env, PROBE_MODE: 'auth-failure' },
    });
    assert.equal(failed.login, 'unavailable');
    assert.ok(!JSON.stringify(failed).includes(secret));
    const calls = readFileSync(join(f.cwd, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(calls.filter((c) => c.method === 'authenticate').length, 1);
    assert.ok(
      !calls.some((c) => c.params?.methodId === 'grok.com' || c.params?.methodId === 'xai.api_key'),
    );
  } finally {
    f.close();
  }
});

test('unconfirmed protocol cleanup overrides successful identity and hides the native cleanup error', async () => {
  const f = setup();
  try {
    const result = await observeNativeAccount('grok', 'grok', f, async () =>
      accountProtocolProbe(
        {
          close: async () => {
            throw new Error(secret);
          },
        },
        async () => ({
          login: 'authenticated',
          mode: 'subscription',
          identity: { email: 'private@example.test' },
          identityQuality: 'display-only',
        }),
        () => false,
      ),
    );
    assert.equal(result.installed, true);
    assert.equal(result.login, 'unavailable');
    assert.equal(result.reason, 'cleanup-unconfirmed');
    assert.equal(result.identity, undefined);
    assert.ok(!JSON.stringify(result).includes(secret));
  } finally {
    f.close();
  }
});
