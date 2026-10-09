# 10. A portable exe that updates itself

Date: 2026-10-09
Status: Accepted

## Context

ja-db was built and run on one machine with `make open`. Using it on another
meant copying the exe by hand, with no way to tell an old copy from a new one
beyond the commit hash in the title bar.

## Decision

- **Releases are tags.** `make release` tags `vX.Y.Z` and pushes it. The
  version comes from the commit emoji since the last tag
  (`scripts/next-version.sh`, as ADR 0004 anticipated); `V=` overrides it.
- **CI publishes.** `.github/workflows/release.yml` runs `make check`,
  cross-compiles the exe as a dev machine does, and attaches `ja-db.exe` and
  `SHA256SUMS` to a GitHub release.
- **No installer.** The exe is the install. WebView2 ships with Windows 10 and
  11, so there is nothing else to put in place.
- **The app updates itself.** At launch it asks GitHub for the latest release
  (`internal/selfupdate`). A newer one gets a toast and an `Update to vX`
  palette command. Updating downloads beside the exe, checks the SHA-256,
  renames the running exe to `.old` — Windows allows a rename where it refuses
  an overwrite — moves the new one into place, quits, and relaunches. The next
  launch deletes `.old`.
- **Stdlib only.** The check, download and swap are about 200 lines; the
  libraries that do this bring SDKs for every forge.

## Consequences

- An exe in a folder the user cannot write to (Program Files) cannot update
  itself; it reports the error and stays as it is.
- Only tagged builds update. `dev` and bare-commit builds report and refuse.
- Updating refuses while edits are staged, since quitting would lose them.
- The checksum guards against a broken download, not a compromised GitHub
  account. Signing releases with a key kept off GitHub is the next step before
  a public release, along with code signing for SmartScreen.
- Every release must read every older release's config files: an update
  lands under whatever the user already has.
- The launch check is one unauthenticated request to api.github.com. Offline
  is silent.
