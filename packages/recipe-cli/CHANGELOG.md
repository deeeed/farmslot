# Changelog

All notable changes to `@farmslot/recipe-cli` are tracked here.

## Unreleased

- Add the `farmslot-recipe` front door, moved from `@farmslot/recipe-harness`: `run` and `validate` as before, plus library-wide discovery with stable `--json` envelopes. `actions`, `list`, `describe`, `explain`, `search`, `template` and `completions` resolve every library on `RECIPE_LIBRARY_PATH` and `--library`, show precedence, shadows, namespaced `<library>.<ref>` ids and library digests, and work for a library with no platform adapter. Discovery and `run` resolve refs, platform aliases and ids identically; every failure prints the `--json` error envelope, and usage errors exit 2.
