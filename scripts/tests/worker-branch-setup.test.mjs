import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const templates = [
  ['farmslot-farm', 'dev'],
  ['farmslot-farm', 'fix-bug'],
  ['metamask-extension-farm', 'dev'],
  ['metamask-extension-farm', 'dev-interactive'],
  ['metamask-mobile-farm', 'dev'],
  ['metamask-mobile-farm', 'dev-interactive'],
  ['metamask-core-farm', 'dev'],
];

for (const [project, template] of templates) {
  const file = path.join(root, 'projects', project, 'templates/worker', `${template}.md`);
  test(
    `${project}/${template} preserves prepared branches and rejects unrelated checkouts`,
    {
      // External project packs are optional in framework-only checkouts.
      skip: !fs.existsSync(file),
    },
    (t) => {
      const source = fs.readFileSync(file, 'utf8');
      const match = source.match(/# Farmslot prepare normally[\s\S]*?\n\s*fi/);
      assert.ok(match, 'template must include branch setup');
      const script = match[0]
        .replaceAll('{{BRANCH}}', 'feature/task')
        .replaceAll('{{DEFAULT_BRANCH}}', 'main');
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'farmslot-branch-setup-'));
      t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
      const git = (...args) =>
        execFileSync('git', args, {
          cwd: repo,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      git('init', '--initial-branch=main');
      git('config', 'core.hooksPath', '/dev/null');
      git(
        '-c',
        'user.name=Branch test',
        '-c',
        'user.email=branch-test@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      );
      const initialHead = git('rev-parse', 'HEAD');
      const run = () => spawnSync('bash', ['-c', script], { cwd: repo, encoding: 'utf8' });

      assert.equal(run().status, 0, 'create missing task branch from main');
      assert.equal(git('branch', '--show-current'), 'feature/task');
      fs.writeFileSync(path.join(repo, 'uncommitted.txt'), 'preserve work');
      assert.equal(run().status, 0, 'reuse the prepared branch');
      assert.equal(git('rev-parse', 'HEAD'), initialHead);
      assert.equal(fs.readFileSync(path.join(repo, 'uncommitted.txt'), 'utf8'), 'preserve work');

      git('checkout', '-b', 'unrelated');
      assert.notEqual(run().status, 0, 'reject an unrelated branch');
      assert.equal(git('branch', '--show-current'), 'unrelated');
      git('checkout', '--detach');
      assert.notEqual(run().status, 0, 'reject detached HEAD');
      assert.equal(git('rev-parse', 'HEAD'), initialHead);
      git('checkout', 'main');
      assert.notEqual(run().status, 0, 'do not reset an existing task branch from main');
      assert.equal(git('branch', '--show-current'), 'main');
    },
  );
}
