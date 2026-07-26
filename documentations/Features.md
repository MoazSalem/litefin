# Features

Litefin has evolved through over 300 technical milestones. Below is a categorized list of implemented functionality.

## Media & Browsing

- **Comprehensive Library Support**: Movies, TV Shows, Music, and Live TV libraries with full browsing, filtering, and sorting.
- **Music Experience**: Lyrics support (server-side), personalized suggestions, dedicated Artist/Album grids, and frequently played tracking.
- **Rich Metadata**: Advanced Details page with metadata, cast/crew (Person pages with roles), studios, genres, and similar items.
- **Search**: Debounced, real-time search across all libraries with hints and people search.
- **Favorites**: Centralized management for favorite items across libraries with toggle buttons.
- **Library Virtualization**: Horizontal `VirtualCardRow` with DOM recycling (sliding window) for smooth browsing on limited memory.
- **Live TV**: Channel browsing, program guides (EPG Grid), recordings management, and timer creation/cancellation.

## Interactive & Social

- **SyncPlay**: Full SyncPlay support — create/join/leave groups, synchronized playback (play/pause/seek/stop/next/previous), and group ping. All via server-side WebSockets.
- **Intro/Recap Skipping**: Automatic detection and skip controls for TV show intros and recaps via server-side Intro Skipper plugin.
- **Local Intros**: Play custom local intro videos before media items.
- **MDBList Ratings**: IMDb, Rotten Tomatoes, Metacritic, Trakt, TMDB, and Letterboxd ratings displayed on cards and hero carousel.
- **Screensaver**: Dimming and title-hide after inactivity, ported from Jellyfin Web with TV optimizations.
- **Server Discovery**: 3-tier automatic discovery (webOS Luna Service → Tizen HTTP Service → subnet HTTP scan) plus manual connection. Background service for Tizen.

## Player Enhancements (OSD)

- **Modular OSD Design**: Multi-layer interface with 19 OSD submodules supporting advanced controls.
- **Chapter Selection**: Navigate media via internal chapters (`ChaptersModal.js`).
- **Quality Switching**: Dynamic bitrate and resolution selection during playback (`QualityMenu.js`).
- **Audio/Subtitle Track Switching**: Per-stream track selection (`TrackMenu.js`).
- **Playback Info**: Real-time stats showing transcode reasons and codec details (`PlaybackInfo.js`).
- **Queue Management**: Shuffle, repeat modes, playback speed, and "Up Next" dialogs for continuous watching.
- **Aspect Ratio Control**: Force 16:9, 4:3, original, or stretch (`AspectRatioMenu.js`).
- **Subtitle Controls**: Offset adjustment, quick settings, and full subtitle editing (`SubtitleOffset.js`, `SubtitleQuickSettings.js`, `SubtitleEditorModal.js`).
- **Lyrics Display**: Synchronized lyrics view during music playback (`LyricsModal.js`).
- **Trickplay**: Preview thumbnails during seeking via server trickplay images (`TrickplayManager.js`).
- **SyncPlay Notifications**: In-player UI for SyncPlay group events (`SyncPlayNotification.js`).

## Technical Milestones

- **Triple Player Backends**: Intelligent switching between Tizen AVPlay, webOS native Player, and HTML5 video player.
- **Subtitle Rendering**: ASS/SSA via `LibassWasmRenderer` (libass compiled to WebAssembly), PGS image-based via `PGSRenderer`, and text-based subtitle parsing via `SubtitleParser`.
- **Translation Engine**: Flat JSON locale system with 100+ languages, RTL support, and automatic tooling for sync/check/status.
- **Theming System**: 5 theme modes (Classic Dark, Classic Light, Black, Tinted, Ambient), accent color customization, button/border/sidebar/OSD style customization, font overrides, rounded corners, text scale, and card label styles.
- **Debugging Suite**: Centralized multi-level logger with localStorage settings and ability to upload logs directly to the Jellyfin server.
- **Emby Compatibility**: Full support for Emby servers with separate auth header formats, WebSocket paths, and API key handling.
- **Quick Connect**: Passwordless login via Quick Connect QR code flow.
- **BlurHash**: Canvas-based BlurHash decoding for beautiful image placeholders.
- **SmartHub Manager**: Tizen SmartHub preview integration (`SmartHubManager`).
