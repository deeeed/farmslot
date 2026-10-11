# Browser provider example

This reusable example implements the [project recipe contract](../../../reference/recipe-concepts.md) with the shared CDP transport and default engine. Keep it with the contract examples; it is also a starting point for a project's own provider.

Use an existing isolated browser page for an application you are authorized to control. The provider requires its exact CDP target ID and port, opens no browser, and disconnects each action's CDP session. Browser launch, installation and cleanup are unsupported. `--heal off` avoids trying to install an overlay for an externally managed browser.

From this repository, run:

```sh
farmslot recipe run docs/examples/projects/browser-example/browser-check.recipe.json \
  --projects-dir docs/examples/projects --project browser-example --target . \
  --cdp-port <port> --page-id <target-id> --heal off \
  'click_selector=a[href="#details"]' 'expected_url=https://example.test/#details'
```

Replace the selector and URL with a real navigation in your application. The recipe presses that control, reads and asserts the resulting URL, and retains a screenshot with the current step's HUD. It does not seed or alter application state through evaluation. Artifacts default to `temp/tasks` in the selected checkout.

`RECIPE_CDP_PAGE_ID` and `RECIPE_CDP_PORT` can supply the same operator-owned targeting values. Discovery and planning do not connect to the page. To inspect this declaration, run `farmslot doctor . --conformance --projects-dir docs/examples/projects --project browser-example --recipe docs/examples/projects/browser-example/browser-check.recipe.json --param click_selector='a[href="#details"]' --param expected_url='https://example.test/#details'`.
