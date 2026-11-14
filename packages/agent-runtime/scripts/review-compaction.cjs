// Gateway-owned maintenance before terminal task delivery. Retries only read the receipt.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { sandbox } = require('./review-filesystem.cjs');
const { claudeCompactionBoundary } = require('./context-compaction.cjs');

async function main(input) {
  const request = input.request;
  if (
    !path.isAbsolute(input.cwd) ||
    !path.isAbsolute(input.task) ||
    !/^[a-f0-9]{64}$/.test(request.operationId)
  )
    throw new Error('Invalid review compaction identity');
  const file = path.join(input.task, `.context-compaction-${request.operationId}.json`);
  const focusSha256 = createHash('sha256').update(request.focus).digest('hex');
  const save = (value) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  };
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of ['operationId', 'lineageId', 'packetDigest', 'nativeSessionId'])
      if (saved[key] !== request[key])
        throw new Error('Review compaction receipt identity changed');
    if (saved.focusSha256 !== focusSha256) throw new Error('Review compaction focus changed');
    return saved;
  }
  if (input.action === 'inspect') return null;
  const record = {
    operationId: request.operationId,
    lineageId: request.lineageId,
    packetDigest: request.packetDigest,
    nativeSessionId: request.nativeSessionId,
    focusSha256,
    requestedAt: new Date().toISOString(),
    status: 'pending',
  };
  // Exclusive intent claims the one provider send, even if two node requests race.
  fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  try {
    if (input.protocol !== 'claude-stream-json')
      throw new Error('Unsupported structured compaction protocol');
    const env = { ...process.env, ...input.environment.set, DISABLE_OMX: '1', DISABLE_OMC: '1' };
    for (const key of [
      ...input.environment.unset,
      'FARMSLOT_NODE_TOKEN',
      'FARMSLOT_GATEWAY_TOKEN',
      'FARMSLOT_GATEWAY_PASSWORD',
      'CLAUDECODE',
    ])
      delete env[key];
    const {
      reviewRuntimeRootsByRunner,
      reviewConfigurationRootsByRunner,
      reviewTemporaryDirectoryVariablesByRunner,
    } = require('./workspace-trust.cjs');
    const cwd = fs.realpathSync(input.cwd);
    const git = cp.spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', env },
    );
    if (git.status !== 0) throw new Error(git.stderr || 'Review repository unavailable');
    const guard = await sandbox(
      {
        readOnlyRoots: [
          cwd,
          fs.realpathSync(git.stdout.trim()),
          ...input.readOnlyRoots.map((root) => fs.realpathSync(root)),
        ],
        writableRoots: [fs.realpathSync(input.task)],
      },
      (reviewRuntimeRootsByRunner[input.runner]?.(env) ?? []).map((root) =>
        root.replace(/^~(?=\/|$)/, env.HOME),
      ),
      reviewConfigurationRootsByRunner[input.runner]?.(cwd) ?? [],
    );
    env.TMPDIR = guard.temporaryDirectory;
    for (const name of reviewTemporaryDirectoryVariablesByRunner[input.runner] ?? [])
      env[name] = guard.temporaryDirectory;
    const result = cp.spawnSync(
      guard.sandbox.executable,
      [...guard.sandbox.args, input.executable, ...input.args],
      {
        cwd,
        env,
        input: `/compact ${request.focus}`,
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || 'Provider compaction failed');
    let evidence,
      completed = false;
    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const message = JSON.parse(line);
      evidence = claudeCompactionBoundary(message, request.nativeSessionId) ?? evidence;
      if (
        message.type === 'assistant' &&
        message.message?.content?.some((block) =>
          ['tool_use', 'server_tool_use'].includes(block.type),
        )
      )
        throw new Error('Compaction attempted task tools');
      if (message.type === 'result') {
        if (message.is_error || message.session_id !== request.nativeSessionId || !evidence)
          throw new Error('Compaction result lacks an exact-session manual boundary');
        completed = true;
      }
    }
    if (!completed || !evidence) throw new Error('Compaction completion unconfirmed');
    record.status = 'confirmed';
    record.evidence = evidence;
  } catch (error) {
    // The provider may have changed context. Preserve uncertainty and never resend.
    record.status = 'unconfirmed';
    record.reason = error instanceof Error ? error.message : String(error);
  }
  save(record);
  return record;
}

if (require.main === module)
  main(JSON.parse(process.argv[2])).then(
    (result) => process.stdout.write(JSON.stringify(result)),
    (error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
    },
  );
module.exports = { main };
