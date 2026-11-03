// Opt-in read-only RPC proof. All configuration, auth and GitHub facts are disposable.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { type DispatchPreviewResult, Methods } from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

test('managed review preview ignores execution pools but rejects duplicate review authorities over RPC', async (t) => {
  const output = process.env.FARMSLOT_REVIEW_POOL_PROOF_OUT;
  assert.ok(output);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'proof.json'), JSON.stringify({ status: 'fail' }) + '\n');
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-pool-rpc-'));
  const source = fileURLToPath(new URL('../../../../', import.meta.url));
  for (const key of Object.keys(process.env))
    if (/^(FARMSLOT_|GATEWAY_|GIT_CONFIG)/.test(key) || key === 'TMUX' || key === 'TMUX_PANE')
      delete process.env[key];
  Object.assign(process.env, {
    NODE_TEST_CONTEXT: '1',
    GATEWAY_HOST: '127.0.0.1',
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
  });
  for (const dir of [
    'scripts',
    'services/gateway',
    'pool',
    'projects/review/shared/review-pr',
    'projects/review/shared/validation',
    'bin',
  ])
    await mkdir(path.join(root, dir), { recursive: true });
  for (const [file, content] of [
    ['CLAUDE.md', '# Isolated review pool proof\n'],
    ['scripts/dev.sh', '#!/bin/sh\n'],
    ['services/gateway/package.json', '{}'],
  ])
    await writeFile(path.join(root, file), content);
  await symlink(path.join(source, 'schemas'), path.join(root, 'schemas'));
  for (const flow of ['review-pr', 'validation'])
    await writeFile(
      path.join(root, `projects/review/shared/${flow}/default.md`),
      '---\nplatforms: [cli]\n---\n\n- [ ] Inspect the frozen change.\n',
    );
  await writeFile(
    path.join(root, 'projects/review/project.json'),
    JSON.stringify({
      name: 'review',
      repo_url: 'https://github.com/example/app.git',
      ci: { repo: 'example/app' },
      static_review: { template_id: 'review-pr/default' },
      execution_templates: {
        sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
      },
      qa: {
        default_profile: 'pr',
        profiles: [{ id: 'pr', title: 'PR QA', template_id: 'validation/default' }],
      },
    }),
  );
  const base = {
    machine: 'review-node',
    project: 'review',
    host: 'localhost',
    platform: 'cli',
    slots: [],
    review_workspaces: { max_concurrent: 2 },
  };
  await writeFile(path.join(root, 'pool/base.json'), JSON.stringify(base));
  await writeFile(
    path.join(root, 'pool/canary.json'),
    JSON.stringify({
      machine: base.machine,
      project: 'farmslot-canary',
      host: 'localhost',
      platform: 'cli',
      slots: [],
    }),
  );
  await writeFile(
    path.join(root, 'bin/gh'),
    `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]!=='api'||args.some(arg=>['POST','PATCH','PUT','DELETE'].includes(arg))) throw Error('Proof refuses GitHub writes');
if(args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n');
process.stdout.write(JSON.stringify({number:42,title:'Fixture change',state:'open',body:'',user:{login:'fixture'},labels:[],head:{sha:'a'.repeat(40)},base:{sha:'b'.repeat(40)}}));
`,
    { mode: 0o755 },
  );
  process.env.PATH = path.join(root, 'bin') + path.delimiter + process.env.PATH;
  await import('../runtime/mock-pty.test-support.js');
  const fixture = await createNativeProofFixture(t, root);
  assert.notEqual(new URL(fixture.url).port, '7801');
  await import('../methods/dispatch.js');
  const params = {
    flowType: 'review-pr',
    project: 'review',
    ticketOrPr: 'example/app#42',
    mode: 'autonomous',
    reviewWorkspaceTarget: { machine: base.machine },
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    transport: 'native',
  };
  const selected = await fixture.client.call<DispatchPreviewResult>(
    Methods.DISPATCH_PREVIEW,
    params,
  );
  assert.equal(selected.preview.slotId, null);
  assert.equal(selected.preview.reviewWorkspace?.machine, base.machine);
  await writeFile(path.join(root, 'pool/second-review-authority.json'), JSON.stringify(base));
  await assert.rejects(fixture.client.call(Methods.DISPATCH_PREVIEW, params), /exactly one/);
  await writeFile(
    path.join(output, 'proof.json'),
    JSON.stringify(
      {
        status: 'pass',
        target: 'isolated',
        readOnly: true,
        modelCalls: 0,
        liveRuns: 0,
        canaryIgnored: true,
        duplicateReviewAuthorityRejected: true,
        machine: selected.preview.reviewWorkspace?.machine,
      },
      null,
      2,
    ) + '\n',
  );
});
