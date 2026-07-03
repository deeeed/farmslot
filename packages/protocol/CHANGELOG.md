# Changelog

All notable changes to `@farmslot/protocol` are tracked here.

## Unreleased

- Add interactive operator packet contracts, artifact discovery, and action request helpers.
- Add worker session history RPC and event contracts for read-only transcript snapshots and deltas.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.7.2 - 2026-07-03

- Rename the team overlay abstraction to "domain" (contracts, rpc, DOMAIN_NAME_RE/isValidDomainName) — clean break, no alias
- validateRecipeDocument / validateRecipeWithManifest accept an optional externalFlowIds set so call refs resolvable from configured recipe library sources are not reported as unresolved

## 0.7.1 - 2026-07-02

- Add GatewayReleaseNotes and optional gateway.status.releaseNotes for operator-facing gateway release notes

## 0.7.0 - 2026-06-30

- Add Gateway Doctor catalog/report fields plus section-scoped request parameters for progressive clients.

## 0.6.0 - 2026-06-02

- Define the v0 public package surface with explicit `contracts`, `rpc`, and `recipe` entry points.
- Refactor Recipe Protocol v1 validation into focused recipe owner modules and explicit public exports.
- Add export-boundary coverage for Recipe Protocol v1 validators.

## 0.5.0 - 2026-05-31

- Initial public active-development release.
