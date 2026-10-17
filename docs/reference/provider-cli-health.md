# Pinned provider CLI health

The machine pool owns installed provider selection through `env.*_PACKAGE_ROOT`. Each root must contain a package manifest with an exact name and version, and public `bin` entries unless it is a binary-free provider (below). Pools without provider roots require no provider check.

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

A root whose manifest declares no `bin` is a binary-free provider.

### Selection at resolution

Binding resolution takes the authoritative root from the first of these that applies:

1. The task's frozen provenance, when it runs inside a task that froze the provider at initialization.
2. The pool's `env` value, when a pool slot is selected.

It compares the inherited value of the binding's `recipe.provider.root.env` variable with that root. Both are compared as real paths. If both exist and differ, resolution MUST refuse with `PROVIDER_SELECTION_CONFLICT` before importing any provider. Worker launches export the pool value current at dispatch. After a rollout, such a worker still matches its task's frozen root, so in-flight tasks are unaffected. The refusal reports the variable, both paths and the action: unset the variable, or select the root in the pool. An absent or equal inherited value is accepted. Without a task or pool selection, the existing precedence still applies. The rule lives in the shared resolver, so it covers commands started by the gateway, node exec, tmux panes and shells alike.

### Health probe

The probe replaces the PATH binary check with these checks, in order:

1. **Package.** `package.json` declares an exact name and version, as above.
2. **Modules.** In a child Node process, with the probe environment and the 5-second command deadline, call `resolveBindingProvider` from `@farmslot/recipe-cli/harness`, loaded from the node's installed CLI. It resolves the registry and each binding exactly as `farmslot` does, so the probe passes no registry or resolution rules of its own. For each binding whose `recipe.provider.root.env` names this pool variable, the provider module must resolve inside the root and import, and the binding's export (default `createProvider`) must be a function. With no matching binding, the module check is skipped, and the global-install check still applies.
3. **Global installs.** In the node exec environment and in the non-interactive, login and interactive shells, wherever `npm` is on PATH, `<npm root -g>/<package>` must not exist. If it does, that is a `version-mismatch` with reason `<scope> global install: <path>`.

Child probe environments drop inherited `*_BIN` and `*_PACKAGE_ROOT` selectors before executing anything. Load failures, unresolved modules and contained-path violations are `probe-error`. Deadlines are `probe-timeout`, handled as above.

Diagnostics add `modules: [{ ref, path, ok, reason? }]`. `binaries` stays empty for this form. A confirmed mismatch is retained in `confirmedMismatch` until requalification or a changed pool selection, as for binaries.

### Rollout without binaries

For a binary-free provider, `scripts/rollout-provider.mjs`:

1. installs the exact version into its immutable versioned root and runs the module check against it;
2. selects that root in the operator and node pool copies;
3. removes the package's global installation under each node's `--prefix` with `npm uninstall --global <package>`, after the reference check above: no active run, retained gate or live process may still use it. If any reference remains, the rollout stops before uninstalling and reports them;
4. runs the shared probe on every node, then waits up to 120 seconds for each node's own `node.health` diagnostics for the new root to report `verified`. Any other status, `probe-timeout` included, fails the rollout.

The final check replaces `<public-bin> --version`. On each node, for each binding that names the pool variable and has a slot in that node's pool, run `farmslot doctor --project <project> --target <that slot's checkout> --json` over plain non-interactive SSH, adding the slot's `--adapter` where the project declares several runtimes. Invoke the node's installed CLI, `$FARMSLOT_CLI` or the standard installer's `~/.local/bin/farmslot`, never a bare PATH lookup. Add or remove no selectors, so the result shows what an SSH caller gets; a stale selector refuses with `PROVIDER_SELECTION_CONFLICT` and fails the check. Only the `provider` fields decide it otherwise: `provider.version` and the real path of `provider.root` must equal the pin, even when doctor exits non-zero for an unrelated readiness failure. Installation-mode `farmslot doctor` without a project reports no provider and cannot be used. Retention and pruning rules are unchanged.
