// core/config.ts — extraction shim. The slot/pool/project config decision core
// moved to @farmslot/slot-config so the CLI's gateway-free `farmslot internal`
// verbs share the implementation. Existing gateway imports keep working.
export * from '@farmslot/slot-config';
