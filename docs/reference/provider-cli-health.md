# Pinned provider CLI health

The machine pool owns installed provider selection through `env.*_PACKAGE_ROOT`. Each root must contain a package manifest with an exact name, version and public `bin` entries. Pools without provider roots require no provider check.

Every public binary must report that version from every executable match on the node service PATH, login PATH, interactive PATH and non-interactive PATH. The non-interactive shell starts with the operating system default path, as an SSH command does. Provider selection environment overrides must be absent from probes so an obsolete executable cannot delegate to the pin and mask drift. Missing commands, a failed probe or a mismatching version are failures.

The node refreshes in the background without delaying gauge events, shares one in-flight sample and caches it for at most 60 seconds. A pool change invalidates it. Diagnostics travel with the existing metrics subscription into `MachineHealth.providerCliHealth`. A confirmed version mismatch or probe error marks node headroom red. A `probe-timeout` remains unverified with `ok: false`, reports "Probe timed out under load" when the one-minute load exceeds available CPU parallelism, and is a yellow warning unless system gauges are already red. It never implies a version mismatch. A previously measured mismatch is retained separately in `confirmedMismatch` and remains critical until successful requalification or a changed pool selection. These states appear in fleet status and resource pressure concerns. Version commands keep their 5-second deadline and shell startup keeps 30 seconds. After a timeout, the node waits until one-minute load falls below half the recorded timeout load or below available CPU parallelism, then retries once. A failed retry remains visible without repeated launches for that unchanged pool selection. A successful retry resumes the normal sampling cadence. This check grants no cleanup, run or slot authority.

## Rollout

Install and verify immutable versioned roots first, then select the same root in the operator and node pool copies. On each node, the rollout runs `npm install --global <package>@<exact-version>` and the shared PATH probe. It succeeds only when every node passes. The operator entry is:

```sh
node --import tsx scripts/rollout-provider.mjs --pool <machine-pool.json> --prefix <npm-global-prefix>
```

Run a final unqualified `<public-bin> --version` over non-interactive SSH with provider selection overrides unset. Do not claim success from a root-qualified binary alone. Global npm installs serve ordinary PATH callers; versioned provider roots serve frozen run pinning. Never alter frozen run inputs to make the versions agree.

Keep the current and immediately previous versioned provider, plus versions referenced by active runs, retained gates or live processes. Recheck references before pruning. Dotfile PATH entries are operator-owned and require an announced change.

## Public surface

`node.health`, `node.health.all` and `fleet.status` retain their existing RPCs. `@farmslot/protocol` adds optional provider diagnostics to node samples and machine health. Existing nodes may omit the field. `@farmslot/slot-config` owns the shared probe and exact global installation helper; the node and rollout script are its consumers. No new provider schema or harness flags are required.

## Providers without public binaries (ADR-015 Amendment 8)

Status: Proposed by [ADR-015 Amendment 8](../adr/015-resource-streams.md#amendment-8-provider-packages-without-public-binaries-2026-10-17).

A root whose manifest declares no `bin` is a binary-free provider. Its probe replaces the PATH binary check with these checks, in order:

1. **Package.** `package.json` declares an exact name and version, as above.
2. **Modules.** Read the registered projects from the pool's `env.FARMSLOT_PROJECTS_DIR`, or the node's configured registry when that is unset. For each binding whose `recipe.provider.root.env` names this pool variable, resolve `recipe.provider.module` through the root's `exports`. The target must stay inside the root. Then import it in a child Node process with the probe environment and the 5-second command deadline, and require the binding's export (default `createProvider`) to be a function. With no matching binding, only the package check applies.
3. **Selectors.** In the node, non-interactive, login and interactive scopes, read the pool variable from the same marker-delimited shell output used for PATH. It must be absent or resolve to the root's real path. A different value is a `version-mismatch` with reason `<scope> <VAR>: <value>, expected <root>`.
4. **Global installs.** In each scope where `npm` is on PATH, `<npm root -g>/<package>` must not exist. If it does, that is a `version-mismatch` with reason `<scope> global install: <path>`.

Probe environments still drop inherited `*_BIN` and `*_PACKAGE_ROOT` selectors before executing anything. Step 3 reads each shell's own startup result, never the node's inherited value. Load failures, unresolved modules and contained-path violations are `probe-error`. Deadlines are `probe-timeout`, handled as above.

Diagnostics add `modules: [{ ref, path, ok, reason? }]` and `selectors: [{ scope, name, value? }]`. `binaries` stays empty for this form. A confirmed mismatch is retained in `confirmedMismatch` until requalification or a changed pool selection, as for binaries.

### Rollout without binaries

For a binary-free provider, `scripts/rollout-provider.mjs`:

1. installs the exact version into its immutable versioned root and runs the module check against it;
2. selects that root in the operator and node pool copies;
3. runs `npm uninstall --global <package>` under each node's `--prefix`;
4. runs the shared probe on every node, and succeeds only when every node passes.

The final non-interactive SSH check runs `farmslot doctor --json` with provider selectors unset and compares `provider.version` with the pin, in place of `<public-bin> --version`. Retention and pruning rules are unchanged.
