# Farmslot website deployment

The public website should be a single Docusaurus property:

- `https://farmslot.io/` — landing page;
- `https://farmslot.io/docs/...` — documentation and protocol references.

## Current desired hosting shape

Use Docusaurus static output with the custom domain `farmslot.io`. The docs app
includes `static/CNAME`, so `yarn docs:deploy` carries the custom domain file
when deploying to GitHub Pages.

## OVH DNS target for GitHub Pages

When the GitHub Pages host is ready, replace the OVH parking records with GitHub
Pages records:

```text
farmslot.io      A      185.199.108.153
farmslot.io      A      185.199.109.153
farmslot.io      A      185.199.110.153
farmslot.io      A      185.199.111.153
www.farmslot.io  CNAME  <github-pages-host>
```

Use the actual GitHub Pages host for the repository or organization, for example
`farmslot.github.io` if the public repository lives under the `farmslot` org.
Do not change DNS until the Pages target/repository owner is confirmed.

## Local checks

```bash
yarn docs:build
```

Optional local preview:

```bash
yarn workspace @farmslot/docs serve
```

## Publish package docs dependency

The package READMEs link to `https://farmslot.io/docs/...`, so deploy the website
before publishing public npm packages.
