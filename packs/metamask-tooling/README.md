# MetaMask tooling pack

Two projects for the MetaMask recipe tooling. Each slot edits its own tooling checkout:

| Project                      | Repository                                    | Slot short |
| ---------------------------- | --------------------------------------------- | ---------- |
| `metamask-harness-farm`      | `MetaMask/experimental-metamask-harness`      | `mmh`      |
| `metamask-recipe-perps-farm` | `MetaMask/experimental-metamask-recipe-perps` | `mmrp`     |

## Trust boundary

The slot checkout is the code under test, so it never runs Farmslot lifecycle or task marking. The recipe provider comes from the published package at the pool's `MM_HARNESS_PACKAGE_ROOT`. The Perps library is pinned by revision at `METAMASK_PERPS_LIBRARY_ROOT`. Task initialization retains both. `scripts/resolve-harness.mjs` refuses a harness root inside the slot checkout.

After-fix proof selects the candidate explicitly. The harness project runs `<slot>/bin/mm-harness`. The recipe library project passes `--library perps=<slot>` to the published harness. Reports record the candidate identity and the source head.

## Mobile live-proof fixture

Slots are `ios` platform, so `project add` gives each one its own simulator (`<short>-<n>`) and Metro port. Each project declares `reference_repos.mobile`, which resolves to `<slot repo parent>/<local_name>`, a sibling checkout the slot owns. The local names differ (`mmh-mobile`, `mmrp-mobile`), so the projects never share a Mobile checkout. No hook falls back to a product farm slot. Slots of one project resolve the same sibling path, so the first slot to provision or boot a Mobile checkout records itself in `<mobile>/temp/recipe/runtime/farmslot-owner`. Any other slot is refused, and its teardown stops nothing. Keep one slot per project, or give each extra slot its own repo parent directory.

The `mobile-proof` runtime capability acquires that fixture only when proof needs it. It writes the slot's runtime context into the Mobile checkout, then launches through the published harness on the slot port and simulator. Release stops Metro and keeps the simulator, the dev client and the wallet fixture. Slot teardown stops Metro too, and does nothing when the Mobile checkout is absent.

Provision once per slot, after registration:

1. Clone `MetaMask/metamask-mobile` to the sibling path.
2. Run the slot actions: **Install owned Mobile dependencies** (Mobile's own `yarn setup:expo`, with `MOBILE_NODE_BIN`), then **Install Mobile dev client** (the published harness's `provision runway ios`).
3. Copy `fixtures/runtime/wallet-fixture.json.sample` to `wallet-fixture.json` in the registered project. Fill in the approved testnet wallet and run **Apply approved testnet wallet fixture**. The pack's `.gitignore` keeps the filled file out of the pack, and `project add` preserves it.

## Checks and Node

The harness runs on Node 22, selected per process through `FARMSLOT_NODE22_BIN`. Machine defaults are unchanged. Dependencies install with `yarn install --immutable`. The repository uses Yarn's hardlinked global store, so nothing here edits an installed file. The recipe library has no dependency manifest.

`ci.local_check` freezes each repository's own CI commands for the `[DETERMINISTIC: ci.local_check]` mark. The library's composition checks run the real engine from the published harness.

## Pool environment

`MM_HARNESS_PACKAGE_ROOT`, `METAMASK_PERPS_LIBRARY_ROOT`, `FARMSLOT_NODE22_BIN` and `MOBILE_NODE_BIN` are already defined for the Mobile farm on mini and macpro.
