import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ArtifactRef } from '@farmslot/protocol';

import {
  BASELINE_MARKER_DIR,
  isGatewayOwnedArtifactMirrorEntry,
  isGatewayOwnedArtifactPath,
} from '../core/artifact-copy-policy.js';
import { buildRunRecord } from '../runs/store.js';

import { isTicketMarkerCommit, markerBaselineVerifier } from './baseline-debug-marker.js';

const base = 'a'.repeat(40);
const marker = 'b'.repeat(40);
const ticket = 'MANUAL-000180';
const additions = `+  if (stateNode && !findMeasurableStateNode(target, false, tree)) {
+    DevLogger.log(
+      '[MANUAL-000180] BUG_MARKER: viewport query measured an ancestor surrogate',
+      JSON.stringify({ testId: options.testId }),
+    );
+  }`;
const patch = `diff --git a/app/source.ts b/app/source.ts
index 123abcd..456abcd 100644
--- a/app/source.ts
+++ b/app/source.ts
@@ -1,0 +2,6 @@
${additions}
`;
const output = `${marker}\0${base}\0debug(${ticket}): add reproduction marker\0\n${patch}`;

test('a marker-only commit admits the real guarded, multiline diagnostic shape', async () => {
  assert.equal(await isTicketMarkerCommit(output, base, marker, ticket), true);
});

test('a marker-only diagnostic admits interpolated measurements with the literal ticket prefix', async () => {
  const interpolated = output.replace(
    "'[MANUAL-000180] BUG_MARKER: viewport query measured an ancestor surrogate'",
    '`[MANUAL-000180] BUG_MARKER: measured ${rect.width}x${rect.height}`',
  );
  assert.equal(await isTicketMarkerCommit(interpolated, base, marker, ticket), true);
  assert.equal(
    await isTicketMarkerCommit(
      interpolated.replace('${rect.width}', '${rect.width = 1}'),
      base,
      marker,
      ticket,
    ),
    false,
  );
});

/** The Mobile checklist's own shape: the file has no logger yet, so the marker brings its import. */
const mobilePatch = `diff --git a/app/components/Perps/View.tsx b/app/components/Perps/View.tsx
index 123abcd..456abcd 100644
--- a/app/components/Perps/View.tsx
+++ b/app/components/Perps/View.tsx
@@ -3,0 +4 @@
+import Logger from '../../../../util/Logger';
@@ -41,0 +43 @@
+    Logger.log('[${ticket}] BUG_MARKER: bottom sheet mounted with no venue row');
`;
const mobileOutput = `${marker}\0${base}\0debug(${ticket}): add reproduction marker\0\n${mobilePatch}`;

test('a Mobile marker admits the logger import the template makes it add', async () => {
  // Every template-conformant marker was refused: the gate accepted only
  // DevLogger.log and refused the import a file without a logger must add, so
  // no Mobile, Extension or Terminal worker could ever produce one it liked.
  assert.equal(await isTicketMarkerCommit(mobileOutput, base, marker, ticket), true);
  assert.equal(
    await isTicketMarkerCommit(
      mobileOutput
        .replace('Logger.log', 'DevLogger.log')
        .replace('import Logger', 'import DevLogger'),
      base,
      marker,
      ticket,
    ),
    true,
  );
});

test('a Terminal marker admits the console.log form its template prescribes', async () => {
  const terminal = `${marker}\0${base}\0debug(${ticket}): add reproduction marker\0\n${`diff --git a/src/perps/order.ts b/src/perps/order.ts
index 123abcd..456abcd 100644
--- a/src/perps/order.ts
+++ b/src/perps/order.ts
@@ -12,0 +13 @@
+  console.log('[${ticket}] BUG_MARKER: size field cleared before submit');
`}`;
  assert.equal(await isTicketMarkerCommit(terminal, base, marker, ticket), true);
});

