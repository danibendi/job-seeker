# Continuous integration

The [GitHub Actions workflow example](../examples/github-actions/ci.yml) runs lint, type checking, TypeScript and Python tests, privacy scanning, dependency-notice verification, and a production build. It uses Node.js 22 and Python 3.11 and requires no deployment credentials.

To enable it, copy the file to `.github/workflows/ci.yml`, commit, and push with credentials permitted to update GitHub Actions workflows. The example is inactive at its current path.

The initial publication credential could write repository contents but lacked workflow permission. Automated checks were run locally as recorded in [release verification](verification-results.md); a successful GitHub Actions run is not claimed.

Until the workflow is enabled, run the equivalent checks locally:

```sh
npm ci
python -m pip install -e '.[test]'
npm run verify
python -m unittest discover -s tests/python -p 'test_*.py'
npm run privacy:scan
npm run licenses:generate
git diff --exit-code -- THIRD_PARTY_NOTICES.json
npm run build
```
