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

A root whose manifest declares no `bin` is a binary-free provider. Its probe replaces the PATH binary check with these checks, in order:

1. **Package.** `package.json` declares an exact name and version, as above.
2. **Modules.** Use the registry the node's CLI resolves, through the CLI's own registry function rather than a restatement of its fallback order. For each binding whose `recipe.provider.root.env` names this pool variable, resolve and import `recipe.provider.module` in a child Node process, with the probe environment and the 5-second command deadline. Resolution MUST use a checkout-free provider resolver exported from `@farmslot/recipe-cli/harness` (`resolveBindingProvider`), loaded from the node's installed CLI. It shares the code `farmslot` uses for the same binding and is not a second implementation. The target must stay inside the root, and the binding's export (default `createProvider`) must be a function. With no matching binding, the module check is skipped; the selector and global-install checks still apply.
3. **Selectors.** Read the pool variable in each place Farmslot starts a command that can resolve a provider:
   - **gateway:** for a machine whose slots the gateway executes locally, the gateway's own process environment. The gateway checks it against that machine's pool selection and merges the result into that machine's `providerCliHealth`;
   - **node exec:** the environment shell-mode node exec passes to commands: the node process environment merged with its login capture, which lasts for the node's lifetime. Build it with the same shared helper exec uses, not a copy;
   - **tmux:** the tmux server's global environment, which worker panes inherit. Check for a server with `list-sessions` under the Amendment 7 client deadline and skip the scope when none is running. Otherwise read the unnamed `tmux show-environment -g` listing and look up the variable. A missing or removed (`-VAR`) entry is absent;
   - **shells:** the non-interactive, login and interactive shells, from the same marker-delimited startup output used for PATH.

   In each scope the variable must be absent or resolve to the root's real path. A process value overrides `pool.env` when `farmslot` resolves a binding.

4. **Global installs.** In each scope where `npm` is on PATH, `<npm root -g>/<package>` must not exist. If it does, that is a `version-mismatch` with reason `<scope> global install: <path>`.

Step 3 reads the gateway, node exec and tmux values before any sanitizing. Child probe environments still drop inherited `*_BIN` and `*_PACKAGE_ROOT` selectors before executing anything, so each shell reports only what its own startup sets. Load failures, unresolved modules and contained-path violations are `probe-error`. Deadlines are `probe-timeout`, handled as above.

Diagnostics add `modules: [{ ref, path, ok, reason? }]` and `selectors: [{ scope, name, value? }]`, where `scope` is `gateway`, `node-exec`, `tmux`, `non-interactive`, `login` or `interactive`. `binaries` stays empty for this form. A confirmed mismatch is retained in `confirmedMismatch` until requalification or a changed pool selection, as for binaries.

### Rollout without binaries

For a binary-free provider, `scripts/rollout-provider.mjs`:

1. installs the exact version into its immutable versioned root and runs the module check against it;
2. selects that root in the operator and node pool copies;
3. removes the package's global installation under each node's `--prefix` with `npm uninstall --global <package>`, after the reference check above: no active run, retained gate or live process may still use it. If any reference remains, the rollout stops before uninstalling and reports them;
4. runs the shared probe on every node, then waits up to 120 seconds, two sampling intervals after the pool change invalidates the cache, for each node's own `node.health` diagnostics for the new root to report `verified`. Only the node and gateway see the gateway, node exec and tmux scopes. Any other status, `probe-timeout` included, fails the rollout.

The final check replaces `<public-bin> --version`. On each node, for each binding that names the pool variable and has a slot in that node's pool, run `farmslot doctor --project <project> --target <that slot's checkout> --json` over plain non-interactive SSH, adding the slot's `--adapter` where the project declares several runtimes. Invoke the node's installed CLI, `$FARMSLOT_CLI` or the standard installer's `~/.local/bin/farmslot`, never a bare PATH lookup. Add or remove no selectors, so the result shows what an SSH caller gets. Only the `provider` fields decide the check: `provider.version` and the real path of `provider.root` must equal the pin, even when doctor exits non-zero for an unrelated readiness failure. Installation-mode `farmslot doctor` without a project reports no provider and cannot be used. Retention and pruning rules are unchanged.
