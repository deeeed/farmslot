#!/usr/bin/env node
// Real browser bootstrap observations. This helper neither supplies credentials nor writes storage.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const mode = process.argv[2];
assert(['unauthenticated', 'missing-binding', 'wrong-binding'].includes(mode));
const pageId = Number(process.env.FARMSLOT_VIEW_SHARING_WEB_PAGE_ID);
const artifactDir = process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR;
const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
assert(Number.isInteger(pageId) && pageId > 0 && artifactDir && caseDir);
const fixture = JSON.parse(await readFile(path.join(caseDir, 'fixture.json'), 'utf8'));
assert.equal(fixture.sourceRoot, sourceRoot);
const call = (tool, args) => {
  const response = JSON.parse(
    execFileSync(
      'mcporter',
      ['call', 'agent-chrome.' + tool, '--args', JSON.stringify(args), '--output', 'json'],
      { cwd: sourceRoot, env: process.env, encoding: 'utf8', timeout: 20000 },
    ),
  );
  assert(!response.isError, 'The exact owned browser page refused the observation');
  return response;
};
const response = call('evaluate_script', {
  pageId,
  function: await readFile(
    path.join(sourceRoot, 'apps/command-center/scripts/probes/shared-view-startup.js'),
    'utf8',
  ),
  format: 'function',
});
const text = response.content
  .filter((item) => item.type === 'text')
  .map((item) => item.text)
  .join('\n');
const match = /```json\n([\s\S]*?)\n```/.exec(text);
assert(match, 'Expected an actual structured browser observation');
const observed = JSON.parse(match[1]);
const base = process.env.FARMSLOT_VIEW_SHARING_WEB_BASE;
assert.equal(
  observed.href,
  base +
    '#run/' +
    fixture.runs[0].id +
    '?panel=timeline' +
    (mode === 'unauthenticated' ? '' : '&sharedView=1'),
);
assert.equal(observed.mountedRun, false);
if (mode === 'unauthenticated') {
  assert(observed.text.includes('Gateway authentication required'));
  assert.equal(observed.passwordFields, 1);
} else {
  assert(observed.text.includes('the selected gateway does not match this deployment'));
  assert.equal(observed.mountedShell, false);
  assert(
    !observed.modules.some((name) => /\/src\/(?:start\.|gateway-client\.)/.test(name)),
    'Refused links must stop before gateway consumers are imported',
  );
}
const screenshot = call('take_screenshot', { pageId, fullPage: true });
const bitmap = screenshot.content.find((item) => item.type === 'image');
assert(
  bitmap?.mimeType === 'image/png' && bitmap.data,
  'Require the actual returned browser screenshot',
);
await writeFile(path.join(artifactDir, mode + '.png'), Buffer.from(bitmap.data, 'base64'), {
  flag: 'wx',
  mode: 0o600,
});

await writeFile(
  path.join(artifactDir, mode + '.json'),
  JSON.stringify({ pageId, mode, observed, sourceRoot }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.log(JSON.stringify({ status: 'PASS', mode, observedIdentity: observed.href }));
