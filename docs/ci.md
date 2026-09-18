# Continuous integration

The active [GitHub Actions workflow](../.github/workflows/ci.yml) runs lint, type checking, TypeScript and Python tests, privacy scanning, dependency-notice verification, and a production build. It uses Node.js 22 and Python 3.11 and requires no deployment credentials.

It runs on pushes and pull requests. It does not deploy to Vercel, connect to a real database, call a model, or modify a Hermes installation. It checks code contracts and buildability; deployment and provider verification remain separate.

| Check | What it catches |
| --- | --- |
| ESLint and TypeScript | Code errors and incompatible types |
| Vitest and Python unittest | Regressions in app, adapter, and reference-setup contracts |
| Privacy scan | Known secret patterns and forbidden private files |
| Dependency notices | A notice manifest that differs from the lockfile |
| Production build | A Next.js application that cannot build |

The workflow is enabled in this repository. To enable it in a copy or fork:

1. Allow GitHub Actions in the repository's **Settings → Actions → General**.
2. Keep `.github/workflows/ci.yml` in place, or restore it from the [workflow example](../examples/github-actions/ci.yml).
3. Commit and push with permission to update workflow files. For a fine-grained GitHub token, grant **Contents: Read and write** and **Workflows: Read and write** for this repository. **Actions: Read** also lets an operator inspect runs. A classic token instead needs the `workflow` scope as well as repository access. See [GitHub's workflow-file permissions](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents).
4. Open the repository's **Actions** tab and verify the first run succeeds. Optionally make the `verify` job a required pull-request check in your branch rules.

No Vercel, Neon, or model keys need to be added to GitHub for these checks. The file under `examples/github-actions/` is a copyable template; GitHub executes the file under `.github/workflows/`.

The workflow uses a read-only repository token. The credential used to publish workflow changes is separate and is not supplied to CI jobs. See the [Actions runs](https://github.com/danibendi/job-seeker/actions/workflows/ci.yml) for current results and [release verification](verification-results.md) for the validation history.

Run the equivalent checks locally:

```sh
npm ci
python -m pip install -e '.[test]'
npm run verify
python -m unittest discover -s tests/python -p 'test_*.py'
python -m unittest discover -s examples/reference-stack/tests -p 'test_*.py'
npm run privacy:scan
npm run licenses:generate
git diff --exit-code -- THIRD_PARTY_NOTICES.json
npm run build
```
