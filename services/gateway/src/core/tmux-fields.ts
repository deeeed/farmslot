// core/tmux-fields.ts — the field contract for every tmux `-F` query.
//
// This is a leaf module on purpose: it imports nothing. Tests that mock
// `core/exec.js` have to register the mock before the module under test is
// loaded, so a fixture reaching for the separator must not pull `core/tmux.js`
// and its exec import in through the front door.

/**
 * Field separator for every tmux `-F` query. A literal tab cannot be used: tmux
 * 3.4 escapes control characters in format output, so a tab-separated row
 * arrives there as a single field (3.3a and 3.7 pass the tab through), and
 * every parser that splits on the tab silently saw no rows. The separator is
 * printable, so it survives on every version, and multi-character, so it cannot
 * appear in a session name, window name, path or pane command.
 */
export const TMUX_FIELD_SEPARATOR = '<<FARMSLOT_TMUX_FIELD>>';

/** A `-F` format body: `tmuxFieldFormat('#{pane_id}', '#{pane_pid}')`. */
export function tmuxFieldFormat(...fields: string[]): string {
  return fields.join(TMUX_FIELD_SEPARATOR);
}

/**
 * The fields of one `-F` row. A separator inside the last value — a path or a
 * command is free-form — keeps that value whole instead of adding a field.
 */
export function splitTmuxFields(line: string, count: number): string[] {
  const parts = line.split(TMUX_FIELD_SEPARATOR);
  if (parts.length <= count) return parts;
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join(TMUX_FIELD_SEPARATOR)];
}
