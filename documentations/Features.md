# Comprehensive Feature Reference

Litefin is a high-performance, hardware-accelerated Jellyfin client engineered from the ground up for Smart TVs (Samsung Tizen and LG webOS), Android devices (Android TV, Google TV, Fire TV, Android Mobile & Tablet), Desktop environments (Windows, Linux, macOS via Tauri v2), and modern Web browsers (via the official Jellyfin Web client plugin). Every component is optimized for remote control navigation (D-pad), desktop mouse & keyboard, mobile touchscreens, constrained hardware memory, and direct media decoding.

---

## 1. Core Architecture & Hardware Optimization

- **Zero-Framework Vanilla JS Engine**:
    - Lightweight component lifecycle engine (`Component.js`, `Page.js`) with zero React/Vue overhead.
    - Centralized event messaging system (`EventBus.js`) and persistent reactive state tree (`StateManager.js`).
- **DOM Virtualization & Memory Management**:
    - `VirtualCardRow`: Horizontal sliding-window recycler maintaining constant DOM node counts regardless of row length.
    - `VirtualGrid` & `MediaGrid`: Vertical list/grid recycling preventing memory exhaustion during massive library browsing.
    - Background image cache recycling with canvas-based `BlurHash` decoding for placeholder generation.
    - Strict Low-VRAM rendering mode for older chipsets with constrained graphics memory.
- **Multi-Platform Build & Packaging Matrix**:
    - **Smart TVs (8x Build Matrix)**:
        - **Modern** (Tizen 6.5+, webOS 22+): Pure ES6+ output, native modern JS features, and full WebAssembly libass.
        - **Normal** (Tizen 5.0+, webOS 4.5+ / Chromium 63+): Targeted transpilation for mid-tier smart TVs.
        - **Legacy** (Tizen 3.0+, webOS 3.5+ / Chromium 47+): Full ES5 transpilation with core polyfills.
        - **Ultra-Legacy** (Tizen 2.3+, webOS 1.0–3.0 / Chromium 32+): Complete polyfill chain, custom style injection (`style-loader`), and no-service options.
    - **Android (Tauri v2 + Media3 ExoPlayer)**:
        - ABI-split APKs (`arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`), universal APK, and Android App Bundle (`.aab`).
    - **Desktop (Tauri v2)**:
        - Native packages for Windows (`.exe` setup, `.msi`), Linux (`.deb`, `.AppImage`, `.rpm`), and macOS (`.dmg`).
    - **Web Client Plugin**:
        - Sideloadable server plugin (`Litefin.Client.Plugin_*.zip`) and repository manifest distribution for Jellyfin servers.

---

## 2. Playback Architecture & Platform Backends

- **5 Hardware-Optimized Player Engines (`JellyfinPlayer.js`)**:
    - **Samsung Tizen AVPlay (`TizenAVPlayer.js`)**: Direct hardware decoding via Samsung's native `webapis.avplay`. Features custom buffer size tuning (byte-based and property-based thresholds), a 10-second instant rewind buffer, serialized seek queues to prevent crash loops, and automatic fallback handling.
    - **LG webOS Player (`WebOSPlayer.js`)**: Hardware-accelerated media pipeline using webOS platform APIs with automatic video container aspect ratio sizing and audio leak suppression on resume.
    - **Android Media3 ExoPlayer (`ExoVideoPlayer.js`)**: Native Android backend with multichannel bitstream passthrough (TrueHD, DTS-HD MA, Dolby Atmos), hardware codec discovery via `MediaCodecList`, and smart software fallback for chipsets lacking native AV1 decoders.
    - **Desktop Movi Player (`MoviVideoPlayer.js`)**: High-performance WebCodecs & WebAssembly engine (`movi-player`) with auto-failover to HTML5.
    - **HTML5 Video Player (`HtmlVideoPlayer.js`)**: Cross-platform fallback and Web client plugin backend with direct transcode resume and audio channel negotiation.
- **Codec Negotiation & Transcoding Intelligence**:
    - Native HEVC / H.265, H.264, VP9, and AV1 video profile negotiation.
    - HDR10, HDR10+, and Dolby Vision (DoVi profiles 7/8 with fallback to HDR10) handling.
    - Dynamic audio channel limits: independent maximum channel limits configured separately for Direct Play vs Transcode streams.
    - Automatic audio stream selection prioritizing tracks capable of direct hardware playback over transcoding.
    - Transcoding audio codec preferences and optional automatic MKV-to-MP4 remuxing.
