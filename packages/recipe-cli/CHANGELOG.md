# Changelog

All notable changes to `@farmslot/recipe-cli` are tracked here.

## Unreleased

- Export `assessRecipe` so host CLIs can judge any resolved recipe, a qualified alias included, with the same readiness rule as `list`.

- `search` without `--platform` finds shadowed platform-only recipes by their `<library>.<ref>` id, listing each id once.

- Add the `farmslot-recipe` front door, moved from `@farmslot/recipe-harness`: `run` and `validate` as before, plus library-wide discovery with stable `--json` envelopes. `actions`, `list`, `describe`, `explain`, `search`, `template` and `completions` resolve every library on `RECIPE_LIBRARY_PATH` and `--library`, show precedence, shadows, namespaced `<library>.<ref>` ids and library digests, and work for a library with no platform adapter. Discovery and `run` resolve refs, platform aliases and ids identically; every failure prints the `--json` error envelope, and usage errors (malformed `--library` included) exit 2. `search` finds shadowed recipes by id, `explain --strict` exits 3 on gaps, and each command loads a library set once per platform.
