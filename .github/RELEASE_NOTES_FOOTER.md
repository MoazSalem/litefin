
---

## 🌐 Web & Server Plugins

Extend Litefin with enhanced features (Seerr discovery, Where to Watch streaming availability, MDBList ratings) and access Litefin directly inside your web browser:

#### 🔌 Server Plugins (Features & Integrations)

- **[Litefin Plugin for Jellyfin](https://github.com/MoazSalem/litefin-plugin)**: Required on Jellyfin server for Seerr integration, per-season requests, and TMDB streaming availability.
- **[Litefin Plugin for Emby](https://github.com/MoazSalem/litefin-plugin-emby)**: Companion plugin for Emby server setups.

---

## 📦 Which Version Should I Choose?

Litefin is available across Smart TVs, Android devices, Desktop environments, and as a Jellyfin Web plugin. Pick the build matching your hardware below:

---

### 📺 Smart TVs (Samsung Tizen & LG webOS)

Smart TV packages come in 4 performance tiers to squeeze maximum performance out of both modern and vintage hardware:

| Build Variant    | Recommended Hardware           | OS / Platform Target            | Package Format  |
| :--------------- | :----------------------------- | :------------------------------ | :-------------- |
| **Modern**       | High-end / Recent TVs (2021+)  | Tizen 6.5+ / webOS 22+		  | `.wgt` / `.ipk` |
| **Normal**       | Most Smart TVs (2019–2021)     | Tizen 5.0+ / webOS 5.0+         | `.wgt` / `.ipk` |
| **Legacy**       | Mid-lifecycle TVs (2017–2018)  | Tizen 4.0+ / webOS 4.0+         | `.wgt` / `.ipk` |
| **Ultra-Legacy** | Older & vintage TVs (Pre-2017) | Tizen 3.0 & below / webOS < 4.0 | `.wgt` / `.ipk` |

> **Tip**: If you're unsure which tier your TV needs, start with **Normal**. If it fails to launch, switch to **Legacy**.
> For vintage **Tizen 2.4** TVs, use the dedicated `Ultra-Legacy (No-Service)` build.

- **Samsung Tizen**: Sideload `.wgt` using [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) or Tizen CLI.
- **LG webOS**: Install `.ipk` via [webOS Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) or Try [Scoty's lg-dev-manager](https://github.com/Scoty/lg-dev-manager).

---

### 📱 Android (Android TV, Google TV, Fire TV & Mobile)

Android builds are native packages powered by Media3 ExoPlayer with hardware decoding and audio passthrough:

| Package                                | Target Hardware & Devices                                                                                                                                     |
| :------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`*-Android-arm64.apk`**              | **Most Modern Devices (Recommended)**: Android TV / Google TV boxes, Nvidia Shield, Fire TV Cube (3rd gen), and modern Android phones / tablets (64-bit ARM). |
| **`*-Android-arm.apk`**                | **32-bit Devices**: Fire TV Stick (Basic, 4K, 4K Max 1st gen), budget Android TV sticks, older Android mobile devices (32-bit ARM).                           |
| **`*-Android-x86_64.apk` / `x86.apk`** | Android emulators, Intel-based Android hardware, and Chromebooks running Android runtime.                                                                     |

- Sideload via **ADB** (`adb install <file>.apk`), **Downloader** app, or **Send Files to TV (SFTV)**.

---

### 🖥️ Desktop (Windows, Linux, macOS)

Native desktop builds powered by Tauri v2 with low resource usage and hardware-accelerated playback:

| OS          | Available Formats                   | Notes                                                                                    |
| :---------- | :---------------------------------- | :--------------------------------------------------------------------------------------- |
| **Windows** | `*.exe`, `*_x64-setup.exe`, `*.msi` | Standalone executable, setup wizard, or MSI enterprise installer (Windows 10/11 64-bit). |
| **Linux**   | `*.AppImage`, `*.deb`, `*.rpm`      | Universal standalone (AppImage), Debian/Ubuntu (.deb), or Fedora/RHEL/openSUSE (.rpm).   |
| **macOS**   | `*.dmg`                             | Drag-and-drop disk image installer.                                                      |

**Notes**: For the macOS build, I don't have an Apple Developer account, so it's not signed. To run it, open Terminal and run:

```text
xattr -cr /Applications/Litefin.app
```

#### ⌨️ Keyboard Controls (Desktop & Web)

| Key / Shortcut              | Action                                             |
| :-------------------------- | :------------------------------------------------- |
| **`Space`** / **`K`**       | Play / Pause toggle                                |
| **`J`** / **`L`**           | Seek backward / forward 10 seconds                 |
| **`←`** / **`→`**           | Navigate UI items or seek timeline during playback |
| **`↑`** / **`↓`**           | Navigate UI items, menus, and OSD controls         |
| **`Enter`**                 | Select / Activate focused item or reveal OSD       |
| **`Esc`** / **`Backspace`** | Go back / Close modal / Exit player                |
| **`F`** / **`F11`**         | Toggle Fullscreen                                  |
| **`M`**                     | Mute / Unmute audio                                |
| **Media Keys**              | Hardware Play, Pause, Next, Previous, Stop         |

---

### 🌐 Litefin Client Plugin (Web Client in Browser)

Integrates Litefin Client directly into the official Jellyfin web client, giving you the Litefin experience in any browser.

##### Option 1: Via Repository Manifest (Recommended)

1. Copy this manifest repository URL:
    ```text
    https://github.com/MoazSalem/litefin/releases/latest/download/litefin-plugin-manifest.json
    ```
2. In your Jellyfin Server, navigate to **Dashboard > Plugins > Repositories**.
3. Click **Add (+)**, enter a name (e.g. `Litefin Plugins`), and paste the URL.
4. Switch to the **Catalog** tab, locate **Litefin Client Plugin** under **General**, and click **Install**.
5. Restart your Jellyfin Server.
6. After restart, Litefin Client is available in your browser at `http://<Jellyfin-IP>:<Jellyfin-Port>/litefin`.

##### Option 2: Manual Installation

1. Download the `Litefin.Client.Plugin_*.zip` archive from the Releases page (or compile from source).
2. Extract the archive (specifically `Litefin.Client.Plugin.dll` and `manifest.json`) into your server's plugin folder:
    - **Windows (Service)**: `C:\ProgramData\Jellyfin\Server\plugins\Litefin_Client\`
    - **Windows (Portable)**: `<Jellyfin-Directory>\data\plugins\Litefin_Client\`
    - **Linux / Docker**: `/config/plugins/Litefin_Client/`
3. Restart your Jellyfin Server.
