# Farmslot release process

Manual release cuts for operator-facing surfaces. Continuous merges still deploy hosted Command Center, but **version bumps and What's New notes** happen only when an operator runs the release tooling.

## Daily development

1. Change code in a workspace (`apps/command-center/ui`, `services/gateway`, `packages/protocol`, …).
2. Add a bullet under that workspace's `CHANGELOG.md` → `## Unreleased`.
3. Open a PR. CI runs `yarn quality:changelogs:pr` and requires a non-placeholder bullet when workspace code changed.

Placeholder lines (ignored by guards) mention "active-development baseline" or "add user-facing changes here".

## Should we cut a release?

```bash
yarn release:status
```

Or invoke the **`fs-release-cut`** agent skill for a succinct NO / SOON / YES signal and next commands.

## Release groups

| Group       | Workspaces                                                                                                        | Typical ship path                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `hosted-cc` | `command-center-ui`, `command-center`, `gateway`, `protocol`                                                      | Merge → GitHub Pages (`farmslot.io/cc`)                            |
| `companion` | `companion`                                                                                                       | EAS update / build via `apps/companion/scripts/release/release.sh` |
| `npm`       | `protocol`, `agent-runtime`, `recipe-runner`, `recipe-cli`, `adapter-sdk`, `adapter-node`, `adapter-rn`, `skills` | Manual `yarn npm publish` after strict checks                      |

## Cut workflow

### 1. Propose

```bash
yarn release:cut --group hosted-cc --assist
```

Writes `.release-cut/proposal.json` with `include`, `defer`, and `operatorSummary` per workspace. Every shipped changelog bullet is included by default; `operatorSummary` is the curated user-facing subset. Consolidate duplicates and tighten operator wording before executing the cut.

When both `hosted-cc` and `npm` need the shared protocol package, cut `hosted-cc` first. The npm cut refuses to consume protocol bullets while hosted workspaces are still pending.

### 2. Execute

```bash
yarn release:cut --group hosted-cc --from-proposal .release-cut/proposal.json --execute
```

Effects:

- Bumps `package.json` versions (patch by default; pass `--bump minor|major` to `--assist`)
- Moves included bullets verbatim into `## X.Y.Z - YYYY-MM-DD`
- Writes `release-notes.json` for UI surfaces
- Syncs `PROTOCOL_VERSION` when `packages/protocol` is in the group, and the protocol version line of `apps/docs/docs/reference/gateway-api.generated.md` with it (the changelog guard counts that file as release-only)

### 3. Commit

```bash
git add -A
git commit -m "chore(release): cut command-center-ui@0.1.1, gateway@0.1.1"
```

Open a PR. Release-only commits skip the PR changelog delta guard.

## What's New UI

| Surface        | Notes source                                                                  | Trigger                                                                 |
| -------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Command Center | `apps/command-center/ui/src/generated/release-notes.json` (build-time inject) | App version newer than `localStorage` `farmslot:whats-new-seen-version` |
| Companion      | `apps/companion/src/generated/release-notes.json`                             | Same pattern via AsyncStorage                                           |
| Gateway RPC    | `services/gateway/release-notes.json`                                         | `gateway.status.releaseNotes`                                           |

Gateway `releaseNotes` load at gateway process start — restart `farmdev` / `farmslot up` after a gateway release cut.

This is separate from the git **update banner** (`commitsBehind` → `farmslot update`).

## Gateway, CLI and node rollout

Deploy from the merged release commit in a dedicated worktree. Keep live gateway
and slot checkouts on their operator branches; never switch them to a release
branch. Merge any required installation fixes before installing the release.

1. Finish the hosted and npm cuts, run the package-readiness checks, and publish
   approved npm versions in [dependency order](package-publishing.md). Keep
   `workspace:*` in source manifests; packing writes the released dependency ranges.
2. Drain or finish native work before upgrading its execution host on the node.
   Upgrade the private CLI and execution nodes before restarting the gateway.
   From the release worktree, deploy each configured machine and instance:

   ```bash
   bash scripts/deploy-node.sh <machine> <gateway-host> --instance <dev|prod>
   ```

   Add `--refresh-cli` for the local machine. Remote deploys refresh the CLI
   automatically. The immutable CLI snapshot's `DEPLOYED-REVISION.json` must name
   the merged release SHA. Dev and prod share one CLI per machine, so deploy both
   from the same revision. Keep native-owner settings and credential-file inputs
   intact; node service and preflight checks must use the same environment roots.

3. A running host belongs to the node; restarting only the gateway does not upgrade it.
   Restart the gateway through its existing supervisor after all CLI/node
   upgrades, so it loads the new gateway version and release notes.
4. Using the deployment's configured CLI/profile, check `gateway.status` and
   `farmslot node status --json`: gateway version and release-note version must
   match the cut. For each dev/prod profile, `gatewayProtocolVersion` must equal
   the cut protocol, and every expected node must report that `protocolVersion`
   with `versionMatch: true`. A successful deploy's
   gateway-unreachable warning is not a successful RPC check.
5. Refresh downstream farm configurations only after the gateway and nodes can
   read their support bindings. Retain the previous CLI link and deployment
   revision until the RPC and review checks pass. Roll back the matching gateway,
   node and CLI cohort together if those checks fail; preserve credentials and
   run/task state.

## Companion EAS release

After a `companion` group cut:

```bash
bash apps/companion/scripts/release/release.sh --variant preview --execute
```

Use `--cut-release` to regenerate the companion proposal before update (dry-run by default).

## npm packages

After an `npm` group cut, run:

```bash
yarn packages:publish:check:strict
```

Then publish from each package directory. See [package-publishing.md](package-publishing.md).

## Commands reference

```bash
yarn release:status
yarn release:cut --group <id> --assist
yarn release:cut --group <id> --from-proposal .release-cut/proposal.json --execute
yarn quality:changelogs
yarn quality:changelogs:pr
```
