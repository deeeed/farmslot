# Siteed website pack

A plain Next.js website, with no extension or wallet runtime. This pack uses the existing `@farmslot/adapter-web` browser ownership, CDP actions and recording path. It requires the release containing the `plain-web` export, planned as 0.18.0.

Preparation installs website dependencies and the isolated recipe dependency, then starts Next.js on the assigned application port and prints its local URL. Provider code and recipes are kept separately from installed dependencies so conformance fingerprints contain authored files. The slot's existing second dev-server port is used as its browser/CDP port; no new ports are guessed.

`web-browser` depends on `web-server`. Browser release stops only the checkout's owned profile; the sandbox server stays up for local preview until explicit slot teardown. Worker templates require planned acceptance recipes, baseline failures for new behavior, screenshots, full-run video and retained coverage. Workers do not install their own harness or deploy.

The bundled `smoke` follows the website's actual Home and Projects navigation. A smoke pass establishes website readiness, not acceptance of every future change. Author task recipes for changed behavior.

For development validation before the runtime release, `SITEED_WEB_ADAPTER_TARBALL` selects an explicit local packed candidate during prepare. Normal workers never set it. Record the candidate digest and source head with evidence; an unpublished candidate is not a registry release.

## Add another web project

1. Copy this pack, rename its pack/project IDs and directory, and update `repo_url`, hook paths and `node_support` paths.
2. Change `fixtures/recipe-provider/web-project.json`: set the server label, install argv and server argv. `{{port}}` and `{{repo}}` expand from the selected checkout. Use an empty install array for a static site.
3. Keep the thin provider bridge. It selects assigned application/CDP ports and configures `createPlainWebAdapter`; application commands and selectors belong in the pack.
4. Replace the smoke recipe's controls, expected content and claims with the new site's behavior. Keep the action manifest and proof nodes aligned.
5. Register the pack and prepare its slot. Check the reported sandbox URL, then run `farmslot doctor <checkout> --project <project> --conformance`.
6. Run the recipe with full-run video into a fresh artifact directory. Inspect screenshots and video, check a contrary-state failure, and verify browser stop retains the sandbox server.

Do this by changing the pack configuration and recipe, without editing `@farmslot/adapter-web` or duplicating its browser lifecycle.
