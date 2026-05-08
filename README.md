# Oryon CI/CD Pipeline

Public GitHub Actions entrypoint for Oryon security scans.

This repository contains only the public CI wrapper. The scanner engine and proprietary analysis logic are not stored here. Authorized GitHub Actions runs receive the scanner at runtime.

## Client Workflow

```yaml
name: Oryon Security Scan

on:
  push:
  pull_request:

permissions:
  contents: read
  id-token: write

jobs:
  oryon:
    uses: Oryon-Technology/oryon-cicd-pipeline/.github/workflows/scan.yml@v1
    secrets:
      ORYON_CI_TOKEN: ${{ secrets.ORYON_CI_TOKEN }}
```

## Required Secret

Configure `ORYON_CI_TOKEN` as a repository or organization secret in GitHub.

The token is project-scoped and can be rotated or revoked from Oryon.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `backend-url` | `https://dashboard.oryontechnology.com` | Oryon service URL. |
| `scanner-version` | `v1` | Scanner release channel. |
| `fail-on` | `none` | Minimum severity that fails the job: `none`, `low`, `medium`, `high`, or `critical`. |
| `ai` | `true` | Enables AI enrichment in the runner. |
| `upload` | `true` | Uploads scan results to Oryon. |
| `report` | `none` | Report artifact type: `none` or `pdf`. |
| `sarif` | `true` | Writes a SARIF artifact when supported by the scanner. |

## What It Does

The reusable workflow checks out the customer repository, validates the CI run with Oryon, runs the authorized scanner in the GitHub runner, and uploads local scan artifacts from `.oryon/`.

## Security Notes

- Customers only configure `ORYON_CI_TOKEN`.
- Provider keys are not stored in customer GitHub secrets.
- Scanner artifacts are short-lived and integrity checked before execution.
- CI access is project-scoped and controlled by Oryon policy.
- Direct use outside the approved reusable workflow can be rejected by Oryon.
