// Manual authenticated prepare proof. Tmux calls are fixture transport;
// script transfer, Git, Bash execution and output bytes are real.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
const runFile = promisify(execFile);
const code = fileURLToPath(new URL('../../../', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'prepare-payload-proof-'));
const output = path.resolve(process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/prepare-payload-proof');
const repo = path.join(root, 'repo');
const session = 'payload-' + randomUUID().replaceAll('-', '');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});
for (const dir of ['repo', 'home', 'pool', 'projects/proof', 'runs'])
  await mkdir(path.join(root, dir), { recursive: true });
await mkdir(output, { recursive: true });
for (const name of [
  'scripts',
  'services',
  'packages',
  'schemas',
  'node_modules',
  'package.json',
  'CLAUDE.md',
])
  await symlink(path.join(code, name), path.join(root, name));
const git = async (...args: string[]) =>
  runFile('git', ['-C', repo, '-c', 'core.hooksPath=.git/hooks', ...args]);
await git('init', '-b', 'main');
await git('config', 'user.name', 'Prepare proof');
await git('config', 'user.email', 'proof@example.invalid');
await git('config', 'commit.gpgsign', 'false');
await writeFile(path.join(repo, 'base.txt'), 'base\n');
await git('add', 'base.txt');
await git('commit', '-m', 'test: seed prepare payload fixture');
const artifact = path.join(root, 'large.diff');
const payload = 'diff --git a/large b/large\n+' + 'x'.repeat(1536 * 1024) + '\n';
const hook = `cat > '${artifact}' <<'PREPARE_DIFF'\n${payload}PREPARE_DIFF\n`;
await writeFile(
  path.join(root, 'pool/proof.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'proof',
    platform: 'cli',
    slots: [{ id: 'payload-slot', repo, session }],
  }),
);
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({
    name: 'proof',
    default_branch: 'main',
    hooks: { post_merge_install: hook },
    prepare: { default: 'payload', profiles: { payload: { phases: ['deps'], requires: [] } } },
  }),
);
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({ slots: [{ slot: 'payload-slot', lifecycle: 'ready' }] }),
);
const load = (file: string) => import(pathToFileURL(path.join(code, file)).href);
const core = await load('services/gateway/src/core/index.ts');
const files = await load('services/gateway/src/core/slot-io.ts');
const tmux = await load('services/gateway/src/core/tmux.ts');
const stages: string[] = [];
let maxCommandBytes = 0;
const execute = async (command: string, options: object = {}) => {
  maxCommandBytes = Math.max(maxCommandBytes, Buffer.byteLength(command));
  if (command.includes('"$TMUX_BIN"') || command.startsWith('tmux ')) {
    if (command.includes('respawn-pane')) {
      const script = stages.at(-1);
      assert.ok(script, 'prepare must transfer its script before launch');
      assert.ok(path.basename(script).startsWith(session));
      assert.equal((await stat(script)).mode & 0o777, 0o600);
      const result = await runFile('bash', [script], {
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      });
      await appendFile(script.replace(/-[a-f0-9]{12}\.sh$/, '.log'), result.stdout + result.stderr);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  return core.execLocal(command, options);
};
mock.module(pathToFileURL(path.join(code, 'services/gateway/src/core/index.ts')).href, {
  namedExports: {
    ...core,
    execOnSlot: async (_vars: unknown, command: string, options: object) =>
      execute(command, options),
  },
});
mock.module(pathToFileURL(path.join(code, 'services/gateway/src/core/tmux.ts')).href, {
  namedExports: { ...tmux, resolveTmuxSession: async () => session },
});
mock.module(pathToFileURL(path.join(code, 'services/gateway/src/core/slot-io.ts')).href, {
  namedExports: {
    ...files,
    slotWriteFiles: async (
      ctx: unknown,
      base: string,
      entries: Array<{ path: string; content: string; mode?: number }>,
    ) => {
      for (const entry of entries)
        if (entry.path.endsWith('.sh')) stages.push(path.join(base, entry.path));
      return files.slotWriteFiles(ctx, base, entries);
    },
  },
});
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
const person = auth.writer.createPrincipal({ type: 'person', displayName: 'Payload proof' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const credential = auth.writer.issueCredential(person.id, 'Disposable proof');
const grant = auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Proof',
  deviceKind: 'cli',
});
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
const server = createServer(),
  wss = createWebSocketServer(server, auth);
let client;
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  client = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 60000,
  }).connect();
  const before = (await git('rev-parse', 'HEAD')).stdout.trim();
  const result = await client.call('slot.prepare', {
    slotId: 'payload-slot',
    prepareProfile: 'payload',
    strictProfile: true,
  });
  const actual = await readFile(artifact);
  assert.equal(actual.toString(), payload);
  assert.ok(maxCommandBytes < 65536, 'large payload never enters exec argv');
  assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), before);
  assert.ok(stages.length > 0);
  const nodeFs = await load('services/node/src/commands/fs.ts');
  const remoteRoot = path.join(root, 'remote-stage');
  await files.slotWriteFiles(
    {
      host: 'fixture-node.invalid',
      machine: 'fixture-node',
      sshTarget: '',
      nodeRequest: async (method: string, params: unknown) => {
        assert.equal(method, 'fs.writeFiles');
        return nodeFs.fsWriteFiles(params);
      },
    },
    remoteRoot,
    [{ path: 'large.diff', content: Buffer.from(payload).toString('base64'), mode: 0o600 }],
  );
  assert.deepEqual(await readFile(path.join(remoteRoot, 'large.diff')), actual);
  assert.equal((await stat(path.join(remoteRoot, 'large.diff'))).mode & 0o777, 0o600);
  const receipt = {
    pass: true,
    method: 'slot.prepare',
    result,
    payloadBytes: actual.length,
    payloadSha256: createHash('sha256').update(actual).digest('hex'),
    maxCommandBytes,
    headPreserved: true,
    nodeFileTransportBytes: actual.length,
    scope:
      'Authenticated production prepare/profile/staging, real file transfer and Bash execution. Tmux transport is substituted; no physical node or tmux liveness claim.',
    modelTurns: 0,
    productOperations: 0,
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ pass: true, payloadBytes: actual.length, maxCommandBytes }));
} finally {
  client?.close();
  for (const connection of wss.clients) connection.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const script of stages) {
    assert.ok(path.basename(script).startsWith(session));
    for (const file of [
      script,
      script.replace(/\.sh$/, '.exit'),
      script.replace(/-[a-f0-9]{12}\.sh$/, '.log'),
    ])
      await rm(file, { force: true });
  }
  await rm(root, { recursive: true, force: true });
}
process.exit(0);
