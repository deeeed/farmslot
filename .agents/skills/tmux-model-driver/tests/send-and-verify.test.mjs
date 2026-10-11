import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { answerQuestion, paneState, send, tmux } from '../scripts/driver.mjs';

let dir, pane, socket;
const originalEnv = { ...process.env };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-send-test-'));
  socket = `driver-test-${process.pid}`;
  Object.assign(process.env, {
    TMUX_MODEL_DRIVER_SOCKET: socket,
    TMUX_MODEL_DRIVER_STATE_DIR: path.join(dir, 'state'),
    TMUX_MODEL_DRIVER_OBSERVABILITY_DIR: dir,
    TMUX_MODEL_DRIVER_VERIFY_TIMEOUT_MS: '100',
    TMUX_PANE_STATE_CURRENT_COMMAND: 'claude',
    TMUX_PANE_STATE_FOREGROUND_COMMANDS: '',
  });
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const fixture = path.join(dir, 'fixture.mjs');
  fs.writeFileSync(
    fixture,
    `
import fs from 'node:fs'; import readline from 'node:readline'; import path from 'node:path';
const dir=process.argv[2], pane=process.env.TMUX_PANE; let saved='';
fs.mkdirSync(path.join(dir,'panes'));
function record(event, extra={}) {
  const now=Date.now(); const row={runner:'claude',tmuxPane:pane,session_id:'fixture',rootSessionId:'fixture',hook_event_name:event,
    observedAt:now,turnActive:event==='UserPromptSubmit',...extra};
  fs.appendFileSync(path.join(dir,'hooks.jsonl'),JSON.stringify(row)+'\\n');
  fs.writeFileSync(path.join(dir,'panes',encodeURIComponent(pane)+'.json'),JSON.stringify(row));
}
record('SessionStart'); fs.writeFileSync(path.join(dir,'ready'),'');
readline.createInterface({input:process.stdin}).on('line', line=> {
  fs.appendFileSync(path.join(dir,'received'),JSON.stringify(line)+'\\n');
  const mode=fs.readFileSync(path.join(dir,'mode'),'utf8');
  if(mode==='drop') { saved=line; return; }
  const payload=line||saved;
  const sent=fs.readdirSync(path.join(dir,'sent')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,'sent',f),'utf8'))).find(s=>s.prompt===payload);
  record('UserPromptSubmit',{runnerPromptDigest:sent?.digest,turnStartedAt:Date.now()});
});
`,
  );
  fs.writeFileSync(path.join(dir, 'mode'), 'accept');
  tmux([
    'new-session',
    '-d',
    '-s',
    'fixture',
    '-c',
    dir,
    `stty -echo; exec node '${fixture}' '${dir}'`,
  ]);
  pane = tmux(['display-message', '-p', '-t', 'fixture', '#{pane_id}']).trim();
  for (let i = 0; i < 40 && !fs.existsSync(path.join(dir, 'ready')); i++) await pause(10);
  assert.ok(fs.existsSync(path.join(dir, 'ready')));
});

after(() => {
  try {
    if (socket) execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch (error) {
    // An early fixture exit can end its server before teardown. tmux reports that as exit 1.
    if (error.status !== 1) throw error;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    if (dir) fs.rmSync(dir, { recursive: true });
  }
});

function reset(mode = 'accept') {
  fs.writeFileSync(path.join(dir, 'mode'), mode);
  fs.writeFileSync(path.join(dir, 'received'), '');
  const row = {
    runner: 'claude',
    tmuxPane: pane,
    session_id: 'fixture',
    rootSessionId: 'fixture',
    hook_event_name: 'Stop',
    observedAt: Date.now(),
    turnActive: false,
  };
  fs.appendFileSync(path.join(dir, 'hooks.jsonl'), `${JSON.stringify(row)}\n`);
  fs.writeFileSync(
    path.join(dir, 'panes', `${encodeURIComponent(pane)}.json`),
    JSON.stringify(row),
  );
  delete process.env.TMUX_PANE_STATE_TAIL_CAPTURE;
  if (fs.existsSync(path.join(dir, 'state')))
    fs.rmSync(path.join(dir, 'state'), { recursive: true });
}
const received = () =>
  fs
    .readFileSync(path.join(dir, 'received'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);

test('wrong runner, shell, question, busy and foreign queue receive no keystrokes', async () => {
  reset();
  assert.equal((await send(pane, 'codex', 'wrong')).verification, 'wrong_runner');
  process.env.TMUX_PANE_STATE_CURRENT_COMMAND = 'zsh';
  assert.equal((await send(pane, 'claude', 'wrong')).verification, 'wrong_runner');
  process.env.TMUX_PANE_STATE_CURRENT_COMMAND = 'claude';
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = 'Do you want to continue? [y/n]';
  assert.equal((await send(pane, 'claude', 'blind answer')).verification, 'pending_question');
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = 'tab to queue message';
  assert.equal((await send(pane, 'claude', 'busy')).verification, 'busy');
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = '1 queued message';
  assert.equal((await send(pane, 'claude', 'queue')).verification, 'queued_input');
  assert.deepEqual(received(), []);
});

test('exact hook digest and new native turn prove one submitted prompt', async () => {
  reset();
  const result = await send(pane, 'claude', 'one prompt');
  assert.equal(result.verification, 'submitted');
  assert.equal(result.evidence.source, 'hook');
  assert.ok(result.evidence.turn_token);
  assert.deepEqual(received(), ['one prompt']);
  assert.equal(paneState(pane, 'claude').phase, 'busy');
});

test('explicit question answer requires the captured fingerprint and expected runner', async () => {
  reset('drop');
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = 'Do you want to continue? [y/n]';
  const state = paneState(pane, 'claude');
  assert.ok(state.question_fingerprint);
  assert.equal(
    (await answerQuestion(pane, 'codex', state.question_fingerprint, ['Enter'])).verification,
    'wrong_runner',
  );
  assert.equal(
    (await answerQuestion(pane, 'claude', 'old-fingerprint', ['Enter'])).verification,
    'question_changed',
  );
  assert.deepEqual(received(), []);
  const result = await answerQuestion(pane, 'claude', state.question_fingerprint, ['Enter']);
  assert.equal(result.acknowledged, true);
  assert.equal(result.submitted, false);
});

test('unverified receipt blocks duplicate sends; explicit flush sends only Enter', async () => {
  reset('drop');
  assert.equal((await send(pane, 'claude', 'buffered prompt')).verification, 'unverified');
  assert.equal((await send(pane, 'claude', 'buffered prompt')).verification, 'queued_input');
  process.env.TMUX_PANE_STATE_TAIL_CAPTURE = 'buffered prompt';
  assert.equal(
    (await send(pane, 'claude', 'different prompt', null, true)).verification,
    'queued_payload_mismatch',
  );
  fs.writeFileSync(path.join(dir, 'mode'), 'accept');
  const result = await send(pane, 'claude', 'buffered prompt', null, true);
  assert.equal(result.verification, 'submitted');
  assert.equal(result.typed, false);
  assert.deepEqual(received(), ['buffered prompt', '']);
  reset();
  assert.equal((await send(pane, 'claude', '', null, true)).verification, 'queue_not_owned');
});
