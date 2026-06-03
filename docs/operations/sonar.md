# SonarQube / SonarCloud setup

Farmslot treats Sonar as the issue detector and models as fixers. This mirrors the VS Code
SonarQube/SonarLint flow without depending on VS Code's Problems panel internals.

The checked-in setup is safe for an open source repository:

- `sonar-project.properties` contains only generic scanner scope and quality settings.
- `.env.sonar.example` contains placeholders only.
- `.env.sonar.local` is ignored and is where local/private Sonar values belong.
- Generated reports go under `temp/quality/`, which is ignored.

## Local environment

```bash
cp .env.sonar.example .env.sonar.local
$EDITOR .env.sonar.local
```

Fill in:

```bash
SONAR_HOST_URL=https://sonarcloud.io # or your SonarQube Server URL
SONAR_PROJECT_KEY=your-project-key
SONAR_ORGANIZATION=farmslot # SonarCloud only
SONAR_TOKEN=your-token
```

Token permissions:

- For `yarn sonar:scan`: token needs **Execute Analysis** permission.
- For `yarn sonar:issues`: token needs permission to browse/read project issues.

## Scanner configuration

The repo includes `sonar-project.properties` for a single root project scan covering:

- `apps/`
- `packages/`
- `services/`
- `scripts/`
- `docs/`
- `projects/farmslot-farm/` only, because it is the checked-in demo project

It intentionally does **not** scan `projects/*` broadly. Those directories can contain nested private
repositories on developer machines. For a real nested project, either:

1. create a separate SonarQube project for that nested repo and scan from its own root, or
2. explicitly opt it into a local/CI scan with an override such as:

```bash
yarn sonar:scan -- -Dsonar.sources=apps,packages,services,scripts,docs,projects/farmslot-farm,projects/my-public-project
```

## Run analysis

Install SonarScanner CLI on the machine or CI runner, then run from the repo root:

```bash
yarn sonar:scan
```

For branches or pull requests, pass normal scanner properties:

```bash
yarn sonar:scan -- -Dsonar.branch.name=my-branch
```

SonarCloud/GitHub PR decoration is usually configured in SonarCloud/SonarQube and CI; keep tokens in
CI secrets, not in repository files.

## Fetch issues for model fixing

```bash
yarn sonar:issues
```

Outputs:

- `temp/quality/sonar-issues.json` — raw Sonar issues plus normalized file/rule/line fields.
- `temp/quality/sonar-issues.md` — compact model checklist grouped by file.

Optional filters:

```bash
SONAR_BRANCH=my-branch yarn sonar:issues
SONAR_PULL_REQUEST=123 yarn sonar:issues
SONAR_COMPONENT_KEYS=my-project:services/gateway/src/task-writer.ts yarn sonar:issues
```

## Model fixing loop

1. Run `yarn sonar:issues`.
2. Ask the model to fix `temp/quality/sonar-issues.md`.
3. Validate with the relevant local gates, for example:
   `yarn lint`, `yarn typecheck`, and focused tests.
4. Re-run `yarn sonar:issues` or refresh SonarLint/SonarQube to confirm the issue count drops.

Line numbers can drift after edits, so models should match by file, rule, message, and nearby code
instead of trusting the original line number alone.

## Recommended SonarQube project settings

Use the default **Sonar way** quality profile first. Avoid suppressing rules globally just to get a
clean first scan; fix or explicitly justify exceptions later.

Recommended project setup:

- Project type: one root project for this monorepo initially.
- New Code definition: use your main branch as the reference branch for PR/branch analysis, or the
  previous version if you release by version tags.
- Quality gate: fail on new-code bugs, vulnerabilities, security hotspots to review, and major code
  smells; ratchet legacy issues gradually.
- Pull request decoration: enable it in SonarQube/SonarCloud if your edition supports it.
- IDE: bind SonarQube for IDE/SonarLint to the same project so VS Code and CI use the same quality
  profile.

Keep scanner-only settings such as `sonar.sources`, `sonar.tests`, and `sonar.projectKey` in CI or
`sonar-project.properties`; Sonar documents these as analysis parameters rather than reusable UI
settings.
