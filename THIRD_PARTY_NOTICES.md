# Third-party notices

Job Seeker is distributed under the MIT License. It includes JavaScript dependencies under their own licenses. The machine-readable `THIRD_PARTY_NOTICES.json` lists every package version and license identifier recorded in `package-lock.json`.

Regenerate the manifest after changing the lockfile:

```sh
npm run licenses:generate
```

The portable worker uses only the Python standard library at runtime. Its optional Hermes readiness checker and test extra use PyYAML under the MIT License. Codex CLI, Hermes, browser providers, hosted model APIs, Vercel, Neon, and PostgreSQL are not redistributed by this repository; operators install or use them under their respective terms.

License identifiers in the generated manifest are package metadata, not legal advice. Source distributions and full license texts remain available through each package's registry entry and source repository.
