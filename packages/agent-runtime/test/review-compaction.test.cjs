'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { main } = require('../scripts/review-compaction.cjs');
const { claudeCompactionArgs } = require('../scripts/context-compaction.cjs');
const { claudeReadOnlyReviewArgs } = require('../scripts/workspace-trust.cjs');

test('compaction keeps the same user settings and hook policy as the retained review', () => {
  const args = claudeCompactionArgs('saved-session', 'fixture-model');
  const start = args.indexOf('--setting-sources');
  assert(start >= 0);
  assert.deepEqual(
    args.slice(start, start + claudeReadOnlyReviewArgs.length),
    claudeReadOnlyReviewArgs,
  );
});

function fixture(t, mode = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-compact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'source'),
    task = path.join(root, 'task');
  fs.mkdirSync(cwd);
  fs.mkdirSync(task);
  execFileSync('git', ['init', '-q'], { cwd });
  const executable = path.join(root, 'runner');
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs=require('node:fs');fs.appendFileSync(process.env.COMPACT_LOG,'send\\n');
const id=process.env.COMPACT_MODE==='foreign'?'foreign':process.env.COMPACT_SESSION;
if(process.env.COMPACT_MODE!=='missing')console.log(JSON.stringify({type:'system',subtype:'compact_boundary',session_id:id,uuid:'boundary',compact_metadata:{trigger:'manual',pre_tokens:100,post_tokens:25}}));
console.log(JSON.stringify({type:'result',session_id:id,is_error:false}));
`,
    { mode: 0o700 },
  );
  const log = path.join(task, 'send.log');
  const request = {
    operationId: 'a'.repeat(64),
    lineageId: 'lineage',
    packetDigest: 'b'.repeat(64),
    nativeSessionId: 'saved-session',
    focus: 'Preserve findings and retire completed task commands',
  };
  return {
    request,
    cwd,
    task,
    runner: 'claude',
    executable,
    protocol: 'claude-stream-json',
    args: [],
    readOnlyRoots: [],
    action: 'execute',
    environment: {
      set: {
        COMPACT_LOG: log,
        COMPACT_MODE: mode,
        COMPACT_SESSION: request.nativeSessionId,
        CLAUDE_CONFIG_DIR: path.join(root, 'account'),
      },
      unset: [],
    },
    log,
  };
}

test(
  'terminal maintenance confirms structured evidence once; inspection/retry never sends again',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const input = fixture(t);
    const record = await main(input);
    assert.equal(record.status, 'confirmed');
    assert.equal(record.evidence.nativeSessionId, input.request.nativeSessionId);
    assert.equal(record.evidence.preTokens, 100);
    assert.equal(record.evidence.postTokens, 25);
    assert.deepEqual(await main({ ...input, action: 'inspect' }), record);
    assert.deepEqual(await main(input), record);
    assert.equal(fs.readFileSync(input.log, 'utf8'), 'send\n');
    await assert.rejects(
      main({ ...input, request: { ...input.request, packetDigest: 'c'.repeat(64) } }),
      /identity changed/,
    );
  },
);

for (const mode of ['foreign', 'missing'])
  test(
    `terminal maintenance retains ${mode} boundary uncertainty without a resend`,
    { skip: process.platform !== 'darwin' },
    async (t) => {
      const input = fixture(t, mode);
      const record = await main(input);
      assert.equal(record.status, 'unconfirmed');
      assert.equal((await main(input)).status, 'unconfirmed');
      assert.equal(fs.readFileSync(input.log, 'utf8'), 'send\n');
    },
  );
