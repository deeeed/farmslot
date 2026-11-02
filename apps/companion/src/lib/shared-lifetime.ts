/**
 * A process-wide service that every mounted app root holds. React Native can mount a second root
 * in the same JS runtime before the first one unmounts, as when a package update relaunches the
 * activity over itself. The service starts with the first holder and stops after the last one
 * releases, so the departing root cannot stop it under the root that stays.
 */
export function sharedLifetime(start: () => () => void): () => () => void {
  let holders = 0;
  let stop: (() => void) | undefined;
  return () => {
    // A start that throws holds nothing, so the next holder starts the service again.
    if (holders === 0) stop = start();
    holders += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      holders -= 1;
      if (holders > 0) return;
      const stopping = stop;
      stop = undefined;
      stopping?.();
    };
  };
}
