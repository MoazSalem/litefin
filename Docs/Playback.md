# Playback

Playback in Litefin is handled by a sophisticated dual-backend system that prioritizes hardware acceleration.

## Advanced Player Core

The player is implemented as a standalone sub-project integrated into the main application. It logicially separates the OSD (On-Screen Display) management from the low-level playback engine.

### Platform Adapters

- **Tizen AVPlay**: The primary backend for Samsung TVs. It utilizes native hardware for decoding and provides advanced buffering controls. It includes custom logic for:
  - **Buffer Tuning**: Hardware-level buffer thresholds (byte-based and property-based).
  - **Trickplay**: Support for previewing thumbnails during seeking.
  - **Rewind Buffer**: A 10-second rewind buffer for direct streams to improve responsiveness.
- **webOS Player**: Dedicated hardware integration for LG web-OS devices.
- **HTML5 Web Player**: A fallback renderer for environments where native hardware APIs are unavailable or unsupported.

### Subtitle Management

Subtitles are a core focus of the playback experience:
- **Subtitle Manager**: Centralizes tracking and rendering of all subtitle formats.
- **ASS/SSA Rendering**: Integrated `libjass` for complex styled subtitles, with specific Tizen-targeted optimizations to handle skew, vertical spacing, and "staircase" layouts.
- **PGS Support**: Native rendering support for image-based PGS subtitles.
- **External Delivery**: Logic to force external subtitle delivery when transcoding to avoid playback out-of-bounds errors on certain hardware.

### Transcoding & Negotiation

The **Device Profile** system negotiates capabilities with the Jellyfin server. It provides specific profiles for:
- 4K / HEVC / HDR10+ support.
- Dolby Vision (DoVi) profiles (7/8) with HDR10 fallback logic.
- Audio codec constraints (e.g., forcing transcoding for unsupported DTS or EAC3 streams).
- Real-time quality switching and bit-rate limitation management.
