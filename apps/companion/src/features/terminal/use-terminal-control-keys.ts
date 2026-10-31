import { useCallback, useState } from 'react';

import type { TerminalControlKey } from '../../lib/terminal-controls';

/**
 * Key-bar presses for a terminal. Each press goes to the pane's input queue at once, in the order
 * pressed; a key still on its way never makes the bar ignore the next one. `send` reports its own
 * errors.
 */
export function useTerminalControlKeys(send: (control: TerminalControlKey) => Promise<void>) {
  const [inFlight, setInFlight] = useState<string[]>([]);
  const press = useCallback(
    (control: TerminalControlKey) => {
      setInFlight((labels) => [...labels, control.label]);
      const done = () =>
        setInFlight((labels) => {
          const at = labels.indexOf(control.label);
          return at < 0 ? labels : [...labels.slice(0, at), ...labels.slice(at + 1)];
        });
      send(control).then(done, done);
    },
    [send],
  );
  return { press, busy: inFlight.length > 0, activeLabel: inFlight[0] ?? null };
}
