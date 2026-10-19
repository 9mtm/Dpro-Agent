# Dpro desktop app

Electron shell for Dpro. One window, one instance.

- **This computer:** the app starts the Dpro backend on the bundled
  Node runtime, on `127.0.0.1` with a random port and a fresh per-launch token
  that every request must carry. The UI bridge (`packages/core-ui/scripts/application-server.cjs`)
  runs inside the app on a second random loopback port and adds the token; the
  page never sees it. Before starting, a read-only check looks for an existing
  owner in known data folders or your saved workspace. A verified existing
  workspace opens sign-in; ambiguous or unreadable data opens a folder chooser
  instead of creating an account. A new workspace requires an explicit choice
  and confirmation, then opens owner setup with a one-time local code. The
  password form offers local generation, visibility and strength guidance.
- **An existing Dpro:** menu → *Connect to an Existing Dpro…* opens another
  Dpro after checking its setup endpoint, by its `https://` address (or `http://` on this computer, for example
  through an SSH tunnel). Nothing runs locally then.
- **Quit** (menu, Cmd/Ctrl+Q or closing the window) stops the backend first:
  an IPC shutdown request, then a forced stop after 15 s. The backend also
  stops by itself when the app's IPC channel closes (crash, force quit).

The selected workspace path is saved in `desktop.json`'s sibling `workspace.json`.
Existing legacy `.data` workspaces retain their original working directory and
legacy store paths. No database or key is moved or merged. A fresh workspace
lives under `<userData>/workspaces/<id>`; older desktop data lives in the OS app-data folder (`~/Library/Application Support/Dpro/data`
on macOS); the redacted backend log in `…/Dpro/logs/backend.log`.

## Run from source

```sh
# once: a live core-ui candidate build (no dev quick-login)
(cd ../core-ui && node scripts/build.cjs --candidate --live-entry)
npm start
```

## Local app build (unsigned)

```sh
npm run stage      # copies Node, backend + modules, UI build into payload/
npm run dist:mac   # DMG + ZIP in release/  (dist:win = NSIS, dist:linux = AppImage)
```

The local payload copies every installed module (large). Release bundles with
a pinned, checksummed Node and production-only modules come later. The app is
not signed yet, so macOS and Windows show their usual warning for apps from
an unidentified developer.

## Tests

```sh
npm test   # process lifecycle with a stand-in backend, settings, setup code
```


## Current release pipeline

Use the **Current Desktop Release** workflow in `.github/workflows/desktop-release.yml`. It builds the shared `core-ui`, backend and Electron shell for macOS Apple Silicon, macOS Intel, Windows x64 and Linux x64. Root Next.js sources and the Tauri bootstrap installer are retired. The legacy release workflows intentionally refuse to build.

The workflow uses Node 24.21.0 and package lockfiles, runs UI/import/desktop retention tests, prunes backend development dependencies, stages the bundled runtime and verifies its dependencies from outside the checkout. Test quick-login builds are refused independently of any private local account configuration. Installers have platform-specific SHA256 manifests. A normal manual run only uploads build artifacts; `publish_draft` creates a draft only after every platform passes. Public publication is a separate release review. These builds are unsigned and are not notarized.

Updates replace application binaries while retaining the selected workspace and operating-system profile. Never package a developer database, `.data`, `.env`, local account configuration or live keys. Do not migrate or merge existing workspaces as part of installation. Existing installations must retain their saved workspace selection; ambiguous discovery requires an explicit choice rather than creating another owner.

For packaging diagnostics, the workflow platform selector can verify one platform independently. Draft publication is allowed only with the default all-platform selection.
