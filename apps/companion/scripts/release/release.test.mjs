import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const realApp = path.resolve(scripts, '../..');
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'companion-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'apps/companion');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  cpSync(scripts, path.join(app, 'scripts/release'), { recursive: true });
  cpSync(path.join(realApp, 'eas.json'), path.join(app, 'eas.json'));
  const log = path.join(root, 'calls.jsonl');
  const store = path.join(root, 'store.json');
  const release = (code) => ({ status: 'completed', versionCodes: [String(code)] });
  writeFileSync(
    store,
    JSON.stringify({
      internal: { releases: [release(14)] },
      alpha: { releases: [release(14)] },
      edits: {},
      sequence: 0,
    }),
  );
  const key = path.join(root, 'fixture-account.json');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(
    key,
    JSON.stringify({
      client_email: 'fixture@example.invalid',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
    { mode: 0o600 },
  );
  const network = path.join(root, 'store-stub.mjs');
  writeFileSync(
    network,
    `import fs from 'node:fs';
globalThis.fetch=async(url,options)=>{
 if(url.includes('oauth2'))return new Response(JSON.stringify({access_token:'fixture-token'}));
 const suffix=new URL(url).pathname.split('/edits')[1];
 fs.appendFileSync(process.env.RELEASE_TEST_LOG,JSON.stringify({method:options.method,suffix})+'\\n');
 const s=JSON.parse(fs.readFileSync(process.env.RELEASE_TEST_STORE));let body={};
 if(options.method==='POST'&&suffix===''){const id=String(++s.sequence);s.edits[id]={internal:s.internal,alpha:s.alpha};body={id};}
 else if(suffix.endsWith(':commit')){const id=suffix.slice(1,-7);s.internal=s.edits[id].internal;s.alpha=s.edits[id].alpha;delete s.edits[id];}
 else {const [,id,,track]=suffix.split('/');if(options.method==='DELETE')delete s.edits[id];else if(options.method==='GET')body=s.edits[id][track];else {if(track!=='alpha')throw Error('unexpected track');s.edits[id][track]=JSON.parse(options.body);}}
 fs.writeFileSync(process.env.RELEASE_TEST_STORE,JSON.stringify(s));return new Response(JSON.stringify(body));
};\n`,
  );
  writeFileSync(
    path.join(bin, 'yarn'),
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TEST_LOG,JSON.stringify({args})+'\\n');
const yarnArgs=args.slice(0,args.findIndex(arg=>arg.startsWith('eas-cli@')));
if(args[0]==='dlx'&&!yarnArgs.includes('-q')&&!yarnArgs.includes('--quiet'))console.log('➤ YN0000: · Yarn 4.5.3 install report');
if(args.includes('build')||args.includes('build:list'))console.log(JSON.stringify([{id:'returned-build-id',status:'FINISHED',platform:'ANDROID',buildProfile:'production',distribution:'STORE',appBuildVersion:'15'}]));
if(args.includes('submit')){if(process.env.RELEASE_TEST_SUBMIT_FAIL)process.exit(9);const s=JSON.parse(fs.readFileSync(process.env.RELEASE_TEST_STORE));s.internal={releases:[{status:'completed',versionCodes:['15']}]};fs.writeFileSync(process.env.RELEASE_TEST_STORE,JSON.stringify(s));}
`,
    { mode: 0o755 },
  );
  const run = (args = [], extra = {}) => {
    const env = {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      NODE_OPTIONS: '--import ' + network,
      FARMSLOT_PLAY_SERVICE_ACCOUNT_KEY: key,
      RELEASE_TEST_LOG: log,
      RELEASE_TEST_STORE: store,
      ...extra,
    };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync('/bin/bash', [path.join(app, 'scripts/release/release.sh'), ...args], {
      env,
      encoding: 'utf8',
      timeout: 4000,
    });
  };
  return {
    root,
    run,
    calls: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    store: () => JSON.parse(readFileSync(store, 'utf8')),
  };
}

test('default dry run shows production Android and both test tracks without calling tools', (t) => {
  const f = fixture(t);
  const result = f.run(['--message', 'test']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Variant: production/);
  assert.match(result.stdout, /Platform: android/);
  assert.match(result.stdout, /build --platform android --profile production --non-interactive/);
  assert.match(result.stdout, /submit --platform android --profile production --id/);
  assert.match(result.stdout, /promote/);
  assert.doesNotMatch(result.stdout, /--platform ios/);
  assert.equal(f.store().sequence, 0);
});

test('real script with stubbed EAS and Play uploads once, promotes the returned version and verifies both tracks', (t) => {
  const f = fixture(t);
  const result = f.run(['--execute', '--message', 'test']);
  assert.equal(result.status, 0, result.stderr);
  const commands = f
    .calls()
    .filter((entry) => entry.args)
    .map((entry) => entry.args);
  assert.equal(commands.filter((args) => args.includes('submit')).length, 1);
  const submit = commands.find((args) => args.includes('submit'));
  assert.ok(submit.includes('returned-build-id'));
  assert.ok(!submit.includes('--latest'));
  assert.ok(commands.find((args) => args.includes('build')).includes('--non-interactive'));
  const update = commands.find((args) => args.includes('update'));
  assert.equal(update[update.indexOf('--platform') + 1], 'android');
  for (const track of ['internal', 'alpha'])
    assert.deepEqual(f.store()[track].releases[0].versionCodes, ['15']);
  assert.match(result.stdout, /"internal":\[15\],"alpha":\[15\]/);
  assert.ok(!f.calls().some((entry) => /production|bundles|apks/.test(entry.suffix || '')));
});

test('submission failure stops before alpha promotion', (t) => {
  const f = fixture(t);
  const result = f.run(['--execute', '--skip-update'], { RELEASE_TEST_SUBMIT_FAIL: '1' });
  assert.equal(result.status, 9, result.stderr);
  assert.ok(!f.calls().some((entry) => entry.method === 'PUT'));
});

test('skip-build captures clean EAS list JSON and promotes its returned build', (t) => {
  const f = fixture(t);
  const result = f.run(['--execute', '--skip-build', '--skip-update']);
  assert.equal(result.status, 0, result.stderr);
  const commands = f
    .calls()
    .filter((entry) => entry.args)
    .map((entry) => entry.args);
  assert.ok(commands.some((args) => args.includes('build:list')));
  assert.ok(!commands.some((args) => args.includes('build')));
  assert.equal(commands.filter((args) => args.includes('submit')).length, 1);
  assert.ok(commands.find((args) => args.includes('submit')).includes('returned-build-id'));
  for (const track of ['internal', 'alpha'])
    assert.deepEqual(f.store()[track].releases[0].versionCodes, ['15']);
});

test('iOS requires the explicit platform and does not call Play', (t) => {
  const f = fixture(t);
  const result = f.run(['--platform', 'ios', '--message', 'test']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /build --platform ios/);
  assert.doesNotMatch(result.stdout, /play-tracks|submit|--platform android/);
  assert.notEqual(f.run(['--platform', 'all']).status, 0);
});