test('a marker admits console.error', async () => {
  const terminal = `${marker}\0${base}\0debug(${ticket}): add reproduction marker\0\n${`diff --git a/src/perps/order.ts b/src/perps/order.ts
index 123abcd..456abcd 100644
--- a/src/perps/order.ts
+++ b/src/perps/order.ts
@@ -12,0 +13 @@
+  console.error('[${ticket}] BUG_MARKER: size field cleared before submit');
`}`;
  assert.equal(await isTicketMarkerCommit(terminal, base, marker, ticket), true);
  // An added import bound as `console` shadows the global: its error() is that logger's.
  const shadowed = terminal.replace(
    '@@ -12,0 +13 @@',
    "@@ -1,0 +2 @@\n+import console from '../util/Logger';\n@@ -12,0 +13 @@",
  );
  assert.equal(await isTicketMarkerCommit(shadowed, base, marker, ticket), false);
  assert.equal(
    await isTicketMarkerCommit(
      shadowed.replace('console.error(', 'console.log('),
      base,
      marker,
      ticket,
    ),
    true,
    'the import is a logger and the marker logs through it',
  );
});

for (const [name, changed] of [
  [
    'an import of something the marker never logs through',
    mobileOutput.replace(
      "+import Logger from '../../../../util/Logger';",
      "+import { track } from '../../../../analytics';",
    ),
  ],
  [
    'a side-effect-only import',
    mobileOutput.replace(
      "+import Logger from '../../../../util/Logger';",
      "+import '../../../../util/polyfill';",
    ),
  ],
  ['a logger call that is not a log', mobileOutput.replace('Logger.log(', 'Logger.configure(')],
  [
    'a logger that is not one the templates prescribe',
    mobileOutput
      .replace('Logger.log', 'Telemetry.log')
      .replace('import Logger', 'import Telemetry'),
  ],
  [
    'an import that renames something else behind a logger name',
    mobileOutput.replace(
      "+import Logger from '../../../../util/Logger';",
      "+import { track as Logger } from '../../../../analytics';",
    ),
  ],
  [
    'a namespace import bound to a logger name',
    mobileOutput.replace(
      "+import Logger from '../../../../util/Logger';",
      "+import * as Logger from '../../../../util/Logger';",
    ),
  ],
  [
    'a named import of the logger under a different name',
    mobileOutput.replace(
      "+import Logger from '../../../../util/Logger';",
      "+import { DevLogger as Logger } from '../../../../util/Logger';",
    ),
  ],
  [
    'an import justified only by a marker in another file',
    `${marker}\0${base}\0debug(${ticket}): add reproduction marker\0\n${`diff --git a/app/a.tsx b/app/a.tsx
index 123abcd..456abcd 100644
--- a/app/a.tsx
+++ b/app/a.tsx
@@ -3,0 +4 @@
+import Logger from '../util/Logger';
diff --git a/app/b.tsx b/app/b.tsx
index 123abcd..456abcd 100644
--- a/app/b.tsx
+++ b/app/b.tsx
@@ -9,0 +10 @@
+    Logger.log('[${ticket}] BUG_MARKER: no venue row');
`}`,
  ],
] as const) {
  test(`a marker commit does not admit ${name}`, async () => {
    assert.equal(await isTicketMarkerCommit(changed, base, marker, ticket), false);
  });
}

for (const [name, changed] of [
  ['wrong parent', output.replace(`\0${base}\0`, `\0${'c'.repeat(40)}\0`)],
  ['merge commit', output.replace(`\0${base}\0`, `\0${base} ${'c'.repeat(40)}\0`)],
  ['wrong ticket subject', output.replace(`debug(${ticket})`, 'debug(OTHER-1)')],
  ['wrong marker ticket', output.replace(`[${ticket}]`, '[OTHER-1]')],
  ['product deletion', output + '-return fixed;\n'],
  ['additional product edit', output + '@@ -10,0 +17 @@\n+return fixed;\n'],
  ['assignment in guard', output.replace('stateNode &&', '(stateNode = target) &&')],
  ['assignment in log', output.replace('options.testId', 'options.testId = "changed"')],
  ['else behavior', output.replace('+  }', '+  } else { return fixed; }')],
  ['mode change', output + 'old mode 100644\nnew mode 100755\n'],
  ['new file', output.replace('index ', 'new file mode 100644\nindex ')],
  ['empty diagnostic block', output.replace(additions, '+  if (stateNode) {}')],
] as const) {
  test(`a debug subject does not admit ${name}`, async () => {
    assert.equal(await isTicketMarkerCommit(changed, base, marker, ticket), false);
  });
}

