// Setup-time storage for owned proof simulators. Stop the app before writing.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function gatewayProfileValues(profile, seenVersion) {
  return {
    '@farmslot:gatewayProfiles': JSON.stringify([profile]),
    '@farmslot:activeGatewayProfileId': profile.id,
    '@farmslot:gatewayUrl': profile.url,
    ...(seenVersion ? { '@farmslot:whats-new-seen-version': seenVersion } : {}),
  };
}

export function seedIOSGatewayProfile({ simulator, bundleId, profile, seenVersion }) {
  const terminated = spawnSync('xcrun', ['simctl', 'terminate', simulator, bundleId], {
    encoding: 'utf8',
  });
  // simctl reports "found nothing to terminate" when the app is not running, which is the goal.
  if (terminated.status !== 0 && !/found nothing to terminate/i.test(terminated.stderr)) {
    throw new Error(`simctl terminate failed: ${terminated.stderr.trim()}`);
  }
  const data = execFileSync('xcrun', ['simctl', 'get_app_container', simulator, bundleId, 'data'], {
    encoding: 'utf8',
  }).trim();
  const storage = path.join(
    data,
    'Library/Application Support',
    bundleId,
    'RCTAsyncLocalStorage_V1',
  );
  const manifestPath = path.join(storage, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : {};
  const values = gatewayProfileValues(profile, seenVersion);
  for (const [key, value] of Object.entries(values)) {
    // A value an earlier run stored out of line would shadow nothing once the
    // manifest holds it inline, but it would be left behind; remove it.
    fs.rmSync(path.join(storage, createHash('md5').update(key).digest('hex')), { force: true });
    manifest[key] = value;
  }
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}

/** Setup-time fixture storage for the selected owned Android emulator. */
export function seedAndroidGatewayProfile({ serial, bundleId, profile, seenVersion }) {
  if (!serial?.startsWith('emulator-'))
    throw new Error('Proof profile seeding requires an owned emulator');
  const adb = (...args) =>
    execFileSync('adb', ['-s', serial, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  adb('shell', 'am', 'force-stop', bundleId);
  adb('shell', 'run-as', bundleId, 'mkdir', '-p', 'databases');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-profile-'));
  const database = path.join(scratch, 'RKStorage');
  try {
    const exists = spawnSync('adb', [
      '-s',
      serial,
      'shell',
      'run-as',
      bundleId,
      'test',
      '-f',
      'databases/RKStorage',
    ]);
    if (exists.status === 0)
      fs.writeFileSync(database, adb('exec-out', 'run-as', bundleId, 'cat', 'databases/RKStorage'));
    execFileSync('python3', [
      '-c',
      `import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.execute('CREATE TABLE IF NOT EXISTS catalystLocalStorage (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
for key,value in json.loads(sys.argv[2]).items(): db.execute('INSERT OR REPLACE INTO catalystLocalStorage (key,value) VALUES (?,?)',(key,value))
db.commit(); db.close()`,
      database,
      JSON.stringify(gatewayProfileValues(profile, seenVersion)),
    ]);
    fs.chmodSync(database, 0o600);
    adb(
      'shell',
      'run-as',
      bundleId,
      'rm',
      '-f',
      'databases/RKStorage-wal',
      'databases/RKStorage-shm',
      'databases/RKStorage-journal',
    );
    execFileSync(
      'adb',
      // shell -T waits for dd to finish before the next operation reads the database.
      ['-s', serial, 'shell', '-T', 'run-as', bundleId, 'dd', 'of=databases/RKStorage', 'bs=65536'],
      { input: fs.readFileSync(database), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    adb('shell', 'run-as', bundleId, 'chmod', '600', 'databases/RKStorage');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
