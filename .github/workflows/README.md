# Supported workflows

The default branch is `main`. The supported application is the Electron shell in
`packages/desktop`, with the shared `packages/core-ui` UI and `packages/backend`.
The retired root Next.js interface and Tauri stub installer are no longer built.

## Current Desktop Release

`desktop-release.yml` runs only when dispatched manually. It does not publish on
push, version tag, or schedule. The platform selector can validate one platform
or all four: macOS arm64, macOS x64, Windows x64, and Linux x64.

Each job installs locked dependencies on Node 24, builds the current UI, runs
UI/desktop/import and compatibility checks, stages production dependencies,
builds the Electron installer, verifies its runtime, and uploads checksummed
artifacts. Artifacts are retained for 14 days.

```sh
gh workflow run desktop-release.yml --ref main -f platform=all -f publish_draft=false
```

Draft creation requires all four platforms to pass and an explicit
`publish_draft=true` input. A platform-specific run cannot create a draft.
The workflow does not publish a draft publicly. Inspect the checksums and verify
an upgrade with synthetic existing accounts, conversations, and encrypted keys
before promoting a release. Current macOS builds are unsigned and not notarized.

## Security Scanning

`security-scan.yml` runs on supported branch pushes, pull requests, a daily
schedule, and manual dispatch. It audits the backend, core UI, and desktop
lockfiles, scans secrets with the maintained default Gitleaks rules, and uploads
CodeQL analysis for the current JavaScript/TypeScript source.

Dependency and secret detection failures fail their jobs. A successful CodeQL
analysis job confirms analysis/upload, not the absence of findings: review the
repository security alerts separately. Full-history secret validation can be
requested manually. Reviewed historical exceptions use exact fingerprints in
`.gitleaksignore`; no general test or documentation directory bypass applies.
Never print credential values when investigating a result.

New security runs supersede obsolete runs on the same ref. Historical failed
runs remain visible in Actions after their causes are fixed.

## Retired workflows

`build-installers.yml` and `release.yml` are disabled in repository settings.
Their files contain only a manual refusal job as an additional safeguard if
someone re-enables them. They cannot build or publish the retired interface,
source ZIP, or Tauri installer. Do not re-enable them for a new release.

GitHub's built-in Dependency Graph workflow is maintained by GitHub and remains
enabled; historical job names can refer to dependency files that were removed.