test('real Git output verifies the direct marker child and refuses the later fix', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'marker-git-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      { encoding: 'utf8' },
    ).trimEnd();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repo, 'source.ts'), 'export const value = true;\n');
  git('add', '.');
  git('commit', '-qm', 'test: seed base');
  const baseSha = git('rev-parse', 'HEAD');
  await writeFile(
    path.join(repo, 'source.ts'),
    `export const value = true;\nDevLogger.log('[${ticket}] BUG_MARKER: repro');\n`,
  );
  git('commit', '-qam', `debug(${ticket}): add reproduction marker`);
  const markerSha = git('rev-parse', 'HEAD');
  const show = () =>
    git(
      '--no-replace-objects',
      'show',
      '--format=%H%x00%P%x00%s%x00',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--unified=0',
      'HEAD',
      '--',
    );
  assert.equal(await isTicketMarkerCommit(show(), baseSha, markerSha, ticket), true);
  await writeFile(
    path.join(repo, 'source.ts'),
    `export const value = false;\nDevLogger.log('[${ticket}] BUG_MARKER: repro');\n`,
  );
  git('commit', '-qam', `debug(${ticket}): add reproduction marker`);
  assert.equal(
    await isTicketMarkerCommit(show(), baseSha, git('rev-parse', 'HEAD'), ticket),
    false,
  );
});

test('retained marker admission requires a gateway-owned receipt pinned to this run, ticket and base', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marker-receipt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = buildRunRecord({ project: 'fixture', flowType: 'fix-bug', ticketOrPr: ticket });
  run.taskFile = path.join(dir, 'TASK.md');
  const relative = `${BASELINE_MARKER_DIR}/${base}-${marker}.json`;
  const receipt = { version: 1, runId: run.id, ticket, baseSha: base, markerSha: marker };
  const bytes = JSON.stringify(receipt);
  const inventory: ArtifactRef[] = [
    {
      path: `artifacts/${relative}`,
      purpose: 'other',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  ];
  const io = {
    async readText(file: string) {
      assert.equal(file, path.join(dir, relative));
      return bytes;
    },
  };
  assert.equal(await markerBaselineVerifier(run, inventory)(marker, base, io, dir), true);
  assert.equal(await markerBaselineVerifier(run, [])(marker, base, io, dir), false);
  assert.equal(
    await markerBaselineVerifier({ ...run, id: 'other-run' }, inventory)(marker, base, io, dir),
    false,
  );
  assert.equal(
    await markerBaselineVerifier({ ...run, ticketOrPr: 'OTHER-1' }, inventory)(
      marker,
      base,
      io,
      dir,
    ),
    false,
  );
  assert.equal(
    await markerBaselineVerifier(run, inventory)(marker, 'c'.repeat(40), io, dir),
    false,
  );
  assert.equal(
    await markerBaselineVerifier(run, inventory)(
      marker,
      base,
      { readText: async () => bytes + ' ' },
      dir,
    ),
    false,
  );
  assert.equal(
    await markerBaselineVerifier({ ...run, flowType: 'dev' }, inventory)(marker, base, io, dir),
    false,
  );
  assert.equal(isGatewayOwnedArtifactMirrorEntry(BASELINE_MARKER_DIR), true);
  assert.equal(isGatewayOwnedArtifactPath(`artifacts/${relative}`), true);
});
