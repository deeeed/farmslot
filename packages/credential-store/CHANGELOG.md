# Changelog

All notable changes to `@farmslot/credential-store` are tracked here.

## Unreleased

- fix(auth): reclaim stale gateway-presence records safely when a later gateway reuses the same PID, root, and port.
- fix(auth): distinguish deliberate credential-store refusals, including live lock/presence contention, from unexpected infrastructure failures at RPC boundaries.
- feat(auth): add the shared locked credential store, secret hashing, offline writer, and identity-domain gateway presence coordination.
