# Nexuzy PMS installers

All packages carry Node.js and the production dependencies, so the target
computer does not need Node.js, npm, an internet connection or administrator
rights. Hotel data is always stored outside the packaged payload and is kept on
upgrade/uninstall.

The application icon is `installer/assets/nexuzy.ico` (9 sizes, up to 256×256).
It is used for the Windows Setup icon, shortcuts and uninstall entry, the web
favicon, and the Linux/macOS application icons.

## Windows

```
dist/installer/Nexuzy-PMS-Setup-<version>.exe
dist/installer/Nexuzy-PMS-Setup-<version>.exe.sha256
```

- Installs per-user to `%LOCALAPPDATA%\Programs\Nexuzy PMS`.
- Adds Desktop and Start Menu shortcuts and an uninstall entry.
- Preserves `data\`, `data\uploads`, backups and `.env` on upgrade.
- Uninstalling removes program files but leaves hotel data in place.
- Stops a verified running `node.exe` before upgrading or uninstalling.

Build on 64-bit Windows with [Inno Setup 6](https://jrsoftware.org/isinfo.php):

```bash
npm run build:installer
```

Silent install:

```bat
Nexuzy-PMS-Setup-1.2.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /MERGETASKS="!desktopicon"
```

## Linux x64

```
dist/installer/Nexuzy-PMS-<version>-linux-x64.run
dist/installer/Nexuzy-PMS-<version>-linux-x64.tar.gz
```

- Bundles the official Node.js Linux x64 runtime and the matching SQLite N-API
  binding; no Node.js install is required.
- Requires a 64-bit glibc-based distribution (glibc 2.28 or newer).
- Installs to `~/.local/share/nexuzy-pms` by default, creates an application-menu
  entry and a desktop shortcut, and preserves the install folder's `data\` on
  upgrade.
- Includes `uninstall.sh`. The in-app **Settings → About, Support & Uninstall**
  action runs it, removes shortcuts and program files, and leaves `data/` in the
  install folder.

Self-extracting installer:

```bash
chmod +x Nexuzy-PMS-1.2.0-linux-x64.run
./Nexuzy-PMS-1.2.0-linux-x64.run
```

From the tarball:

```bash
tar -xzf Nexuzy-PMS-1.2.0-linux-x64.tar.gz
cd Nexuzy-PMS-linux-x64
./install.sh
```

Set `NEXUZY_INSTALL_DIR` to choose a different install folder. The app window
uses Chrome, Chromium, Edge or Brave when present; otherwise it opens in the
default browser.

## macOS

```
dist/installer/Nexuzy-PMS-<version>-macos-x64.tar.gz
dist/installer/Nexuzy-PMS-<version>-macos-arm64.tar.gz
```

- Use the **arm64** package on Apple Silicon and the **x64** package on Intel.
- Each package contains `Nexuzy PMS.app` with its own Node.js runtime and SQLite
  binding, plus `Install Nexuzy PMS.command`.
- Double-click `Install Nexuzy PMS.command` to copy the app to `~/Applications`
  and create a Desktop shortcut.
- Hotel data is stored in `~/Library/Application Support/Nexuzy PMS` and is
  preserved on uninstall. The in-app **Settings → About, Support & Uninstall**
  action removes the app bundle and Desktop shortcut.

The app is not code-signed or notarized. On first launch, right-click the app
and choose **Open** if Gatekeeper blocks it. Creating a `.dmg` or a signed
`.pkg` requires macOS tooling (and an Apple Developer ID); the `.app` bundle is
the portable installer payload and can be placed in a DMG on a Mac.

## One ZIP for a GitHub release

After `npm run build:installers`, run:

```bash
npm run package:installers
```

This creates `dist/installer/Nexuzy-PMS-<version>-all-platforms.zip` (plus a
`.sha256` file) containing all five installers, their checksum files,
`SHA256SUMS.txt` and `INSTALL.txt`.

For the in-app updater, attach the **individual** platform installer files to
the GitHub release as well, because the updater matches asset names such as
`Nexuzy-PMS-Setup-<version>.exe` and
`Nexuzy-PMS-<version>-linux-x64.run`. The all-platform ZIP can be attached as a
convenient manual download.

Tagged `v*` releases do this automatically through
`.github/workflows/release.yml`: it builds the Windows installer on Windows,
the Linux/macOS packages on Ubuntu, creates the combined ZIP, and publishes
both the bundle and the individual installer assets.

## Build all platforms

On 64-bit Windows with Inno Setup 6 installed:

```bash
npm run build:installers
```

Or run the individual builders:

```bash
npm run build:installer            # Windows Setup EXE
node installer/build-cross-platform.js   # Linux + macOS archives
```

The cross-platform builder downloads the official Node.js runtimes and the
published SQLite N-API prebuilds into `installer/vendor/`, verifies Node
checksums, installs production dependencies once, and writes all artifacts plus
`.sha256` files to `dist/installer/`.

`installer/build/`, `installer/build-cross/` and `installer/vendor/` are
generated and git-ignored.

## Verification notes

- Windows install/uninstall was exercised silently, including bundled SQLite,
  first-run setup, shortcut targets and uninstall while running.
- Linux and macOS packages are assembled from official runtimes and published
  native bindings; their binaries, scripts, archive modes and app structure are
  inspected at build time. Run the artifact on the target OS for a final
  platform-specific smoke test.
