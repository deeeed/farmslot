# MetaMask tooling pack

Two projects for the MetaMask recipe tooling. Each slot edits its own tooling checkout:

| Project                      | Repository                                    | Slot short |
| ---------------------------- | --------------------------------------------- | ---------- |
| `metamask-harness-farm`      | `MetaMask/experimental-metamask-harness`      | `mmh`      |
| `metamask-recipe-perps-farm` | `MetaMask/experimental-metamask-recipe-perps` | `mmrp`     |

The lifecycle implementation (`scripts/tooling.sh`, `scripts/resolve-harness.mjs`, `setup/ios.sh`) has one copy, in `metamask-harness-farm`. `metamask-recipe-perps-farm` calls it through `{{farmslot_dir}}/projects/metamask-harness-farm/...`; source locks and node support follow that existing cross-project reference. Its own `setup/ios.sh` only delegates. Register both projects together.

## Trust boundary

The slot checkout is the code under test, so it never runs Farmslot lifecycle or task marking. The recipe provider comes from the published package at the pool's `MM_HARNESS_PACKAGE_ROOT`. The Perps library is pinned by revision at `METAMASK_PERPS_LIBRARY_ROOT`. Task initialization retains both. `scripts/resolve-harness.mjs` refuses a harness root inside the slot checkout.

Live proof runs outside the task checkout, so the templates pass every selection explicitly. `tooling.sh published` prints the published harness. `tooling.sh retained-library` verifies the task through the installed CLI (`task verify`) and prints the retained Perps copy from that receipt. Baselines run the published harness with `--library perps=<retained>`. The harness candidate runs `<slot>/bin/mm-harness` with the same retained library. The library candidate runs the published harness with `--library perps=<slot>`. Reports record both identities.

Templates use `{{OWNED_MOBILE_REPO}}`, a project var rendered from `{{mobile_repo}}`. It is the execution node's sibling path, with no gateway-local existence check. Slot repo paths must be absolute: `{{mobile_repo}}` derives from the pool's `repo` value and does not expand `~`.

## Mobile live-proof fixture

Slots are `ios` platform, so `project add` gives each one its own simulator (`<short>-<n>`) and Metro port. Each project declares `reference_repos.mobile`, which resolves to `<slot repo parent>/<local_name>`, a sibling checkout the slot owns. The local names differ (`mmh-mobile`, `mmrp-mobile`), so the projects never share a Mobile checkout. No hook falls back to a product farm slot. Slots of one project resolve the same sibling path, so the first slot to install dependencies, provision or boot a Mobile checkout records itself in `<mobile>/temp/recipe/runtime/farmslot-owner`. Any other slot is refused, and its teardown stops nothing. Keep one slot per project, or give each extra slot its own repo parent directory.

The `mobile-proof` runtime capability acquires that fixture only when proof needs it. It writes the slot's runtime context into the Mobile checkout, then launches through the published harness on the slot port and simulator. Release stops Metro and keeps the simulator, the dev client and the wallet fixture. Slot teardown stops Metro too, and does nothing when the Mobile checkout is absent.

Provision once per slot, after registration:

1. Clone `MetaMask/metamask-mobile` to the sibling path.
2. Provision the approved private Mobile runtime environment (`.js.env` and the other env files Mobile reads) into the owned checkout on the node. It stays node-local and never enters Git or the pack. The example env that Mobile's setup writes does not authorize the testnet RPC, so `launch --verify` refuses it.
3. Run the slot actions **Install owned Mobile dependencies** (with `MOBILE_NODE_BIN`: `yarn install --immutable` when the checkout has no install state, then Mobile's own `yarn setup:expo`, which builds nothing native) and **Install Mobile dev client** (the published harness's `provision runway ios`).
4. Fill `metamask-harness-farm/fixtures/runtime/wallet-fixture.json.sample` with the approved testnet wallet and save it on the node as `<owned Mobile checkout>/temp/recipe/private/wallet-fixture.json` (mode 600; Mobile ignores `temp/`). Private input never lives in pack sources, which may be read-only source locks.
5. Boot this slot's `dev-server` resource (owned Metro and dev client).
6. Run **Apply approved testnet wallet fixture** once. It refuses another slot's checkout, refuses unless the owned app is live (`doctor --expect-live`), then runs the published `fixtures init` and `fixtures set` against the running app. Acquire, reuse and review fixes never reseed the wallet.

## Checks and Node

The harness runs on Node 22, selected per process through `FARMSLOT_NODE22_BIN`. Machine defaults are unchanged. Dependencies install with `yarn install --immutable`. The repository uses Yarn's hardlinked global store, so nothing here edits an installed file. The recipe library has no dependency manifest.

`ci.local_check` freezes each repository's own CI commands for the `[DETERMINISTIC: ci.local_check]` mark. The library's composition checks run the real engine from the published harness.

## Pool environment

`MM_HARNESS_PACKAGE_ROOT`, `METAMASK_PERPS_LIBRARY_ROOT`, `FARMSLOT_NODE22_BIN` and `MOBILE_NODE_BIN` are already defined for the Mobile farm on mini and macpro.
