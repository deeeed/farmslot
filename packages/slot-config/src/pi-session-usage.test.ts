import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runSessionUsage } from './session-usage.js';

const fixture = fileURLToPath(new URL('../test/fixtures/pi-session.jsonl', import.meta.url));

test('Pi total extraction uses recorded tokens and cost from real assistant JSONL', async () => {
  const output = await runSessionUsage({
    repo: '',
    slotId: 'pi-test',
    action: 'total',
    forcedPath: fixture,
    forcedRunner: 'pi',
  });
  assert.match(output, /turns=3\n/);
  assert.match(output, /input_tokens=8\n/);
  assert.match(output, /output_tokens=742\n/);
  assert.match(output, /cache_creation=38822\n/);
  assert.match(output, /cache_read=58613\n/);
  assert.match(output, /total_tokens=98185\n/);
  assert.match(output, /cost_usd=0\.2324/);
});

test('Pi never estimates a missing native cost or reports absent usage as zero', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const records = (await readFile(fixture, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  delete records[2].message.usage.cost;
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const output = await runSessionUsage({
    repo: '',
    slotId: 'pi-test',
    action: 'total',
    forcedPath: file,
    forcedRunner: 'pi',
  });
  assert.doesNotMatch(output, /cost_usd=/);
  await writeFile(file, JSON.stringify(records[0]) + '\n');
  await assert.rejects(
    runSessionUsage({
      repo: '',
      slotId: 'pi-test',
      action: 'total',
      forcedPath: file,
      forcedRunner: 'pi',
    }),
    /no assistant usage/,
  );
});
