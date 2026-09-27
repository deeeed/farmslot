import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);
const digest = (text) => createHash('sha256').update(text).digest('hex');

async function rpc(method, params) {
  const { stdout } = await execute(
    process.execPath,
    [
      path.join(root, 'apps/command-center/scripts/cdp.mjs'),
      'gateway',
      method,
      JSON.stringify(params),
    ],
    { cwd: root, encoding: 'utf8', timeout: 40_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

export function verifyReceipts(proof, transcript) {
  assert.equal(proof.messages.length, 2, 'Concurrency proof requires two messages');
  assert.notEqual(proof.messages[0].id, proof.messages[1].id);
  assert.notEqual(proof.messages[0].text, proof.messages[1].text);
  const receipts = new Map();
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.sessionId !== proof.sessionId) continue;
    const texts =
      record.type === 'user' && record.message?.role === 'user'
        ? typeof record.message.content === 'string'
          ? [record.message.content]
          : (record.message.content ?? [])
              .filter((entry) => entry.type === 'text')
              .map((entry) => entry.text)
        : [];
    let matchedInTurn = false;
    for (const text of texts) {
      if (typeof text !== 'string') continue;
      const wrapper = text.match(
        /^[\t\r\n ]*<pasted_content id="([A-Za-z0-9_-]+)">\n([\s\S]*)\n<\/pasted_content id="\1">[\t\r\n ]*$/u,
      );
      const payload = wrapper ? wrapper[2] : text;
      for (const expected of proof.messages) {
        if (payload === expected.text) {
          assert.equal(matchedInTurn, false, 'Messages must arrive in separate user turns');
          assert.equal(receipts.has(expected.id), false, 'Message delivered more than once');
          matchedInTurn = true;
          receipts.set(expected.id, {
            id: expected.id,
            bytes: Buffer.byteLength(payload),
            sha256: digest(payload),
            nativeEventBytes: Buffer.byteLength(text),
            nativePasteEnvelope: Boolean(wrapper),
            eventType: record.type,
            timestamp: record.timestamp,
          });
        }
      }
    }
  }
  assert.equal(
    receipts.size,
    proof.messages.length,
    'Each message must arrive whole, separately and unchanged',
  );
  return [...receipts.values()];
}

async function main() {
  const directory = process.env.FARMSLOT_PASTE_PROOF_DIR;
  assert.ok(directory, 'Set FARMSLOT_PASTE_PROOF_DIR to a private artifact directory');
  const proofFile = path.join(directory, 'proof.json');
  if (process.argv.includes('--send')) {
    const runId = process.env.FARMSLOT_PASTE_PROOF_RUN_ID;
    assert.ok(runId, 'Set FARMSLOT_PASTE_PROOF_RUN_ID; this sends two validation-only messages');
    const { run } = await rpc('run.get', { runId });
    const contextId = process.env.FARMSLOT_PASTE_PROOF_CONTEXT_ID;
    assert.ok(contextId, 'Set FARMSLOT_PASTE_PROOF_CONTEXT_ID to the selected worker context');
    const context = run.agentContexts.find((entry) => entry.id === contextId);
    assert.equal(context?.runner ?? run.metrics.runner, 'claude');
    assert.equal(run.transport ?? 'tmux', 'tmux');
    assert.ok(context?.target && !context.nativeSession && !context.nativeSessionOwner);
    assert.ok(run.slotId && context?.runnerSessionId && context.runnerSessionPath);
    assert.ok(
      ['monitoring', 'blocked'].includes(run.status),
      'Use a retained, deliberately selected worker',
    );
    const proof = {
      runId,
      slotId: run.slotId,
      contextId,
      sessionId: context.runnerSessionId,
      transcriptPath: context.runnerSessionPath,
      startedAt: new Date().toISOString(),
      messages: ['first', 'second'].map((label) => {
        const id = `${label}-${randomUUID()}`;
        const text = `TRANSPORT VALIDATION ONLY. Do not execute or change task scope. Marker ${id}.\n${'literal \'quote\' "double" 字 🧪\n'.repeat(180)}END ${id}`;
        assert.ok(Buffer.byteLength(text) > 4096 && Buffer.byteLength(text) < 15_000);
        return { id, text, bytes: Buffer.byteLength(text), sha256: digest(text) };
      }),
    };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(proofFile, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const results = await Promise.allSettled(
      proof.messages.map(async (message) => {
        const result = await rpc('terminal.send', {
          runId,
          slotId: run.slotId,
          contextId,
          text: message.text,
          enter: true,
        });
        assert.equal(result.sent, true);
      }),
    );
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError(failures, 'Submission failed; do not resend blindly');
    console.log(
      JSON.stringify({
        submitted: true,
        received: 'unverified',
        proofFile,
        transcriptPath: proof.transcriptPath,
        sessionId: proof.sessionId,
      }),
    );
  } else if (process.argv.includes('--verify')) {
    const transcriptFile = process.env.FARMSLOT_PASTE_PROOF_TRANSCRIPT;
    assert.ok(
      transcriptFile,
      'Set FARMSLOT_PASTE_PROOF_TRANSCRIPT to the real copied runner JSONL',
    );
    const proof = JSON.parse(readFileSync(proofFile, 'utf8'));
    const { run } = await rpc('run.get', { runId: proof.runId });
    assert.equal(
      run.agentContexts.find((entry) => entry.id === proof.contextId)?.runnerSessionId,
      proof.sessionId,
    );
    const receipts = verifyReceipts(proof, readFileSync(transcriptFile, 'utf8'));
    const report = { runId: proof.runId, sessionId: proof.sessionId, receipts };
    writeFileSync(path.join(directory, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(JSON.stringify(report));
  } else {
    throw new Error('Use --send, then copy the actual session JSONL and use --verify');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
