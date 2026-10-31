import { createContext } from 'react';

/**
 * True where the screen already says it is offline: under the connection banner, or by its own
 * "Offline". A read-status slot there adds nothing more.
 */
export const OfflineShown = createContext(false);
