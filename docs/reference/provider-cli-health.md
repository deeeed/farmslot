# Pinned provider CLI health

The machine pool owns installed provider selection through `env.*_PACKAGE_ROOT`. Each root must contain a package manifest with an exact name, version and public `bin` entries. Pools without provider roots require no provider check.

Every public binary must report that version from every executable match on the node service PATH, login PATH, interactive PATH and non-interactive PATH. The non-interactive shell starts with the operating system default path, as an SSH command does. Provider selection environment overrides must be absent from probes so an obsolete executable cannot delegate to the pin and mask drift. Missing commands, a failed probe or a mismatching version are failures.

The node refreshes in the background without delaying gauge events, shares one in-flight sample and caches it for at most 60 seconds. A pool change invalidates it. Diagnostics travel with the existing metrics subscription into `MachineHealth.providerCliHealth`. A failure marks node headroom red and appears in fleet status and resource pressure concerns. This check grants no cleanup, run or slot authority.

## Rollout

Install and verify immutable versioned roots first, then select the same root in the operator and node pool copies. On each node, the rollout runs `npm install --global <package>@<exact-version>` and the shared PATH probe. It succeeds only when every node passes. The operator entry is:

```sh
node --import tsx scripts/rollout-provider.mjs --pool <machine-pool.json> --prefix <npm-global-prefix>
```

Run a final unqualified `<public-bin> --version` over non-interactive SSH with provider selection overrides unset. Do not claim success from a root-qualified binary alone. Global npm installs serve ordinary PATH callers; versioned provider roots serve frozen run pinning. Never alter frozen run inputs to make the versions agree.

Keep the current and immediately previous versioned provider, plus versions referenced by active runs, retained gates or live processes. Recheck references before pruning. Dotfile PATH entries are operator-owned and require an announced change.

## Public surface

`node.health`, `node.health.all` and `fleet.status` retain their existing RPCs. `@farmslot/protocol` adds optional provider diagnostics to node samples and machine health. Existing nodes may omit the field. `@farmslot/slot-config` owns the shared probe and exact global installation helper; the node and rollout script are its consumers. No new provider schema or harness flags are required.