- **Zero-Latency Playback Prewarming**:
    - Background stream pre-fetching (`PrewarmManager.js`) that initializes connection handshakes on card focus for instantaneous playback starts.
- **Multi-Part Media Playback**:
    - Native detection and continuous chained playback of multi-part files (e.g. `Movie-cd1.mkv`, `Movie-cd2.mkv`).

---

## 3. Subtitle Engine

- **WebAssembly ASS/SSA Rendering (`LibassWasmRenderer.js`)**:
    - High-performance vector subtitle engine utilizing libass compiled to WebAssembly via `@jellyfin/libass-wasm`.
    - Accurate layout positioning, typography, skew, and dialogue positioning for complex anime typesetting.
    - Legacy fallback variant (`ASSRenderer.js` via `libjass` and `ASSJSRenderer.js`) for environments lacking WASM support.
- **Bitmap PGS Subtitle Engine (`PGSRenderer.js`)**:
    - Native hardware canvas decoding of Blu-ray image-based PGS subtitles via `libpgs`.
- **Text Subtitle Customization**:
    - Granular control over font family, font size, weight, letter spacing, font color, background opacity, and vertical screen offset.
    - Shadow styling presets: Soft shadow, Drop shadow, Uniform border, or Outline.
    - Option to preserve or override embedded text subtitle colors.
- **In-Player Subtitle Downloader**:
    - Search, preview, and download external subtitle tracks directly from the player interface using OpenSubtitles and Jellyfin integrations.
- **Subtitle Sync & Offset Tuning**:
    - Real-time millisecond offset adjustment via OSD with persistent delay synchronization.

---

## 4. On-Screen Display (OSD) Subsystems

The player includes 23 modular interactive overlays managed by `OSDController.js`:

| Module                      | Identifier                                  | Description                                                                                            |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Trickplay Manager**       | `TrickplayManager.js`                       | Fast seek scrub previews using server-generated BIF/trickplay images.                                  |
| **Track Menu**              | `TrackMenu.js`                              | Dynamic switching of audio streams and subtitle tracks with persistent track memory per season.        |
| **Stream Quality**          | `QualityMenu.js`                            | On-the-fly bitrate and resolution selection with direct transcode handoff.                             |
| **Chapter Selector**        | `ChaptersModal.js`                          | Visual chapter browser with titles and timeline checkpoints.                                           |
| **Playback Info**           | `PlaybackInfo.js`                           | Real-time diagnostics: video/audio codecs, container, bitrates, transcode reasons, and dropped frames. |
| **Queue & Playlist**        | `QueueModal.js`                             | Up Next queue viewer, item reordering, and multi-item playback control.                                |
| **Up Next Countdown**       | `UpNextDialog.js`                           | Post-episode countdown card with configurable auto-advance delay.                                      |
| **Lyrics Overlay**          | `LyricsModal.js`                            | Synchronized, scrolling karaoke-style lyrics display during music playback.                            |
| **Subtitle Quick Settings** | `SubtitleQuickSettings.js`                  | Fast modal to adjust subtitle size, position, and delay without stopping playback.                     |
| **Subtitle Offset**         | `SubtitleOffset.js`                         | Dedicated timeline tool for subtitle audio-sync alignment.                                             |
| **Playback Modes**          | `PlaybackModeMenu.js` / `RepeatModeMenu.js` | Shuffle and repeat options (Repeat All, Repeat One, Normal).                                           |
| **Speed Controls**          | `PlaybackSpeedMenu.js`                      | Variable playback rates from 0.5x to 2.0x.                                                             |
| **Aspect Ratio Modes**      | `AspectRatioMenu.js`                        | Overrides: Original, 16:9, 4:3, Zoom, Stretch.                                                         |
| **Confirm Exit**            | `ConfirmExitModal.js`                       | Optional confirmation prompt on remote Back button press during playback.                              |
| **SyncPlay Overlays**       | `SyncPlayNotification.js`                   | In-stream toast notifications for group playback events (pauses, seeks, joins).                        |

---

