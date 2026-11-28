import os from 'node:os';

const localHostname = os.hostname();

/** Mirrors bash is_local() for an execution host or machine. */
export function isLocal(host: string, machine: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    machine === localHostname ||
    host === `${localHostname}.local`
  );
}
