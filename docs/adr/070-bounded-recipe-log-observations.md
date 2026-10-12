# ADR-070: Bounded recipe log observations

**Status:** Accepted
**Date:** 2026-10-12
**Owner:** Recipe runtime maintainers
**Scope:** Optional observation window for the existing `watch_logs` action
**Specification:** [Recipe log observations](../reference/recipe-log-observations.md)
**Related:** [ADR-034](034-recipe-protocol-v1.md)

## Context

`watch_logs` reads once. Asynchronous application output arriving just after that read fails the assertion. Its manifests reject a timeout parameter, so adding a waiting window changes the public action contract.

## Decision

Add optional `timeout_ms` to `watch_logs`. Omission or zero preserves the existing immediate check. A positive value up to 60000 ms permits read-only polling for the authored `contains` condition at 100 ms intervals, shortened by the remaining budget. Preserve path containment, run/file scope, cancellation, output shape and failure classification. The action never launches or repairs its producer.

The protocol owns input relationships; the shared runner owns resolved-invocation preflight, initial file offsets and polling. Run-scoped paths must resolve from inputs before producers execute. Output-derived paths require explicit file scope. Project providers declare the option and pin supporting protocol/runner releases. Existing project lifecycle callbacks remain unchanged.

## Public surface

Recipes and `farmslot recipe call watch_logs` consume the optional parameter through the existing action catalog. `@farmslot/recipe-runner` owns execution; no SDK export or CLI flag is added. The optional window is a backward-compatible action extension requiring a supporting runtime dependency. Rejecting output-derived run-scoped paths corrects a stale-content false pass and is a breaking correction. MetaMask's Core, Mobile, Extension and web-dapp manifests are the first consumers. Terminal inherits the MetaMask web-dapp catalog; its own library adds domain actions. These catalogs and dependent package pins must move together.

## Validation

Prove delayed append and file creation, immediate checks, timeout, cancellation, scope isolation and preflight rejection. Use a real filesystem producer and public CLI execution. Keep unit cases below five seconds.
