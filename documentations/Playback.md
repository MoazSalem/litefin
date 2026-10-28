# Playback

Playback in Litefin is powered by a multi-engine playback system that automatically leverages platform-native hardware decoders, WebAssembly pipelines, or WebCodecs depending on the device environment.

## Advanced Player Core

The player subsystem is organized under `src/player/` into two primary modules:

- **`core/`** (17 files): Low-level hardware playback drivers, subtitle engines, prewarming, and media helpers.
- **`osd/`** (19 files): On-Screen Display controllers, modals, track selectors, and interactive overlays.

### Platform Playback Engines

Litefin integrates five dedicated player backends coordinated by `JellyfinPlayer.js`:

1. **Samsung Tizen (AVPlay)** (`src/player/core/TizenAVPlayer.js`):
   - Direct hardware integration with `webapis.avplay`.
   - **Buffer Tuning**: Byte-based buffer configuration with dynamic network compensation.
   - **Trickplay & Rewind**: Frame preview during scrubbing and a 10-second rewind buffer for direct streams.
2. **LG webOS Player** (`src/player/core/WebOSPlayer.js`):
   - Dedicated hardware pipeline utilizing LG webOS media APIs with full application lifecycle synchronization.
3. **Android Media3 ExoPlayer** (`src/player/core/ExoVideoPlayer.js`):
   - Native Android playback backend powered by Google's Media3 ExoPlayer via the **Tauri v2** Android bridge.
   - **Multichannel Audio Passthrough**: Direct bitstream passthrough for TrueHD, DTS-HD Master Audio, and Dolby Atmos to AV receivers.
   - **Hardware Codec Probing**: Queries Android `MediaCodecList` for dynamic hardware decode support with automatic software fallback for chipsets lacking native AV1 decoders (e.g. Amlogic S905X).
4. **Desktop Movi Player** (`src/player/core/MoviVideoPlayer.js`):
   - High-efficiency WebCodecs and WebAssembly-assisted video engine (`movi-player`) for Windows, Linux, and macOS.
   - Ultra-low latency decoding with seamless failover to HTML5.
5. **Universal HTML5 Player** (`src/player/core/HtmlVideoPlayer.js`):
   - HTML5 `<video>` engine for browser environments (Jellyfin Web plugin) and fallback.


### JellyfinPlayer

The main player controller (`src/player/core/JellyfinPlayer.js`) orchestrates all platform players. It handles:

- Player backend selection based on platform and content type.
- Playback reporting (start/progress/stop) to the Jellyfin server.
- Quality switching, seeking, and trickplay.
- Integration with SyncPlay for synchronized group playback.

### Subtitle Management

Subtitles are a core focus of the playback experience:

- **SubtitleManager** (`src/player/core/SubtitleManager.js`): Centralizes tracking and rendering of all subtitle formats with format detection and delivery strategy.
- **ASS/SSA Rendering**: Uses `LibassWasmRenderer` — libass compiled to WebAssembly (via `@jellyfin/libass-wasm`). Replaces the older libjass approach. Includes Tizen-targeted optimizations for skew, vertical spacing, and "staircase" layouts. A legacy variant (`LibassWasmRenderer.legacy.js`) is available for older Tizen builds.
- **PGS Support** (`src/player/core/PGSRenderer.js`): Native rendering support for image-based PGS subtitles (via `libpgs`).
- **ASS Renderer** (`src/player/core/ASSRenderer.js`): Alternative pure-JS ASS rendering using `libjass` for environments where WebAssembly is unavailable.
- **External Delivery**: Logic to force external subtitle delivery when transcoding to avoid playback out-of-bounds errors on certain hardware.
- **Subtitle Parsing** (`src/player/core/SubtitleParser.js`): Parses and normalizes subtitle streams for consistent rendering.

### On-Screen Display (OSD)

The OSD subsystem (`src/player/osd/`) provides 19 modular menus managed by `OSDController.js`:

| Menu                    | File                       | Purpose                          |
| ----------------------- | -------------------------- | -------------------------------- |
| Chapters                | `ChaptersModal.js`         | Chapter navigation               |
| Quality                 | `QualityMenu.js`           | Bitrate/resolution switching     |
| Tracks                  | `TrackMenu.js`             | Audio/subtitle track selection   |
| Playback Mode           | `PlaybackModeMenu.js`      | Shuffle, repeat                  |
| Playback Speed          | `PlaybackSpeedMenu.js`     | Speed control (0.5x–2x)          |
| Aspect Ratio            | `AspectRatioMenu.js`       | Force aspect ratio               |
| Subtitle Offset         | `SubtitleOffset.js`        | Subtitle timing offset           |
| Subtitle Quick Settings | `SubtitleQuickSettings.js` | Font size, color, position       |
| Lyrics                  | `LyricsModal.js`           | Synchronized lyrics view         |
| Queue                   | `QueueModal.js`            | Now playing queue                |
| Up Next                 | `UpNextDialog.js`          | Auto-play next episode countdown |
| Playback Info           | `PlaybackInfo.js`          | Transcode details, codec info    |
| Settings                | `SettingsMenu.js`          | Player settings                  |
| SyncPlay Notifications  | `SyncPlayNotification.js`  | Group playback events            |
| Trickplay               | `TrickplayManager.js`      | Seek thumbnails                  |
| Description             | `DescriptionModal.js`      | Item description/overview        |
| Repeat Mode             | `RepeatModeMenu.js`        | Repeat off/all/one               |
| Base Menu               | `BaseMenu.js`              | Abstract base for OSD menus      |

### Play Queue & Shuffle

`PlayQueue` (`src/core/PlayQueue.js`) is an app-lifetime singleton, and shuffle and repeat mode are user preferences that survive `clear()` and `init()`. Shuffle stays on for the whole session that asked for it (Shuffle button, OSD toggle, remote `SetShuffleQueue`), including Up Next and autoplay. The `player:play` handler in `App.js` turns it off for any play that does not carry `isShufflePlay`, so Play, Continue Watching, Next Up, slideshow and remote play start in order. Repeat mode is left alone.

### Transcoding & Negotiation

The **Device Profile** system (`src/api/DeviceProfile.js` and `src/api/profiles/`) negotiates capabilities with the Jellyfin server. It provides specific profiles for:

- 4K / HEVC / HDR10+ support.
- Dolby Vision (DoVi) profiles (7/8) with HDR10 fallback logic.
- Audio codec constraints (e.g., forcing transcoding for unsupported DTS or EAC3 streams).
- Real-time quality switching and bit-rate limitation management.