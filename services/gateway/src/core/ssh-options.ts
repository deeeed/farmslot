// core/ssh-options.ts — connect options for every ssh, scp and rsync the gateway spawns.
//
// macOS ssh can fail outright on a host name whose first address does not
// answer (`ssh mini.local` resolving a link-local IPv6 address first:
// "connect to host mini.local port 22: Undefined error: 0") instead of trying
// the next one. With a ConnectTimeout it moves on to the IPv4 address (ledger
// F56). BatchMode makes a missing key fail at once instead of waiting on a
// prompt nobody sees.

/** argv form, for execFile/spawn of a non-interactive ssh or scp. */
export const SSH_CONNECT_OPTIONS: readonly string[] = [
  '-o',
  'ConnectTimeout=10',
  '-o',
  'BatchMode=yes',
];

/** argv form for an interactive session (`ssh -t`): bounded connect, prompts still allowed. */
export const SSH_INTERACTIVE_CONNECT_OPTIONS: readonly string[] = ['-o', 'ConnectTimeout=10'];

// Shell-string forms, for a command run through bash. Every word above is a
// fixed literal with no shell metacharacter or quote, so joining them is already
// quoted, and single quotes make the rsync remote shell one word.

/** Shell-string form of SSH_CONNECT_OPTIONS. */
export const SSH_CONNECT_SHELL_OPTIONS = SSH_CONNECT_OPTIONS.join(' ');

/** Shell-string form of SSH_INTERACTIVE_CONNECT_OPTIONS. */
export const SSH_INTERACTIVE_CONNECT_SHELL_OPTIONS = SSH_INTERACTIVE_CONNECT_OPTIONS.join(' ');

/** rsync's remote shell carrying the same options, as one shell word: `-e 'ssh …'`. */
export const RSYNC_SSH_SHELL_OPTION = `-e 'ssh ${SSH_CONNECT_SHELL_OPTIONS}'`;
