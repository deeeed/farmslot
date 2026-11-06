import * as runtimeModule from 'node:module';

export function requireRecoveryFaultSupport() {
  if (typeof runtimeModule.registerHooks !== 'function')
    throw new Error(
      'Recovery matrix requires node:module.registerHooks, available in Node 22.15+; upgrade Node before starting the isolated stack.',
    );
}
