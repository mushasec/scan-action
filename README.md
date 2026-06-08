# Musha Security Scan — GitHub Action

Scan your repository with [Musha Security](https://mushasec.com) on every push and
pull request. Authenticates with **OIDC**.

## Usage

```yaml
name: Musha Security Scan
on: [push, pull_request]

permissions:
  id-token: write   # required to mint the OIDC token
  contents: read

jobs:
  musha-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0   # lets Musha scan only what a PR changed
      - uses: mushasec/scan-action@v1
        with:
          project-id: <your-project-id>   # from the Musha Integration Guide
```

That's it. The job mints a short-lived OIDC token, exchanges it for a Musha token,
uploads your code, and scans it. Results appear in your Musha dashboard under
**Scans**, and the job **fails** if the scan is blocked by your SLA policy.

## Diff-aware pull requests

On a pull request, Musha blocks only on findings **the PR introduced** —
pre-existing issues elsewhere in the repo are treated as Technical Debt and do
not fail your build. This needs **`fetch-depth: 0`** on `actions/checkout` so the
Action can compute the diff. Without it the scan still runs, but every finding is
treated as new (a one-line PR could then fail on the whole repo's existing debt).

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `project-id` | **yes** | — | Your Musha project ID (shown in the project's Integration Guide). |

Scan type and gating policy are **not** configured here — they live in your
project's settings on the Musha web app and are applied server-side.

## How it authenticates

1. GitHub issues a signed OIDC token proving the job runs in your repository.
2. The Action exchanges it at `POST /v1/ci/token` for a short-lived Musha token.
3. Musha only accepts it if **you registered this repository** for the project in
   the Integration Guide — a public copy of this Action can't scan anything that
   isn't already authorized in your account.

## Requirements

- `permissions: id-token: write` on the job (so GitHub can issue the OIDC token).
- The repository must be connected to a project in your Musha account.

---

© Musha Security. All rights reserved. This Action is provided to use within
GitHub Actions; it is not open-source and may not be redistributed.
