import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('../..', import.meta.url));
const rootManifest = JSON.parse(fs.readFileSync(path.join(appDir, '../../package.json'), 'utf8'));
const appManifest = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-sherpa-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    'SKIP_SHERPA_DOWNLOAD',
    'SITEED_SHERPA_ONNX_ALLOW_MISSING_PREBUILTS',
    'YARN_ENABLE_SCRIPTS',
    'NODE_OPTIONS',
  ])
    delete env[key];
  return { ...env, ...extra };
}

for (const location of ['root', 'companion']) {
  test(`${location} install succeeds with the Sherpa download host unreachable and no escape flags`, async (t) => {
    const root = scratch(t);
    const server = net.createServer();
    t.after(() => {
      if (server.listening) server.close();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    const dependency = path.join(root, 'package');
    fs.mkdirSync(dependency);
    fs.writeFileSync(
      path.join(dependency, 'package.json'),
      JSON.stringify({
        name: '@siteed/sherpa-onnx.rn',
        version: '1.3.1',
        scripts: { postinstall: 'node install.cjs' },
      }),
    );
    fs.writeFileSync(
      path.join(dependency, 'install.cjs'),
      `require('node:fs').writeFileSync(process.env.SHERPA_ATTEMPT_FILE,'attempted'); require('node:http').get(process.env.SHERPA_ASSET_URL).on('error',error=>{console.error(error.code);process.exitCode=1;});\n`,
    );
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'apps/companion'), { recursive: true });
    const packed = spawnSync(
      'tar',
      ['-czf', path.join(workspace, 'sherpa.tgz'), '-C', root, 'package'],
      { encoding: 'utf8' },
    );
    assert.equal(packed.status, 0, packed.stderr);
    fs.writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({
        name: 'install-fixture',
        private: true,
        packageManager: 'yarn@4.5.3',
        workspaces: ['apps/*'],
        dependenciesMeta: rootManifest.dependenciesMeta,
      }),
    );
    fs.writeFileSync(
      path.join(workspace, 'apps/companion/package.json'),
      JSON.stringify({
        name: 'companion-fixture',
        private: true,
        scripts: appManifest.scripts,
        dependencies: { '@siteed/sherpa-onnx.rn': 'file:../../sherpa.tgz' },
      }),
    );
    fs.writeFileSync(
      path.join(workspace, '.yarnrc.yml'),
      'nodeLinker: node-modules\nenableGlobalCache: false\nenableNetwork: false\n',
    );
    const attempted = path.join(root, 'attempted');
    const result = spawnSync('yarn', ['install'], {
      cwd: location === 'root' ? workspace : path.join(workspace, 'apps/companion'),
      encoding: 'utf8',
      timeout: 4500,
      env: cleanEnv({
        CI: '1',
        YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
        YARN_ENABLE_SCRIPTS: 'true',
        SHERPA_ATTEMPT_FILE: attempted,
        SHERPA_ASSET_URL: `http://127.0.0.1:${port}/prebuilts.zip`,
      }),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      fs.existsSync(path.join(workspace, 'node_modules/@siteed/sherpa-onnx.rn/package.json')),
      true,
      'Sherpa remains installed',
    );
    assert.equal(fs.existsSync(attempted), false, 'Yarn never invokes its downloader');
  });
}

