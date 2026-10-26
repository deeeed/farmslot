import type { Methods } from '../rpc/registry.js';

import type { ResourceReadMethod } from './registry.js';

/** A gateway method outside the shared resource cache; command transports accept only these. */
export type CommandMethod = Exclude<(typeof Methods)[keyof typeof Methods], ResourceReadMethod>;
