# @farmslot/credential-store

Shared credential-store persistence and secret-verification primitives used by
the Farmslot gateway and CLI.

The package owns the `credentials.json`, `credentials.lock`, and
`gateways.live` file formats, their locking rules, and atomic writer. Gateway
authentication, authorization, RPC handlers, and CLI presentation remain in
their owning workspaces.

## Source layout

`src/credential-store.ts` owns the persisted schema and runtime; the remaining
modules own locking, one-way secrets, gateway presence, and mutations.

## Maintenance rules

- Keep stored secrets one-way (`scrypt`); never add a plaintext secret field to
  the persisted schema or exported summaries.
- Route mutations through `CredentialStoreWriter` so locking, activation, and
  last-admin rules stay consistent.
- Keep offline writers guarded by the live-gateway presence marker.
- Add protocol-facing types to `@farmslot/protocol`, not this implementation
  package.

## Local quality

Run `yarn quality` in this directory before changing the package.
