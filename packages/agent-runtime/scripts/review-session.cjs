// Persist a runner-owned chat identity before launching a managed review terminal.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const input = JSON.parse(process.argv[2]);
const file = path.join(input.task, '.runner-session.json');
const identity = { runId: input.runId, workspaceId: input.workspaceId, runner: input.runner };
if (!path.isAbsolute(input.task) || !path.isAbsolute(input.cwd))
  throw Error('Invalid session workspace');
if (fs.existsSync(file)) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of Object.keys(identity))
    if (saved[key] !== identity[key]) throw Error('Runner session identity changed');
  if (input.resumeSessionId && saved.sessionId !== input.resumeSessionId)
    throw Error('Retained session changed');
  process.stdout.write(JSON.stringify(saved));
} else {
  let sessionId = input.resumeSessionId;
  if (!sessionId) {
    const env = { ...process.env, ...input.environment.set };
    for (const key of [
      ...input.environment.unset,
      'FARMSLOT_NODE_TOKEN',
      'FARMSLOT_GATEWAY_TOKEN',
      'FARMSLOT_GATEWAY_PASSWORD',
      'CLAUDECODE',
    ])
      delete env[key];
    const result = cp.spawnSync(input.argv[0], input.argv.slice(1), {
      cwd: input.cwd,
      env,
      encoding: 'utf8',
      timeout: 20000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(result.stderr || 'Could not reserve runner session');
    sessionId = result.stdout.trim();
  }
  // create-chat documents a UUID result. Never infer identity from terminal text.
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId))
    throw Error('Runner returned an invalid chat ID');
  const saved = { ...identity, sessionId };
  fs.writeFileSync(file, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(saved));
}
