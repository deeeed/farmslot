// Opt-in real reviewer proof. Supply provider credentials and an optional FARMSLOT_REVIEW_PROOF_MODEL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NativeSessionManager } from '../../packages/agent-runtime/src/native/manager.js';

const evidence = path.resolve(process.argv[2] ?? '/tmp/review-cwd-state-evidence');
await mkdir(evidence, { recursive: true });
const root = await realpath(await mkdtemp('/tmp/cwd-native-'));
const source = path.join(root, 'source'),
  task = path.join(root, 'task'),
  account = path.join(root, 'account');
for (const directory of [source, task, account]) await mkdir(directory);
await writeFile(path.join(source, 'sample.txt'), 'native source evidence\n');
const manager = new NativeSessionManager(path.join(root, 'native-state'));
let id: string | undefined;
const result: Record<string, unknown> = { root, status: 'FAIL' };
try {
  const session = await manager.create(
    'cwd-proof',
    { runner: 'claude', cwd: source, model: process.env.FARMSLOT_REVIEW_PROOF_MODEL },
    {
      leaseId: randomUUID(),
      executable: process.env.FARMSLOT_REVIEW_PROOF_BINARY ?? 'claude',
      safetyTier: 'sandboxed',
      approvalPolicy: 'never',
      modelQuestions: 'off',
      filesystemPolicy: { readOnlyRoots: [source], writableRoots: [task] },
      environment: {
        set: { CLAUDE_CONFIG_DIR: account, CLAUDE_CODE_TMPDIR: '/tmp/stale-cwd-proof' },
        unset: [
          'CLAUDE_CODE_OAUTH_TOKEN',
          'ANTHROPIC_AUTH_TOKEN',
          'CLAUDECODE',
          'TMUX',
          'TMUX_PANE',
        ],
      },
    },
  );
  id = session.id;
  result.sessionId = session.nativeSessionId;
  const commandId = randomUUID();
  await manager.send(
    'cwd-proof',
    id,
    commandId,
    'Call Bash exactly once with command "cat sample.txt". Do not retry if it fails. Then report the tool result and stop.',
  );
  const deadline = Date.now() + 120000;
  let snapshot = manager.read('cwd-proof', id, 0, 500);
  while (
    !snapshot.events.some(
      (event) => event.type === 'turn.completed' && event.commandId === commandId,
    )
  ) {
    assert(Date.now() < deadline, 'Native turn timed out');
    assert(!['failed', 'closed'].includes(snapshot.session.state), 'Native session failed');
    await new Promise((resolve) => setTimeout(resolve, 500));
    snapshot = manager.read('cwd-proof', id, 0, 500);
  }
  await writeFile(
    path.join(evidence, 'NATIVE-EVENTS.json'),
    JSON.stringify(snapshot.events, null, 2) + '\n',
  );
  const tools = snapshot.events.filter((event) => event.type === 'tool.completed');
  const bash = snapshot.events.find(
    (event) =>
      event.type === 'tool.started' &&
      event.commandId === commandId &&
      event.tool?.name === 'Bash' &&
      event.tool.command === 'cat sample.txt',
  );
  assert(bash?.nativeId, 'Expected the exact Bash source-read command');
  const completion = tools.find(
    (event) => event.commandId === commandId && event.nativeId === bash.nativeId,
  );
  assert(completion?.tool, 'Expected the matching Bash completion');
  assert.equal(completion.tool.status, 'completed');
  const output = completion.tool.output;
  assert(typeof output === 'string', 'Expected textual Bash output');
  assert.equal(output.trim(), 'native source evidence');
  result.tools = tools;
  const temporaryDirectory = path.join(task, '.review-runtime/tmp');
  result.privateTemporaryFiles = await readdir(temporaryDirectory);
  result.cwdFiles = (await readdir(temporaryDirectory)).filter((name) =>
    /^claude-.*-cwd$/.test(name),
  );
  const projectDirectory = (await readdir(path.join(account, 'projects')))[0];
  const transcript = await readFile(
    path.join(account, 'projects', projectDirectory, session.nativeSessionId + '.jsonl'),
    'utf8',
  );
  const toolResults = transcript
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((value) => value.type === 'user')
    .flatMap((value) => value.message.content)
    .filter((value) => value.type === 'tool_result');
  result.toolResults = toolResults;
  assert(toolResults.some((value) => value.tool_use_id === bash.nativeId));
  assert(toolResults.every((value) => !value.is_error));
  assert.equal(await readFile(path.join(source, 'sample.txt'), 'utf8'), 'native source evidence\n');
  result.status = 'PASS';
} finally {
  if (id) {
    await manager.close('cwd-proof', id);
    result.processStopped = manager.read('cwd-proof', id).session.processStopped;
    assert.equal(result.processStopped, true);
  }
  await writeFile(
    path.join(evidence, 'NATIVE-RESULT.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
