# Changelog

All notable changes to `@farmslot/credential-store` are tracked here.

## Unreleased

- fix(auth): a credential store that is not valid JSON fails with `Unable to load credential store <path>: not valid JSON` instead of the parse message, which quoted part of the file.

- Bind native execution nodes to an immutable owner through the locked credential store, validating owner references and machine assignments.

- fix(auth): reclaim stale gateway-presence records safely when a later gateway reuses the same PID, root, and port.
- fix(auth): distinguish deliberate credential-store refusals from unexpected infrastructure failures at RPC boundaries, and keep live lock-holder PIDs in internal diagnostics while returning sanitized retry guidance.
- feat(auth): add the shared locked credential store, secret hashing, offline writer, and identity-domain gateway presence coordination.