function nativeFixture(t) {
  const root = scratch(t);
  for (const directory of [
    'scripts/agentic',
    'scripts/doctor',
    'bin',
    'node_modules/@siteed/sherpa-onnx.rn',
    'ios/Fixture.xcworkspace',
    'ios/Pods',
  ])
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  const helper = path.join(appDir, 'scripts/install-sherpa-prebuilts.mjs');
  if (fs.existsSync(helper))
    fs.copyFileSync(helper, path.join(root, 'scripts/install-sherpa-prebuilts.mjs'));
  for (const file of ['run-ios.sh', 'run-android.sh'])
    fs.copyFileSync(
      path.join(appDir, 'scripts/agentic', file),
      path.join(root, 'scripts/agentic', file),
    );
  const dependency = path.join(root, 'node_modules/@siteed/sherpa-onnx.rn');
  fs.writeFileSync(
    path.join(dependency, 'package.json'),
    JSON.stringify({ name: '@siteed/sherpa-onnx.rn', version: '1.3.1' }),
  );
  fs.writeFileSync(
    path.join(dependency, 'install.js'),
    `const fs=require('node:fs'); if(process.env.SHERPA_NATIVE_FAIL==='1')process.exit(7); if(process.env.SKIP_SHERPA_DOWNLOAD==='1'||process.env.SITEED_SHERPA_ONNX_ALLOW_MISSING_PREBUILTS==='1'||process.env.CI!=='1')throw new Error('Native installation must fetch and fail strictly'); fs.writeFileSync(process.env.SHERPA_NATIVE_READY,'native-prebuilts');\n`,
  );
  fs.writeFileSync(
    path.join(root, 'scripts/agentic/agentic.conf'),
    'APP_VARIANT=development\nSITEED_BUNDLE_BASE=net.siteed.fixture\nSITEED_SCHEME_BASE=fixture\nBUNDLE_ID=net.siteed.fixture.development\nSCHEME=fixture-development\nMETRO_PORT=41234\nGATEWAY_PORT=41235\nCOMPANION_GATEWAY_URL=ws://localhost:41235\nCOMPANION_PACKAGER_HOSTNAME=localhost\nMETRO_CONNECTION=lan\n',
  );
  fs.writeFileSync(
    path.join(root, 'scripts/agentic/slot-context.sh'),
    'companion_apply_farmslot_slot_context() { :; }\n',
  );
  fs.writeFileSync(
    path.join(root, 'scripts/agentic/network.sh'),
    'companion_configure_network_env() { :; }\n',
  );
  fs.writeFileSync(path.join(root, 'scripts/doctor/ios-build.sh'), '#!/bin/bash\nexit 0\n');
  fs.writeFileSync(path.join(root, 'scripts/agentic/prepare-dev-client.mjs'), '');
  const nativeStarted =
    '[[ -f "$SHERPA_NATIVE_READY" ]] || { echo "native prebuilts missing" >&2; exit 42; }; printf started > "$SHERPA_NATIVE_STARTED"';
  const executable = (name, source) =>
    fs.writeFileSync(path.join(root, 'bin', name), `#!/bin/bash\n${source}\n`, { mode: 0o755 });
  executable('expo', nativeStarted);
  executable('xcodebuild', nativeStarted);
  executable('curl', 'exit 0');
  executable('adb', 'printf "List of devices attached\\n"');
  executable(
    'xcrun',
    `if [[ "$*" == *list* ]]; then printf '%s\\n' '{"devices":{"runtime":[{"name":"fixture","udid":"fixture"}]}}'; fi`,
  );
  executable(
    'yarn',
    `if [[ "$*" == *config* ]]; then printf '%s\\n' '{"android":{"package":"net.siteed.fixture.development"}}'; else ${nativeStarted}; fi`,
  );
  const ready = path.join(root, 'ready'),
    started = path.join(root, 'started');
  const env = {
    ...process.env,
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
    SHERPA_NATIVE_READY: ready,
    SHERPA_NATIVE_STARTED: started,
    SKIP_SHERPA_DOWNLOAD: '1',
    SITEED_SHERPA_ONNX_ALLOW_MISSING_PREBUILTS: '1',
    DEVICE_MODE: 'simulator',
    IOS_SIMULATOR: 'fixture',
    FARMSLOT_SLOT_ID: '',
  };
  return { root, ready, started, env };
}

for (const command of ['prebuild', 'eas-build-post-install']) {
  test(`${command} fetches native prebuilts explicitly after workspace installation`, (t) => {
    const f = nativeFixture(t);
    assert.equal(typeof appManifest.scripts[command], 'string', `native hook ${command} exists`);
    const result = spawnSync('bash', ['-c', appManifest.scripts[command]], {
      cwd: f.root,
      env: f.env,
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(f.ready, 'utf8'), 'native-prebuilts');
    if (command === 'prebuild') assert.equal(fs.existsSync(f.started), true);
  });
}

test('native prebuild stops before Expo when the explicit dependency fetch fails', (t) => {
  const f = nativeFixture(t);
  const result = spawnSync('bash', ['-c', appManifest.scripts.prebuild], {
    cwd: f.root,
    env: { ...f.env, SHERPA_NATIVE_FAIL: '1' },
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.equal(fs.existsSync(f.started), false);
});

for (const platform of ['ios', 'android']) {
  test(`local ${platform} build fetches prebuilts even with an existing native project`, (t) => {
    const f = nativeFixture(t);
    if (platform === 'android') {
      fs.mkdirSync(path.join(f.root, 'android/app'), { recursive: true });
      fs.writeFileSync(
        path.join(f.root, 'android/app/build.gradle'),
        `applicationId 'net.siteed.fixture.development'\n`,
      );
    }
    const script = path.join(f.root, 'scripts/agentic', `run-${platform}.sh`);
    const args =
      platform === 'ios'
        ? [script]
        : ['-c', 'source "$1"; select_android_device() { printf fixture; }; main', '_', script];
    const result = spawnSync('bash', args, {
      cwd: f.root,
      env: f.env,
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(f.ready), true);
    assert.equal(fs.existsSync(f.started), true);
  });
}
