# Changelog

All notable changes to `@farmslot/slot-config` are tracked here.

## Unreleased

- feat(slot-config): expose `metro_port` as a slot resource and fail legacy hook expansion with a named migration hint when it is absent.
- fix(slot-config): `getProjectField` returns numbers and booleans instead of an empty string. Shell callers read project fields through `farmslot internal project-field` and fold the result into `${VAR:-<default>}`, so every numeric `project.json` value silently lost to a hardcoded default — `metamask-extension-farm` sets `timeouts.build_manifest_s: 600` and preflight used 180 for every build. Objects and arrays still return empty: they have no single shell value.
- feat: validate project execution-template sources, defaults, and domain environment.
- feat: template placeholder guard — `collectTemplatePlaceholders` / `collectPlaceholderTokens` / `knownTemplatePlaceholders` / `assertNoUnknownPlaceholders` / `expandTemplateWithReservedLast`; worker-facing render sinks fail hard on unexpandable `{{...}}` instead of shipping raw tokens to agents.
- fix: config values substituted verbatim (slot resource values, `paths.*`, project var values) are validated against `{{...}}` smuggling at load; the documented `{{runtime_dir}}/recipes` recipe_dir default now resolves in the loader.

- feat: `monitoring.flows` project config field — per-flow `total_timeout_min` / `stuck_timeout_min` overrides. Keys are restricted to the `FlowType` union (schema `propertyNames` enum + `Partial<Record<FlowType, …>>`) so a typo'd flow name fails validation instead of silently never matching.

- feat: `self_review.session_policy` project config field (`'fresh-per-pass' | 'warm-per-reviewer'`) — reviewer session lifecycle across one run's review loops (MANUAL-000009).
- feat: `computeFixturePlan` + `expandFixturePath` — fixture variant/include selection and compose/render loop ported from `sync-fixtures.sh`, shared with the gateway and `farmslot internal fixture-plan`. An unresolved `{{domain}}` in a fixture path stays literal so an unselected optional overlay skips quietly instead of resolving to a bogus `domains//…`.
- fix: `computeFixturePlan` rejects a fixture destination containing a tab or newline (`INVALID_FIXTURE_DST`) so it can't corrupt the tab-delimited copy manifest, and logs files it will copy as `[PLAN]` — the `[OK]` line is emitted by `sync-fixtures.sh` only after the copy lands, so a failed copy no longer leaves a log claiming success.
- fix: `loadProjectVars` distinguishes a genuinely-absent config (`ENOENT` → `Project config not found`) from a malformed/unreadable one (now surfaced as `Failed to read project config …`) instead of masking every read/parse failure as "not found", so callers can no longer silently treat corrupt config as missing.

## 0.1.0 - 2026-07-13

- feat: `session-usage.ts` — runner session discovery (claude/codex/grok), JSONL token aggregation, and model pricing ported from `scripts/session-usage.sh`'s python; consumed by the gateway and `farmslot internal session-usage`.
- feat: initial extraction of the slot/pool/project config + hook/template expansion decision core from `services/gateway/src/core/{config,hooks}.ts`, so the CLI (`farmslot internal …` verbs) and the gateway share one implementation that works without a running gateway.
