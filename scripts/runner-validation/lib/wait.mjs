import { PROMPT_MARKER, sleepMs } from './common.mjs';
import { eventName, readHookLines } from './hooks.mjs';
import { capturePane } from './tmux.mjs';

export function waitForRunnerCompletion({ paneId, logPath, beforeCount, timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = capturePane(paneId, 80);
    const newRows = readHookLines(logPath).slice(beforeCount);
    const sawStop = newRows.some((row) => eventName(row) === 'Stop');
    if (pane.includes(PROMPT_MARKER) || sawStop) {
      return { pane, newRows, sawStop, sawMarker: pane.includes(PROMPT_MARKER) };
    }
    sleepMs(intervalMs);
  }
  const pane = capturePane(paneId, 80);
  const newRows = readHookLines(logPath).slice(beforeCount);
  return {
    pane,
    newRows,
    sawStop: newRows.some((row) => eventName(row) === 'Stop'),
    sawMarker: pane.includes(PROMPT_MARKER),
  };
}

export function pollHookRows(logPath, beforeCount, requiredEvents, timeoutMs = 90000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const newRows = readHookLines(logPath).slice(beforeCount);
    const seen = new Set(newRows.map(eventName).filter(Boolean));
    if (requiredEvents.every((name) => seen.has(name))) return newRows;
    sleepMs(intervalMs);
  }
  return readHookLines(logPath).slice(beforeCount);
}