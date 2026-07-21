# Security

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/bacarndiaye/wslc-desktop/security/advisories/new)
rather than opening a public issue. You should get a first response within a week.

## Release integrity

WSLC Desktop releases are protected by two independent mechanisms:

1. **Authenticode** — installers (`.exe`) are code-signed through
   [SignPath Foundation](https://signpath.org) once the application is approved.
   Windows verifies this signature at install time.
2. **GPG** — every release includes a `SHA256SUMS` file and a detached signature
   `SHA256SUMS.asc`, produced in CI with the release signing key. Release tags
   are signed with the same key.

### Official release signing key

```
WSLC Desktop Release Signing <6508454+bacarndiaye@users.noreply.github.com>

Fingerprint:
01A4 6115 2FC4 4EE3 3FF4  EF36 2B99 67BB 8A71 425B
```

Public key file: [`docs/wslc-desktop-release-public-key.asc`](docs/wslc-desktop-release-public-key.asc)

Verification instructions: see [README → Verifying releases](README.md#verifying-releases).

Releases are built exclusively by GitHub Actions from tagged commits of this
repository — no release binary is ever built or uploaded from a developer
machine.
