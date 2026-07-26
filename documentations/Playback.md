# Playback

Playback in Litefin is handled by a sophisticated triple-backend system that prioritizes hardware acceleration.

## Advanced Player Core

The player is implemented as a standalone sub-project under `src/player/` with two major modules:

- **`core/`** (11 files): Low-level playback engines and subtitle rendering.
- **`osd/`** (19 files): On-Screen Display menus and controllers for user interaction.

### Platform Players

- **Tizen AVPlay** (`src/player/core/TizenAVPlayer.js`): The primary backend for Samsung TVs. Utilizes native hardware decoding via `webapis.avplay` with:
    - **Buffer Tuning**: Hardware-level buffer thresholds (byte-based and property-based).
    - **Trickplay**: Support for previewing thumbnails during seeking.
    - **Rewind Buffer**: A 10-second rewind buffer for direct streams to improve responsiveness.
- **webOS Player** (`src/player/core/WebOSPlayer.js`): Dedicated hardware integration for LG webOS devices using webOS video APIs.
- **HTML5 Web Player** (`src/player/core/HtmlVideoPlayer.js`): A fallback renderer for environments where native hardware APIs are unavailable or unsupported.

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

### Transcoding & Negotiation

The **Device Profile** system (`src/api/DeviceProfile.js` and `src/api/profiles/`) negotiates capabilities with the Jellyfin server. It provides specific profiles for:

- 4K / HEVC / HDR10+ support.
- Dolby Vision (DoVi) profiles (7/8) with HDR10 fallback logic.
- Audio codec constraints (e.g., forcing transcoding for unsupported DTS or EAC3 streams).
- Real-time quality switching and bit-rate limitation management.
