import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
test('the worker fixture cannot inherit a foreign tmux server or pane', async () => {
  const dir = await mkdtemp('/tmp/fs-view-link-env-');
  try {
    const caseDir = path.join(dir, 'case');
    const bin = path.join(dir, 'bin');
    await mkdir(caseDir);
    await mkdir(bin);
    await writeFile(path.join(caseDir, 'fixture.json'), JSON.stringify({ sourceRoot: root }));
    const capture = path.join(dir, 'tmux-observation.json');
    const stub = path.join(bin, 'tmux');
    await writeFile(
      stub,
      '#!/usr/bin/env node\n' +
        `require('node:fs').writeFileSync(process.env.FARMSLOT_TEST_TMUX_CAPTURE,JSON.stringify({args:process.argv.slice(2),server:process.env.TMUX??null,pane:process.env.TMUX_PANE??null,directory:process.env.TMUX_TMPDIR}));process.exit(7);\n`,
    );
    await chmod(stub, 0o700);
    const socketRoot = path.join(dir, 'tmux');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        path.join(root, 'node_modules/tsx/dist/loader.mjs'),
        path.join(root, 'apps/companion/scripts/agentic/view-sharing-fixture.mjs'),
        'prepare-worker',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          TSX_TSCONFIG_PATH: path.join(root, 'services/gateway/tsconfig.json'),
          GATEWAY_PORT: '41235',
          FARMSLOT_VIEW_SHARING_CASE: caseDir,
          TMUX: 'foreign-server,999,0',
          TMUX_PANE: '%foreign',
          TMUX_TMPDIR: socketRoot,
          FARMSLOT_TEST_TMUX_CAPTURE: capture,
        },
      },
    );
    assert.notEqual(
      result.status,
      0,
      'The stub stops before any runtime store or service can start',
    );
    const observed = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(observed.server, null);
    assert.equal(observed.pane, null);
    assert.equal(observed.directory, socketRoot);
    assert(observed.args.includes('new-session'));
    assert(observed.args.includes('farmslot-copilot'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
