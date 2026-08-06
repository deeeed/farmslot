import fs from 'node:fs';
import path from 'node:path';

export function readHookLines(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function eventName(row) {
  return row.hook_event_name || row.event || null;
}

export function observedEvents(rows) {
  return [...new Set(rows.map(eventName).filter(Boolean))].sort();
}

export function writePromptSentinel(obsDir, message, digestModule) {
  const digest = digestModule.runnerPromptDigest(message);
  const sentDir = path.join(obsDir, 'sent');
  fs.mkdirSync(sentDir, { recursive: true });
  const sentAt = Date.now();
  fs.writeFileSync(
    path.join(sentDir, `${digest}.json`),
    `${JSON.stringify({
      sentAt,
      digest,
      prompt: digestModule.instructionNeedle(message),
    })}\n`,
  );
  return { digest, sentAt };
}

export function assertRequiredHookEvents(rows, required) {
  const seen = observedEvents(rows);
  const missing = required.filter((name) => !seen.includes(name));
  return { seen, missing, pass: missing.length === 0 };
}

export function tmuxPaneSeen(rows) {
  return rows.some((row) => typeof row.tmuxPane === 'string' && row.tmuxPane.length > 0);
}

export function turnBoundaryOrdered(rows) {
  const submit = rows.find((row) => eventName(row) === 'UserPromptSubmit');
  const stop = rows.find((row) => eventName(row) === 'Stop');
  if (!submit || !stop) return { pass: false, reason: 'missing submit or stop' };
  const submitAt = submit.observedAt ?? submit.timestamp;
  const stopAt = stop.observedAt ?? stop.timestamp;
  if (typeof submitAt !== 'number' || typeof stopAt !== 'number') {
    return { pass: false, reason: 'missing timestamps' };
  }
  return { pass: stopAt >= submitAt, submitAt, stopAt };
}

export function hookDigestTurnEvidence(rows, promptDigest) {
  const submit = rows.find(
    (row) => eventName(row) === 'UserPromptSubmit' && row.runnerPromptDigest === promptDigest,
  );
  if (!submit) return null;
  const submitAt = submit.observedAt ?? submit.timestamp;
  const stop = rows.find((row) => {
    if (eventName(row) !== 'Stop' || row.session_id !== submit.session_id) return false;
    const stopAt = row.observedAt ?? row.timestamp;
    return typeof submitAt === 'number' && typeof stopAt === 'number' && stopAt >= submitAt;
  });
  return stop
    ? {
        digest: promptDigest,
        sessionId: submit.session_id,
        submittedAt: submitAt,
        stoppedAt: stop.observedAt ?? stop.timestamp,
      }
    : null;
}
