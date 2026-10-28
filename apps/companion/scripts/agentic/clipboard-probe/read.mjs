import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const probePackage = 'net.siteed.farmslot.viewlinkprobe.development';
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

/** The helper receives only a nonce. It measures the actual OS clipboard in a focused activity. */
export async function readForegroundClipboard({
  adb,
  serial,
  receiptPath,
  artifactDir,
  execute = execFileSync,
  wait = delay,
}) {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const apk = await readFile(receipt.apk);
  assert.equal(createHash('sha256').update(apk).digest('hex'), receipt.apkSha256);
  const requestId = randomUUID();
  const beforePid = execute(
    adb,
    ['-s', serial, 'shell', 'pidof', '-s', 'net.siteed.farmslot.development'],
    { encoding: 'utf8', timeout: 5000 },
  ).trim();
  const command = [
    'am',
    'start',
    '-W',
    '-n',
    probePackage + '/.ClipboardProbeActivity',
    '--es',
    'requestId',
    requestId,
  ]
    .map(quote)
    .join(' ');
  execute(adb, ['-s', serial, 'shell', command], {
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let raw;
  const deadline = Date.now() + 3000;
  while (!raw) {
    try {
      raw = execute(
        adb,
        [
          '-s',
          serial,
          'exec-out',
          'run-as',
          probePackage,
          'cat',
          'files/clipboard-' + requestId + '.json',
        ],
        { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      // Android exec-out can report a missing file on stdout with exit code zero.
      // Only the exact current nonce file's absence is a readiness condition.
      if (
        raw.toString().trim() ===
        `cat: files/clipboard-${requestId}.json: No such file or directory`
      ) {
        if (Date.now() >= deadline)
          throw new Error('The focused clipboard probe did not publish its nonce receipt');
        raw = undefined;
        await wait(100);
      }
    } catch (error) {
      if (!String(error.stderr).includes('No such file') || Date.now() >= deadline) throw error;
      await wait(100); // The focused activity publishes its observation asynchronously.
    }
  }
  const measured = JSON.parse(raw);
  assert.equal(measured.requestId, requestId);
  assert.equal(measured.status, 'read');
  assert.equal(measured.itemCount, 1);
  assert.equal(typeof measured.text, 'string');
  const afterPid = execute(
    adb,
    ['-s', serial, 'shell', 'pidof', '-s', 'net.siteed.farmslot.development'],
    { encoding: 'utf8', timeout: 5000 },
  ).trim();
  assert(
    beforePid && afterPid === beforePid,
    'Foreground clipboard observation must not restart Companion',
  );
  await writeFile(
    path.join(artifactDir, 'clipboard-probe-' + requestId + '.json'),
    JSON.stringify(
      { ...measured, probeApkSha256: receipt.apkSha256, companionPid: Number(afterPid) },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return { action: 'read', text: measured.text, reader: 'android-foreground-clipboard-probe' };
}
