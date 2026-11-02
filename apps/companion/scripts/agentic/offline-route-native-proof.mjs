import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const phase = process.argv[2];
assert(['warm', 'cold'].includes(phase));
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const serial = process.env.ADB_SERIAL;
assert(serial && serial === process.env.FARMSLOT_PROOF_PHYSICAL_SERIAL);
const output = process.env.FARMSLOT_OFFLINE_ROUTE_OUT;
assert(output && path.isAbsolute(output));
const subjects = JSON.parse(await fs.readFile(process.env.FARMSLOT_OFFLINE_ROUTE_SUBJECTS, 'utf8'));
const cases = JSON.parse(
  await fs.readFile(
    new URL('../../../command-center/scripts/agentic/offline-route-cases.json', import.meta.url),
    'utf8',
  ),
);
const bundle = 'net.siteed.farmslot.development';
const adb = (...args) =>
  execute('adb', ['-s', serial, ...args], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
const shellArgument = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const decode = (value) =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
const results = [];
await fs.mkdir(output, { recursive: true });
try {
  for (const entry of cases.companion) {
    if (
      ['layout', 'connection', 'development', 'stream'].includes(entry.kind) ||
      entry.href.includes('terminal')
    ) {
      results.push({
        ...entry,
        result: 'NAMED EXCEPTION',
        proofReason: entry.href.includes('terminal')
          ? 'Live terminal opening can resize its pane; requires an owned sandbox rather than the read-only farm.'
          : entry.reason,
      });
      continue;
    }
    try {
      const missing = [...entry.href.matchAll(/\{([^}]+)\}/g)]
        .map((match) => match[1])
        .filter((key) => !subjects[key]);
      assert.equal(missing.length, 0, `No live subject for ${missing.join(', ')}`);
      const href = entry.href.replace(/\{([^}]+)\}/g, (_match, key) =>
        encodeURIComponent(subjects[key]),
      );
      if (phase === 'cold') await adb('shell', 'am', 'force-stop', bundle);
      await adb(
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        shellArgument(`farmslot-development://${href}`),
        bundle,
      );
      const deadline = Date.now() + 20_000;
      let xml;
      let texts;
      do {
        await adb('shell', 'uiautomator', 'dump', '/sdcard/cx-offline-route.xml');
        xml = (await adb('shell', 'cat', '/sdcard/cx-offline-route.xml')).stdout;
        texts = [...xml.matchAll(/\btext="([^"]*)"/g)]
          .map((match) => decode(match[1]))
          .filter(Boolean);
        if (texts.length > 3 && !texts.some((text) => /^Loading(?:\s|…|\.)/.test(text))) break;
        assert(Date.now() < deadline, `Native screen never settled: ${texts.join(' | ')}`);
      } while (Date.now() < deadline);
      const stem = `${String(results.length).padStart(2, '0')}-${entry.file.replaceAll(/[^a-zA-Z0-9.-]/g, '_')}`;
      await fs.writeFile(path.join(output, `${stem}.xml`), xml);
      const focus = (await adb('shell', 'dumpsys', 'window')).stdout.match(
        /mCurrentFocus=.*$/m,
      )?.[0];
      assert(focus?.includes(bundle), `Wrong foreground app: ${focus}`);
      const screenshot = await execute('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
        encoding: 'buffer',
        maxBuffer: 8 * 1024 * 1024,
      });
      await fs.writeFile(path.join(output, `${stem}.png`), screenshot.stdout);
      const body = texts.join(' | ');
      assert(
        !/Unmatched Route|Something went wrong|Render Error|Unable to resolve module/i.test(body),
        body,
      );
      if (entry.kind === 'cached')
        assert(
          !/Connect to (?:the )?gateway to|This .* has not been (?:cached|stored)|Nothing stored yet/i.test(
            body,
          ),
          body,
        );
      results.push({ ...entry, href, texts, focus, screenshot: `${stem}.png`, result: 'RENDERED' });
    } catch (error) {
      results.push({ ...entry, result: 'FAIL', message: String(error.message).slice(0, 1500) });
    }
  }
  assert.deepEqual(
    results.filter((entry) => entry.result === 'FAIL').map(({ file }) => file),
    [],
    'Each native route must render its saved body',
  );
  console.log(JSON.stringify({ phase, result: 'PASS', routes: results.length }));
} finally {
  await fs.writeFile(
    path.join(output, 'route-results.json'),
    JSON.stringify(
      {
        phase,
        results,
        limits:
          'Native accessibility rendering smoke. Cold phase restarts the DEV app for every route; the owned proxy must be offline. Saved-row and command-authority assertions are covered separately by cache/controller tests.',
      },
      null,
      2,
    ),
  );
}