## 5. Media Browsing & Library Experiences

- **Home Screen (`HomePage.js`)**:
    - Highly configurable section ordering: Continue Watching, Next Up, My Media, Trending Movies, Trending Shows, Suggestions, Live TV Channels.
    - Interactive Hero Carousel with customizable transition styles and simplified indicator dots for enhanced performance.
    - Configurable collection-based trending rows and merged Next Up / Continue Watching rows.
- **Library Hub (`LibraryPage.js`)**:
    - High-performance grid views with toggleable infinite scrolling or page-based navigation.
    - Dual Alphabetic Jump Selector (left-side bar or right-side overlay) with instant scroll-to-letter indexing.
    - Jellyfin 12 `filters2` support: advanced filtering by genres, tags, studios, release years, parental ratings, unplayed status, and video types.
- **Item Details Experience (`DetailsPage.js`)**:
    - Rich metadata overview: high-resolution backdrops, logos, ratings, tags, genres, studios, and crew members.
    - Split layout configuration: distinct presentation choices for movies/series vs seasons/episodes.
    - Native embedded YouTube and stream trailer player (`TrailerPlayer.js`).
    - Theme song playback with non-repeating audio loop option.
    - Action tooltips and configurable overview text length with expandable modal view.
- **Streaming Availability (Where to Watch)**:
    - Lists streaming services for movies or series in the selected country (Netflix, Prime, Disney+, etc.) grouped under Subscription and Buy.
    - Powered by TMDB and the Litefin Server Plugin.
- **Cast & Crew (`PersonPage.js` & `SeerrPersonPage.js`)**:
    - Dedicated actor, director, and crew biographies with comprehensive, role-grouped filmographies.
- **Music Experience**:
    - Album and artist grids, square poster layouts, personalized suggestions, frequently played rows, and lightweight performance modes for older hardware.
- **Live TV & EPG (`LiveTvPage.js` & `EpgGrid.js`)**:
    - Electronic Program Guide (EPG) grid with horizontal timeline navigation.
    - Channel switcher, active program guides, recording scheduling, timer management, and sticky guide styling.
- **Photo Slideshow (`SlideshowPage.js`)**:
    - Image viewer with automatic slideshow timers, smooth transitions, and high-resolution rendering.
- **Gaming Support (`EmulatorPage.js`)**:
    - Native launcher and browsing UI for JellyEmu retro gaming integration.

---

## 6. Integrations & Plugin Ecosystem

- **Modular Plugin Engine (`PluginManager.js`, `ServerPluginClient.js`)**:
    - Standalone plugin architecture allowing client modules and server plugins to be toggled on or off via settings.
- **Jellyseerr / Overseerr Integration**:
    - Dedicated Discovery tab (`DiscoverPage.js`) displaying trending, popular, upcoming, and genre-filtered titles.
    - Full catalogue search with toggle between Jellyfin library items and Seerr discovery items.
    - Interactive Request Modal (`SeerrRequestModal.js`): request movies, series, or select individual seasons with "Request As" proxy support.
    - Status indicators (Requested, Pending, Available) with direct "Watch in Jellyfin" jump links.
- **Intro Skipper**:
    - Automatic skip button overlays for TV show intros and recap segments based on server marker data.
    - Configurable auto-skip rules or manual button presses with auto-hiding triggers.
- **SyncPlay**:
    - Real-time room creation, joining, and synchronized multi-client playback (play, pause, seek, speed) over WebSockets.
- **MDBList Ratings**:
    - Multi-source ratings badge rendering (IMDb, Rotten Tomatoes, Metacritic, Trakt, Letterboxd, TMDB) across media cards and hero headers.
- **Local Intros**:
    - Pre-roll cinema trailers and custom intro video sequences executed before main media playback.
- **webOS Launch Deep Links (`LaunchTargetManager.js`)**:
    - Other apps can open a title by launching Litefin through `luna://com.webos.applicationManager/launch` with `{ "id": "org.litefin.app", "params": { "tmdbId": 603, "mediaType": "movie" } }` (`mediaType` is `movie` or `tv`; an optional `title` helps find the item on servers that ignore the TMDB id filter).
    - Opens the library item's details page when the library has that TMDB id, otherwise the Seerr details page to request it; works at launch and while Litefin runs, with Back leading to Home.
