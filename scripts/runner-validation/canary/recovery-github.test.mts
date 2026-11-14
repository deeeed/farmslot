import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { githubCli } from '../../../services/gateway/src/host-services/github-cli.js';
import { fetchGitHubPR } from '../../../services/gateway/src/external/github.js';
import { getPRRawData } from '../../../services/gateway/src/methods/pr/raw-cache.js';
import {
  githubPrChecksOp,
  githubPrViewOp,
} from '../../../services/gateway/src/integrations/github-operations.js';

import { startRecoveryGithub } from './recovery-github.mjs';

test('recovery CI reads use the HTTP fixture without a keyring and reject unknown requests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-github-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const holds = path.join(root, 'holds');
  await mkdir(holds);
  const heads = new Map<number, string>();
  for (const [number, name] of [
    [101, 'recovery-node-timeout-1'],
    [102, 'recovery-fixer-scope-1'],
  ] as const) {
    const repo = path.join(root, 'slots', name);
    await mkdir(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], {
        encoding: 'utf8',
      }).trim();
    git('init', '-q', '-b', 'main');
    git(
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'test: fixture base',
    );
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', `fix/recovery-${number}`);
    heads.set(number, git('rev-parse', 'HEAD'));
  }
  const keyring = mock.method(githubCli, 'authToken', async () => {
    throw new Error('Recovery must not read a real credential');
  });
  t.after(() => keyring.mock.restore());
  const fixture = await startRecoveryGithub(() => holds);
  t.after(() => fixture.close());
  const previous = process.env.FARMSLOT_GITHUB_API_URL;
  process.env.FARMSLOT_GITHUB_API_URL = fixture.origin;
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_GITHUB_API_URL;
    else process.env.FARMSLOT_GITHUB_API_URL = previous;
  });

  for (const [number, bucket] of [
    [101, 'pending'],
    [102, 'fail'],
  ] as const) {
    const ticket = await fetchGitHubPR(`fixture/recovery#${number}`);
    assert.equal(ticket.headSha, heads.get(number));
    assert.equal(ticket.branch, `fix/recovery-${number}`);
    const pr = await githubPrViewOp('fixture/recovery', number, ['state', 'headRefOid'], {});
    assert.deepEqual(pr.data, { state: 'OPEN', headRefOid: heads.get(number) });
    const checks = await githubPrChecksOp('fixture/recovery', number, ['name', 'bucket'], {});
    assert.deepEqual(checks.data, [{ name: 'fixture', bucket }]);
    const status = await getPRRawData('fixture/recovery', number, true);
    assert.deepEqual(status.errors, []);
    assert.match(status.prStateStdout, /^OPEN\t/);
    assert.match(status.checksStdout, new RegExp(`fixture\\t${bucket}\\t`));
  }
  assert.equal(keyring.mock.callCount(), 0);
  const unknown = await fetch(`${fixture.origin}/repos/other/private/pulls/1`);
  assert.equal(unknown.status, 500);
  assert.match(await unknown.text(), /Unsupported recovery GitHub operation/);
});
