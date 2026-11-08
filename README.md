# Oryon CI/CD Pipeline

Public CI/CD wrapper for Oryon security scans.

This repository contains only the public bootstrap layer. The scanner engine and proprietary analysis logic are not stored here. Authorized CI runs receive the private scanner at runtime from Oryon.

## GitHub Actions

### GitHub App connection

With the GitHub App backend enabled, open your Oryon project's Integrations tab,
install the App for selected repositories, pick a repository and create its workflow
pull request. Review and merge the PR in GitHub. No `ORYON_CI_TOKEN` secret is needed.

The backend verifies GitHub OIDC and supplies a temporary project credential and
the effective exclusions/severity configuration. These settings override the
workflow's severity input for App-connected runs and are frozen for that run.
Branches and event changes require an updated workflow PR. AI and analysis defaults
remain unchanged. Fork pull requests are skipped explicitly.

This path is prepared in wrapper **0.1.3** and requires scanner **2.2.8** plus the
corresponding backend deployment and App registration. Publishing source alone
does not register or activate the App. The generated workflow pins an approved
full commit SHA; its internal action uses the versioned `v0.1.3` tag.

### Existing manual connection

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

Configure `ORYON_CI_TOKEN` as a repository or organization secret in GitHub.
Existing manual connections and Azure remain supported.

## Azure Pipelines

```yaml
trigger:
  branches:
    include:
      - main

pr:
  branches:
    include:
      - main

pool:
  vmImage: ubuntu-latest

steps:
  - checkout: self
    persistCredentials: false

  - bash: |
      set -euo pipefail
      curl -fsSL https://raw.githubusercontent.com/Oryon-Technology/oryon-cicd-pipeline/v1/azure/oryon-scan.sh | bash
    displayName: Oryon Security Scan
    env:
      ORYON_CI_TOKEN: $(ORYON_CI_TOKEN)
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

Configure `ORYON_CI_TOKEN` as a secret pipeline variable in Azure DevOps.

The token is project-scoped and can be rotated or revoked from Oryon.

## GitHub Inputs

| Input | Default | Description |
| --- | --- | --- |
| `backend-url` | `https://dashboard.oryontechnology.com` | Oryon service URL. |
| `scanner-version` | `v1` | Scanner release channel. |
| `fail-on` | `none` | Minimum severity that fails the job: `none`, `low`, `medium`, `high`, or `critical`. |
| `ai` | `true` | Enables AI enrichment in the runner. |
| `upload` | `true` | Uploads scan results to Oryon. |
| `report` | `none` | Report artifact type: `none` or `pdf`. |
| `sarif` | `true` | Writes a SARIF artifact when supported by the scanner. |

## Azure Environment Options

| Variable | Default | Description |
| --- | --- | --- |
| `ORYON_BACKEND_URL` | `https://dashboard.oryontechnology.com` | Oryon service URL. |
| `ORYON_SCANNER_VERSION` | `v1` | Scanner release channel. |
| `ORYON_WORKSPACE` | `$(Build.SourcesDirectory)` | Workspace path to scan. |
| `ORYON_OUT_DIR` | `.oryon` | Directory where local artifacts are written. |
| `ORYON_FAIL_ON` | `none` | Minimum severity that fails the job: `none`, `low`, `medium`, `high`, or `critical`. |
| `ORYON_AI` | `true` | Enables AI enrichment in the runner. |
| `ORYON_UPLOAD` | `true` | Uploads scan results to Oryon. |
| `ORYON_REPORT` | `none` | Report artifact type: `none` or `pdf`. |
| `ORYON_SARIF` | `true` | Writes a SARIF artifact when supported by the scanner. |
| `ORYON_CICD_REF` | `v1` | Wrapper ref used by `azure/oryon-scan.sh` to download `oryon-scan.mjs`. |

## What It Does

The wrapper validates the CI run with Oryon using the provider OIDC token, downloads the authorized scanner, verifies the scanner SHA256, runs it in the CI runner, and writes local scan artifacts under `.oryon/`.

## Security Notes

- Customers only configure `ORYON_CI_TOKEN`.
- Provider keys are not stored in customer CI secrets.
- Scanner artifacts are short-lived and integrity checked before execution.
- CI access is project-scoped and controlled by Oryon policy.
- Direct use outside the approved repository, pipeline, ref, or reusable workflow can be rejected by Oryon.
