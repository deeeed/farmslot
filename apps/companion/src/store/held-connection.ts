import { createHeldConnection } from '../lib/held-connection';

import { useConnectionStore } from './connection';

/** Connected, or dropped for less than the shared grace: held data renders and acts silently. */
export const { isHeld: heldConnectionCurrent, useHeldConnection } =
  createHeldConnection(useConnectionStore);