- **Server Plugin Ecosystem ([Jellyfin](https://github.com/MoazSalem/litefin-plugin) / [Emby](https://github.com/MoazSalem/litefin-plugin-emby))**:
    - Server-side counterpart proxying Seerr requests, caching TMDB streaming provider catalogs, and serving the Litefin Client plugin (`Litefin.Client.Plugin`).

---

## 7. TV & In-App Administration

- **In-App Image Editor (`ImageEditorModal.js`)**:
    - Search, view, download, and set posters, backdrops, and logos directly from the app interface.
- **In-App Item Identification (`IdentifyModal.js`)**:
    - Fix incorrect metadata matches by searching external databases (IMDb, TMDB, TVDb) and updating library entries directly.
- **Server Library Management**:
    - Trigger global server library scans or refresh item metadata directly from the Litefin Settings interface.

---

## 8. UI/UX, Theming & Multi-Platform Input Systems

- **Comprehensive Theming System**:
    - **10 Curated Themes**: Dark Classic, Light Classic, True Black (OLED), Tinted Dark, Tinted Light, Ambient Glow, Apple TV Glass, Blue Radiance, Purple Haze, Windows Media Center.
    - Custom accent color picker, light background toggles, rounded corner sliders, and customizable typography scales.
    - Bundled font selector including `Manrope`, `Outfit`, `Inter`, and system fallbacks.
    - 10+ configurable loading spinner styles.
- **Versatile Sidebar System (`Sidebar.js`)**:
    - 5 Layout Variations:
        1. **Classic Sidebar**: Standard persistent left-hand navigation pane.
        2. **Modern Sidebar**: Clean, auto-expanding design with icon highlights.
        3. **Modern Collapsed**: Minimalist footprint with floating tooltip labels.
        4. **Floating Buttons**: Modern detached navigation capsules.
        5. **Floating Island**: Glassmorphic floating control dock.
- **Multi-Platform Input Paradigms**:
    - **10-Foot TV Remotes (`FocusManager.js`, `SpatialNavigator.js`)**: Precision spatial directional calculation, section memory, colored button handlers (Red, Green, Yellow, Blue), and OK button behavior toggles (play/pause vs show OSD).
    - **Desktop Keyboard & Mouse**: Mouse hover card zoom, mouse wheel list scrolling, comprehensive keyboard shortcuts (Space/K for play/pause, J/L for seeking, M for mute, F/F11 for fullscreen, Esc/Backspace for back, arrow keys & Enter for navigation), and frameless titlebar drag/window controls via Tauri v2.
    - **Mobile & Tablet Touch**: Fluid touch scrolling on `VirtualCardRow` and media grids, touch-friendly tap targets, and responsive layout adaptivity.
- **Internationalization (i18n)**:
    - Flat JSON localization engine with multi-language support.
    - Full bidirectional support with automated Right-to-Left (RTL) layout switching.

---

## 9. Authentication, Connectivity & Diagnostics

- **Multi-Tier Server Discovery**:
    - Automated local network discovery via LG webOS Luna services, Samsung Tizen background HTTP services, and direct local subnet pinging.
    - Manual IP/domain connection fallback with HTTPS and base path support.
- **Authentication Flows (`AuthManager.js`)**:
    - Quick Connect passwordless pairing via on-screen QR codes.
    - Multi-user profile management with user avatar switcher.
    - Profile switcher prompt on app launch or wake from standby.
    - PIN code dialog protection for user profiles (`PinDialog.js`).
- **Wake-on-LAN (WoL)**:
    - Magic packet broadcasting with adjustable cold-boot wait timers to power up sleeping media servers.
- **Emby Server Compatibility**:
    - Full interoperability with Emby servers, adapting authentication headers, WebSocket payloads, and API endpoints.
- **Diagnostic & Logging Suite (`Logger.js`, `DebugOverlay.js`)**:
    - Multi-tiered logging (DEBUG, INFO, WARN, ERROR) stored in local memory.
    - On-screen debug overlay for monitoring memory, FPS, and playback metrics.
    - One-click log export directly to the host Jellyfin server log folder ("Send to Server").
- **Backup & Restore**:
    - Complete JSON configuration export and import to migrate layout, theme, player, and subtitle settings across devices.
