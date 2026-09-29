# Runner model preferences

In a runner picker, choose **Other models** to load that runner's catalog. Select
a model name to use it for the current request. Check models and choose **Save
visible models** to change the shortcut list.

Choose **Use selected as default** to save a default for that runner. **Reset to
built-in default** removes the override. Defaults apply to fresh selections and
untouched new Dispatch and Evals forms. Existing runs, restored drafts, explicit
project workflow models, and the current selection are not rewritten by saving
or resetting a default. The default remains selectable even when hidden from
the shortcut list.

Preferences belong to the authenticated principal on the connected gateway.
They are stored below `FARMSLOT_HOME/runner-preferences/`; switching credentials
or gateways does not reuse another principal's preferences. These preference
and catalog RPCs currently require admin access.

Shared project-workflow and PR-rule editors can browse catalogs, but do not apply
or edit personal defaults and shortcut preferences. Their saved configuration is
shared rather than owned by the current operator.

Discovery is a runner capability, queried on the gateway host:

| Runner | Source                                                               |
| ------ | -------------------------------------------------------------------- |
| Cursor | `cursor-agent --list-models`, with a bounded timeout and output size |
| Codex  | `.codex/models_cache.json` under the gateway user's home             |
| Grok   | `.grok/models_cache.json` under the gateway user's home              |
| Pi     | `.pi/agent/models-store.json` under the gateway user's home          |
| Claude | No catalog source declared; the picker reports unsupported           |

The Cursor catalog uses the gateway host's configured `cursor_path` when present,
otherwise `cursor-agent` from its PATH. Remote slots can use a different binary;
their launch configuration is not changed by browsing this catalog.

Catalogs can differ by installed runner version, account and host. An unavailable
catalog is not an empty list of supported models. **Custom model ID** remains an
escape hatch; launch validation still applies. Discovery never starts a prompt
or parses an interactive terminal session.

The RPCs are `runner.modelCatalog`, `runner.visibleModels.get`, and
`runner.visibleModels.set`. The set call accepts `models`, `defaultModel`, or
both. Omitting a field preserves it; `defaultModel: null` resets only the default.

Evals encodes candidate choices in its URL. Reloading a saved Evals URL restores
those choices rather than replacing them with a newer default. Open `#evals`
without a saved state to start from the current default.

If a preference file is invalid JSON, the gateway reports `INVALID_STATE` instead
of discarding preferences. Back up the affected principal's
`runner-visible-models.json`, then repair it or remove that file to restore the
built-in preferences. Other principals' files do not need to change.

Runner-validation scripts may intentionally pin a model for reproducible transport
checks. Such explicit test selections are not application defaults and do not
change when an operator saves a preference.
