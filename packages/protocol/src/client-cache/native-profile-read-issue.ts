import type { ResourceQueryError } from './types.js';

/** Picker presentation for the runner-configuration details on observed native profile errors. */
export function nativeProfileReadIssue(error: ResourceQueryError | undefined) {
  if (!error) return undefined;
  const { code, message } = error;
  if (code === 'NATIVE_PROFILES_UNAVAILABLE') {
    if (
      message ===
      'Native account profiles are refreshing for updated runner configuration. Retry shortly.'
    ) {
      return {
        kind: 'refreshing' as const,
        title: 'Refreshing runner configuration',
        detail: message,
        retryLabel: 'Check again',
      };
    }
    if (message.startsWith('Native account profiles failed to sync runner configuration: ')) {
      return {
        kind: 'retryable' as const,
        title: 'Could not sync runner configuration',
        detail: message,
        retryLabel: 'Check again',
      };
    }
    if (!message.startsWith('Native account profiles failed to resolve runner configuration: '))
      return undefined;
  } else if (
    !(
      (code === 'NATIVE_SOURCE_UNAVAILABLE' &&
        message === 'Execution node upgrade required for configured runner executables') ||
      (code === 'NATIVE_SESSION_ERROR' &&
        message === 'Execution node upgrade required for native account profiles')
    )
  ) {
    return undefined;
  }
  return {
    kind: 'blocked' as const,
    title: 'Runner configuration blocked',
    detail: message,
    retryLabel: 'Retry after fixing configuration',
  };
}
