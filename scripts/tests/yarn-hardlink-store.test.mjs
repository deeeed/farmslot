import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const plugin = fileURLToPath(new URL('../yarn-hardlink-store.cjs', import.meta.url));

test('concurrent cold-store installs retain every dependency file', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'yarn-hardlink-store-'));
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    rmSync(root, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = path.join(root, String(attempt));
    const projects = ['dep-a', 'dep-b'].map((name) => {
      const cwd = path.join(base, name);
      mkdirSync(path.join(cwd, name), { recursive: true });
      writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({
          private: true,
          packageManager: 'yarn@4.5.3',
          dependencies: { [name]: `file:./${name}` },
        }),
      );
      writeFileSync(
        path.join(cwd, '.yarnrc.yml'),
        `nodeLinker: node-modules\nnmMode: hardlinks-global\nplugins:\n  - path: ${JSON.stringify(plugin)}\n`,
      );
      writeFileSync(
        path.join(cwd, name, 'package.json'),
        JSON.stringify({ name, version: '1.0.0' }),
      );
      writeFileSync(path.join(cwd, name, 'index.js'), 'module.exports = 42;\n');
      return { cwd, name };
    });
    const outcomes = await Promise.allSettled(
      projects.map(({ cwd }) =>
        run('yarn', ['install'], {
          cwd,
          env: {
            ...process.env,
            YARN_GLOBAL_FOLDER: path.join(base, 'global'),
            YARN_NM_MODE: 'hardlinks-global',
            YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
            YARN_ENABLE_SCRIPTS: 'false',
            YARN_ENABLE_TELEMETRY: 'false',
          },
          signal: controller.signal,
        }),
      ),
    );
    for (const outcome of outcomes)
      assert.equal(
        outcome.status,
        'fulfilled',
        outcome.status === 'rejected' ? outcome.reason.stdout || outcome.reason.message : undefined,
      );
    for (const { cwd, name } of projects) {
      assert.equal(
        readFileSync(path.join(cwd, 'node_modules', name, 'index.js'), 'utf8'),
        'module.exports = 42;\n',
      );
      assert.deepEqual(
        JSON.parse(readFileSync(path.join(cwd, 'node_modules', name, 'package.json'), 'utf8')),
        { name, version: '1.0.0' },
      );
      assert.ok(statSync(path.join(cwd, 'node_modules', name, 'index.js')).nlink > 1);
    }
  }
});
