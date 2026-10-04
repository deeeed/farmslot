# Hello recipe library

A minimal recipe library for trying `farmslot-recipe` discovery. It needs no app, device or
platform adapter.

```text
recipe-library.json                  platforms ["web"], requires @farmslot/recipe-runner
manifests/shared.action-manifest.json  command, assert_output (every platform)
manifests/web.action-manifest.json     hello.wave (web only, implemented by a web adapter)
recipes/greet.recipe.json              prints and checks a greeting
recipes/greet-twice.recipe.json        calls greet twice
recipes/web/greet.recipe.json          web variant of greet
```

```sh
export RECIPE_LIBRARY_PATH="hello=$PWD/examples/recipe-library-hello"
farmslot-recipe list
farmslot-recipe actions
farmslot-recipe describe greet
farmslot-recipe explain greet-twice --param guest=Ada
farmslot-recipe explain greet --platform web
```

Walkthrough: https://farmslot.io/docs/reference/recipe-discovery
