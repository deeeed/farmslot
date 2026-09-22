// Runner-neutral terminal lifecycle. Inputs come from the owning gateway, never PR content.
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process');
const { sandbox } = require('./review-filesystem.cjs');
const input = JSON.parse(process.argv[2]);
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const tmux = (args) => cp.spawnSync('tmux', args, { encoding: 'utf8' });
const check = (result) => {
  if (result.status !== 0)
    throw Error(result.stderr || result.error?.message || 'Terminal operation failed');
  return result.stdout.trim();
};
const target = input.session;
async function main() {
  if (
    !/^[a-zA-Z0-9_-]+$/.test(input.session) ||
    !path.isAbsolute(input.task) ||
    !path.isAbsolute(input.cwd)
  )
    throw Error('Invalid review terminal identity');
  const marker = path.join(input.task, '.terminal-launch.json');
  const cancelled = path.join(input.task, '.terminal-cancelled');
  const existing = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : undefined;
  if (
    existing &&
    (existing.runId !== input.runId ||
      existing.workspaceId !== input.workspaceId ||
      existing.session !== input.session)
  )
    throw Error('Review terminal identity changed');
  const has = tmux(['has-session', '-t', '=' + target]);
  if (![0, 1].includes(has.status)) check(has);
  if (
    has.status === 0 &&
    check(tmux(['show-option', '-v', '-t', target, '@farmslot-review-workspace'])) !==
      input.workspaceId
  )
    throw Error('Review terminal belongs to another workspace');
  if (input.action === 'stop') {
    fs.writeFileSync(cancelled, input.runId, { mode: 0o600 });
    if (has.status === 0) check(tmux(['kill-session', '-t', target]));
    process.stdout.write(JSON.stringify({ stopped: true }));
    return;
  }
  if (input.action === 'inspect') {
    process.stdout.write(JSON.stringify({ exists: has.status === 0, launch: existing }));
    return;
  }
  if (fs.existsSync(cancelled)) throw new Error('Review terminal launch was cancelled');
  if (existing) {
    if (has.status !== 0) throw Error('Review terminal exited; explicit retry required');
    process.stdout.write(JSON.stringify(existing));
    return;
  }
  if (has.status === 0) throw Error('Review terminal exists without a launch record');
  const cwd = fs.realpathSync(input.cwd),
    task = fs.realpathSync(input.task);
  const gitRoot = check(
    cp.spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
    }),
  );
  const policy = {
    readOnlyRoots: [
      cwd,
      fs.realpathSync(gitRoot),
      ...(input.support ? [fs.realpathSync(input.support)] : []),
    ],
    writableRoots: [task],
  };
  const runtimeRoots = input.runtimeRoots.map((root) =>
    root.replace(/^~(?=\/|$)/, process.env.HOME),
  );
  const guard = await sandbox(policy, runtimeRoots);
  const promptFile = path.join(task, '.terminal-prompt.txt');
  fs.writeFileSync(promptFile, input.prompt, { mode: 0o600 });
  const environment = {
    ...process.env,
    ...input.environment.set,
    TMPDIR: guard.temporaryDirectory,
    DISABLE_OMX: '1',
    DISABLE_OMC: '1',
  };
  for (const key of [
    ...input.environment.unset,
    'CLAUDECODE',
    'FARMSLOT_NODE_TOKEN',
    'FARMSLOT_GATEWAY_TOKEN',
    'FARMSLOT_GATEWAY_PASSWORD',
  ])
    delete environment[key];
  if (input.setup)
    check(
      cp.spawnSync('/bin/sh', ['-c', input.setup], { cwd, env: environment, encoding: 'utf8' }),
    );
  const commandFile = path.join(task, '.terminal-start.cjs');
  const record = {
    runId: input.runId,
    workspaceId: input.workspaceId,
    session: input.session,
    startedAt: new Date().toISOString(),
  };
  const launch = `const cp=require('node:child_process');const env={...process.env};for(const key of ['FARMSLOT_NODE_TOKEN','FARMSLOT_GATEWAY_TOKEN','FARMSLOT_GATEWAY_PASSWORD','CLAUDECODE'])delete env[key];const r=cp.spawnSync(${JSON.stringify(guard.sandbox.executable)},${JSON.stringify([...guard.sandbox.args, '/bin/sh', '-c', input.command])},{cwd:${JSON.stringify(cwd)},env,stdio:'inherit'});process.exit(r.status??1);`;
  fs.writeFileSync(commandFile, launch, { mode: 0o600 });
  const envArgs = Object.entries(environment)
    .filter(([, value]) => typeof value === 'string')
    .flatMap(([name, value]) => ['-e', name + '=' + value]);
  fs.writeFileSync(marker, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  check(
    tmux([
      'new-session',
      '-d',
      ...envArgs,
      '-s',
      input.session,
      '-c',
      cwd,
      `${quote(process.execPath)} ${quote(commandFile)}`,
      ';',
      'set-option',
      '-t',
      target,
      '@farmslot-review-workspace',
      input.workspaceId,
    ]),
  );
  if (fs.existsSync(cancelled)) {
    check(tmux(['kill-session', '-t', target]));
    throw new Error('Review terminal launch was cancelled');
  }
  process.stdout.write(JSON.stringify(record));
}
main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
