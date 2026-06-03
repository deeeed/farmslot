import assert from 'node:assert/strict';
import test from 'node:test';

import { copilotFormatInstruction } from './copilot.js';

test('copilotFormatInstruction removes mobile dictation prefaces and filler words', () => {
  const result = copilotFormatInstruction({
    transcript:
      'hey farmslot please tell the worker to um run yarn type check and report the result',
    slotId: 'runner-mobile-1',
    runId: 'run-1',
  });

  assert.equal(result.draftText, 'Run `yarn typecheck` and report the result.');
  assert.deepEqual(result.warnings, []);
});

test('copilotFormatInstruction normalizes spoken punctuation in commands', () => {
  const result = copilotFormatInstruction({
    transcript: 'could you run yarn test colon lib',
    slotId: 'runner-mobile-1',
    runId: 'run-1',
  });

  assert.equal(result.draftText, 'Run `yarn test:lib`.');
});

test('copilotFormatInstruction normalizes dictated technical acronyms', () => {
  assert.equal(
    copilotFormatInstruction({
      transcript: 'check c i on git hub pull request and validate on i o s',
      slotId: 'runner-mobile-1',
      runId: 'run-1',
    }).draftText,
    'Check CI on GitHub PR and validate on iOS.',
  );

  assert.equal(
    copilotFormatInstruction({
      transcript: 'run type script then test h m r and q r pairing with e a s build',
      slotId: 'runner-mobile-1',
      runId: 'run-1',
    }).draftText,
    'Run TypeScript then test HMR and QR pairing with EAS build.',
  );
});

test('copilotFormatInstruction preserves warnings that require mobile review', () => {
  const result = copilotFormatInstruction({
    transcript: 'ask the worker to summarize current status',
  });

  assert.equal(result.draftText, 'Summarize current status.');
  assert.deepEqual(result.warnings, [
    'No target slot or worker was provided; verify the destination before sending.',
    'No target run was provided; the mobile client must revalidate before sending.',
  ]);
});

test('copilotFormatInstruction extracts explicit target slots without sending', () => {
  const result = copilotFormatInstruction({
    transcript: 'tell runner-mobile-2 to continue',
    slotId: 'runner-mobile-1',
    runId: 'run-1',
  });

  assert.equal(result.draftText, 'Please continue with the current task.');
  assert.deepEqual(result.targetSuggestion, { slotId: 'runner-mobile-2', runId: 'run-1' });
  assert.deepEqual(result.warnings, [
    'Transcript mentions target slot runner-mobile-2; current terminal is runner-mobile-1. Verify the destination before sending.',
  ]);
});

test('copilotFormatInstruction uses explicit target hints when provided', () => {
  const result = copilotFormatInstruction({
    transcript: 'please report current status',
    slotId: 'runner-mobile-1',
    runId: 'run-1',
    targetHint: 'runner-a-mm-1',
  });

  assert.equal(result.draftText, 'Please report current status.');
  assert.deepEqual(result.targetSuggestion, { slotId: 'runner-a-mm-1', runId: 'run-1' });
  assert.deepEqual(result.warnings, [
    'Transcript mentions target slot runner-a-mm-1; current terminal is runner-mobile-1. Verify the destination before sending.',
  ]);
});

test('copilotFormatInstruction maps common status and validation intents', () => {
  assert.equal(
    copilotFormatInstruction({
      transcript: 'hey farmslot what is the current status',
      slotId: 'runner-mobile-1',
      runId: 'run-1',
    }).draftText,
    'Please report current status.',
  );

  assert.equal(
    copilotFormatInstruction({
      transcript: 'please run validation and report back',
      slotId: 'runner-mobile-1',
      runId: 'run-1',
    }).draftText,
    'Please run validation and share the result.',
  );
});

test('copilotFormatInstruction maps common pause and resume intents', () => {
  assert.equal(
    copilotFormatInstruction({
      transcript: 'pause now',
      slotId: 'runner-mobile-1',
      runId: 'run-1',
    }).draftText,
    'Please pause and ask for clarification.',
  );

  assert.equal(
    copilotFormatInstruction({
      transcript: 'go ahead',
      slotId: 'runner-mobile-1',
      runId: 'run-1',
    }).draftText,
    'Please continue with the current task.',
  );
});

test('copilotFormatInstruction tolerates short mobile ASR noise for continue intents', () => {
  assert.equal(
    copilotFormatInstruction({
      transcript: 'so let us continue here dot f',
      slotId: 'runner-mobile-1',
      runId: 'run-1',
    }).draftText,
    'Please continue with the current task.',
  );

  assert.equal(
    copilotFormatInstruction({
      transcript: 'okay carry on with current task df',
      slotId: 'runner-mobile-1',
      runId: 'run-1',
    }).draftText,
    'Please continue with the current task.',
  );
});

test('copilotFormatInstruction maps common mobile steering intents', () => {
  assert.equal(
    copilotFormatInstruction({
      transcript: 'what should be next then',
      slotId: 'runner-mobile-1',
      runId: 'run-1',
    }).draftText,
    'Please propose the next concrete step.',
  );

  assert.equal(
    copilotFormatInstruction({
      transcript: 'save this work',
      slotId: 'runner-mobile-1',
      runId: 'run-1',
    }).draftText,
    'Please commit the current changes with an appropriate conventional commit message.',
  );

  assert.equal(
    copilotFormatInstruction({
      transcript: 'validate this on iOS and report',
      slotId: 'runner-mobile-1',
      runId: 'run-1',
    }).draftText,
    'Please validate this on iOS and report the evidence.',
  );
});

test('copilotFormatInstruction accepts worker terminal targets without slot or run warnings', () => {
  const worker = {
    nodeId: 'runner-local',
    session: 'omx',
    window: '1',
    pane: '2',
    target: 'omx:1.2',
  };
  const result = copilotFormatInstruction({
    transcript: 'please continue',
    worker,
    terminalTail: ['waiting for input'],
  });

  assert.equal(result.draftText, 'Please continue with the current task.');
  assert.deepEqual(result.targetSuggestion, { worker });
  assert.deepEqual(result.warnings, []);
});

test('copilotFormatInstruction warns when worker dictation mentions a slot target', () => {
  const worker = { nodeId: 'runner-local', session: 'omx', target: 'omx:1.1' };
  const result = copilotFormatInstruction({
    transcript: 'tell runner-mobile-2 to continue',
    worker,
  });

  assert.equal(result.draftText, 'Please continue with the current task.');
  assert.deepEqual(result.targetSuggestion, { slotId: 'runner-mobile-2', worker });
  assert.deepEqual(result.warnings, [
    'Transcript mentions target slot runner-mobile-2; current terminal is worker runner-local:omx:1.1. Send only if this selected worker is intentional.',
  ]);
});
