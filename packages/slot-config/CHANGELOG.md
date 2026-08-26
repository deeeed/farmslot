# Changelog

All notable changes to `@farmslot/slot-config` are tracked here.

## Unreleased

- fix(session-usage): the local sampler's failure path keeps the transcript identity it is counting instead of stamping the requested path onto a prior offset.
- fix(session-usage): a codex `token_count` record carrying only `last_token_usage` is skipped instead of folded. It reports one turn rather than the session, so folding it overwrote the reference and charged the next record the whole way back up to the session total.
- feat(session-usage): `pinnedIncrementalSessionUsageState()` starts counting at a byte offset mid-transcript. An absent `lastCumulative` marks that the next session-total reading only establishes the reference, so runners that restate totals are counted as increments from the pin instead of restating someone else's history.
- fix(session-usage): a record larger than the bounded read window widens the read once (up to 16MiB) so its usage is still counted; only records beyond that are skipped, counted in `skippedOversizedRecords`, and no longer raise a permanent integrity failure that disabled accounting for the rest of a run.
- fix(dispatch): expand `{task_prompt}` with a replacement callback so `$`, `$'`, and `$&` in the prompt stay literal.
- feat(ci): allow projects to opt in to worker-report comments and internal metrics in formal review comments; both remain disabled by default.
- perf(resources): allow project resource watches to declare a typed shared-poll provider and provider lookup target while retaining the legacy command fallback.
- feat(runtime-capabilities): validate and normalize `prepare.core`, explicit compatibility profiles, and project-owned capability provider graphs with typed action references, costs, sharing, and dependencies.

- feat(session-usage): runner-neutral incremental complete-line sampling with 1MiB reads, split-write preservation, and explicit integrity failure for oversized records (MANUAL-000096).

- feat(monitoring): per-flow `max_turns` / `max_total_tokens` soft budgets on `monitoring.flows.*` (MANUAL-000096).

- docs(config): the `self_review.session_policy` schema comment names `warm-per-reviewer` as the default.

- feat(config): `loadMachineSlots(machine)` lists a machine's pool slots from the same pool dir as every other lookup, failing closed on a missing machine (MANUAL-000085).
- feat(resources): `vite_port` joins the optional dev-server resource placeholders (`{{vite_port}}`) for sandbox UI port provisioning (MANUAL-000085).

- feat(review): allow projects to declare fixture-backed static review instruction files that are frozen into review tasks without prepare.
- fix(dispatch): attach runtime-owned runner arguments through the selected runner-path placeholder so trailing shell commands cannot consume them.
- fix(monitoring): validate per-flow timeout overrides and allow non-Metro slots to omit `metro_port` unless a selected hook actually references it.
- fix(dispatch): an unset effort drops the whole `--effort {effort}` flag from dispatch templates instead of leaving a bare `--effort` that swallows the next argument.
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
