export type DiscoveryErrorCode =
  | 'ACTION_MANIFEST_INVALID'
  | 'DISCOVERY_NAME_AMBIGUOUS'
  | 'DISCOVERY_NOT_FOUND'
  | 'DISCOVERY_USAGE'
  | 'LIBRARY_REQUIREMENT_UNSATISFIED'
  | 'RECIPE_PLATFORM_REQUIRED';

/** A discovery failure with the next command the caller should run. */
export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;
  readonly userAction: string;

  constructor(code: DiscoveryErrorCode, message: string, userAction: string) {
    super(message);
    this.name = 'DiscoveryError';
    this.code = code;
    this.userAction = userAction;
  }
}
