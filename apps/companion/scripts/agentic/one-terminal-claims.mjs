// Claims the shared terminal's device proof asserts (prove-offline-runs.mjs terminal-context).
// Pure, so each can be shown to fail on a broken frame or pane without a device.

/** Lines of a pane capture, without the blank tail tmux pads it with. */
function paneLines(paneText) {
  return paneText.split('\n').filter((line) => line.trim() !== '');
}

/** `echo <tag>` ran exactly once: one command line and one output line, nothing repeated. */
export function typedOnce(paneText, tag) {
  const lines = paneLines(paneText);
  const commands = lines.filter((line) => line.trimEnd().endsWith(`echo ${tag}`)).length;
  const outputs = lines.filter((line) => line.trim() === tag).length;
  return commands === 1 && outputs === 1;
}

/** The terminal resolved a pane for this slot and streams it. */
export function openOnSlot(frame, slotId) {
  return Boolean(
    frame?.focused &&
    frame.terminalReady &&
    frame.terminalStream === 'live' &&
    frame.terminalTarget?.slotId === slotId,
  );
}

/** A missing slot session was created through terminal.reinit, and now exists. */
export function sessionRecreated(frame, sessionExists) {
  return frame?.terminalReinit === 'done' && sessionExists === true;
}

/** The unsent draft came back after a relaunch, on the same pane. */
export function draftRestored(frame, text) {
  return frame?.terminalReady === true && frame.terminalDraft === text;
}

/** Send from a slot-opened terminal went through the runner's terminal.send, once. */
export function sentThroughRunner(frame, sendsBefore) {
  const sends = frame?.terminalSends ?? [];
  return sends.length === sendsBefore + 1 && sends.at(-1) === 'terminal.send';
}
