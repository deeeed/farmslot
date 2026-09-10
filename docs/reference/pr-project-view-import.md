# Project/view import

Implementation reference for [ADR-055](../adr/055-persistent-pr-monitoring-and-review-intake.md). The feature is under validation; successful live Project import is not yet established.

In Command Center, open **PRs → Rules → Create team**, select the GitHub account and import an HTTPS Project or saved-view URL. The account needs repository read access and `read:project`. Import reads metadata without saving a team, enrolling monitors or starting work.

The imported source retains Project membership and the original saved-view filter. Archived Project items and non-PR items are excluded. A repository added separately is an independent source, so it can include PRs outside the imported view.

Supported automatic filter mappings:

| Filter                                          | Mapping                                         |
| ----------------------------------------------- | ----------------------------------------------- |
| `is:pr`, `is:issue`                             | Include or exclude PR-backed items              |
| `is:open`, `is:closed`, `is:merged`, `is:draft` | Provider state; closed includes merged PRs      |
| `repo:owner/repo`                               | Exact repository identity                       |
| `label:bug,support`                             | Any listed label                                |
| Single-select field values                      | Provider option IDs                             |
| Number fields                                   | Equality, `>` and `<`                           |
| Date fields                                     | Literal `YYYY-MM-DD` equality                   |
| `has:field`, `no:field`                         | Field presence; labels use non-empty membership |

Separate terms use AND; comma-separated values use OR; a leading `-` negates a term. Double-quoted values may contain spaces and commas. [GitHub's filter documentation](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/filtering-projects) describes provider syntax.

Single quotes, grouped expressions, text search, relative dates, numeric ranges, inclusive comparisons and unrecognized qualifiers require explicit mapping. Each unresolved term stays visible and blocks activation. Use **Map term** to choose its typed predicate; the original text remains attached for review. Missing permissions and deleted or incompatible field/option bindings remain errors, not empty successful matches.

Field and option renames preserve ID bindings. **Refresh field names** reloads the catalog without changing filters. Re-import the saved view to use later filter edits, then preview and explicitly enable or backfill the rule.
