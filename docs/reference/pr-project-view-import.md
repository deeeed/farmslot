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

## Gateway accounts and farm setup

In Command Center, **Rules → Create team** offers an existing farm or a GitHub Project URL. Farm selection reads local `config.projects` metadata and fills the repository source and execution mapping. Filters, review defaults and manual source settings are collapsed until needed. Adding a farm does not scan GitHub.

GitHub accounts come from `config.githubAccounts`, which verifies the gateway machine's stored GitHub CLI accounts and returns identity metadata only. A sole account is read-only; multiple accounts are selectable. Add accounts with `gh auth login` on the gateway machine, then use **Refresh gateway accounts**. Credentials remain on the gateway. Inventory checks are cached and concurrent checks coalesce. New or changed account references use the same credential resolver as runtime reads; unchanged references can be edited during a credential outage.

Project import explicitly reads the Project/view and its field catalog. PR discovery occurs during rule preview and enabled scans. The dashboard pauses its timer while an editor is open or its browser tab is hidden.

The quota badge shows the lowest non-expired observed quota across independent credential/resource observations. A healthy REST response cannot overwrite a low GraphQL observation. After reset, an expired count is marked as awaiting an update. These are observations, not a spending ledger: other processes and machines may share the account budget.

The installed GitHub CLI 2.98.0 was verified to use GraphQL for `pr view`, `pr list`, and `pr checks`. Those reads obey the gateway's GraphQL reserve along with direct GraphQL queries. A quota-held dashboard refresh returns an error and retains the previous cache rather than publishing empty PR data. Other provider failures retain the existing per-PR fallback behavior.

## Monitoring without PR URLs

To monitor PRs without entering individual URLs, enable publication monitoring under **Project defaults** for new Farmslot publications, or create a team with an `author` filter and a rule with **Add PR monitor**. A separate team can exclude that author for teammate reviews. Project publication policies apply to publications after activation; they do not import older PRs or wait for `ci-watch` to finish.

Discovery and monitoring have separate intervals. A rule's discovery interval controls scans for matching PRs. **Check each PR every, minutes** sets the polling interval for newly created monitors; use `120` for two hours. Existing rules without this setting retain the five-minute monitor default. Existing monitors keep their own interval and lifecycle when a rule changes. Project publication policies expose the equivalent setting under **Monitoring limits and checks**.

Active runs temporarily suspend automated monitoring for the same PR. Command Center shows the owning run and slot, disables check/repair actions, and retains previous observations. Monitoring resumes on its configured schedule after all owning runs become terminal. A manual pause stays paused. This status is derived from gateway run ownership; it does not rewrite the saved monitoring lifecycle.

## PR workspace and configuration navigation

Command Center has three sections: **PRs**, **Reviews**, and **Automation**. The PR list combines gateway PRs, monitored PRs and review candidates by host/repository/number. **Monitored** filters this list; selecting a PR opens **Overview**, **Monitoring**, and **Review** tabs in the existing viewer. Monitoring controls apply only to that selection. Unassigned monitored and review PRs remain visible under machine filters. The list fills the workspace. Selecting a PR opens a right-side detail overlay; closing it or pressing Escape returns to the same list position. Selection follows browser history and survives reload. Mobile details use the available width with **Back to PR list**.

The selected PR’s **Review** tab also links to **Open review dispatch**, which prefills the manual review workflow. This can continue recorded legacy/manual review chains. Incremental scope requires a recorded reviewed commit; team-rule requests reuse only matching owner/profile history. Opening setup does not start a run.

Automation contains teams, rules, project defaults and notifications. Team and rule cards have explicit type labels; each rule shows its team, enabled state and actions. `prSection`, `prScope`, `prPane` and `prSort` preserve workspace navigation alongside repo-qualified PR selection. Earlier `prTab` links still open the corresponding section.

PR URLs retain the active tab, editor, saved configuration identity, history filter and board/list layout. Team and rule editors also keep unsaved values and expanded sections in browser-local drafts. The URL contains only an opaque draft ID, never the policy values or credentials. Drafts are scoped to the gateway connection and authenticated Farmslot principal; another browser or identity cannot recover the private draft from the URL alone. Save applies changes to the gateway and removes the local draft. Close keeps the draft available through browser history; Discard removes it.

Allowed slots and per-model restrictions use the shared slot-selector dialog, with search, grouping, and optional farm/machine filters. Other PR choices use the shared searchable choice picker rather than native selects. The shared examples are available at `#dev/slot-selector`, `#dev/choice-picker`, and `#dev/pr-execution`.

Review rows show GitHub's overall requirement separately from Farmslot run setup. “Reviews required” can coexist with an existing review from your account when other approvals are still needed. “Approved” means GitHub reports its requirements satisfied. Unknown status stays explicit until observed. Selecting a row checks that PR through the existing read-only rule preview; older rows missing observations load at most two lookups concurrently, and the explicit refresh button updates the selected PR. Checks do not launch reviews.

Review admission stops when GitHub's requirements are satisfied or the configured account already reviewed the current commit. A changed head with unmet requirements, or an explicit GitHub re-request, can make another review eligible. Eligibility still requires the normal rule, owner, execution and manual-start authorization. Clicking the selected row closes its detail panel.

**Review anyway** opens the existing manual review dispatch with the selected PR and project. It deliberately bypasses the review queue's “not needed” recommendation, while retaining normal dispatch authorization, slot/model selection and execution checks. The dispatch form defaults to a full review. Opening it does not start a run; automatic rules remain unchanged.
